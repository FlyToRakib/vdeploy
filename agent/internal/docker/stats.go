package docker

import (
	"context"
	"net/http"
	"net/url"
)

// Stats is one container's resource use, as the Engine reports it.
type Stats struct {
	CPUPercent  float64
	MemoryBytes int64
	MemoryLimit int64
	RxBytes     int64
	TxBytes     int64
}

// statsBody is the shape the Engine answers with; only what is used is named.
type statsBody struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage  int64   `json:"total_usage"`
			PerCPUUsage []int64 `json:"percpu_usage"`
		} `json:"cpu_usage"`
		SystemUsage int64 `json:"system_cpu_usage"`
		OnlineCPUs  int   `json:"online_cpus"`
	} `json:"cpu_stats"`
	PreCPUStats struct {
		CPUUsage struct {
			TotalUsage int64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemUsage int64 `json:"system_cpu_usage"`
	} `json:"precpu_stats"`
	MemoryStats struct {
		Usage int64            `json:"usage"`
		Limit int64            `json:"limit"`
		Stats map[string]int64 `json:"stats"`
	} `json:"memory_stats"`
	Networks map[string]struct {
		RxBytes int64 `json:"rx_bytes"`
		TxBytes int64 `json:"tx_bytes"`
	} `json:"networks"`
}

/*
ContainerStats is one reading of what a container is using. It asks for a
single sample rather than a stream: a graph wants a point every half minute,
not a firehose, and an open stream per container would cost more than the
numbers are worth.
*/
func (c *Client) ContainerStats(ctx context.Context, id string) (Stats, error) {
	var body statsBody
	query := url.Values{"stream": {"false"}, "one-shot": {"false"}}
	if err := c.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(id)+"/stats", query, nil, &body); err != nil {
		return Stats{}, err
	}
	return readStats(body), nil
}

// readStats turns the Engine's counters into the numbers people read.
func readStats(body statsBody) Stats {
	out := Stats{
		MemoryBytes: body.MemoryStats.Usage,
		MemoryLimit: body.MemoryStats.Limit,
	}
	// Page cache is not what an app is using: Docker's own `stats` subtracts
	// it, and a memory graph that counts it frightens people for no reason.
	if cache, ok := body.MemoryStats.Stats["inactive_file"]; ok && cache <= out.MemoryBytes {
		out.MemoryBytes -= cache
	}
	cpuDelta := float64(body.CPUStats.CPUUsage.TotalUsage - body.PreCPUStats.CPUUsage.TotalUsage)
	systemDelta := float64(body.CPUStats.SystemUsage - body.PreCPUStats.SystemUsage)
	cpus := body.CPUStats.OnlineCPUs
	if cpus == 0 {
		cpus = len(body.CPUStats.CPUUsage.PerCPUUsage)
	}
	if cpuDelta > 0 && systemDelta > 0 && cpus > 0 {
		out.CPUPercent = (cpuDelta / systemDelta) * float64(cpus) * 100
	}
	for _, net := range body.Networks {
		out.RxBytes += net.RxBytes
		out.TxBytes += net.TxBytes
	}
	return out
}
