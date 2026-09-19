// Package logs streams a project's container output to the control plane on
// request (§21 "Logs"): a bounded tail, then, if asked, new lines as they
// come. Only containers the agent manages for that project are read, and
// every line is capped, so nothing asked for can reach other containers or
// flood the channel.
package logs

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

const (
	// MaxTail is the most earlier lines a request may ask for, per container.
	MaxTail = 1000
	// MaxLine caps one line; the rest is cut with an ellipsis.
	MaxLine = 8 << 10
	// MaxFollow bounds a live stream; the viewer reconnects for more.
	MaxFollow = 30 * time.Minute
	// batchEvery is how often collected lines are sent: live, without a frame per line.
	batchEvery = 300 * time.Millisecond
	// maxPending bounds what waits between batches; beyond it lines are counted, not kept.
	maxPending = 2000
)

// Line is one line of output from one container.
type Line struct {
	Container string `json:"container"`
	Stream    string `json:"stream"` // out | err
	Time      string `json:"time"`
	Text      string `json:"text"`
}

// Source is what reading logs needs from Docker.
type Source interface {
	ListManaged(ctx context.Context) ([]docker.Container, error)
	StreamLogs(ctx context.Context, id string, tail int, follow bool, each func(stream byte, line []byte)) error
}

// ErrNoContainers means the project has nothing on this server to read.
var ErrNoContainers = errors.New("this project has no containers on this server")

// Stream reads the project's containers and hands lines to emit in batches.
// It returns when every container's output ends (no follow), when ctx ends,
// or when emit fails.
func Stream(ctx context.Context, src Source, projectID string, tail int, follow bool, emit func([]Line) error) error {
	tail = min(max(tail, 0), MaxTail)
	all, err := src.ListManaged(ctx)
	if err != nil {
		return fmt.Errorf("list containers: %w", err)
	}
	var mine []docker.Container
	for _, c := range all {
		if c.Labels[compose.ProjectLabel] == projectID {
			mine = append(mine, c)
		}
	}
	if len(mine) == 0 {
		return ErrNoContainers
	}
	if follow {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, MaxFollow)
		defer cancel()
	}

	var mu sync.Mutex
	var pending []Line
	skipped := 0
	flush := func() error {
		mu.Lock()
		batch := pending
		if skipped > 0 {
			batch = append(batch, Line{Stream: "err", Text: fmt.Sprintf("… %d lines skipped: output was faster than it could be sent", skipped)})
		}
		pending, skipped = nil, 0
		mu.Unlock()
		if len(batch) == 0 {
			return nil
		}
		return emit(batch)
	}
	var wg sync.WaitGroup
	for _, c := range mine {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = src.StreamLogs(ctx, c.ID, tail, follow, func(stream byte, raw []byte) {
				line := parse(c.Name, stream, raw)
				mu.Lock()
				if len(pending) < maxPending {
					pending = append(pending, line)
				} else {
					skipped++
				}
				mu.Unlock()
			})
		}()
	}
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	ticker := time.NewTicker(batchEvery)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return flush()
		case <-ctx.Done():
			_ = flush()
			return nil
		case <-ticker.C:
			if err := flush(); err != nil {
				return err
			}
		}
	}
}

// parse splits Docker's "<RFC3339Nano timestamp> <text>" and caps the text.
func parse(container string, stream byte, raw []byte) Line {
	line := Line{Container: container, Stream: "out"}
	if stream == 2 {
		line.Stream = "err"
	}
	raw = bytes.TrimRight(raw, "\r\n")
	if space := bytes.IndexByte(raw, ' '); space > 0 && space <= 40 {
		if _, err := time.Parse(time.RFC3339Nano, string(raw[:space])); err == nil {
			line.Time = string(raw[:space])
			raw = raw[space+1:]
		}
	}
	text := strings.ToValidUTF8(string(raw), "�")
	if len(text) > MaxLine {
		text = text[:MaxLine] + "…"
	}
	line.Text = text
	return line
}
