package docker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"slices"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/router"
)

// Traefik is the agent's own infrastructure (§13): the only container with
// host ports and a bind mount, and it is built entirely from constants here —
// nothing the control plane sends can shape it.
const (
	// TraefikImage is v3.7.13, pinned by digest.
	TraefikImage = "traefik@sha256:1c32e7c368204fd72812152ebdd2ac0425993df6fd982317deb02e48f2d5423c"
	TraefikName  = "vd-traefik"
	// MetricsPort is where Traefik says what it has answered (§16). It is
	// never published: only the agent, on the same bridge, can read it.
	MetricsPort = 8082
	// InfraLabel marks platform containers; they are never in ListManaged.
	InfraLabel = "io.vdeploy.infra"
	// configLabel carries a hash of the request the router was created
	// from, so an agent that asks for a different router replaces it.
	configLabel = "io.vdeploy.traefik-config"
	acmeVolume  = "vd-traefik-acme"
	// drainSeconds is how long the router being replaced has to finish
	// the requests it is answering.
	drainSeconds = 10
)

// DNSChallenge is what the router needs to prove a name through DNS.
type DNSChallenge struct {
	Provider string
	// Env is the provider's credentials as KEY=value, for the router alone.
	Env []string
}

// TraefikOptions come from the agent's local configuration, and the DNS
// provider from the organization's desired state.
type TraefikOptions struct {
	// DynamicDir is the host directory of routing files (mounted read-only).
	DynamicDir string
	ACMEEmail  string
	// ACMEServer overrides Let's Encrypt (a staging or test CA).
	ACMEServer string
	// DNS adds the resolver that proves names through DNS; nil leaves it out.
	DNS *DNSChallenge
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
	Env          []string            `json:"Env,omitempty"`
	Labels       map[string]string   `json:"Labels"`
	ExposedPorts map[string]struct{} `json:"ExposedPorts"`
	HostConfig   traefikHostConfig   `json:"HostConfig"`
}

