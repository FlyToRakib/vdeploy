package docker

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
)

// Container is a managed container as the Engine reports it.
type Container struct {
	ID     string
	Name   string
	State  string // created, running, paused, restarting, exited, dead
	Image  string
	Labels map[string]string
}

// ListManaged returns only containers carrying the VDeploy label. Nothing
// else on the server is ever listed, and so nothing else is ever touched.
func (c *Client) ListManaged(ctx context.Context) ([]Container, error) {
	var raw []struct {
		ID     string            `json:"Id"`
		Names  []string          `json:"Names"`
		State  string            `json:"State"`
		Image  string            `json:"Image"`
		Labels map[string]string `json:"Labels"`
	}
	query := labelFilter(compose.ManagedLabel + "=true")
	query.Set("all", "1")
	if err := c.do(ctx, http.MethodGet, "/containers/json", query, nil, &raw); err != nil {
		return nil, err
	}
	out := make([]Container, 0, len(raw))
	for _, r := range raw {
		// Defense in depth: never trust the filter alone.
		if r.Labels[compose.ManagedLabel] != "true" {
			continue
		}
		out = append(out, Container{
			ID: r.ID, Name: containerName(r.Names), State: r.State, Image: r.Image, Labels: r.Labels,
		})
	}
	return out, nil
}

func managedLabels(projectID string) map[string]string {
	return map[string]string{compose.ManagedLabel: "true", compose.ProjectLabel: projectID}
}

// EnsureNetwork creates the project's bridge network if it does not exist.
func (c *Client) EnsureNetwork(ctx context.Context, name, projectID string) error {
	err := c.do(ctx, http.MethodGet, "/networks/"+url.PathEscape(name), nil, nil, &struct{}{})
	if !IsNotFound(err) {
		return err
	}
	body := map[string]any{"Name": name, "Driver": "bridge", "Labels": managedLabels(projectID)}
	return c.do(ctx, http.MethodPost, "/networks/create", nil, body, &struct{}{})
}

// ManagedNetworks lists the project networks the agent created: name → project.
func (c *Client) ManagedNetworks(ctx context.Context) (map[string]string, error) {
	var raw []struct {
		Name   string            `json:"Name"`
		Labels map[string]string `json:"Labels"`
	}
	if err := c.do(ctx, http.MethodGet, "/networks", labelFilter(compose.ManagedLabel+"=true"), nil, &raw); err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, n := range raw {
		// Defense in depth: never trust the filter alone.
		if n.Labels[compose.ManagedLabel] == "true" && n.Labels[compose.ProjectLabel] != "" {
			out[n.Name] = n.Labels[compose.ProjectLabel]
		}
	}
	return out, nil
}

// RemoveNetwork removes a project network the agent created, first letting
// Traefik go of it. A network holds no data: this is only tidying up.
func (c *Client) RemoveNetwork(ctx context.Context, name string) error {
	body := map[string]any{"Container": TraefikName, "Force": true}
	// Traefik may not have joined it: that is fine.
	_ = c.do(ctx, http.MethodPost, "/networks/"+url.PathEscape(name)+"/disconnect", nil, body, nil)
	err := c.do(ctx, http.MethodDelete, "/networks/"+url.PathEscape(name), nil, nil, nil)
	if IsNotFound(err) {
		return nil
	}
	return err
}

// EnsureVolume creates a permanent folder's volume if it does not exist.
// Volumes are never removed by the agent: deleting data is a separate,
// explicit, snapshotted operation (§17.2).
func (c *Client) EnsureVolume(ctx context.Context, name, projectID string) (bool, error) {
	err := c.do(ctx, http.MethodGet, "/volumes/"+url.PathEscape(name), nil, nil, &struct{}{})
	if !IsNotFound(err) {
		return false, err
	}
	body := map[string]any{"Name": name, "Labels": managedLabels(projectID)}
	if err := c.do(ctx, http.MethodPost, "/volumes/create", nil, body, &struct{}{}); err != nil {
		return false, err
	}
	return true, nil
}

// EnsureImage pulls a digest-pinned image unless it is already present.
func (c *Client) EnsureImage(ctx context.Context, ref string) error {
	err := c.do(ctx, http.MethodGet, "/images/"+ref+"/json", nil, nil, &struct{}{})
	if !IsNotFound(err) {
		return err
	}
	return c.do(ctx, http.MethodPost, "/images/create", url.Values{"fromImage": {ref}}, nil, nil)
}

