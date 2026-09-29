package docker

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
)

// fakeDocker serves a scripted Engine API on a unix socket.
func fakeDocker(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "docker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Skipf("unix sockets unavailable: %v", err)
	}
	server := httptest.NewUnstartedServer(handler)
	server.Listener = listener
	server.Start()
	t.Cleanup(server.Close)
	return New(socket)
}

func TestListManagedIgnoresUnlabelledContainersEvenIfTheFilterIsIgnored(t *testing.T) {
	client := fakeDocker(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.RawQuery, "io.vdeploy.managed") {
			t.Errorf("no label filter sent: %s", r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode([]map[string]any{
			{"Id": "a", "Names": []string{"/vd-x-v1-0"}, "State": "running", "Labels": map[string]string{compose.ManagedLabel: "true"}},
			{"Id": "b", "Names": []string{"/revoye-api"}, "State": "running", "Labels": map[string]string{}},
		})
	})
	got, err := client.ListManaged(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Name != "vd-x-v1-0" {
		t.Fatalf("listed %+v — a container the agent does not own leaked through", got)
	}
}

func TestCreateRequestIsHardenedAndCannotEscalate(t *testing.T) {
	body, err := json.Marshal(CreateRequest(compose.Container{
		Name: "vd-x-v1-0", Image: "nginx@sha256:" + strings.Repeat("a", 64),
		Env: []string{"A=1"}, Network: "vd-x", MemoryBytes: 256 << 20, NanoCPUs: 5e8,
		PidsLimit: compose.PidsLimit, StopTimeout: 30, RestartPolicy: "unless-stopped", Port: 80,
		Volumes: []compose.Mount{{Volume: "vd-x-data", Target: "/data"}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, forbidden := range []string{
		"Privileged", "CapAdd", "Devices", "Sysctls", "Binds", "PidMode", "IpcMode", "UsernsMode", "docker.sock",
	} {
		if strings.Contains(text, forbidden) {
			t.Errorf("create request contains %s: %s", forbidden, text)
		}
	}
	for _, required := range []string{
		`"Memory":268435456`, `"MemorySwap":268435456`, `"PidsLimit":4096`, `"no-new-privileges:true"`,
		`"max-size":"10m"`, `"max-file":"3"`, `"NetworkMode":"vd-x"`, `"Type":"volume"`, `"80/tcp"`,
	} {
		if !strings.Contains(text, required) {
			t.Errorf("create request lacks %s: %s", required, text)
		}
	}
}

func TestEnsureNetworkCreatesOnlyWhenMissing(t *testing.T) {
	var created int
	client := fakeDocker(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/networks/vd-new"):
			w.WriteHeader(http.StatusNotFound)
		case r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{}`))
		case r.URL.Path == "/"+APIVersion+"/networks/create":
			created++
			_, _ = w.Write([]byte(`{"Id":"n"}`))
		}
	})
	ctx := context.Background()
	if err := client.EnsureNetwork(ctx, "vd-existing", "prj_x"); err != nil {
		t.Fatal(err)
	}
	if err := client.EnsureNetwork(ctx, "vd-new", "prj_x"); err != nil {
		t.Fatal(err)
	}
	if created != 1 {
		t.Fatalf("created %d networks, want 1", created)
	}
}

func TestEngineErrorsCarryStatusAndMessage(t *testing.T) {
	client := fakeDocker(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"message":"name already in use"}`))
	})
	_, err := client.Create(context.Background(), compose.Container{Name: "vd-x"})
	if err == nil || !strings.Contains(err.Error(), "409 name already in use") {
		t.Fatalf("err = %v", err)
	}
}

func TestOnlyAnOpenedDatabaseIsPublishedOnTheServer(t *testing.T) {
	app, _ := json.Marshal(CreateRequest(compose.Container{Name: "vd-x-v1-0", Image: "nginx", Port: 80}))
	if strings.Contains(string(app), "PortBindings") {
		t.Fatalf("an app container asked for a port on the server: %s", app)
	}
	db, _ := json.Marshal(CreateRequest(compose.Container{Name: "vd-db-x", Image: "postgres", Port: 5432, HostPort: 15432}))
	if !strings.Contains(string(db), `"PortBindings":{"5432/tcp":[{"HostPort":"15432"}]}`) {
		t.Fatalf("an opened database is not published as asked: %s", db)
	}
}
