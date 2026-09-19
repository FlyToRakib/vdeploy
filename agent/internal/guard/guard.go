// Package guard is L6 (§8): the agent's own refusals. It assumes the control
// plane is hostile. Whatever arrives, the agent refuses anything that could
// reach the host — a stolen API token or a compromised control plane must
// still be unable to root this server.
package guard

import (
	"errors"
	"fmt"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// Policy is local to this server, set at install time. It never comes from
// the control plane: a compromised control plane cannot widen it.
type Policy struct {
	// AllowedRegistries are the registries images may come from ("docker.io", "ghcr.io").
	AllowedRegistries []string
	// MaxMemoryBytes is the most memory one container may be given.
	MaxMemoryBytes int64
	// MaxCPUs is the most CPU one container may be given.
	MaxCPUs float64
}

// Refusal lists every reason a project was refused, so one round trip shows them all.
type Refusal struct {
	ProjectID string
	Reasons   []string
}

func (r *Refusal) Error() string {
	return fmt.Sprintf("project %s refused: %s", r.ProjectID, strings.Join(r.Reasons, "; "))
}

var (
	pinnedImage = regexp.MustCompile(`^(?:([a-z0-9.-]+(?::[0-9]{1,5})?)/)?([a-z0-9]+(?:[._/-][a-z0-9]+)*)@sha256:[0-9a-f]{64}$`)
	localImage  = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	memoryQty   = regexp.MustCompile(`^([1-9][0-9]{0,6})(Ki|Mi|Gi|Ti)$`)
)

// Paths inside a container a volume may never cover: the kernel's views of
// the container. Volumes are always named volumes, so no mount path can
// reach the host; these would only break the container in confusing ways.
var forbiddenMounts = []string{"/", "/proc", "/sys", "/dev"}

const minMemoryBytes = 32 << 20

// Registry returns the registry host of an image reference ("docker.io" when none is named).
func Registry(image string) string {
	m := pinnedImage.FindStringSubmatch(image)
	if m == nil || m[1] == "" {
		return "docker.io"
	}
	host := m[1]
	if !strings.ContainsAny(host, ".:") && host != "localhost" {
		return "docker.io" // "library/nginx": the first segment is a namespace, not a host
	}
	return host
}

// MemoryBytes parses a binary memory quantity ("512Mi").
func MemoryBytes(quantity string) (int64, bool) {
	m := memoryQty.FindStringSubmatch(quantity)
	if m == nil {
		return 0, false
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return 0, false
	}
	shift := map[string]uint{"Ki": 10, "Mi": 20, "Gi": 30, "Ti": 40}[m[2]]
	return n << shift, true
}

// Check applies every L6 rule to one project and returns a *Refusal, or nil.
func Check(p spec.DesiredProject, policy Policy) error {
	var reasons []string
	refuse := func(format string, args ...any) {
		reasons = append(reasons, fmt.Sprintf(format, args...))
	}

	switch {
	case localImage.MatchString(p.Image):
		// Built on this server: never pulled, and the reconciler runs it only
		// if its own record says this agent built it for this project.
	case !pinnedImage.MatchString(p.Image):
		refuse("image %q is not pinned by digest", p.Image)
	default:
		if registry := Registry(p.Image); !slices.Contains(policy.AllowedRegistries, registry) {
			refuse("registry %q is not allowed on this server", registry)
		}
	}

	rt := p.Spec.Runtime
	limit, ok := MemoryBytes(rt.Resources.Memory.Limit)
	switch {
	case !ok:
		refuse("a memory limit is required")
	case limit < minMemoryBytes:
		refuse("memory limit %s is below 32Mi", rt.Resources.Memory.Limit)
	case limit > policy.MaxMemoryBytes:
		refuse("memory limit %s exceeds what this server allows", rt.Resources.Memory.Limit)
	}
	if rt.Resources.CPU.Limit <= 0 || rt.Resources.CPU.Limit > policy.MaxCPUs {
		refuse("CPU limit %.2f is outside what this server allows", rt.Resources.CPU.Limit)
	}
	if rt.Replicas < 0 || rt.Replicas > 64 {
		refuse("replicas %d is outside 0-64", rt.Replicas)
	}
	if len(rt.Volumes) > 0 && rt.Replicas > 1 {
		refuse("more than one replica cannot share a permanent folder")
	}
	for _, v := range rt.Volumes {
		clean := path.Clean(v.MountPath)
		switch {
		case !path.IsAbs(v.MountPath) || clean != v.MountPath:
			refuse("mount path %q must be absolute and clean", v.MountPath)
		case slices.ContainsFunc(forbiddenMounts, func(f string) bool {
			return clean == f || (f != "/" && strings.HasPrefix(clean, f+"/"))
		}):
			refuse("mount path %q covers a system directory", v.MountPath)
		}
	}
	delivered := map[string]bool{}
	for _, s := range p.Secrets {
		delivered[s.ID] = true
	}
	for _, e := range rt.Env {
		if e.SecretRef != "" && !delivered[e.SecretRef] {
			refuse("secret %s for %s was not delivered to this server", e.SecretRef, e.Key)
		}
		if strings.ContainsRune(e.Value, 0) || strings.ContainsAny(e.Key, "=\x00") {
			refuse("environment variable %q is malformed", e.Key)
		}
	}
	for _, arg := range rt.Command {
		if strings.ContainsRune(arg, 0) {
			refuse("command contains a NUL byte")
		}
	}

	if len(reasons) > 0 {
		return &Refusal{ProjectID: p.ProjectID, Reasons: reasons}
	}
	return nil
}

// sharedHosts refuses any hostname two projects claim: traffic for one
// project must never be routable to another.
func sharedHosts(projects []spec.DesiredProject) []error {
	owner := map[string]string{}
	var refusals []error
	for _, p := range projects {
		hosts := append([]string{p.Hosts.Instant}, p.Hosts.Redirects...)
		if p.Spec.Network != nil {
			for _, d := range p.Spec.Network.Domains {
				hosts = append(hosts, d.Host)
			}
		}
		for _, host := range hosts {
			other, taken := owner[host]
			switch {
			case host == "":
			case !taken:
				owner[host] = p.ProjectID
			case other != p.ProjectID:
				refusals = append(refusals, &Refusal{ProjectID: p.ProjectID, Reasons: []string{
					"hostname " + host + " is already routed to project " + other,
				}})
			}
		}
	}
	return refusals
}

// Admit is the agent's only intake for desired state: strict contract
// validation, then every L6 rule on every project. All refusals are reported.
func Admit(frame []byte, policy Policy) (*spec.DesiredState, error) {
	state, err := spec.Decode(frame)
	if err != nil {
		return nil, fmt.Errorf("refused: %w", err)
	}
	var refusals []error
	for _, p := range state.Projects {
		if err := Check(p, policy); err != nil {
			refusals = append(refusals, err)
		}
	}
	refusals = append(refusals, sharedHosts(state.Projects)...)
	if len(refusals) > 0 {
		return nil, errors.Join(refusals...)
	}
	return state, nil
}