type logConfig struct {
	Type   string            `json:"Type"`
	Config map[string]string `json:"Config"`
}

type restartPolicy struct {
	Name string `json:"Name"`
}

type mount struct {
	Type   string `json:"Type"`
	Source string `json:"Source"`
	Target string `json:"Target"`
}

// hostConfig is deliberately small: it has no Privileged, CapAdd, Devices,
// Sysctls, Binds, PidMode, IpcMode or UsernsMode field to set.
type hostConfig struct {
	Memory        int64         `json:"Memory"`
	MemorySwap    int64         `json:"MemorySwap"`
	NanoCPUs      int64         `json:"NanoCpus"`
	PidsLimit     int64         `json:"PidsLimit"`
	OomScoreAdj   int           `json:"OomScoreAdj"`
	SecurityOpt   []string      `json:"SecurityOpt"`
	CapDrop       []string      `json:"CapDrop"`
	Init          bool          `json:"Init"`
	LogConfig     logConfig     `json:"LogConfig"`
	RestartPolicy restartPolicy `json:"RestartPolicy"`
	Mounts        []mount       `json:"Mounts"`
	NetworkMode   string        `json:"NetworkMode"`
}

// CreateBody is the Engine's container-create request, as the agent builds it.
type CreateBody struct {
	Image        string              `json:"Image"`
	Cmd          []string            `json:"Cmd,omitempty"`
	User         string              `json:"User,omitempty"`
	Env          []string            `json:"Env"`
	Labels       map[string]string   `json:"Labels"`
	StopTimeout  int                 `json:"StopTimeout"`
	ExposedPorts map[string]struct{} `json:"ExposedPorts,omitempty"`
	HostConfig   hostConfig          `json:"HostConfig"`
}

// CreateRequest is the exact Engine request for a composed container.
func CreateRequest(ct compose.Container) CreateBody {
	mounts := make([]mount, 0, len(ct.Volumes))
	for _, m := range ct.Volumes {
		mounts = append(mounts, mount{Type: "volume", Source: m.Volume, Target: m.Target})
	}
	var exposed map[string]struct{}
	if ct.Port > 0 {
		exposed = map[string]struct{}{strconv.Itoa(ct.Port) + "/tcp": {}}
	}
	return CreateBody{
		Image:        ct.Image,
		Cmd:          ct.Cmd,
		User:         ct.User,
		Env:          ct.Env,
		Labels:       ct.Labels,
		StopTimeout:  ct.StopTimeout,
		ExposedPorts: exposed,
		HostConfig: hostConfig{
			Memory:      ct.MemoryBytes,
			MemorySwap:  ct.MemoryBytes, // the limit is the limit: no swap beyond it
			NanoCPUs:    ct.NanoCPUs,
			PidsLimit:   ct.PidsLimit,
			OomScoreAdj: compose.OomScoreAdj,
			SecurityOpt: []string{"no-new-privileges:true"},
			CapDrop:     []string{"NET_RAW"},
			Init:        true,
			LogConfig: logConfig{Type: "json-file", Config: map[string]string{
				"max-size": compose.LogMaxSize, "max-file": compose.LogMaxFiles,
			}},
			RestartPolicy: restartPolicy{Name: ct.RestartPolicy},
			Mounts:        mounts,
			NetworkMode:   ct.Network,
		},
	}
}

// Create creates a container and returns its id.
func (c *Client) Create(ctx context.Context, ct compose.Container) (string, error) {
	var out struct {
		ID string `json:"Id"`
	}
	err := c.do(ctx, http.MethodPost, "/containers/create", url.Values{"name": {ct.Name}}, CreateRequest(ct), &out)
	if err != nil {
		return "", fmt.Errorf("create %s: %w", ct.Name, err)
	}
	return out.ID, nil
}

// Start starts a container; starting a running one is not an error.
func (c *Client) Start(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(id)+"/start", nil, nil, nil)
}

// Stop stops a container, waiting up to timeoutSeconds before killing it.
func (c *Client) Stop(ctx context.Context, id string, timeoutSeconds int) error {
	query := url.Values{"t": {strconv.Itoa(timeoutSeconds)}}
	return c.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(id)+"/stop", query, nil, nil)
}

// Remove deletes a stopped container. Its named volumes are kept.
func (c *Client) Remove(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/containers/"+url.PathEscape(id), nil, nil, nil)
}
