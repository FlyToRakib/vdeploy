package preflight

import (
	"context"
	"errors"
	"testing"
)

type fakeHost struct {
	os, arch    string
	root        bool
	mem, swap   int64
	disk        int64
	busy        map[int]bool
	synced      bool
	cgroupV2    bool
	dockerVer   string
	dockerError error
}

func healthy() *fakeHost {
	return &fakeHost{
		os: "linux", arch: "amd64", root: true, mem: 2 * gib, swap: gib, disk: 40 * gib,
		busy: map[int]bool{}, synced: true, cgroupV2: true, dockerVer: "1.47",
	}
}

func (f *fakeHost) OS() string                          { return f.os }
func (f *fakeHost) Arch() string                        { return f.arch }
func (f *fakeHost) IsRoot() bool                        { return f.root }
func (f *fakeHost) MemoryBytes() (int64, int64, error)  { return f.mem, f.swap, nil }
func (f *fakeHost) FreeDiskBytes(string) (int64, error) { return f.disk, nil }
func (f *fakeHost) PortInUse(port int) bool             { return f.busy[port] }
func (f *fakeHost) ClockSynchronized() (bool, error)    { return f.synced, nil }
func (f *fakeHost) CgroupV2() bool                      { return f.cgroupV2 }
func (f *fakeHost) DockerAPIVersion(context.Context) (string, error) {
	return f.dockerVer, f.dockerError
}

func result(results []Result, id string) Result {
	for _, r := range results {
		if r.ID == id {
			return r
		}
	}
	return Result{}
}

func TestHealthyServerPasses(t *testing.T) {
	results := Run(context.Background(), healthy(), "/var/lib/vdeploy")
	for _, r := range results {
		if r.Status != Pass {
			t.Errorf("%s: %s %s", r.ID, r.Status, r.Message)
		}
	}
	if Failed(results) {
		t.Fatal("healthy server failed")
	}
}

func TestProblemsFailWithAFix(t *testing.T) {
	cases := []struct {
		name   string
		spoil  func(h *fakeHost)
		id     string
		status Status
	}{
		{"a laptop", func(h *fakeHost) { h.os = "darwin" }, "os", Fail},
		{"an odd cpu", func(h *fakeHost) { h.arch = "386" }, "arch", Fail},
		{"not root", func(h *fakeHost) { h.root = false }, "root", Fail},
		{"no docker", func(h *fakeHost) { h.dockerError = errors.New("no socket") }, "docker", Fail},
		{"old docker", func(h *fakeHost) { h.dockerVer = "1.41" }, "docker", Fail},
		{"512 MB box", func(h *fakeHost) { h.mem = 512 << 20 }, "memory", Fail},
		{"no swap", func(h *fakeHost) { h.swap = 0 }, "memory", Warn},
		{"full disk", func(h *fakeHost) { h.disk = gib }, "disk", Fail},
		{"small disk", func(h *fakeHost) { h.disk = 5 * gib }, "disk", Warn},
		{"nginx on 80", func(h *fakeHost) { h.busy[80] = true }, "ports", Fail},
		{"clock drift", func(h *fakeHost) { h.synced = false }, "clock", Warn},
		{"cgroup v1", func(h *fakeHost) { h.cgroupV2 = false }, "cgroup", Warn},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := healthy()
			tc.spoil(h)
			r := result(Run(context.Background(), h, "/"), tc.id)
			if r.Status != tc.status {
				t.Fatalf("%s = %s (%s)", tc.id, r.Status, r.Message)
			}
			if r.Status == Fail && r.Fix == "" {
				t.Fatalf("%s failed without telling the user how to fix it", tc.id)
			}
		})
	}
}

func TestCompareVersions(t *testing.T) {
	for _, tc := range []struct {
		a, b string
		want int
	}{{"1.44", "1.44", 0}, {"1.47", "1.44", 1}, {"1.9", "1.44", -1}, {"2", "1.99", 1}} {
		if got := compareVersions(tc.a, tc.b); got != tc.want {
			t.Errorf("compare(%s,%s) = %d", tc.a, tc.b, got)
		}
	}
}
