package reconcile

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

func TestDecodesProcSocketAddresses(t *testing.T) {
	for field, want := range map[string]string{
		"0100007F:0BB8":                         "127.0.0.1:3000",
		"00000000:1F90":                         "0.0.0.0:8080",
		"00000000000000000000000001000000:0050": "[::1]:80",
		"00000000000000000000000000000000:0BB8": "[::]:3000",
	} {
		got, ok := decodeAddress(field)
		if !ok || got != want {
			t.Errorf("%s = %q, want %q", field, got, want)
		}
	}
	if _, ok := decodeAddress("zz:0BB8"); ok {
		t.Error("decoded garbage")
	}
}

func TestReadsOnlyListeningSockets(t *testing.T) {
	proc := t.TempDir()
	old := ProcRoot
	ProcRoot = proc
	t.Cleanup(func() { ProcRoot = old })
	dir := filepath.Join(proc, "42", "net")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	tcp := "  sl  local_address rem_address   st\n" +
		"   0: 0100007F:0BB8 00000000:0000 0A\n" + // listening on 127.0.0.1:3000
		"   1: 0100007F:0BB8 0100007F:D4C2 01\n" // an established connection, not listening
	if err := os.WriteFile(filepath.Join(dir, "tcp"), []byte(tcp), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := listening(42)
	if err != nil || !slices.Equal(got, []string{"127.0.0.1:3000"}) {
		t.Fatalf("listening = %v, %v", got, err)
	}
}

type fakeInspector struct {
	facts  docker.ContainerFacts
	output string
	calls  int
}

func (f *fakeInspector) Facts(context.Context, string) (docker.ContainerFacts, error) {
	f.calls++
	return f.facts, nil
}

func (f *fakeInspector) LastOutput(context.Context, string, int) (string, error) {
	return f.output, nil
}

func TestEvidenceIsGatheredForReplicasThatAreNotServing(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	inspector := &fakeInspector{
		facts:  docker.ContainerFacts{Running: false, ExitCode: 1, Restarts: 4},
		output: "Error: DATABASE_URL is not set\n",
	}
	r.Inspector = inspector
	r.Prober = &fakeProber{healthy: map[string]bool{}} // never becomes healthy
	p := routedProject(1)                              // two replicas
	reconcile(t, r, desired(1, p))
	advance(61 * time.Second) // past the startup window: unhealthy
	report := reconcile(t, r, desired(1, p))
	evidence := report.Projects[0].Evidence
	if len(evidence) != 2 || evidence[0].ExitCode == nil || *evidence[0].ExitCode != 1 ||
		evidence[0].Restarts != 4 || evidence[0].LastOutput == "" {
		t.Fatalf("evidence = %+v", evidence)
	}
	calls := inspector.calls
	// Looked at again only after a while.
	reconcile(t, r, desired(1, p))
	if inspector.calls != calls {
		t.Fatalf("inspected %d times, want %d", inspector.calls, calls)
	}
	advance(evidenceEvery)
	reconcile(t, r, desired(1, p))
	if inspector.calls != calls+2 {
		t.Fatalf("inspected %d times, want %d", inspector.calls, calls+2)
	}
}

func TestEvidenceIsTakenAgainWhenAReplicaFails(t *testing.T) {
	engine := newFake()
	r := newReconciler(engine)
	inspector := &fakeInspector{facts: docker.ContainerFacts{Running: true}}
	r.Inspector = inspector
	r.Prober = &fakeProber{healthy: map[string]bool{}}
	p := routedProject(1)
	reconcile(t, r, desired(1, p)) // starting: evidence taken
	starting := inspector.calls
	advance(61 * time.Second) // now unhealthy, well within evidenceEvery of nothing else
	r.evidence = map[string]evidenceCache{}
	for name := range r.ready {
		r.evidence[name] = evidenceCache{at: clock, evidence: ReplicaEvidence{State: StateStarting}}
	}
	reconcile(t, r, desired(1, p))
	if inspector.calls <= starting {
		t.Fatal("the failed replica was not looked at again")
	}
}
