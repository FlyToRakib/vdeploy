// Package compose turns a validated project into the containers the agent
// will run. This is the only place container settings are decided, and they
// are decided here, by the agent — never taken from the control plane.
package compose

import (
	"fmt"
	"slices"
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
		if e.SecretRef == "" { // secrets are opened only at creation: see SecretEnv
			env = append(env, e.Key+"="+e.Value)
		}
	}
	mounts := make([]Mount, 0, len(rt.Volumes))
	for _, v := range rt.Volumes {
		mounts = append(mounts, Mount{Volume: VolumeName(p.ProjectID, v.Name), Target: v.MountPath})
	}
	port := 0
	if p.Spec.Network != nil {
		port = p.Spec.Network.ContainerPort
	}
	// Most frameworks listen where PORT says; an app that sets its own keeps it.
	if port > 0 && !slices.ContainsFunc(rt.Env, func(e spec.EnvVar) bool { return e.Key == "PORT" }) {
		env = append(env, fmt.Sprintf("PORT=%d", port))
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

// SecretEnv opens a project's secret variables for one container creation.
// Values never go into a Container kept by the reconciler, and no error
// carries any part of one.
func SecretEnv(p spec.DesiredProject, open func(secretID string, version int, sealed string) (string, error)) ([]string, error) {
	var env []string
	for _, e := range p.Spec.Runtime.Env {
		if e.SecretRef == "" {
			continue
		}
		i := slices.IndexFunc(p.Secrets, func(s spec.Secret) bool { return s.ID == e.SecretRef })
		if i < 0 {
			return nil, fmt.Errorf("the value of %s was not delivered", e.Key)
		}
		s := p.Secrets[i]
		value, err := open(s.ID, s.Version, s.Sealed)
		if err != nil {
			return nil, fmt.Errorf("the value of %s could not be opened: %w", e.Key, err)
		}
		if strings.ContainsRune(value, 0) {
			return nil, fmt.Errorf("the value of %s contains a NUL byte", e.Key)
		}
		env = append(env, e.Key+"="+value)
	}
	return env, nil
}

// RoleLabel marks what a container is for; unset means an app replica.
const RoleLabel = "io.vdeploy.role"

// ReleaseName is the one-shot container that runs a release's release command.
func ReleaseName(p spec.DesiredProject) string {
	return fmt.Sprintf("vd-%s-v%d-release", ProjectKey(p.ProjectID), p.ReleaseVersion)
}

// ReleaseJob is the release command's container: a replica's image,
// environment, network, folders and limits, running the command once.
func ReleaseJob(p spec.DesiredProject, replica Container) Container {
	job := replica
	job.Name = ReleaseName(p)
	job.Cmd = p.Spec.Deploy.ReleaseCommand
	job.RestartPolicy = "no"
	job.Port = 0
	job.Labels = map[string]string{
		ManagedLabel: "true",
		ProjectLabel: p.ProjectID,
		ReleaseLabel: p.ReleaseID,
		RoleLabel:    "release",
	}
	return job
}
