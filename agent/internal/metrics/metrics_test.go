package metrics

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

// fakeEngine answers with a fixed reading per container.
type fakeEngine struct {
	stats map[string]docker.Stats
	asked []string
	err   error
}

func (f *fakeEngine) ContainerStats(_ context.Context, id string) (docker.Stats, error) {
	f.asked = append(f.asked, id)
	if f.err != nil {
		return docker.Stats{}, f.err
	}
	return f.stats[id], nil
}

const projectID = "prj_01J9Z3Q8S7M2K4X6V1B5N0C9D8"

func replica(id, state string) docker.Container {
	return docker.Container{
		ID:     id,
		Name:   "vd-" + id,
		State:  state,
		Labels: map[string]string{"io.vdeploy.project": projectID},
	}
}

func TestAnAppsUseIsTheSumOfItsCopies(t *testing.T) {
	engine := &fakeEngine{stats: map[string]docker.Stats{
		"a": {CPUPercent: 12.5, MemoryBytes: 100 << 20, MemoryLimit: 256 << 20, RxBytes: 10, TxBytes: 20},
		"b": {CPUPercent: 37.5, MemoryBytes: 150 << 20, MemoryLimit: 256 << 20, RxBytes: 5, TxBytes: 7},
	}}
	reader := &Reader{Engine: engine}
	usage := reader.Read(
		context.Background(),
		[]docker.Container{replica("a", "running"), replica("b", "running")},
		time.Now(),
	)
	if len(usage.Projects) != 1 {
		t.Fatalf("projects = %+v", usage.Projects)
	}
	got := usage.Projects[0]
	if got.CPUPercent != 50 || got.MemoryBytes != 250<<20 || got.Replicas != 2 {
		t.Fatalf("summed wrongly: %+v", got)
	}
	// The limit is what the copies are allowed together, which is what a
	// person compares the usage against.
	if got.MemoryLimit != 512<<20 || got.RxBytes != 15 || got.TxBytes != 27 {
		t.Fatalf("summed wrongly: %+v", got)
	}
}

func TestOnlyRunningCopiesOfManagedAppsAreMeasured(t *testing.T) {
	engine := &fakeEngine{stats: map[string]docker.Stats{"a": {CPUPercent: 1}}}
	reader := &Reader{Engine: engine}
	usage := reader.Read(context.Background(), []docker.Container{
		replica("a", "running"),
		replica("b", "exited"),
		{ID: "c", Name: "somebody-elses", State: "running", Labels: map[string]string{}},
	}, time.Now())
	if len(engine.asked) != 1 || engine.asked[0] != "a" {
		t.Fatalf("asked about %v", engine.asked)
	}
	if len(usage.Projects) != 1 || usage.Projects[0].Replicas != 1 {
		t.Fatalf("projects = %+v", usage.Projects)
	}
}

func TestOneContainerThatWillNotAnswerIsNotAFailedReading(t *testing.T) {
	engine := &fakeEngine{err: os.ErrDeadlineExceeded}
	reader := &Reader{Engine: engine}
	usage := reader.Read(
		context.Background(),
		[]docker.Container{replica("a", "running")},
		time.Now(),
	)
	if len(usage.Projects) != 0 {
		t.Fatalf("projects = %+v", usage.Projects)
	}
}

func TestTheFirstReadingReportsNoCpuRatherThanTheUptimeAverage(t *testing.T) {
	dir := t.TempDir()
	stat := filepath.Join(dir, "stat")
	write := func(idle, busy int) {
		line := "cpu  " + itoa(busy) + " 0 0 " + itoa(idle) + " 0 0 0 0 0 0\n"
		if err := os.WriteFile(stat, []byte(line), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	reader := &Reader{Engine: &fakeEngine{}, ProcStat: stat, Root: dir}

	write(1000, 1000)
	if got := reader.cpu(); got != 0 {
		t.Fatalf("the first reading invented a number: %v", got)
	}
	// Half the time since is busy, so the machine was half busy.
	write(1100, 1100)
	if got := reader.cpu(); got != 50 {
		t.Fatalf("cpu = %v", got)
	}
}

func TestMemoryIsWhatIsAvailableNotWhatIsFree(t *testing.T) {
	dir := t.TempDir()
	meminfo := filepath.Join(dir, "meminfo")
	// Cache is available, so a server with a big cache is not a full one.
	body := "MemTotal:       2048000 kB\nMemFree:          65536 kB\nMemAvailable:   1500000 kB\n"
	if err := os.WriteFile(meminfo, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	reader := &Reader{Engine: &fakeEngine{}, ProcMeminfo: meminfo}
	total, available := reader.memory()
	if total != 2048000*1024 || available != 1500000*1024 {
		t.Fatalf("total %d, available %d", total, available)
	}
}

func TestAReadingReadsPlainlyInALogLine(t *testing.T) {
	words := Words(Usage{Server: Server{
		CPUPercent:       42,
		MemoryUsedBytes:  1 << 30,
		MemoryTotalBytes: 2 << 30,
		DiskUsedBytes:    10 << 30,
		DiskTotalBytes:   40 << 30,
	}})
	for _, want := range []string{"cpu 42%", "1024 of 2048 MB", "10 of 40 GB"} {
		if !contains(words, want) {
			t.Fatalf("%q is not in %q", want, words)
		}
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var out []byte
	for n > 0 {
		out = append([]byte{byte('0' + n%10)}, out...)
		n /= 10
	}
	return string(out)
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
