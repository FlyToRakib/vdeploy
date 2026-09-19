package docker

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Build tooling (ADR 0008), pinned by digest and never shaped by the control plane.
const (
	// BuildkitImage is moby/buildkit v0.33.0-rootless.
	BuildkitImage = "moby/buildkit@sha256:80b15f0735e87bab7bf59ec4d695dfb4a7cfb25521cf56dc75d6f256285b63ef"
	// RailpackImage is ghcr.io/railwayapp/railpack-frontend v0.39.0; it also carries the railpack CLI.
	RailpackImage = "ghcr.io/railwayapp/railpack-frontend@sha256:db24dc37640b6887c3d455b40876ea30f75182964479670cba6e4cde7ffef103"
	// BuildCacheVolume keeps BuildKit's layer cache between builds.
	BuildCacheVolume = "vd-build-cache"
)

// Helper is a one-shot container the agent runs for itself — a build step.
// Like Traefik, it is agent infrastructure: every field is set by agent code.
type Helper struct {
	Name        string
	Image       string
	Entrypoint  []string
	Cmd         []string
	User        string
	Env         []string
	Binds       []string // host:container[:ro], agent-owned paths only
	Volumes     map[string]string
	MemoryBytes int64
	NanoCPUs    int64
	Network     string // "none" or "bridge"
	SecurityOpt []string
}

type helperHostConfig struct {
	Binds       []string  `json:"Binds"`
	Mounts      []mount   `json:"Mounts"`
	Memory      int64     `json:"Memory"`
	MemorySwap  int64     `json:"MemorySwap"`
	NanoCPUs    int64     `json:"NanoCpus"`
	PidsLimit   int64     `json:"PidsLimit"`
	SecurityOpt []string  `json:"SecurityOpt"`
	CapDrop     []string  `json:"CapDrop"`
	NetworkMode string    `json:"NetworkMode"`
	OomScoreAdj int       `json:"OomScoreAdj"`
	LogConfig   logConfig `json:"LogConfig"`
}

type helperCreate struct {
	Image      string            `json:"Image"`
	Entrypoint []string          `json:"Entrypoint"`
	Cmd        []string          `json:"Cmd"`
	User       string            `json:"User,omitempty"`
	Env        []string          `json:"Env"`
	Labels     map[string]string `json:"Labels"`
	HostConfig helperHostConfig  `json:"HostConfig"`
}

// maxHelperLog is how much of a helper's output is kept: the end matters most.
const maxHelperLog = 256 << 10

// RunHelper creates, runs and removes a helper, returning its exit code and
// the tail of its output.
func (c *Client) RunHelper(ctx context.Context, h Helper) (int, string, error) {
	if err := c.EnsureImage(ctx, h.Image); err != nil {
		return -1, "", fmt.Errorf("image: %w", err)
	}
	mounts := make([]mount, 0, len(h.Volumes))
	for volume, target := range h.Volumes {
		mounts = append(mounts, mount{Type: "volume", Source: volume, Target: target})
	}
	body := helperCreate{
		Image: h.Image, Entrypoint: h.Entrypoint, Cmd: h.Cmd, User: h.User, Env: h.Env,
		Labels: map[string]string{InfraLabel: "build"},
		HostConfig: helperHostConfig{
			Binds: h.Binds, Mounts: mounts,
			Memory: h.MemoryBytes, MemorySwap: h.MemoryBytes, NanoCPUs: h.NanoCPUs, PidsLimit: 8192,
			SecurityOpt: h.SecurityOpt, NetworkMode: h.Network,
			// Under memory pressure the kernel kills a build before any app.
			OomScoreAdj: 800,
			LogConfig:   logConfig{Type: "json-file", Config: map[string]string{"max-size": "20m", "max-file": "1"}},
		},
	}
	var created struct {
		ID string `json:"Id"`
	}
	// A leftover from a crashed run would block the name: it is ours, remove it.
	_ = c.do(ctx, http.MethodDelete, "/containers/"+url.PathEscape(h.Name), url.Values{"force": {"true"}}, nil, nil)
	if err := c.do(ctx, http.MethodPost, "/containers/create", url.Values{"name": {h.Name}}, body, &created); err != nil {
		return -1, "", fmt.Errorf("create %s: %w", h.Name, err)
	}
	defer func() {
		// Removal must happen even if the caller's context is gone.
		_ = c.do(context.WithoutCancel(ctx), http.MethodDelete, "/containers/"+created.ID, url.Values{"force": {"true"}}, nil, nil)
	}()
	if err := c.Start(ctx, created.ID); err != nil {
		return -1, "", err
	}
	var waited struct {
		StatusCode int `json:"StatusCode"`
	}
	if err := c.do(ctx, http.MethodPost, "/containers/"+created.ID+"/wait", nil, nil, &waited); err != nil {
		return -1, "", fmt.Errorf("wait %s: %w", h.Name, err)
	}
	logs, err := c.logs(ctx, created.ID)
	if err != nil {
		return waited.StatusCode, "", err
	}
	return waited.StatusCode, logs, nil
}

