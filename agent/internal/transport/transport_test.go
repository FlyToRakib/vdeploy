package transport

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/FlyToRakib/vdeploy/agent/internal/backup"
	"github.com/FlyToRakib/vdeploy/agent/internal/identity"
	"github.com/FlyToRakib/vdeploy/agent/internal/protocol"
	"github.com/FlyToRakib/vdeploy/agent/internal/reconcile"
)

const server = "srv_01J9Z3Q8S7M2K4X6V1B5N0C9D8"

type harness struct {
	cpPub, agentPub ed25519.PublicKey
	cpKey, agentKey ed25519.PrivateKey
	updates         chan reconcile.Update
	accepted        [][]byte
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{updates: make(chan reconcile.Update)}
	var err error
	if h.cpPub, h.cpKey, err = ed25519.GenerateKey(rand.Reader); err != nil {
		t.Fatal(err)
	}
	if h.agentPub, h.agentKey, err = ed25519.GenerateKey(rand.Reader); err != nil {
		t.Fatal(err)
	}
	return h
}

// loop stands in for the reconcile loop: it accepts everything except "bad".
func (h *harness) loop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case u := <-h.updates:
			if string(u.Frame) == `"bad"` {
				u.Result <- errors.New("refused by L6")
				continue
			}
			h.accepted = append(h.accepted, u.Frame)
			u.Result <- nil
		}
	}
}

func (h *harness) client(url string) *Client {
	return &Client{
		Identity:     identity.Identity{ServerID: server, ControlPlaneURL: url},
		Key:          h.agentKey,
		ControlPlane: h.cpPub,
		Facts:        identity.Facts{AgentVersion: "test"},
		Updates:      h.updates,
		Generation:   func() int64 { return 4 },
		Reports:      make(chan reconcile.Report),
		Log:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		HTTPClient:   http.DefaultClient,
		Now:          time.Now,
	}
}

// cp is one scripted control-plane connection.
type cp struct {
	t       *testing.T
	h       *harness
	ws      *websocket.Conn
	session *protocol.Session
}

func (c *cp) send(body any) {
	wire, err := protocol.Seal(c.h.cpKey, body)
	if err != nil {
		c.t.Error(err)
		return
	}
	_ = c.ws.Write(context.Background(), websocket.MessageText, wire)
}

func (c *cp) read() (map[string]any, error) {
	_, wire, err := c.ws.Read(context.Background())
	if err != nil {
		return nil, err
	}
	body, err := protocol.Open(c.h.agentPub, wire)
	if err != nil {
		c.t.Errorf("agent frame not signed by the agent: %v", err)
		return nil, err
	}
	var out map[string]any
	return out, json.Unmarshal(body, &out)
}

func frame(h protocol.Header, extra map[string]any) map[string]any {
	out := map[string]any{"v": h.V, "type": h.Type, "serverId": h.ServerID, "nonce": h.Nonce, "seq": h.Seq, "sentAt": h.SentAt}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

// serve runs script against the first connection and reports whether the agent then closed it.
func serve(t *testing.T, h *harness, script func(c *cp)) (url string, closed chan bool) {
	closed = make(chan bool, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-VDeploy-Server") != server {
			t.Error("agent did not identify itself")
		}
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		c := &cp{t: t, h: h, ws: ws, session: &protocol.Session{ServerID: server, Nonce: "nonce-0123456789abcdef", Now: time.Now}}
		c.send(frame(c.session.Next(protocol.TypeChallenge), nil))
		hello, err := c.read()
		if err != nil || hello["type"] != "hello" || hello["generation"] != float64(4) {
			t.Errorf("hello = %v, %v", hello, err)
		}
		script(c)
		_, _, err = ws.Read(context.Background())
		closed <- err != nil
	}))
	t.Cleanup(srv.Close)
	return srv.URL, closed
}

func runClient(t *testing.T, h *harness, url string) context.CancelFunc {
	ctx, cancel := context.WithCancel(context.Background())
	go h.loop(ctx)
	go func() { _ = h.client(url).session(ctx) }()
	t.Cleanup(cancel)
	return cancel
}

