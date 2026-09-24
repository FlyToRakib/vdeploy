package guard

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// The adversarial suite (§34.2): a hostile control plane sends frames built
// to escape onto the host. Every one must be refused. A case that is ever
// admitted is a breach, not a bug.

var testPolicy = Policy{
	AllowedRegistries: []string{"docker.io", "ghcr.io"},
	MaxMemoryBytes:    4 << 30,
	MaxCPUs:           2,
}

func validFrame(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile("testdata/valid_frame.json")
	if err != nil {
		t.Fatal(err)
	}
	var frame map[string]any
	if err := json.Unmarshal(raw, &frame); err != nil {
		t.Fatal(err)
	}
	return frame
}

func project(frame map[string]any) map[string]any {
	return frame["projects"].([]any)[0].(map[string]any)
}

func appSpec(frame map[string]any) map[string]any { return project(frame)["spec"].(map[string]any) }

func runtime(frame map[string]any) map[string]any {
	return appSpec(frame)["runtime"].(map[string]any)
}

func volume(frame map[string]any) map[string]any {
	return runtime(frame)["volumes"].([]any)[0].(map[string]any)
}

func digest(ref string) string { return ref + "@sha256:" + strings.Repeat("b", 64) }

func admit(t *testing.T, frame map[string]any) error {
	t.Helper()
	raw, err := json.Marshal(frame)
	if err != nil {
		t.Fatal(err)
	}
	_, err = Admit(raw, testPolicy)
	return err
}

func TestValidFrameIsAdmitted(t *testing.T) {
	if err := admit(t, validFrame(t)); err != nil {
		t.Fatalf("valid frame refused: %v", err)
	}
}

