package docker

import "testing"

func TestCacheIsNotCountedAsMemoryTheAppIsUsing(t *testing.T) {
	// Docker reports page cache inside a container's usage; a memory graph
	// that counts it frightens people for no reason.
	body := statsBody{}
	body.MemoryStats.Usage = 200 << 20
	body.MemoryStats.Limit = 512 << 20
	body.MemoryStats.Stats = map[string]int64{"inactive_file": 120 << 20}
	if got := readStats(body); got.MemoryBytes != 80<<20 {
		t.Fatalf("memory = %d MB", got.MemoryBytes>>20)
	}
}

func TestCpuIsCountedAcrossEveryCore(t *testing.T) {
	body := statsBody{}
	body.CPUStats.CPUUsage.TotalUsage = 2_000
	body.PreCPUStats.CPUUsage.TotalUsage = 1_000
	body.CPUStats.SystemUsage = 20_000
	body.PreCPUStats.SystemUsage = 10_000
	body.CPUStats.OnlineCPUs = 4
	// A tenth of the machine's time across four cores is 40% of one core.
	if got := readStats(body); got.CPUPercent != 40 {
		t.Fatalf("cpu = %v", got.CPUPercent)
	}
}

func TestACounterThatWentBackwardsIsNotANegativePercentage(t *testing.T) {
	// A restarted container resets its counters; the answer is "nothing to
	// say yet", not a negative reading.
	body := statsBody{}
	body.CPUStats.CPUUsage.TotalUsage = 500
	body.PreCPUStats.CPUUsage.TotalUsage = 1_000
	body.CPUStats.SystemUsage = 20_000
	body.PreCPUStats.SystemUsage = 10_000
	body.CPUStats.OnlineCPUs = 2
	if got := readStats(body); got.CPUPercent != 0 {
		t.Fatalf("cpu = %v", got.CPUPercent)
	}
}

func TestNetworkIsSummedAcrossEveryInterface(t *testing.T) {
	body := statsBody{}
	body.Networks = map[string]struct {
		RxBytes int64 `json:"rx_bytes"`
		TxBytes int64 `json:"tx_bytes"`
	}{
		"eth0": {RxBytes: 100, TxBytes: 200},
		"eth1": {RxBytes: 50, TxBytes: 25},
	}
	got := readStats(body)
	if got.RxBytes != 150 || got.TxBytes != 225 {
		t.Fatalf("rx %d tx %d", got.RxBytes, got.TxBytes)
	}
}
