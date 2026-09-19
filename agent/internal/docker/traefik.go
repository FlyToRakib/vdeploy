package docker

import (
	"context"
	"fmt"
	"net/http"
	"net/url"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
)

// Traefik is the agent's own infrastructure (§13): the only container with
// host ports and a bind mount, and it is built entirely from constants here —
// nothing the control plane sends can shape it.
const (
	// TraefikImage is v3.7.13, pinned by digest.
	TraefikImage = "traefik@sha256:1c32e7c368204fd72812152ebdd2ac0425993df6fd982317deb02e48f2d5423c"
	TraefikName  = "vd-traefik"
	// InfraLabel marks platform containers; they are never in ListManaged.
	InfraLabel = "io.vdeploy.infra"
	acmeVolume = "vd-traefik-acme"
)

// TraefikOptions come from the agent's local configuration only.
type TraefikOptions struct {
	// DynamicDir is the host directory of routing files (mounted read-only).
	DynamicDir string
	ACMEEmail  string
	// ACMEServer overrides Let's Encrypt (a staging or test CA).
	ACMEServer string
}

type portBinding struct {
	HostPort string `json:"HostPort"`
}

type traefikHostConfig struct {
	hostConfig
	Binds        []string                 `json:"Binds"`
	PortBindings map[string][]portBinding `json:"PortBindings"`
	CapAdd       []string                 `json:"CapAdd"`
}

type traefikCreate struct {
	Image        string              `json:"Image"`
	Cmd          []string            `json:"Cmd"`
	Labels       map[string]string   `json:"Labels"`
	ExposedPorts map[string]struct{} `json:"ExposedPorts"`
	HostConfig   traefikHostConfig   `json:"HostConfig"`
}

func traefikArgs(opts TraefikOptions) []string {
	args := []string{
		"--entrypoints.web.address=:80",
		"--entrypoints.websecure.address=:443",
		"--providers.file.directory=/etc/traefik/dynamic",
		"--providers.file.watch=true",
		"--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web",
		"--certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json",
		"--ping=true",
		"--log.level=WARN",
		"--global.sendanonymoususage=false",
		"--global.checknewversion=false",
	}
	if opts.ACMEEmail != "" {
		args = append(args, "--certificatesresolvers.letsencrypt.acme.email="+opts.ACMEEmail)
	}
	if opts.ACMEServer != "" {
		args = append(args, "--certificatesresolvers.letsencrypt.acme.caserver="+opts.ACMEServer)
	}
	return args
}

// TraefikRequest is the exact create request for the agent's Traefik.
func TraefikRequest(opts TraefikOptions) any {
	return traefikCreate{
		Image:  TraefikImage,
		Cmd:    traefikArgs(opts),
		Labels: map[string]string{InfraLabel: "traefik"},
		ExposedPorts: map[string]struct{}{
			"80/tcp": {}, "443/tcp": {},
		},
		HostConfig: traefikHostConfig{
			hostConfig: hostConfig{
				Memory:      256 << 20,
				MemorySwap:  256 << 20,
				PidsLimit:   1024,
				OomScoreAdj: -500, // the kernel kills apps before the router
				SecurityOpt: []string{"no-new-privileges:true"},
				CapDrop:     []string{"ALL"},
				Init:        true,
				LogConfig: logConfig{Type: "json-file", Config: map[string]string{
					"max-size": compose.LogMaxSize, "max-file": compose.LogMaxFiles,
				}},
				RestartPolicy: restartPolicy{Name: "unless-stopped"},
				Mounts:        []mount{{Type: "volume", Source: acmeVolume, Target: "/acme"}},
				NetworkMode:   "bridge",
			},
			Binds:  []string{opts.DynamicDir + ":/etc/traefik/dynamic:ro"},
			CapAdd: []string{"NET_BIND_SERVICE"},
			PortBindings: map[string][]portBinding{
				"80/tcp":  {{HostPort: "80"}},
				"443/tcp": {{HostPort: "443"}},
			},
		},
	}
}

type inspected struct {
	State struct {
		Running bool `json:"Running"`
	} `json:"State"`
	NetworkSettings struct {
		Networks map[string]struct{} `json:"Networks"`
	} `json:"NetworkSettings"`
}

func (c *Client) inspect(ctx context.Context, name string) (*inspected, error) {
	var out inspected
	if err := c.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(name)+"/json", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// EnsureTraefik creates and starts the router if it is missing or stopped.
func (c *Client) EnsureTraefik(ctx context.Context, opts TraefikOptions) error {
	current, err := c.inspect(ctx, TraefikName)
	switch {
	case err == nil && current.State.Running:
		return nil
	case err == nil:
		return c.Start(ctx, TraefikName)
	case !IsNotFound(err):
		return err
	}
	if err := c.EnsureImage(ctx, TraefikImage); err != nil {
		return fmt.Errorf("traefik image: %w", err)
	}
	var created struct {
		ID string `json:"Id"`
	}
	query := url.Values{"name": {TraefikName}}
	if err := c.do(ctx, http.MethodPost, "/containers/create", query, TraefikRequest(opts), &created); err != nil {
		return fmt.Errorf("create traefik: %w", err)
	}
	return c.Start(ctx, created.ID)
}

// ConnectTraefik joins the router to a project network so it can reach that
// project's replicas — and only that project's.
func (c *Client) ConnectTraefik(ctx context.Context, network string) error {
	current, err := c.inspect(ctx, TraefikName)
	if err != nil {
		return err
	}
	if _, joined := current.NetworkSettings.Networks[network]; joined {
		return nil
	}
	body := map[string]string{"Container": TraefikName}
	return c.do(ctx, http.MethodPost, "/networks/"+url.PathEscape(network)+"/connect", nil, body, nil)
}