func TestHostileFramesAreRefused(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(f map[string]any)
		reason string // a fragment of the expected refusal
	}{
		// Container settings the agent must never accept from anyone.
		{"privileged at frame level", func(f map[string]any) { f["hostConfig"] = map[string]any{"Privileged": true} }, "contract"},
		{"privileged on a project", func(f map[string]any) { project(f)["privileged"] = true }, "contract"},
		{"privileged in runtime", func(f map[string]any) { runtime(f)["privileged"] = true }, "contract"},
		{"added capabilities", func(f map[string]any) { runtime(f)["capAdd"] = []any{"SYS_ADMIN"} }, "contract"},
		{"security options", func(f map[string]any) { runtime(f)["securityOpt"] = []any{"apparmor=unconfined"} }, "contract"},
		{"devices", func(f map[string]any) { runtime(f)["devices"] = []any{"/dev/sda:/dev/sda"} }, "contract"},
		{"sysctls", func(f map[string]any) { runtime(f)["sysctls"] = map[string]any{"kernel.panic": "1"} }, "contract"},
		{"host network", func(f map[string]any) { appSpec(f)["network"].(map[string]any)["networkMode"] = "host" }, "contract"},
		{"container network", func(f map[string]any) { runtime(f)["networkMode"] = "container:revoye-api" }, "contract"},
		{"host pid namespace", func(f map[string]any) { runtime(f)["pidMode"] = "host" }, "contract"},
		{"host ipc namespace", func(f map[string]any) { runtime(f)["ipcMode"] = "host" }, "contract"},
		{"docker socket bind", func(f map[string]any) {
			runtime(f)["binds"] = []any{"/var/run/docker.sock:/var/run/docker.sock"}
		}, "contract"},
		{"root filesystem bind", func(f map[string]any) { runtime(f)["binds"] = []any{"/:/host"} }, "contract"},
		{"host path on a volume", func(f map[string]any) { volume(f)["hostPath"] = "/etc" }, "contract"},
		{"docker socket as volume source", func(f map[string]any) { volume(f)["source"] = "/var/run/docker.sock" }, "contract"},
		{"unknown field deep in the spec", func(f map[string]any) { appSpec(f)["metadata"].(map[string]any)["x"] = 1 }, "contract"},

		// Paths and names.
		{"mount path traversal", func(f map[string]any) { volume(f)["mountPath"] = "/app/../../etc" }, "absolute and clean"},
		{"relative mount path", func(f map[string]any) { volume(f)["mountPath"] = "app/data" }, "contract"},
		{"mount over proc", func(f map[string]any) { volume(f)["mountPath"] = "/proc/self" }, "system directory"},
		{"mount over root", func(f map[string]any) { volume(f)["mountPath"] = "/" }, "system directory"},
		{"volume name traversal", func(f map[string]any) { volume(f)["name"] = "../../etc" }, "contract"},
		{"project id traversal", func(f map[string]any) { project(f)["projectId"] = "prj_../../../../etc/passwd" }, "contract"},

		// Images.
		{"mutable tag", func(f map[string]any) { project(f)["image"] = "nginx:latest" }, "contract"},
		{"foreign registry", func(f map[string]any) { project(f)["image"] = digest("evil.example.com/miner") }, "not allowed"},
		{"lookalike registry", func(f map[string]any) { project(f)["image"] = digest("docker.io.evil.com/nginx") }, "not allowed"},
		{"local registry by port", func(f map[string]any) { project(f)["image"] = digest("localhost:5000/x") }, "not allowed"},

		// Resource limits.
		{"missing memory limit", func(f map[string]any) {
			delete(runtime(f)["resources"].(map[string]any)["memory"].(map[string]any), "limit")
		}, "contract"},
		{"memory beyond the server", func(f map[string]any) {
			runtime(f)["resources"].(map[string]any)["memory"].(map[string]any)["limit"] = "1Ti"
		}, "exceeds"},
		{"memory below the floor", func(f map[string]any) {
			runtime(f)["resources"].(map[string]any)["memory"] = map[string]any{"request": "8Mi", "limit": "16Mi"}
		}, "below 32Mi"},
		{"cpu beyond the server", func(f map[string]any) {
			runtime(f)["resources"].(map[string]any)["cpu"] = map[string]any{"request": 1, "limit": 32}
		}, "CPU limit"},
		{"replicas sharing a permanent folder", func(f map[string]any) { runtime(f)["replicas"] = 2 }, "permanent folder"},

		// Payloads.
		{"secret reference without a delivered value", func(f map[string]any) {
			ref := "sec_01J9Z3Q8S7M2K4X6V1B5N0C9D8" // #nosec G101 -- an id, not a credential
			runtime(f)["env"] = []any{map[string]any{"key": "DB", "secretRef": ref}}
		}, "not delivered"},
		{"env key with equals", func(f map[string]any) {
			runtime(f)["env"] = []any{map[string]any{"key": "A=B", "value": "x"}}
		}, "contract"},
		{"NUL in env value", func(f map[string]any) {
			runtime(f)["env"] = []any{map[string]any{"key": "A", "value": "x\x00y"}}
		}, "malformed"},
		{"NUL in command", func(f map[string]any) { runtime(f)["command"] = []any{"sh", "-c\x00rm"} }, "NUL"},

		// Hostnames: they are spliced into Traefik rules, and routing is a trust boundary.
		{"rule injection in the instant host", func(f map[string]any) {
			project(f)["hosts"].(map[string]any)["instant"] = "a.example.com`) || Host(`victim.example.com"
		}, "contract"},
		{"rule injection in a redirect", func(f map[string]any) {
			project(f)["hosts"].(map[string]any)["redirects"] = []any{"x.io`) || PathPrefix(`/"}
		}, "contract"},
		{"another project's hostname", func(f map[string]any) {
			var twin map[string]any
			raw, _ := json.Marshal(project(f))
			_ = json.Unmarshal(raw, &twin)
			twin["projectId"] = "prj_01J9Z3Q8S7M2K4X6V1B5N0C9ZZ"
			twin["hosts"] = map[string]any{
				"instant": "evil.8-8-4-4.sslip.io", "redirects": []any{"blog.8-8-4-4.sslip.io"}, "verified": []any{},
			}
			f["projects"] = append(f["projects"].([]any), twin)
		}, "already routed"},

		// Protocol.
		{"future protocol", func(f map[string]any) { f["protocol"] = 3 }, "contract"},
		{"future spec version", func(f map[string]any) { appSpec(f)["apiVersion"] = "vdeploy/v2" }, "contract"},
		{"negative generation", func(f map[string]any) { f["generation"] = -1 }, "contract"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			frame := validFrame(t)
			tc.mutate(frame)
			err := admit(t, frame)
			if err == nil {
				t.Fatalf("BREACH: hostile frame %q was admitted", tc.name)
			}
			if !strings.Contains(err.Error(), tc.reason) {
				t.Fatalf("refused for the wrong reason: want %q in %v", tc.reason, err)
			}
		})
	}
}

func TestEveryRefusalIsReportedAtOnce(t *testing.T) {
	frame := validFrame(t)
	project(frame)["image"] = digest("evil.example.com/x")
	runtime(frame)["replicas"] = 3
	err := admit(t, frame)
	if err == nil || !strings.Contains(err.Error(), "not allowed") ||
		!strings.Contains(err.Error(), "permanent folder") {
		t.Fatalf("want both refusals, got %v", err)
	}
}

func TestNotJSON(t *testing.T) {
	if _, err := Admit([]byte("{not json"), testPolicy); err == nil {
		t.Fatal("garbage admitted")
	}
}

func TestRegistry(t *testing.T) {
	cases := map[string]string{
		digest("nginx"):                       "docker.io",
		digest("library/nginx"):               "docker.io",
		digest("ghcr.io/acme/app"):            "ghcr.io",
		digest("registry.example.com:5000/a"): "registry.example.com:5000",
		digest("localhost/a"):                 "localhost",
	}
	for image, want := range cases {
		if got := Registry(image); got != want {
			t.Errorf("Registry(%s) = %s, want %s", image, got, want)
		}
	}
}
