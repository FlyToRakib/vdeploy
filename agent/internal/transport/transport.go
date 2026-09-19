// Package transport keeps the agent connected to its control plane over an
// outbound wss:// connection (§25): no inbound port is ever opened on the
// server. Losing the connection changes nothing on the server (N6); the
// agent reconnects with backoff and resumes.
package transport

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/FlyToRakib/vdeploy/agent/internal/build"
	"github.com/FlyToRakib/vdeploy/agent/internal/identity"
	"github.com/FlyToRakib/vdeploy/agent/internal/protocol"
	"github.com/FlyToRakib/vdeploy/agent/internal/reconcile"
)

// maxFrameBytes bounds any frame the control plane may send.
const maxFrameBytes = 16 << 20

// Client is the agent's side of the connection.
type Client struct {
	Identity     identity.Identity
	Key          ed25519.PrivateKey
	ControlPlane ed25519.PublicKey
	Facts        identity.Facts
	// BoxKey is this agent's X25519 public key (base64): secrets are sealed to it.
	BoxKey string
	// Updates hands accepted frames to the reconcile loop, which answers each.
	Updates chan<- reconcile.Update
	// Generation reports the generation the loop holds.
	Generation func() int64
	Reports    <-chan reconcile.Report
	Log        *slog.Logger
	HTTPClient *http.Client
	Now        func() time.Time
	// Builder runs builds the control plane asks for; nil refuses them.
	Builder Builder

	buildMu sync.Mutex
	builds  map[string]*build.Result // by build id: nil while running
	results chan build.Result
}

// Builder runs one build to completion.
type Builder interface {
	Run(ctx context.Context, req build.Request) build.Result
}

// maxBuildTime bounds a build; the builder's own limits apply inside it.
const maxBuildTime = time.Hour

// Run stays connected until ctx is cancelled.
func (c *Client) Run(ctx context.Context) {
	c.buildMu.Lock()
	if c.results == nil {
		c.results = make(chan build.Result, 16)
		c.builds = map[string]*build.Result{}
	}
	c.buildMu.Unlock()
	backoff := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		err := c.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second // it was a working connection; reconnect promptly
		}
		c.Log.Warn("control plane connection lost", "err", err, "retryIn", backoff)
		// Jitter only spreads reconnects out; it needs no cryptographic randomness.
		jitter := time.Duration(rand.Int64N(int64(backoff / 2))) // #nosec G404
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff + jitter):
		}
		backoff = min(backoff*2, time.Minute)
	}
}

type challenge struct {
	protocol.Header
}

type hello struct {
	protocol.Header
	AgentVersion string `json:"agentVersion"`
	Protocol     int    `json:"protocol"`
	Generation   int64  `json:"generation"`
	BoxKey       string `json:"boxKey,omitempty"`
	identity.Facts
}

type desiredState struct {
	protocol.Header
	State json.RawMessage `json:"state"`
}

type ack struct {
	protocol.Header
	Generation int64  `json:"generation"`
	Accepted   bool   `json:"accepted"`
	Error      string `json:"error,omitempty"`
}

type observed struct {
	protocol.Header
	Report reconcile.Report `json:"report"`
}

func (c *Client) endpoint() string {
	u := strings.Replace(c.Identity.ControlPlaneURL, "https://", "wss://", 1)
	u = strings.Replace(u, "http://", "ws://", 1)
	return strings.TrimSuffix(u, "/") + "/api/v1/agent/connect"
}

func strictDecode(body []byte, into any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		return fmt.Errorf("frame body: %w", err)
	}
	return nil
}

type conn struct {
	ws      *websocket.Conn
	key     ed25519.PrivateKey
	session *protocol.Session
	mu      sync.Mutex
}

// send numbers, signs and writes one frame. Numbering happens under the same
// lock as writing, so frames leave in sequence order from any goroutine.
func (k *conn) send(ctx context.Context, frameType string, build func(protocol.Header) any) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	wire, err := protocol.Seal(k.key, build(k.session.Next(frameType)))
	if err != nil {
		return err
	}
	if err := k.ws.Write(ctx, websocket.MessageText, wire); err != nil {
		return fmt.Errorf("send: %w", err)
	}
	return nil
}

func (c *Client) session(ctx context.Context) error {
	ws, _, err := websocket.Dial(ctx, c.endpoint(), &websocket.DialOptions{
		HTTPClient: c.HTTPClient,
		HTTPHeader: http.Header{"X-VDeploy-Server": {c.Identity.ServerID}},
	})
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer func() { _ = ws.CloseNow() }()
	ws.SetReadLimit(maxFrameBytes)

	k := &conn{ws: ws, key: c.Key}
	if err := c.handshake(ctx, k); err != nil {
		_ = ws.Close(websocket.StatusPolicyViolation, "handshake refused")
		return err
	}
	c.Log.Info("connected to control plane", "server", c.Identity.ServerID)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go c.forwardReports(ctx, k)
	go c.forwardBuildResults(ctx, k)
	for {
		if err := c.receive(ctx, k); err != nil {
			_ = ws.Close(websocket.StatusPolicyViolation, "frame refused")
			return err
		}
	}
}

