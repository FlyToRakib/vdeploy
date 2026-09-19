package logs

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

type fakeSource struct {
	containers []docker.Container
	output     map[string][]string // by id; "!" prefix means stderr
	mu         sync.Mutex
	asked      []string
}

func (f *fakeSource) ListManaged(context.Context) ([]docker.Container, error) {
	return f.containers, nil
}

func (f *fakeSource) StreamLogs(_ context.Context, id string, tail int, _ bool, each func(byte, []byte)) error {
	f.mu.Lock()
	f.asked = append(f.asked, id)
	f.mu.Unlock()
	lines := f.output[id]
	if tail < len(lines) {
		lines = lines[len(lines)-tail:]
	}
	for _, l := range lines {
		if rest, ok := strings.CutPrefix(l, "!"); ok {
			each(2, []byte(rest))
		} else {
			each(1, []byte(l))
		}
	}
	return nil
}

func container(id, name, project string) docker.Container {
	return docker.Container{ID: id, Name: name, Labels: map[string]string{compose.ProjectLabel: project}}
}

func TestStreamReadsOnlyThisProjectsContainers(t *testing.T) {
	src := &fakeSource{
		containers: []docker.Container{
			container("a", "vd-blog-v1-r0-0", "prj_blog"),
			container("b", "vd-shop-v1-r0-0", "prj_shop"),
		},
		output: map[string][]string{
			"a": {"2026-09-19T12:00:00.000000001Z GET / 200", "!2026-09-19T12:00:01Z boom", "no timestamp here"},
			"b": {"secret shop output"},
		},
	}
	var got []Line
	err := Stream(context.Background(), src, "prj_blog", 10, false, func(lines []Line) error {
		got = append(got, lines...)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(src.asked, "b") {
		t.Fatal("read another project's container")
	}
	want := []Line{
		{Container: "vd-blog-v1-r0-0", Stream: "out", Time: "2026-09-19T12:00:00.000000001Z", Text: "GET / 200"},
		{Container: "vd-blog-v1-r0-0", Stream: "err", Time: "2026-09-19T12:00:01Z", Text: "boom"},
		{Container: "vd-blog-v1-r0-0", Stream: "out", Text: "no timestamp here"},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("got %+v", got)
	}
}

func TestTailIsCappedAndLongLinesAreCut(t *testing.T) {
	long := strings.Repeat("x", MaxLine+100)
	src := &fakeSource{
		containers: []docker.Container{container("a", "c", "p")},
		output:     map[string][]string{"a": {long}},
	}
	var got []Line
	_ = Stream(context.Background(), src, "p", 1_000_000, false, func(lines []Line) error {
		got = append(got, lines...)
		return nil
	})
	if len(got) != 1 || len(got[0].Text) != MaxLine+len("…") {
		t.Fatalf("got %d lines, first %d bytes", len(got), len(got[0].Text))
	}
}

func TestNothingToReadIsSaid(t *testing.T) {
	err := Stream(context.Background(), &fakeSource{}, "p", 10, false, func([]Line) error { return nil })
	if !errors.Is(err, ErrNoContainers) {
		t.Fatalf("err = %v", err)
	}
}

func TestAStreamEndsWhenItsContextDoes(t *testing.T) {
	src := &blockingSource{fakeSource: fakeSource{containers: []docker.Container{container("a", "c", "p")}}}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- Stream(ctx, src, "p", 0, true, func([]Line) error { return nil }) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("stream did not stop")
	}
}

type blockingSource struct{ fakeSource }

func (b *blockingSource) StreamLogs(ctx context.Context, _ string, _ int, _ bool, _ func(byte, []byte)) error {
	<-ctx.Done()
	return nil
}
