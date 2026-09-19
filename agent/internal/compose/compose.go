// Package compose turns a validated project into the containers the agent
// will run. This is the only place container settings are decided, and they
// are decided here, by the agent — never taken from the control plane.
package compose

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/guard"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// Labels on everything the agent creates. The agent only ever touches
// containers, volumes and networks carrying ManagedLabel: anything else on
// the server — including pre-existing containers — is invisible to it.
const (
	ManagedLabel = "io.vdeploy.managed"
	ProjectLabel = "io.vdeploy.project"
	ReleaseLabel = "io.vdeploy.release"
	ReplicaLabel = "io.vdeploy.replica"
)

// Container is everything needed to create one replica. There is no field
// for privileges, capabilities, devices, sysctls, host namespaces or host
// paths: the agent cannot express them, so it can never be asked to.
type Container struct {
	Name          string
	Image         string
	Cmd           []string
	User          string
	Env           []string
	Labels        map[string]string
	Network       string
	Volumes       []Mount
	MemoryBytes   int64
	NanoCPUs      int64
	PidsLimit     int64
	StopTimeout   int
	RestartPolicy string
	Port          int
}

// Mount attaches a named volume the agent owns.
type Mount struct {
	Volume string
	Target string
}

// Fixed hardening for every container (§18, §19).
const (
	// PidsLimit stops a fork bomb inside one app from exhausting the host.
	PidsLimit = 4096
	// LogMaxSize and LogMaxFiles cap Docker's own log files: unbounded logs are
	// the most common cause of a dead VPS.
	LogMaxSize  = "10m"
	LogMaxFiles = "3"
	// OomScoreAdj makes the kernel kill app containers before the agent and Traefik.
	OomScoreAdj = 500
)

// ProjectKey is the short, name-safe form of a project id.
func ProjectKey(projectID string) string {
	return strings.ToLower(strings.TrimPrefix(projectID, "prj_"))
}

// NetworkName is the project's own network: projects cannot reach each other.
func NetworkName(projectID string) string {
	return "vd-" + ProjectKey(projectID)
}

// VolumeName is the named volume behind a permanent folder.
func VolumeName(projectID, name string) string {
	return "vd-" + ProjectKey(projectID) + "-" + name
}

// Plan composes the replicas of a project that already passed guard.Check.
func Plan(p spec.DesiredProject) ([]Container, error) {
	rt := p.Spec.Runtime
	memory, ok := guard.MemoryBytes(rt.Resources.Memory.Limit)
	if !ok {
		return nil, fmt.Errorf("project %s has no memory limit", p.ProjectID)
	}
	grace, err := time.ParseDuration(rt.StopGracePeriod)
	if err != nil {
		grace = 30 * time.Second
	}
	env := make([]string, 0, len(rt.Env))
	for _, e := range rt.Env {
		env = append(env, e.Key+"="+e.Value)
	}
	mounts := make([]Mount, 0, len(rt.Volumes))
	for _, v := range rt.Volumes {
		mounts = append(mounts, Mount{Volume: VolumeName(p.ProjectID, v.Name), Target: v.MountPath})
	}
	port := 0
	if p.Spec.Network != nil {
		port = p.Spec.Network.ContainerPort
	}
	replicas := make([]Container, 0, rt.Replicas)
	for i := range rt.Replicas {
		replicas = append(replicas, Container{
			Name:    fmt.Sprintf("vd-%s-v%d-r%d-%d", ProjectKey(p.ProjectID), p.ReleaseVersion, p.Revision, i),
			Image:   p.Image,
			Cmd:     rt.Command,
			User:    rt.User,
			Env:     env,
			Network: NetworkName(p.ProjectID),
			Volumes: mounts,
			Labels: map[string]string{
				ManagedLabel: "true",
				ProjectLabel: p.ProjectID,
				ReleaseLabel: p.ReleaseID,
				ReplicaLabel: strconv.Itoa(i),
			},
			MemoryBytes:   memory,
			NanoCPUs:      int64(rt.Resources.CPU.Limit * 1e9),
			PidsLimit:     PidsLimit,
			StopTimeout:   int(grace.Seconds()),
			RestartPolicy: rt.RestartPolicy,
			Port:          port,
		})
	}
	return replicas, nil
}