func (c *Client) handshake(ctx context.Context, k *conn) error {
	_, wire, err := k.ws.Read(ctx)
	if err != nil {
		return fmt.Errorf("read challenge: %w", err)
	}
	body, err := protocol.Open(c.ControlPlane, wire)
	if err != nil {
		return err
	}
	var ch challenge
	if err := strictDecode(body, &ch); err != nil {
		return err
	}
	if ch.Type != protocol.TypeChallenge || len(ch.Nonce) < 16 {
		return errors.New("expected a challenge")
	}
	k.session = &protocol.Session{ServerID: c.Identity.ServerID, Nonce: ch.Nonce, Now: c.Now}
	if err := k.session.Check(ch.Header); err != nil {
		return err
	}
	return k.send(ctx, protocol.TypeHello, func(h protocol.Header) any {
		return hello{
			Header:       h,
			AgentVersion: c.Facts.AgentVersion,
			Protocol:     protocol.Version,
			Generation:   c.Generation(),
			BoxKey:       c.BoxKey,
			Facts:        c.Facts,
		}
	})
}

func (c *Client) receive(ctx context.Context, k *conn) error {
	_, wire, err := k.ws.Read(ctx)
	if err != nil {
		return fmt.Errorf("read: %w", err)
	}
	body, err := protocol.Open(c.ControlPlane, wire)
	if err != nil {
		return err
	}
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(body, &head); err != nil {
		return fmt.Errorf("malformed frame: %w", err)
	}
	if head.Type == protocol.TypeBuild {
		var frame buildFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		c.startBuild(ctx, frame.Build)
		return nil
	}
	var frame desiredState
	if err := strictDecode(body, &frame); err != nil {
		return err
	}
	if err := k.session.Check(frame.Header); err != nil {
		return err
	}
	if frame.Type != protocol.TypeDesiredState {
		return fmt.Errorf("unexpected frame type %q", frame.Type)
	}
	result := make(chan error, 1)
	select {
	case c.Updates <- reconcile.Update{Frame: frame.State, Result: result}:
	case <-ctx.Done():
		return fmt.Errorf("stopped: %w", ctx.Err())
	}
	accepted := <-result
	return k.send(ctx, protocol.TypeAck, func(h protocol.Header) any {
		reply := ack{Header: h, Generation: c.Generation(), Accepted: accepted == nil}
		if accepted != nil {
			reply.Error = accepted.Error()
		}
		return reply
	})
}

func (c *Client) forwardReports(ctx context.Context, k *conn) {
	for {
		select {
		case <-ctx.Done():
			return
		case report := <-c.Reports:
			err := k.send(ctx, protocol.TypeObserved, func(h protocol.Header) any {
				return observed{Header: h, Report: report}
			})
			if err != nil {
				c.Log.Warn("report not sent", "err", err)
				return
			}
		}
	}
}

type buildFrame struct {
	protocol.Header
	Build build.Request `json:"build"`
}

type buildResultFrame struct {
	protocol.Header
	Result build.Result `json:"result"`
}

// startBuild runs a requested build once. A request repeated after a
// reconnect gets the finished result again instead of a second build.
func (c *Client) startBuild(ctx context.Context, req build.Request) {
	c.buildMu.Lock()
	defer c.buildMu.Unlock()
	if done, seen := c.builds[req.BuildID]; seen {
		if done != nil {
			c.queueResult(*done)
		}
		return
	}
	refuse := func(reason string) {
		result := build.Result{BuildID: req.BuildID, Error: reason}
		c.builds[req.BuildID] = &result
		c.queueResult(result)
	}
	switch {
	case c.Builder == nil:
		refuse("this server does not build")
		return
	case !strings.HasPrefix(req.Source.URL, strings.TrimRight(c.Identity.ControlPlaneURL, "/")+"/api/v1/agent/sources/"):
		// Sources come only from this agent's own control plane, never from an arbitrary address.
		refuse("the source must come from this server's control plane")
		return
	}
	c.builds[req.BuildID] = nil
	go func() {
		buildCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), maxBuildTime)
		defer cancel()
		result := c.Builder.Run(buildCtx, req)
		c.buildMu.Lock()
		c.builds[req.BuildID] = &result
		c.buildMu.Unlock()
		c.queueResult(result)
	}()
}

// queueResult hands a result to whichever connection is up; the newest win if the queue is full.
func (c *Client) queueResult(result build.Result) {
	select {
	case c.results <- result:
	default:
		c.Log.Warn("build result dropped: queue full", "build", result.BuildID)
	}
}

func (c *Client) forwardBuildResults(ctx context.Context, k *conn) {
	for {
		select {
		case <-ctx.Done():
			return
		case result := <-c.results:
			err := k.send(ctx, protocol.TypeBuildResult, func(h protocol.Header) any {
				return buildResultFrame{Header: h, Result: result}
			})
			if err != nil {
				c.queueResult(result) // the next connection sends it
				return
			}
		}
	}
}
