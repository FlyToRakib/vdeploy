package health

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
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
			// Where almost all of the build cache actually lives.
			{Name: docker.BuildCacheVolume, SizeBytes: 5 << 30, Labels: map[string]string{"io.vdeploy.infra": "build"}},
		},
	}
}

func TestTheBuildCacheIsCountedAsBuildCacheNotAsSomebodysFiles(t *testing.T) {
	// Docker files BuildKit's cache under volumes, which is the last place
	// somebody hunting for gigabytes of build cache would look.
	r := reader(t, &fakeEngine{usage: usage()})
	report := r.Read(context.Background(), map[string]bool{"vd-live-uploads": true}, time.Now())

	if report.Docker.BuildCacheBytes != 7<<30 {
		t.Fatalf("build cache = %d GB", report.Docker.BuildCacheBytes>>30)
	}
	// Only the two folders VDeploy made, never the other tool's nine.
	if report.Docker.VolumesBytes != 3<<30 {
		t.Fatalf("permanent folders = %d GB", report.Docker.VolumesBytes>>30)
	}
	if report.Docker.OtherBytes != 9<<30 {
		t.Fatalf("other = %d GB", report.Docker.OtherBytes>>30)
	}
	// And the build cache volume is never offered as somebody's lost folder.
	for _, orphan := range report.Orphans {
		if orphan.Volume == docker.BuildCacheVolume {
			t.Fatal("the build cache was offered as an app's folder")
		}
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
	report := r.Read(context.Background(), map[string]bool{"vd-live-uploads": true}, time.Now())

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

func TestAFolderTakenOutOfAnAppThatStillRunsIsAnOrphanToo(t *testing.T) {
	// The other way one appears: the app is alive and well, and no longer
	// asks for this folder. Nothing will ever mount it again either.
	r := reader(t, &fakeEngine{usage: usage()})
	report := r.Read(context.Background(), map[string]bool{}, time.Now())

	var named []string
	for _, orphan := range report.Orphans {
		named = append(named, orphan.Volume)
	}
	if !slices.Contains(named, "vd-live-uploads") {
		t.Fatalf("a folder nothing asks for was not named: %v", named)
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

func TestEachAppsFolderIsMeasuredOnItsOwn(t *testing.T) {
	disk := usage()
	disk.Volumes = append(disk.Volumes, docker.VolumeUsage{
		Name: compose.VolumeName(live, "media"), SizeBytes: 7 << 30, Labels: managed(live), InUse: 1,
	})
	r := reader(t, &fakeEngine{usage: disk})
	report := r.Read(context.Background(), map[string]bool{compose.VolumeName(live, "media"): true}, time.Now())
	var media *Folder
	for i := range report.Folders {
		if report.Folders[i].Name == "media" {
			media = &report.Folders[i]
		}
	}
	// Named as the app's spec names it, so the control plane can hold it
	// up against the size the app was given.
	if media == nil || media.ProjectID != live || media.SizeBytes != 7<<30 {
		t.Fatalf("folders = %+v", report.Folders)
	}
	for _, f := range report.Folders {
		if f.ProjectID == gone {
			t.Fatalf("an orphan was measured as an app's folder: %+v", f)
		}
	}
}