func TestDesiredStateIsDeliveredAndAcked(t *testing.T) {
	h := newHarness(t)
	acks := make(chan map[string]any, 2)
	url, _ := serve(t, h, func(c *cp) {
		c.send(frame(c.session.Next(protocol.TypeDesiredState), map[string]any{"state": map[string]any{"generation": 5}}))
		a, _ := c.read()
		acks <- a
		c.send(frame(c.session.Next(protocol.TypeDesiredState), map[string]any{"state": "bad"}))
		a, _ = c.read()
		acks <- a
	})
	runClient(t, h, url)
	first, second := <-acks, <-acks
	if first["type"] != "ack" || first["accepted"] != true {
		t.Fatalf("first ack = %v", first)
	}
	if second["accepted"] != false || second["error"] != "refused by L6" {
		t.Fatalf("second ack = %v", second)
	}
	if len(h.accepted) != 1 {
		t.Fatalf("accepted %d frames", len(h.accepted))
	}
}

func TestHostileFramesCloseTheConnection(t *testing.T) {
	_, stranger, _ := ed25519.GenerateKey(rand.Reader)
	cases := map[string]func(c *cp){
		"signed by someone else": func(c *cp) {
			wire, _ := protocol.Seal(stranger, frame(c.session.Next(protocol.TypeDesiredState), map[string]any{"state": 1}))
			_ = c.ws.Write(context.Background(), websocket.MessageText, wire)
		},
		"replayed sequence": func(c *cp) {
			h := c.session.Next(protocol.TypeDesiredState)
			c.send(frame(h, map[string]any{"state": 1}))
			_, _ = c.read()
			c.send(frame(h, map[string]any{"state": 1}))
		},
		"another connection's nonce": func(c *cp) {
			h := c.session.Next(protocol.TypeDesiredState)
			h.Nonce = "some-other-connection"
			c.send(frame(h, map[string]any{"state": 1}))
		},
		"unknown field": func(c *cp) {
			c.send(frame(c.session.Next(protocol.TypeDesiredState), map[string]any{"state": 1, "exec": "sh"}))
		},
		"unexpected type": func(c *cp) {
			c.send(frame(c.session.Next("shell"), map[string]any{"state": 1}))
		},
	}
	for name, script := range cases {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			url, closed := serve(t, h, script)
			runClient(t, h, url)
			select {
			case wasClosed := <-closed:
				if !wasClosed {
					t.Fatal("agent kept the connection open")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("agent did not close the connection")
			}
			if name != "replayed sequence" && len(h.accepted) != 0 {
				t.Fatalf("a hostile frame reached the loop: %s", h.accepted)
			}
		})
	}
}

func TestAChallengeFromAnImpostorIsRefused(t *testing.T) {
	h := newHarness(t)
	_, impostor, _ := ed25519.GenerateKey(rand.Reader)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		s := &protocol.Session{ServerID: server, Nonce: "nonce-0123456789abcdef", Now: time.Now}
		wire, _ := protocol.Seal(impostor, frame(s.Next(protocol.TypeChallenge), nil))
		_ = ws.Write(context.Background(), websocket.MessageText, wire)
		_, _, _ = ws.Read(context.Background())
	}))
	t.Cleanup(srv.Close)
	err := h.client(srv.URL).session(context.Background())
	if !errors.Is(err, protocol.ErrBadSignature) {
		t.Fatalf("err = %v", err)
	}
}

// oneBackup stands in for the backup runner: it hands back a fixed number of
// chunks, and records how many it was actually allowed to send.
type oneBackup struct {
	chunks int
	sent   atomic.Int64
}

func (o *oneBackup) Take(context.Context, backup.Request) backup.Result { return backup.Result{} }
func (o *oneBackup) Restore(context.Context, backup.RestoreRequest) backup.RestoreResult {
	return backup.RestoreResult{}
}
func (o *oneBackup) CheckOffsite(context.Context, backup.CheckRequest) backup.CheckResult {
	return backup.CheckResult{}
}

func (o *oneBackup) Verify(context.Context, backup.VerifyRequest) backup.VerifyResult {
	return backup.VerifyResult{}
}

