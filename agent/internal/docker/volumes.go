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

// DiskUsage is what Docker is holding, from its own accounting
// (`GET /system/df`). It walks the filesystem, so it is asked for rarely.
type DiskUsage struct {
	ImagesBytes                int64
	ImagesReclaimableBytes     int64
	ContainersBytes            int64
	VolumesBytes               int64
	BuildCacheBytes            int64
	BuildCacheReclaimableBytes int64
	// Volumes is every named volume Docker knows, with what it holds.
	Volumes []VolumeUsage
}

// VolumeUsage is one volume and its size, as `/system/df` reports it.
type VolumeUsage struct {
	Name      string
	SizeBytes int64
	Labels    map[string]string
	CreatedAt string
	// InUse is how many containers currently reference it.
	InUse int64
}

// dfBody is Docker's answer to `/system/df`.
type dfBody struct {
	LayersSize int64 `json:"LayersSize"`
	Images     []struct {
		Size       int64 `json:"Size"`
		SharedSize int64 `json:"SharedSize"`
		Containers int64 `json:"Containers"`
	} `json:"Images"`
	Containers []struct {
		SizeRw int64 `json:"SizeRw"`
	} `json:"Containers"`
	Volumes []struct {
		Name      string            `json:"Name"`
		Labels    map[string]string `json:"Labels"`
		CreatedAt string            `json:"CreatedAt"`
		UsageData *struct {
			Size     int64 `json:"Size"`
			RefCount int64 `json:"RefCount"`
		} `json:"UsageData"`
	} `json:"Volumes"`
	BuildCache []struct {
		Size   int64 `json:"Size"`
		InUse  bool  `json:"InUse"`
		Shared bool  `json:"Shared"`
	} `json:"BuildCache"`
}

// SystemDF asks Docker what its own disk is made of.
func (c *Client) SystemDF(ctx context.Context) (DiskUsage, error) {
	var raw dfBody
	if err := c.do(ctx, http.MethodGet, "/system/df", nil, nil, &raw); err != nil {
		return DiskUsage{}, err
	}
	return readDiskUsage(raw), nil
}

func readDiskUsage(raw dfBody) DiskUsage {
	out := DiskUsage{ImagesBytes: raw.LayersSize}
	for _, image := range raw.Images {
		// Docker calls an image reclaimable when no container runs from it.
		// That is its opinion, not ours: a rollback target runs from
		// nothing until the day it has to.
		if image.Containers == 0 {
			out.ImagesReclaimableBytes += max(image.Size-image.SharedSize, 0)
		}
	}
	for _, container := range raw.Containers {
		out.ContainersBytes += container.SizeRw
	}
	for _, volume := range raw.Volumes {
		usage := VolumeUsage{Name: volume.Name, Labels: volume.Labels, CreatedAt: volume.CreatedAt}
		if volume.UsageData != nil {
			// Docker reports -1 when it has not measured a volume.
			usage.SizeBytes = max(volume.UsageData.Size, 0)
			usage.InUse = max(volume.UsageData.RefCount, 0)
		}
		out.VolumesBytes += usage.SizeBytes
		out.Volumes = append(out.Volumes, usage)
	}
	for _, cache := range raw.BuildCache {
		if cache.Shared {
			continue // counted already under the record that owns it
		}
		out.BuildCacheBytes += cache.Size
		if !cache.InUse {
			out.BuildCacheReclaimableBytes += cache.Size
		}
	}
	return out
}

// Image is one image on this server, as the Engine lists it.
type Image struct {
	ID        string
	RepoTags  []string
	SizeBytes int64
}

// ListImages lists every image on this server, tagged or not.
func (c *Client) ListImages(ctx context.Context) ([]Image, error) {
	var raw []struct {
		ID       string   `json:"Id"`
		RepoTags []string `json:"RepoTags"`
		Size     int64    `json:"Size"`
	}
	if err := c.do(ctx, http.MethodGet, "/images/json", url.Values{"all": {"0"}}, nil, &raw); err != nil {
		return nil, err
	}
	out := make([]Image, 0, len(raw))
	for _, r := range raw {
		tags := make([]string, 0, len(r.RepoTags))
		for _, tag := range r.RepoTags {
			// Docker writes "<none>:<none>" for an image with no name.
			if tag != "" && tag != "<none>:<none>" {
				tags = append(tags, tag)
			}
		}
		out = append(out, Image{ID: r.ID, RepoTags: tags, SizeBytes: r.Size})
	}
	return out, nil
}

// ImagesOfContainers maps every container on this server — running, stopped
// or merely created — to the image it was made from. An image any of them
// references is in use, whoever created the container.
func (c *Client) ImagesOfContainers(ctx context.Context) (map[string]bool, error) {
	var raw []struct {
		ImageID string `json:"ImageID"`
		Image   string `json:"Image"`
	}
	if err := c.do(ctx, http.MethodGet, "/containers/json", url.Values{"all": {"1"}}, nil, &raw); err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, r := range raw {
		if r.ImageID != "" {
			out[r.ImageID] = true
		}
		if r.Image != "" {
			out[r.Image] = true
		}
	}
	return out, nil
}

// RemoveImage deletes one image by id. Force is never set: an image a
// container still references must stay, and the Engine saying so is one
// more check this does not have to get right by itself.
func (c *Client) RemoveImage(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/images/"+url.PathEscape(id),
		url.Values{"force": {"false"}, "noprune": {"false"}}, nil, nil)
}

// PruneBuildCache frees the Engine's own builder cache — derived data, and
// never an image anything could be rolled back to. `all` false keeps what a
// build is using right now.
func (c *Client) PruneBuildCache(ctx context.Context) (int64, error) {
	var out struct {
		SpaceReclaimed int64 `json:"SpaceReclaimed"`
	}
	if err := c.do(ctx, http.MethodPost, "/build/prune", url.Values{"all": {"false"}}, nil, &out); err != nil {
		return 0, err
	}
	return out.SpaceReclaimed, nil
}

// RemoveVolume deletes one named volume and everything in it.
//
// This is the only place the agent ever destroys data, and it refuses on
// three counts before it does: the volume must carry VDeploy's own label,
// it must belong to the project named, and `force` is never set — so a
// volume any container still references is the Engine's refusal, not this
// code's judgement.
func (c *Client) RemoveVolume(ctx context.Context, name, projectID string) error {
	if _, err := c.VolumeOf(ctx, name, projectID); err != nil {
		return err
	}
	return c.do(ctx, http.MethodDelete, "/volumes/"+url.PathEscape(name),
		url.Values{"force": {"false"}}, nil, nil)
}
