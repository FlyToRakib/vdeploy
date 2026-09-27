package health

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

const (
	live = "prj_01J9Z3Q8S7M2K4X6V1B5N0C9D8"
	gone = "prj_01J9Z3Q8S7M2K4X6V1B5N0C9E9"
)

type fakeEngine struct {
	usage docker.DiskUsage
	err   error
}

func (f *fakeEngine) SystemDF(context.Context) (docker.DiskUsage, error) {
	return f.usage, f.err
}

func managed(project string) map[string]string {
	return map[string]string{compose.ManagedLabel: "true", compose.ProjectLabel: project}
}

func usage() docker.DiskUsage {
	return docker.DiskUsage{
		ImagesBytes:                4 << 30,
		ImagesReclaimableBytes:     1 << 30,
		ContainersBytes:            200 << 20,
		VolumesBytes:               3 << 30,
		BuildCacheBytes:            2 << 30,
		BuildCacheReclaimableBytes: 2 << 30,
		Volumes: []docker.VolumeUsage{
			{Name: "vd-live-uploads", SizeBytes: 1 << 30, Labels: managed(live)},
			{Name: "vd-gone-uploads", SizeBytes: 2 << 30, Labels: managed(gone), CreatedAt: "2026-01-01T00:00:00Z"},
			// Somebody else's data on the same server.
			{Name: "postgres-of-another-tool", SizeBytes: 9 << 30, Labels: map[string]string{}},
		},
	}
}

func reader(t *testing.T, engine *fakeEngine) *Reader {
	t.Helper()
	dir := t.TempDir()
	loadavg := filepath.Join(dir, "loadavg")
	meminfo := filepath.Join(dir, "meminfo")
	if err := os.WriteFile(loadavg, []byte("1.51 0.72 0.35 2/431 9912\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	memory := "MemTotal:        2048000 kB\nSwapTotal:       1024000 kB\nSwapFree:         524288 kB\n"
	if err := os.WriteFile(meminfo, []byte(memory), 0o600); err != nil {
		t.Fatal(err)
	}
	return &Reader{Engine: engine, ProcLoadavg: loadavg, ProcMeminfo: meminfo, Root: dir}
}

func TestAFolderWhoseAppIsGoneIsNamed(t *testing.T) {
	r := reader(t, &fakeEngine{usage: usage()})
	report := r.Read(context.Background(), map[string]bool{live: true}, time.Now())

	if len(report.Orphans) != 1 {
		t.Fatalf("orphans = %+v", report.Orphans)
	}
	orphan := report.Orphans[0]
	if orphan.Volume != "vd-gone-uploads" || orphan.ProjectID != gone || orphan.SizeBytes != 2<<30 {
		t.Fatalf("orphan = %+v", orphan)
	}
}

func TestAnotherToolsDataIsNotVDeploysToOffer(t *testing.T) {
	r := reader(t, &fakeEngine{usage: usage()})
	report := r.Read(context.Background(), map[string]bool{}, time.Now())
	for _, orphan := range report.Orphans {
		if orphan.Volume == "postgres-of-another-tool" {
			t.Fatal("a volume VDeploy did not make was offered as an orphan")
		}
	}
	// Both of VDeploy's own are orphans once no project is live.
	if len(report.Orphans) != 2 {
		t.Fatalf("orphans = %+v", report.Orphans)
	}
}

func TestAFolderStillMountedIsNotAnOrphan(t *testing.T) {
	df := usage()
	df.Volumes[1].InUse = 1
	r := reader(t, &fakeEngine{usage: df})
	report := r.Read(context.Background(), map[string]bool{}, time.Now())
	for _, orphan := range report.Orphans {
		if orphan.Volume == "vd-gone-uploads" {
			t.Fatal("a folder a container still holds was called an orphan")
		}
	}
}

func TestLoadSwapAndInodesComeFromTheKernel(t *testing.T) {
	r := reader(t, &fakeEngine{usage: usage()})
	report := r.Read(context.Background(), nil, time.Now())

	if report.Load.One != 1.51 || report.Load.Five != 0.72 || report.Load.Fifteen != 0.35 {
		t.Fatalf("load = %+v", report.Load)
	}
	if report.Load.CPUs < 1 {
		t.Fatalf("cores = %d", report.Load.CPUs)
	}
	// 1000 MB of swap, half of it free.
	if report.SwapTotalBytes != 1024000*1024 || report.SwapUsedBytes != 499712*1024 {
		t.Fatalf("swap %d of %d", report.SwapUsedBytes, report.SwapTotalBytes)
	}
	if report.InodesTotal <= 0 || report.InodesUsed > report.InodesTotal {
		t.Fatalf("inodes %d of %d", report.InodesUsed, report.InodesTotal)
	}
	if report.At == "" {
		t.Fatal("a reading with no time on it is a reading nobody can judge")
	}
}

func TestAServerThatWillNotSayWhatItsDiskHoldsStillReportsTheRest(t *testing.T) {
	r := reader(t, &fakeEngine{err: errors.New("docker is busy")})
	report := r.Read(context.Background(), nil, time.Now())
	if report.Load.One != 1.51 || report.SwapTotalBytes == 0 {
		t.Fatalf("half an answer was thrown away: %+v", report)
	}
	if report.Docker.ImagesBytes != 0 || len(report.Orphans) != 0 {
		t.Fatalf("something was invented: %+v", report)
	}
}