func traefikArgs(opts TraefikOptions) []string {
	args := []string{
		"--entrypoints.web.address=:80",
		"--entrypoints.websecure.address=:443",
		// HTTP/3 (§13): QUIC on 443/udp, advertised by an Alt-Svc header;
		// a browser that cannot reach it keeps using HTTP/2 or 1.1 on tcp.
		http3Arg,
		// X_Auth_User reads as X-Auth-User to PHP, Python and CGI apps, so a
		// visitor could forge the identity forward-auth hands an app. Such
		// headers are dropped at the door, as nginx does by default.
		"--entrypoints.web.http.aliasheadersstrategy=delete",
		"--entrypoints.websecure.http.aliasheadersstrategy=delete",
		"--providers.file.directory=/etc/traefik/dynamic",
		"--providers.file.watch=true",
		"--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web",
		"--certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json",
		"--ping=true",
		// What the router answered, for a stepped rollout (§16). On an
		// entrypoint of its own, never published: the agent reads it over
		// the bridge, and nothing outside the server can.
		"--entrypoints.internal.address=:8082",
		"--metrics.prometheus=true",
		"--metrics.prometheus.entrypoint=internal",
		"--metrics.prometheus.addentrypointslabels=false",
		"--metrics.prometheus.addserviceslabels=true",
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
	if opts.DNS != nil {
		resolver := "--certificatesresolvers." + router.DNSResolver + ".acme."
		args = append(args,
			resolver+"dnschallenge.provider="+opts.DNS.Provider,
			resolver+"storage=/acme/acme-dns.json",
		)
		if opts.ACMEEmail != "" {
			args = append(args, resolver+"email="+opts.ACMEEmail)
		}
		if opts.ACMEServer != "" {
			args = append(args, resolver+"caserver="+opts.ACMEServer)
		}
	}
	return args
}

// traefikConfig names a router's create request: equal means the running
// router is the one this agent would create.
func traefikConfig(request traefikCreate) string {
	unlabelled := request
	unlabelled.Labels = map[string]string{}
	for k, v := range request.Labels {
		if k != configLabel {
			unlabelled.Labels[k] = v
		}
	}
	body, _ := json.Marshal(unlabelled)
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

const http3Arg = "--entrypoints.websecure.http3=true"

// udpFree says whether nothing on this machine holds a UDP port.
var udpFree = func(port int) bool {
	conn, err := net.ListenPacket("udp", fmt.Sprintf(":%d", port))
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

/*
withoutHTTP3 is the router for a machine where something else already
holds 443/udp — a VPN on the HTTPS port, say. Asking Docker for that port
anyway would leave the router unable to start at all, and every site down
with it; without it, visitors simply keep to HTTP/2.

The router keeps the label of the one this agent would make, so it is not
replaced again on every pass for as long as the port stays taken.
*/
func withoutHTTP3(request traefikCreate) traefikCreate {
	request.Cmd = slices.DeleteFunc(slices.Clone(request.Cmd), func(a string) bool { return a == http3Arg })
	exposed := map[string]struct{}{}
	for port := range request.ExposedPorts {
		if port != "443/udp" {
			exposed[port] = struct{}{}
		}
	}
	request.ExposedPorts = exposed
	bindings := map[string][]portBinding{}
	for port, b := range request.HostConfig.PortBindings {
		if port != "443/udp" {
			bindings[port] = b
		}
	}
	request.HostConfig.PortBindings = bindings
	return request
}

// traefikRequest is the exact create request for the agent's Traefik.
func traefikRequest(opts TraefikOptions) traefikCreate {
	var env []string
	if opts.DNS != nil {
		env = opts.DNS.Env
	}
	return traefikCreate{
		Image:  TraefikImage,
		Cmd:    traefikArgs(opts),
		Env:    env,
		Labels: map[string]string{InfraLabel: "traefik"},
		ExposedPorts: map[string]struct{}{
			"80/tcp": {}, "443/tcp": {}, "443/udp": {},
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
				"443/udp": {{HostPort: "443"}},
			},
		},
	}
}

type inspected struct {
	Config struct {
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	State struct {
		Running bool `json:"Running"`
	} `json:"State"`
	NetworkSettings struct {
		Networks map[string]struct {
			IPAddress string `json:"IPAddress"`
		} `json:"Networks"`
	} `json:"NetworkSettings"`
}

// ContainerIP is a container's address on one of its networks.
func (c *Client) ContainerIP(ctx context.Context, name, network string) (string, error) {
	current, err := c.inspect(ctx, name)
	if err != nil {
		return "", err
	}
	endpoint, ok := current.NetworkSettings.Networks[network]
	if !ok || endpoint.IPAddress == "" {
		return "", fmt.Errorf("%s has no address on %s", name, network)
	}
	return endpoint.IPAddress, nil
}

func (c *Client) inspect(ctx context.Context, name string) (*inspected, error) {
	var out inspected
	if err := c.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(name)+"/json", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

/*
EnsureTraefik creates and starts the router if it is missing or stopped.

A router created from a different request — by an agent before this one,
which knew fewer of the router's settings — is replaced, or it would keep
the old settings for as long as the server runs. Replacing it drops
connections for a few seconds, once, when an agent update changes what the
router is made of; certificates live in their own volume and are kept, and
the pass that replaces it joins it to every app's network again.
*/
func (c *Client) EnsureTraefik(ctx context.Context, opts TraefikOptions) error {
	request := traefikRequest(opts)
	want := traefikConfig(request)
	request.Labels[configLabel] = want
	current, err := c.inspect(ctx, TraefikName)
	switch {
	case err == nil && current.Config.Labels[configLabel] != want:
		if err := c.Stop(ctx, TraefikName, drainSeconds); err != nil {
			return fmt.Errorf("replace traefik: %w", err)
		}
		if err := c.Remove(ctx, TraefikName); err != nil {
			return fmt.Errorf("replace traefik: %w", err)
		}
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
	if !udpFree(443) {
		request = withoutHTTP3(request)
	}
	var created struct {
		ID string `json:"Id"`
	}
	query := url.Values{"name": {TraefikName}}
	if err := c.do(ctx, http.MethodPost, "/containers/create", query, request, &created); err != nil {
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
