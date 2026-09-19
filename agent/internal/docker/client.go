// Package docker is the agent's client for the Docker Engine API (ADR 0003).
// The request type for application containers can only express what an app
// may have: there is no field for privileges, added capabilities, devices,
// host namespaces, host ports or host-path binds. The single exception is
// the agent's own Traefik (traefik.go), built from constants alone.
package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// APIVersion is the Engine API the agent speaks: Docker 25 and newer.
const APIVersion = "v1.44"

// ErrNotFound is returned when the Engine answers 404.
var ErrNotFound = errors.New("not found")

// Client talks to one Docker Engine over its unix socket.
type Client struct {
	http *http.Client
	base string
}

// New returns a client for the socket at path (usually /var/run/docker.sock).
func New(socketPath string) *Client {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socketPath)
		},
		MaxIdleConns:    4,
		IdleConnTimeout: 30 * time.Second,
	}
	return &Client{http: &http.Client{Transport: transport}, base: "http://docker/" + APIVersion}
}

// APIError is a non-success answer from the Engine.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("docker: %d %s", e.Status, e.Message) }

func (c *Client) do(ctx context.Context, method, path string, query url.Values, body, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode %s %s: %w", method, path, err)
		}
		reader = bytes.NewReader(encoded)
	}
	target := c.base + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return fmt.Errorf("build %s %s: %w", method, path, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, res.Body)
		return fmt.Errorf("%s %s: %w", method, path, ErrNotFound)
	}
	if res.StatusCode >= 300 && res.StatusCode != http.StatusNotModified {
		var msg struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&msg)
		return &APIError{Status: res.StatusCode, Message: msg.Message}
	}
	if out == nil {
		// Streaming endpoints (image pull) report progress in the body; it must be drained.
		_, err = io.Copy(io.Discard, res.Body)
		if err != nil {
			return fmt.Errorf("read %s %s: %w", method, path, err)
		}
		return nil
	}
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		return fmt.Errorf("decode %s %s: %w", method, path, err)
	}
	return nil
}

func labelFilter(labels ...string) url.Values {
	filters, _ := json.Marshal(map[string][]string{"label": labels})
	return url.Values{"filters": {string(filters)}}
}

// APIVersion returns the highest Engine API version the daemon speaks.
func (c *Client) APIVersion(ctx context.Context) (string, error) {
	var v struct {
		APIVersion string `json:"ApiVersion"`
	}
	if err := c.do(ctx, http.MethodGet, "/version", nil, nil, &v); err != nil {
		return "", err
	}
	return v.APIVersion, nil
}

// Ping checks that the Engine answers.
func (c *Client) Ping(ctx context.Context) error {
	_, err := c.APIVersion(ctx)
	return err
}

// IsNotFound reports whether err means the Engine has no such object.
func IsNotFound(err error) bool { return errors.Is(err, ErrNotFound) }

func containerName(names []string) string {
	if len(names) == 0 {
		return ""
	}
	return strings.TrimPrefix(names[0], "/")
}
