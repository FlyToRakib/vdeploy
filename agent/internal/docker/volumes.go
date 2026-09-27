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
