package build

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAnImageIsRecentForADayAfterItWasMade(t *testing.T) {
	images := &Images{Path: filepath.Join(t.TempDir(), "images.json")}
	const id = "sha256:" + "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12"
	if err := images.Add(id, "bld_1", "prj_1"); err != nil {
		t.Fatal(err)
	}
	if !images.Recent(id, time.Hour) {
		t.Fatal("an image made just now is not recent")
	}
	if images.Recent(id, 0) {
		t.Fatal("recent for no time at all")
	}
	if images.Recent("sha256:somebody-elses", time.Hour) {
		t.Fatal("an image this agent never made is recent")
	}
	// A record that cannot be read never makes an image look old.
	if err := os.WriteFile(images.Path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !images.Recent(id, time.Hour) {
		t.Fatal("a damaged record made an image look old enough to remove")
	}
}
