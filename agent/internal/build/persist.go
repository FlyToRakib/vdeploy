package build

import (
	"encoding/json"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// Finding is a path an app almost certainly writes data to that must
// survive a deploy (§17.2 "detect at build time").
type Finding struct {
	// Path is where it lives in the container.
	Path string `json:"path"`
	// Why says, in plain words, what is usually kept there.
	Why string `json:"why"`
}

const (
	scanDepth  = 4
	scanFiles  = 20_000
	maxFinding = 50
)

// skipped folders never hold an app's own data, and are huge.
var skipped = map[string]bool{".git": true, "node_modules": true, "vendor": true, ".venv": true, "__pycache__": true}

// genericData are folder names that nearly always hold user data.
var genericData = []string{"uploads", "media", "attachments", "data", "files"}

type scan struct {
	root     string
	found    map[string]string
	files    int
	packages map[string]bool // package.json dependencies, by name
}

func (s *scan) exists(rel string) bool {
	_, err := os.Stat(filepath.Join(s.root, filepath.FromSlash(rel)))
	return err == nil
}

func (s *scan) read(rel string) string {
	raw, err := os.ReadFile(filepath.Join(s.root, filepath.FromSlash(rel))) // #nosec G304 -- inside the unpacked source
	if err != nil || len(raw) > 1<<20 {
		return ""
	}
	return strings.ToLower(string(raw))
}

func (s *scan) flag(rel, why string) {
	if _, seen := s.found[rel]; !seen {
		s.found[rel] = why
	}
}

// ScanPersistence looks through an unpacked source for folders an app will
// write lasting data to, relative to the source root (absolute for a few
// apps that always use one fixed place).
func ScanPersistence(root string) map[string]string {
	s := &scan{root: root, found: map[string]string{}, packages: map[string]bool{}}
	var pkg struct {
		Dependencies map[string]string `json:"dependencies"`
	}
	if raw := s.read("package.json"); raw != "" && json.Unmarshal([]byte(raw), &pkg) == nil {
		for name := range pkg.Dependencies {
			s.packages[name] = true
		}
	}
	if s.exists("wp-content") || s.exists("wp-config.php") {
		for _, dir := range []string{"wp-content/uploads", "wp-content/plugins", "wp-content/themes"} {
			s.flag(dir, "WordPress keeps uploaded media, plugins and themes here")
		}
	}
	if s.exists("artisan") && strings.Contains(s.read("composer.json"), "laravel/framework") {
		s.flag("storage/app", "Laravel keeps uploaded files here")
		s.flag("storage/framework/sessions", "Laravel keeps sign-in sessions here")
	}
	if s.exists("manage.py") {
		s.flag("media", "Django keeps uploaded files (MEDIA_ROOT) here")
	}
	if s.exists("bin/rails") || strings.Contains(s.read("Gemfile"), "'rails'") || strings.Contains(s.read("Gemfile"), `"rails"`) {
		s.flag("storage", "Rails keeps Active Storage files here")
		s.flag("public/uploads", "Rails apps keep uploaded files here")
		s.flag("public/system", "Rails apps keep uploaded files here")
	}
	switch {
	case s.packages["@strapi/strapi"]:
		s.flag("public/uploads", "Strapi keeps uploaded media here")
	case s.packages["ghost"]:
		s.flag("content", "Ghost keeps posts' images and settings here")
	case s.packages["n8n"]:
		s.flag("/home/node/.n8n", "n8n keeps its workflows and credentials here")
	}
	for _, dir := range genericData {
		if info, err := os.Stat(filepath.Join(root, dir)); err == nil && info.IsDir() {
			s.flag(dir, "a folder named "+dir+" usually holds data people add")
		}
	}
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || s.files > scanFiles {
			return fs.SkipDir
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if skipped[d.Name()] || strings.Count(rel, "/") >= scanDepth {
				return fs.SkipDir
			}
			return nil
		}
		s.files++
		switch strings.ToLower(path.Ext(d.Name())) {
		case ".sqlite", ".sqlite3", ".db":
			dir := path.Dir(rel)
			if dir == "." {
				// A database file at the top: the folder is the app itself, so flag the file.
				s.flag(rel, "a SQLite database: in a container it deletes itself on every deploy")
			} else {
				s.flag(dir, "holds a SQLite database: in a container it deletes itself on every deploy")
			}
		}
		return nil
	})
	return s.found
}

// ContainerFindings places findings in the container: relative ones under
// the image's working directory. At most maxFinding, sorted by path.
func ContainerFindings(found map[string]string, workdir string) []Finding {
	if workdir == "" {
		workdir = "/"
	}
	out := make([]Finding, 0, len(found))
	for rel, why := range found {
		p := rel
		if !path.IsAbs(rel) {
			p = path.Join(workdir, rel)
		}
		out = append(out, Finding{Path: p, Why: why})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	if len(out) > maxFinding {
		out = out[:maxFinding]
	}
	return out
}
