package docker

import (
	"context"
	"fmt"
	"net/http"
	"net/url"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
)

// Volume is what the Engine knows about one named volume.
type Volume struct {
	Name       string            `json:"Name"`
	Driver     string            `json:"Driver"`
	Mountpoint string            `json:"Mountpoint"`
	CreatedAt  string            `json:"CreatedAt"`
	Labels     map[string]string `json:"Labels"`
}

// VolumeOf looks up one volume, and refuses any the agent did not create:
// everything else on this server — including another tool's data — is
// invisible to VDeploy, and a lookup is where that stops being true.
func (c *Client) VolumeOf(ctx context.Context, name, projectID string) (Volume, error) {
	var found Volume
	if err := c.do(ctx, http.MethodGet, "/volumes/"+url.PathEscape(name), nil, nil, &found); err != nil {
		return Volume{}, err
	}
	if found.Labels[compose.ManagedLabel] != "true" {
		return Volume{}, fmt.Errorf("%q is not a folder VDeploy made", name)
	}
	if projectID != "" && found.Labels[compose.ProjectLabel] != projectID {
		return Volume{}, fmt.Errorf("%q belongs to another app", name)
	}
	if found.Driver != "local" || found.Mountpoint == "" {
		return Volume{}, fmt.Errorf("%q is kept somewhere this agent cannot read", name)
	}
	return found, nil
}
