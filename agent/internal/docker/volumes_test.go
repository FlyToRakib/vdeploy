package docker

import (
	"encoding/json"
	"testing"
)

// A trimmed answer from a real `docker system df`, including the two shapes
// that mislead: a volume Docker has not measured (-1), and build-cache
// records that share the same bytes.
const df = `{
  "LayersSize": 4294967296,
  "Images": [
    {"Size": 1073741824, "SharedSize": 536870912, "Containers": 1},
    {"Size": 2147483648, "SharedSize": 536870912, "Containers": 0}
  ],
  "Containers": [{"SizeRw": 104857600}, {"SizeRw": 5242880}],
  "Volumes": [
    {"Name": "vd-one-uploads", "Labels": {"io.vdeploy.managed": "true"},
     "UsageData": {"Size": 2147483648, "RefCount": 1}},
    {"Name": "never-measured", "Labels": null, "UsageData": {"Size": -1, "RefCount": -1}}
  ],
  "BuildCache": [
    {"Size": 1073741824, "InUse": false, "Shared": false},
    {"Size": 536870912, "InUse": true, "Shared": false},
    {"Size": 1073741824, "InUse": false, "Shared": true}
  ]
}`

func parsed(t *testing.T) DiskUsage {
	t.Helper()
	var raw dfBody
	if err := json.Unmarshal([]byte(df), &raw); err != nil {
		t.Fatal(err)
	}
	return readDiskUsage(raw)
}

func TestWhatTheDiskHoldsIsReadFromDockersOwnAccounting(t *testing.T) {
	usage := parsed(t)
	if usage.ImagesBytes != 4<<30 {
		t.Fatalf("images = %d", usage.ImagesBytes)
	}
	// Only the image nothing runs from, and only the layers it does not share.
	if usage.ImagesReclaimableBytes != 1536<<20 {
		t.Fatalf("reclaimable images = %d MB", usage.ImagesReclaimableBytes>>20)
	}
	if usage.ContainersBytes != 105<<20 {
		t.Fatalf("containers = %d MB", usage.ContainersBytes>>20)
	}
}

func TestAVolumeDockerNeverMeasuredIsNotCountedAsNegativeSpace(t *testing.T) {
	usage := parsed(t)
	if usage.VolumesBytes != 2<<30 {
		t.Fatalf("volumes = %d", usage.VolumesBytes)
	}
	if len(usage.Volumes) != 2 {
		t.Fatalf("volumes = %+v", usage.Volumes)
	}
	unmeasured := usage.Volumes[1]
	if unmeasured.SizeBytes != 0 || unmeasured.InUse != 0 {
		t.Fatalf("unmeasured volume = %+v", unmeasured)
	}
}

func TestSharedBuildCacheIsCountedOnce(t *testing.T) {
	usage := parsed(t)
	if usage.BuildCacheBytes != 1536<<20 {
		t.Fatalf("build cache = %d MB", usage.BuildCacheBytes>>20)
	}
	// Only the record nothing is using.
	if usage.BuildCacheReclaimableBytes != 1<<30 {
		t.Fatalf("reclaimable cache = %d MB", usage.BuildCacheReclaimableBytes>>20)
	}
}
