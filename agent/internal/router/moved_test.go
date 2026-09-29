package router

import (
	"regexp"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// follow does to a request what Traefik does with a redirectRegex rule.
func follow(t *testing.T, moved spec.MovedPath, url string) (string, bool) {
	t.Helper()
	def := movedPath(moved)["redirectRegex"].(object)
	re, err := regexp.Compile(def["regex"].(string))
	if err != nil {
		t.Fatalf("the rule is not a regular expression: %v", err)
	}
	if !re.MatchString(url) {
		return "", false
	}
	return re.ReplaceAllString(url, def["replacement"].(string)), true
}

func TestAMovedPathTakesEverythingUnderItAndNothingBeside(t *testing.T) {
	moved := spec.MovedPath{From: "/blog", To: "/journal/", Permanent: true}
	for url, want := range map[string]string{
		"https://shop.com/blog":         "https://shop.com/journal",
		"https://shop.com/blog/":        "https://shop.com/journal/",
		"https://shop.com/blog/a/b?x=1": "https://shop.com/journal/a/b?x=1",
		"http://shop.com/blog?x=1":      "http://shop.com/journal?x=1",
	} {
		got, ok := follow(t, moved, url)
		if !ok || got != want {
			t.Errorf("%s → %q (matched %v), want %q", url, got, ok, want)
		}
	}
	for _, url := range []string{"https://shop.com/blogger", "https://shop.com/", "https://shop.com/x/blog"} {
		if got, ok := follow(t, moved, url); ok {
			t.Errorf("%s was moved to %s", url, got)
		}
	}
}

func TestAPathCanMoveToAnotherSite(t *testing.T) {
	got, ok := follow(t, spec.MovedPath{From: "/docs", To: "https://docs.example.com"}, "https://shop.com/docs/start?v=2")
	if !ok || got != "https://docs.example.com/start?v=2" {
		t.Fatalf("got %q", got)
	}
}

func TestWhatAPersonTypedIsOnlyEverLiteral(t *testing.T) {
	// A dot in the path is a dot, not "any character".
	if _, ok := follow(t, spec.MovedPath{From: "/a.b", To: "/c"}, "https://shop.com/axb"); ok {
		t.Fatal("a dot in the path matched any character")
	}
	// A $ in the destination is a $, not a capture group.
	got, _ := follow(t, spec.MovedPath{From: "/price", To: "/cost$1"}, "https://shop.com/price")
	if got != "https://shop.com/cost$1" {
		t.Fatalf("got %q", got)
	}
}

func TestMovedPathsComeFirstInTheChain(t *testing.T) {
	n := spec.Network{ContainerPort: 80, Redirects: []spec.MovedPath{{From: "/old", To: "/new"}}}
	_, chain := middlewares("p", n, nil)
	if len(chain) == 0 || chain[0] != "p-moved-path-0" {
		t.Fatalf("chain = %v", chain)
	}
}
