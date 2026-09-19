package compose

import (
	"strings"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

func project() spec.DesiredProject {
	p := spec.DesiredProject{
		ProjectID:      "prj_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		ReleaseID:      "rel_01J9Z3Q8S7M2K4X6V1B5N0C9D8",
		ReleaseVersion: 3,
		Image:          "nginx@sha256:" + strings.Repeat("a", 64),
		Running:        true,
	}
	p.Spec.Runtime = spec.Runtime{
		Replicas:        2,
		Command:         []string{"nginx", "-g", "daemon off;"},
		RestartPolicy:   "unless-stopped",
		StopGracePeriod: "45s",
		Env:             []spec.EnvVar{{Key: "MODE", Value: "production"}},
	}
	p.Spec.Runtime.Resources.Memory.Limit = "512Mi"
	p.Spec.Runtime.Resources.CPU.Limit = 0.5
	p.Spec.Network = &spec.Network{ContainerPort: 80}
	return p
}

func TestPlanHardensEveryReplica(t *testing.T) {
	containers, err := Plan(project())
	if err != nil {
		t.Fatal(err)
	}
	if len(containers) != 2 {
		t.Fatalf("want 2 replicas, got %d", len(containers))
	}
	for i, c := range containers {
		if c.MemoryBytes != 512<<20 {
			t.Errorf("replica %d memory = %d", i, c.MemoryBytes)
		}
		if c.NanoCPUs != 500_000_000 {
			t.Errorf("replica %d cpus = %d", i, c.NanoCPUs)
		}
		if c.PidsLimit != PidsLimit {
			t.Errorf("replica %d pids limit = %d", i, c.PidsLimit)
		}
		if c.Network != "vd-01j9z3q8s7m2k4x6v1b5n0c9d8" {
			t.Errorf("replica %d network = %s", i, c.Network)
		}
		if c.Labels[ManagedLabel] != "true" || c.Labels[ProjectLabel] != "prj_01J9Z3Q8S7M2K4X6V1B5N0C9D8" {
			t.Errorf("replica %d labels = %v", i, c.Labels)
		}
		if c.StopTimeout != 45 {
			t.Errorf("replica %d stop timeout = %d", i, c.StopTimeout)
		}
	}
	if containers[0].Name == containers[1].Name {
		t.Error("replicas share a name")
	}
}

func TestPlanMountsOnlyNamedVolumes(t *testing.T) {
	p := project()
	p.Spec.Runtime.Replicas = 1
	p.Spec.Runtime.Volumes = []spec.Volume{{Name: "uploads", MountPath: "/app/uploads"}}
	containers, err := Plan(p)
	if err != nil {
		t.Fatal(err)
	}
	want := Mount{Volume: "vd-01j9z3q8s7m2k4x6v1b5n0c9d8-uploads", Target: "/app/uploads"}
	if got := containers[0].Volumes; len(got) != 1 || got[0] != want {
		t.Fatalf("mounts = %v, want %v", got, want)
	}
}

func TestPlanRefusesWithoutMemoryLimit(t *testing.T) {
	p := project()
	p.Spec.Runtime.Resources.Memory.Limit = ""
	if _, err := Plan(p); err == nil {
		t.Fatal("planned a container with no memory limit")
	}
}