// logs reads a stopped container's combined output from the Engine's
// multiplexed stream, keeping only the last maxHelperLog bytes.
func (c *Client) logs(ctx context.Context, id string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		c.base+"/containers/"+id+"/logs?stdout=1&stderr=1", nil)
	if err != nil {
		return "", fmt.Errorf("logs: %w", err)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("logs: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	var out tail
	header := make([]byte, 8)
	for {
		if _, err := io.ReadFull(res.Body, header); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return out.String(), nil
			}
			return out.String(), fmt.Errorf("logs: %w", err)
		}
		size := int64(binary.BigEndian.Uint32(header[4:]))
		if _, err := io.CopyN(&out, res.Body, size); err != nil {
			return out.String(), fmt.Errorf("logs: %w", err)
		}
	}
}

// tail keeps the last maxHelperLog bytes written to it.
type tail struct{ buf []byte }

func (t *tail) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if over := len(t.buf) - maxHelperLog; over > 0 {
		t.buf = append(t.buf[:0], t.buf[over:]...)
	}
	return len(p), nil
}

func (t *tail) String() string { return string(t.buf) }

// LoadImage loads a docker-format image tarball and returns the loaded image's ID.
func (c *Client) LoadImage(ctx context.Context, tarball io.Reader, name string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/images/load?quiet=1", tarball)
	if err != nil {
		return "", fmt.Errorf("load: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-tar")
	res, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("load: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode >= 300 {
		return "", &APIError{Status: res.StatusCode, Message: strings.TrimSpace(string(body))}
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	for decoder.More() {
		var line struct {
			ErrorDetail *struct {
				Message string `json:"message"`
			} `json:"errorDetail"`
		}
		if err := decoder.Decode(&line); err != nil {
			break
		}
		if line.ErrorDetail != nil {
			return "", fmt.Errorf("load: %s", line.ErrorDetail.Message)
		}
	}
	return c.ImageID(ctx, name)
}

// ImageID is a local image's ID (sha256:…).
func (c *Client) ImageID(ctx context.Context, ref string) (string, error) {
	var image struct {
		ID string `json:"Id"`
	}
	if err := c.do(ctx, http.MethodGet, "/images/"+ref+"/json", nil, nil, &image); err != nil {
		return "", err
	}
	return image.ID, nil
}

// RootDir is where the daemon keeps images and volumes, to check free disk before a build.
func (c *Client) RootDir(ctx context.Context) (string, error) {
	var info struct {
		DockerRootDir string `json:"DockerRootDir"`
	}
	if err := c.do(ctx, http.MethodGet, "/info", nil, nil, &info); err != nil {
		return "", err
	}
	return info.DockerRootDir, nil
}

// EnsureBuildCache creates the volume BuildKit keeps its cache in.
func (c *Client) EnsureBuildCache(ctx context.Context) error {
	err := c.do(ctx, http.MethodGet, "/volumes/"+BuildCacheVolume, nil, nil, &struct{}{})
	if !IsNotFound(err) {
		return err
	}
	body := map[string]any{"Name": BuildCacheVolume, "Labels": map[string]string{InfraLabel: "build"}}
	return c.do(ctx, http.MethodPost, "/volumes/create", nil, body, &struct{}{})
}