func (o *oneBackup) Send(
	_ context.Context,
	_ backup.ArtifactRequest,
	each func([]byte) error,
) (int64, string, error) {
	for i := range o.chunks {
		if err := each([]byte{byte(i)}); err != nil {
			return o.sent.Load(), "", err
		}
		o.sent.Add(1)
	}
	return o.sent.Load(), strings.Repeat("a", 64), nil
}

// readWithin reads one frame, or reports that none came. A read that times
// out ends the connection, so it is only ever used where one is expected.
func (c *cp) readWithin() (map[string]any, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, wire, err := c.ws.Read(ctx)
	if err != nil {
		return nil, false
	}
	body, err := protocol.Open(c.h.agentPub, wire)
	if err != nil {
		c.t.Errorf("agent frame not signed by the agent: %v", err)
		return nil, false
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		c.t.Error(err)
		return nil, false
	}
	return out, true
}

func TestADownloadOnlyMovesAsFastAsTheControlPlaneTakesIt(t *testing.T) {
	h := newHarness(t)
	taker := &oneBackup{chunks: 20}
	done := make(chan struct{})
	url, _ := serve(t, h, func(c *cp) {
		c.send(frame(c.session.Next(protocol.TypeArtifact), map[string]any{
			"artifact": map[string]any{
				"requestId": "req_1",
				"fileName":  "blog.dump",
				"image":     "postgres:18",
			},
		}))
		// The window, and not a chunk more, until the control plane says so.
		for range initialArtifactWindow {
			got, ok := c.readWithin()
			if !ok || got["type"] != protocol.TypeArtifactChunk {
				t.Errorf("frame = %v", got)
			}
		}
		// Given time to run ahead, it does not: the ninth chunk waits.
		time.Sleep(300 * time.Millisecond)
		if sent := taker.sent.Load(); sent > int64(initialArtifactWindow) {
			t.Errorf("%d chunks were sent into a window of %d", sent, initialArtifactWindow)
		}

		for range taker.chunks - initialArtifactWindow {
			c.send(frame(c.session.Next(protocol.TypeArtifactAck), map[string]any{"requestId": "req_1"}))
		}
		for range taker.chunks - initialArtifactWindow {
			if got, ok := c.readWithin(); !ok || got["type"] != protocol.TypeArtifactChunk {
				t.Errorf("frame = %v", got)
			}
		}
		end, ok := c.readWithin()
		if !ok || end["type"] != protocol.TypeArtifactEnd || end["sizeBytes"] != float64(20) {
			t.Errorf("end = %v", end)
		}
		close(done)
	})
	client := h.client(url)
	client.Backups = taker
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go h.loop(ctx)
	go func() { _ = client.session(ctx) }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("the download never finished")
	}
}

func TestADownloadStopsWhenTheOtherEndGivesUp(t *testing.T) {
	h := newHarness(t)
	taker := &oneBackup{chunks: 1000}
	done := make(chan struct{})
	url, _ := serve(t, h, func(c *cp) {
		c.send(frame(c.session.Next(protocol.TypeArtifact), map[string]any{
			"artifact": map[string]any{"requestId": "req_1", "fileName": "blog.dump", "image": "postgres:18"},
		}))
		if got, ok := c.readWithin(); !ok || got["type"] != protocol.TypeArtifactChunk {
			t.Errorf("frame = %v", got)
		}
		c.send(frame(c.session.Next(protocol.TypeArtifactStop), map[string]any{"requestId": "req_1"}))
		// Whatever was already in flight arrives; then it ends, and says why.
		for range initialArtifactWindow + 2 {
			got, ok := c.readWithin()
			if !ok {
				t.Error("nothing said the download had stopped")
				break
			}
			if got["type"] == protocol.TypeArtifactEnd {
				if got["error"] != "the download was stopped" {
					t.Errorf("end = %v", got)
				}
				break
			}
		}
		if sent := taker.sent.Load(); sent >= int64(taker.chunks) {
			t.Errorf("the agent kept reading after being told to stop: %d", sent)
		}
		close(done)
	})
	client := h.client(url)
	client.Backups = taker
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go h.loop(ctx)
	go func() { _ = client.session(ctx) }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("the download never stopped")
	}
}
