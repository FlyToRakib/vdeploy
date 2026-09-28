package image

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"testing"
)

const (
	build   = "bld_01J9Z3Q8S7M2K4X6V1B5N0C9D8"
	project = "prj_01J9Z3Q8S7M2K4X6V1B5N0C9D8"
	id      = "sha256:" + "11" + "22334455667788990011223344556677889900112233445566778899001122"
)

type engine struct {
	name   string
	loaded []byte
	give   string
	err    error
}

func (e *engine) LoadImage(_ context.Context, tarball io.Reader, name string) (string, error) {
	e.name = name
	body, err := io.ReadAll(tarball)
	if err != nil {
		return "", err
	}
	e.loaded = body
	return e.give, e.err
}

type record struct {
	id, build, project string
	err                error
}

func (r *record) Add(imageID, buildID, projectID string) error {
	r.id, r.build, r.project = imageID, buildID, projectID
	return r.err
}

// serve hands out bytes at a one-time URL, the way the control plane pipes
// them from the server that built the image.
func serve(t *testing.T, body []byte) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer token-token-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(server.Close)
	return server
}

func arrival(url string, body []byte) Arrival {
	sum := sha256.Sum256(body)
	return Arrival{
		BuildID:   build,
		ProjectID: project,
		Image:     id,
		URL:       url,
		Token:     "token-token-token",
		SizeBytes: int64(len(body)),
		SHA256:    hex.EncodeToString(sum[:]),
	}
}

func loader(t *testing.T, e *engine, r *record) *Loader {
	t.Helper()
	return &Loader{Engine: e, HTTP: http.DefaultClient, TempDir: t.TempDir(), Images: r}
}

func TestAnImageBuiltElsewhereBecomesRunnableHere(t *testing.T) {
	body := []byte("a tarball, near enough")
	e, r := &engine{give: id}, &record{}
	result := loader(t, e, r).Load(context.Background(), arrival(serve(t, body).URL, body))
	if !result.OK {
		t.Fatalf("the image did not arrive: %s", result.Error)
	}
	if string(e.loaded) != string(body) {
		t.Fatal("what was loaded is not what was sent")
	}
	// Recording it is what makes it runnable at all (ADR 0008).
	if r.id != id || r.build != build || r.project != project {
		t.Fatalf("recorded %q for %q/%q", r.id, r.build, r.project)
	}
}

func TestBytesThatAreNotTheOnesBuiltAreRefused(t *testing.T) {
	body := []byte("a tarball, near enough")
	req := arrival(serve(t, []byte("something else entirely")).URL, body)
	r := &record{}
	result := loader(t, &engine{give: id}, r).Load(context.Background(), req)
	if result.OK {
		t.Fatal("bytes that do not match what was built were accepted")
	}
	if r.id != "" {
		t.Fatal("an image that failed its check was recorded as runnable")
	}
}

// The check ADR 0008 actually rests on: an image ID is the hash of its own
// config, so "these bytes, and this ID out" is the same guarantee as having
// built it here. A load that produces a different ID is a load of something
// else, and nothing may run it.
func TestAnImageThatLoadsAsSomethingElseIsRefused(t *testing.T) {
	body := []byte("a tarball, near enough")
	other := "sha256:" + "99" + "88776655443322110099887766554433221100998877665544332211009988"
	r := &record{}
	result := loader(t, &engine{give: other}, r).Load(
		context.Background(),
		arrival(serve(t, body).URL, body),
	)
	if result.OK {
		t.Fatal("an image that is not the one that was built was accepted")
	}
	if r.id != "" {
		t.Fatal("an image that is not the one that was built was recorded as runnable")
	}
}

func TestAnImageThatCannotBeRecordedIsNotReportedAsArrived(t *testing.T) {
	body := []byte("a tarball, near enough")
	result := loader(t, &engine{give: id}, &record{err: errors.New("disk full")}).Load(
		context.Background(),
		arrival(serve(t, body).URL, body),
	)
	if result.OK {
		t.Fatal("an image nothing recorded was reported as runnable")
	}
}

func TestMalformedRequestsAnswerRatherThanCrash(t *testing.T) {
	bad := []Arrival{
		{BuildID: "not-a-build"},
		{BuildID: build, ProjectID: "not-a-project"},
		{BuildID: build, ProjectID: project, Image: "latest"},
		{BuildID: build, ProjectID: project, Image: id, SHA256: "short"},
	}
	for _, req := range bad {
		if loader(t, &engine{give: id}, &record{}).Load(context.Background(), req).OK {
			t.Fatalf("%+v was accepted", req)
		}
	}
}

/*
Docker refuses a reference with an upper-case letter in it, and an id is
upper-case.

The name is only a label — what the agent trusts is the ID that comes back
— which is exactly why it was easy to get wrong and why nothing else would
have noticed: an image that arrived perfectly well was refused on its name,
and the build it belonged to failed with it.
*/
func TestTheImageIsTaggedWithSomethingDockerAccepts(t *testing.T) {
	body := []byte("a tarball, near enough")
	e := &engine{give: id}
	if !loader(t, e, &record{}).Load(context.Background(), arrival(serve(t, body).URL, body)).OK {
		t.Fatal("the image did not arrive")
	}
	if e.name != strings.ToLower(e.name) {
		t.Fatalf("loaded under %q, which Docker will not take", e.name)
	}
	// And under the name the builder gave it, because that is the name
	// inside the tarball: ask for anything else and the image that was
	// just loaded is not there.
	if e.name != compose.BuildImageName(project, build) {
		t.Fatalf("loaded under %q, not the name it was built with", e.name)
	}
}
