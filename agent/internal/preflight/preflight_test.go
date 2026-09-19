package preflight

import (
	"context"
	"errors"
	"strings"
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

type fakeMachine struct {
	id, version     string
	panels          []string
	laptop, desktop bool
	v4, v6          bool
	foreign         int
}

func (f *fakeMachine) OSRelease() (string, string) { return f.id, f.version }
func (f *fakeMachine) Panels() []string            { return f.panels }
func (f *fakeMachine) PortOwner(int) string        { return "" }
func (f *fakeMachine) ForeignContainers(context.Context) (int, error) {
	return f.foreign, nil
}
func (f *fakeMachine) PublicAddresses() (bool, bool) { return f.v4, f.v6 }
func (f *fakeMachine) Chassis() (bool, bool)         { return f.laptop, f.desktop }

func cleanServer() *fakeMachine {
	return &fakeMachine{id: "ubuntu", version: "24.04", v4: true}
}

func TestACleanServerPassesTheServerChecks(t *testing.T) {
	for _, r := range RunServer(context.Background(), cleanServer(), Options{}) {
		if r.Status != Pass {
			t.Errorf("%s: %s %s", r.ID, r.Status, r.Message)
		}
	}
}

func TestServerProblemsAreNamed(t *testing.T) {
	cases := []struct {
		name   string
		spoil  func(m *fakeMachine)
		id     string
		status Status
		says   string
	}{
		{"old ubuntu", func(m *fakeMachine) { m.version = "20.04" }, "distro", Fail, "Ubuntu 20.04 is too old"},
		{"centos", func(m *fakeMachine) { m.id, m.version = "centos", "7" }, "distro", Fail, "CentOS"},
		{"alpine", func(m *fakeMachine) { m.id, m.version = "alpine", "3.20" }, "distro", Fail, "Alpine"},
		{"untested distro", func(m *fakeMachine) { m.id, m.version = "arch", "" }, "distro", Warn, "not been tested"},
		{"cpanel", func(m *fakeMachine) { m.panels = []string{"cPanel"} }, "panel", Fail, "already runs cPanel"},
		{"a laptop", func(m *fakeMachine) { m.laptop = true }, "machine", Fail, "laptop"},
		{"a desktop session", func(m *fakeMachine) { m.desktop = true }, "machine", Warn, "desktop"},
		{"ipv6 only", func(m *fakeMachine) { m.v4, m.v6 = false, true }, "network", Warn, "only an IPv6"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := cleanServer()
			tc.spoil(m)
			for _, r := range RunServer(context.Background(), m, Options{}) {
				if r.ID != tc.id {
					continue
				}
				if r.Status != tc.status || !strings.Contains(r.Message, tc.says) {
					t.Fatalf("%s = %s %q", r.ID, r.Status, r.Message)
				}
				return
			}
			t.Fatalf("no %s check", tc.id)
		})
	}
}

func TestExistingContainersAreNotAProblem(t *testing.T) {
	m := cleanServer()
	m.foreign = 13
	for _, r := range RunServer(context.Background(), m, Options{}) {
		if r.ID == "containers" && (r.Status != Pass || !strings.Contains(r.Message, "never touches")) {
			t.Fatalf("%+v", r)
		}
	}
}

type namingHost struct{ *fakeHost }

func (namingHost) PortOwner(port int) string {
	if port == 80 {
		return "nginx"
	}
	return ""
}

func TestPortConflictNamesTheProgram(t *testing.T) {
	h := healthy()
	h.busy[80] = true
	r := checkPorts(namingHost{h})
	if r.Status != Fail || !strings.Contains(r.Message, "used by nginx") || !strings.Contains(r.Fix, "systemctl disable --now nginx") {
		t.Fatalf("%+v", r)
	}
}

func TestATestMachineCanAllowAnUnsupportedSystem(t *testing.T) {
	m := cleanServer()
	m.id, m.version = "alpine", "3.20"
	r := RunServer(context.Background(), m, Options{AllowUnsupportedOS: true})[0]
	if r.Status != Warn || !strings.Contains(r.Message, "allowUnsupportedOS") {
		t.Fatalf("%+v", r)
	}
}
