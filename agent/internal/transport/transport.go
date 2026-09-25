// Package transport keeps the agent connected to its control plane over an
// outbound wss:// connection (§25): no inbound port is ever opened on the
// server. Losing the connection changes nothing on the server (N6); the
// agent reconnects with backoff and resumes.
package transport

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
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

	"github.com/FlyToRakib/vdeploy/agent/internal/backup"
	"github.com/FlyToRakib/vdeploy/agent/internal/build"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"github.com/FlyToRakib/vdeploy/agent/internal/identity"
	"github.com/FlyToRakib/vdeploy/agent/internal/logs"
	"github.com/FlyToRakib/vdeploy/agent/internal/protocol"
	"github.com/FlyToRakib/vdeploy/agent/internal/reconcile"
)

// maxArtifactWindow and initialArtifactWindow bound how much of a download
// is in flight: chunks leave only against credits the control plane grants.
const (
	maxArtifactWindow     = 16
	initialArtifactWindow = 8
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
	// Backups takes database backups the control plane asks for; nil refuses them.
	Backups BackupTaker
	// Logs streams a project's container output; nil refuses log requests.
	Logs func(ctx context.Context, projectID string, tail int, follow bool, emit func([]logs.Line) error) error

	buildMu sync.Mutex
	builds  map[string]*build.Result // by build id: nil while running
	results chan build.Result

	backupMu       sync.Mutex
	backups        map[string]*backup.Result        // by backup id: nil while running
	restores       map[string]*backup.RestoreResult // by restore id: nil while running
	backupResults  chan backup.Result
	restoreResults chan backup.RestoreResult
	checks         map[string]*backup.CheckResult // by check id: nil while running
	checkResults   chan backup.CheckResult

	artifactMu sync.Mutex
	artifacts  map[string]*artifactSend // by request id, while a download is running
}

// BackupTaker takes one backup to completion, and puts one back.
type BackupTaker interface {
	Take(ctx context.Context, req backup.Request) backup.Result
	Restore(ctx context.Context, req backup.RestoreRequest) backup.RestoreResult
	CheckOffsite(ctx context.Context, req backup.CheckRequest) backup.CheckResult
	Send(ctx context.Context, req backup.ArtifactRequest, each func([]byte) error) (int64, string, error)
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
	c.backupMu.Lock()
	if c.backupResults == nil {
		c.backupResults = make(chan backup.Result, 16)
		c.backups = map[string]*backup.Result{}
		c.restoreResults = make(chan backup.RestoreResult, 16)
		c.restores = map[string]*backup.RestoreResult{}
		c.checkResults = make(chan backup.CheckResult, 8)
		c.checks = map[string]*backup.CheckResult{}
	}
	c.backupMu.Unlock()
	c.artifactMu.Lock()
	if c.artifacts == nil {
		c.artifacts = map[string]*artifactSend{}
	}
	c.artifactMu.Unlock()
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

	logsMu sync.Mutex
	logs   map[string]context.CancelFunc // open log streams, by request id
}

func (k *conn) addLogs(id string, cancel context.CancelFunc) bool {
	k.logsMu.Lock()
	defer k.logsMu.Unlock()
	if k.logs == nil {
		k.logs = map[string]context.CancelFunc{}
	}
	if _, open := k.logs[id]; open || len(k.logs) >= maxLogStreams {
		return false
	}
	k.logs[id] = cancel
	return true
}

func (k *conn) stopLogs(id string) {
	k.logsMu.Lock()
	defer k.logsMu.Unlock()
	if cancel, open := k.logs[id]; open {
		cancel()
		delete(k.logs, id)
	}
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
	go c.forwardBackupResults(ctx, k)
	go c.forwardRestoreResults(ctx, k)
	go c.forwardCheckResults(ctx, k)
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
	switch head.Type {
	case protocol.TypeLogs:
		var frame logsFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		c.startLogs(ctx, k, frame)
		return nil
	case protocol.TypeLogsStop:
		var frame logsStopFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		k.stopLogs(frame.RequestID)
		return nil
	}
	if head.Type == protocol.TypeRestore {
		var frame restoreFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		c.startRestore(ctx, frame.Restore)
		return nil
	}
	switch head.Type {
	case protocol.TypeArtifact:
		var frame artifactFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		c.startArtifact(ctx, k, frame.Artifact)
		return nil
	case protocol.TypeArtifactAck, protocol.TypeArtifactStop:
		var frame artifactControlFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		if head.Type == protocol.TypeArtifactAck {
			c.grantArtifact(frame.RequestID)
		} else {
			c.stopArtifact(frame.RequestID)
		}
		return nil
	}
	if head.Type == protocol.TypeOffsiteCheck {
		var frame offsiteCheckFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		c.startOffsiteCheck(ctx, frame.Check)
		return nil
	}
	if head.Type == protocol.TypeBackup {
		var frame backupFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		c.startBackup(ctx, frame.Backup)
		return nil
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

type logsFrame struct {
	protocol.Header
	RequestID string `json:"requestId"`
	ProjectID string `json:"projectId"`
	Tail      int    `json:"tail"`
	Follow    bool   `json:"follow"`
}

type logsStopFrame struct {
	protocol.Header
	RequestID string `json:"requestId"`
}

type logsChunkFrame struct {
	protocol.Header
	RequestID string      `json:"requestId"`
	Lines     []logs.Line `json:"lines"`
}

type logsEndFrame struct {
	protocol.Header
	RequestID string `json:"requestId"`
	Error     string `json:"error,omitempty"`
}

// maxLogStreams bounds the log streams one connection may hold open.
const maxLogStreams = 8

// startLogs streams a project's logs for one request, until it ends, the
// control plane stops it, or the connection drops.
func (c *Client) startLogs(ctx context.Context, k *conn, frame logsFrame) {
	end := func(reason string) {
		_ = k.send(ctx, protocol.TypeLogsEnd, func(h protocol.Header) any {
			return logsEndFrame{Header: h, RequestID: frame.RequestID, Error: reason}
		})
	}
	if c.Logs == nil || len(frame.RequestID) == 0 || len(frame.RequestID) > 64 {
		end("this server does not stream logs")
		return
	}
	streamCtx, cancel := context.WithCancel(ctx)
	if !k.addLogs(frame.RequestID, cancel) {
		cancel()
		end("too many log streams are open")
		return
	}
	go func() {
		defer k.stopLogs(frame.RequestID)
		err := c.Logs(streamCtx, frame.ProjectID, frame.Tail, frame.Follow, func(lines []logs.Line) error {
			return k.send(streamCtx, protocol.TypeLogsChunk, func(h protocol.Header) any {
				return logsChunkFrame{Header: h, RequestID: frame.RequestID, Lines: lines}
			})
		})
		reason := ""
		if err != nil && streamCtx.Err() == nil {
			reason = err.Error()
		}
		end(reason)
	}()
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

type backupFrame struct {
	protocol.Header
	Backup backup.Request `json:"backup"`
}

type backupResultFrame struct {
	protocol.Header
	Result backup.Result `json:"result"`
}

// startBackup takes one backup. A request repeated after a reconnect gets
// the finished result again instead of a second dump.
func (c *Client) startBackup(ctx context.Context, req backup.Request) {
	c.backupMu.Lock()
	defer c.backupMu.Unlock()
	if done, seen := c.backups[req.BackupID]; seen {
		if done != nil {
			c.queueBackupResult(*done)
		}
		return
	}
	if c.Backups == nil {
		result := backup.Result{BackupID: req.BackupID, Error: "this server does not take backups"}
		c.backups[req.BackupID] = &result
		c.queueBackupResult(result)
		return
	}
	c.backups[req.BackupID] = nil
	go func() {
		result := c.Backups.Take(context.WithoutCancel(ctx), req)
		c.backupMu.Lock()
		c.backups[req.BackupID] = &result
		c.backupMu.Unlock()
		c.queueBackupResult(result)
	}()
}

func (c *Client) queueBackupResult(result backup.Result) {
	select {
	case c.backupResults <- result:
	default:
		c.Log.Warn("backup result dropped: queue full", "backup", result.BackupID)
	}
}

func (c *Client) forwardBackupResults(ctx context.Context, k *conn) {
	for {
		select {
		case <-ctx.Done():
			return
		case result := <-c.backupResults:
			err := k.send(ctx, protocol.TypeBackupResult, func(h protocol.Header) any {
				return backupResultFrame{Header: h, Result: result}
			})
			if err != nil {
				c.queueBackupResult(result) // the next connection sends it
				return
			}
		}
	}
}

type restoreFrame struct {
	protocol.Header
	Restore backup.RestoreRequest `json:"restore"`
}

type restoreResultFrame struct {
	protocol.Header
	Result backup.RestoreResult `json:"result"`
}

// startRestore puts one backup back. Asked twice, it answers with the result
// it already has rather than restoring the same data over itself again.
func (c *Client) startRestore(ctx context.Context, req backup.RestoreRequest) {
	c.backupMu.Lock()
	defer c.backupMu.Unlock()
	if done, seen := c.restores[req.RestoreID]; seen {
		if done != nil {
			c.queueRestoreResult(*done)
		}
		return
	}
	if c.Backups == nil {
		result := backup.RestoreResult{RestoreID: req.RestoreID, Error: "this server does not restore backups"}
		c.restores[req.RestoreID] = &result
		c.queueRestoreResult(result)
		return
	}
	c.restores[req.RestoreID] = nil
	go func() {
		result := c.Backups.Restore(context.WithoutCancel(ctx), req)
		c.backupMu.Lock()
		c.restores[req.RestoreID] = &result
		c.backupMu.Unlock()
		c.queueRestoreResult(result)
	}()
}

func (c *Client) queueRestoreResult(result backup.RestoreResult) {
	select {
	case c.restoreResults <- result:
	default:
		c.Log.Warn("restore result dropped: queue full", "restore", result.RestoreID)
	}
}

func (c *Client) forwardRestoreResults(ctx context.Context, k *conn) {
	for {
		select {
		case <-ctx.Done():
			return
		case result := <-c.restoreResults:
			err := k.send(ctx, protocol.TypeRestoreResult, func(h protocol.Header) any {
				return restoreResultFrame{Header: h, Result: result}
			})
			if err != nil {
				c.queueRestoreResult(result) // the next connection sends it
				return
			}
		}
	}
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

type offsiteCheckFrame struct {
	protocol.Header
	Check backup.CheckRequest `json:"check"`
}

type offsiteCheckResultFrame struct {
	protocol.Header
	Result backup.CheckResult `json:"result"`
}

// startOffsiteCheck proves the organization's offsite target from this
// server. Asked twice, it answers with the result it already has.
func (c *Client) startOffsiteCheck(ctx context.Context, req backup.CheckRequest) {
	c.backupMu.Lock()
	defer c.backupMu.Unlock()
	if done, seen := c.checks[req.CheckID]; seen {
		if done != nil {
			c.queueCheckResult(*done)
		}
		return
	}
	if c.Backups == nil {
		result := backup.CheckResult{CheckID: req.CheckID, Error: "this server does not take backups"}
		c.checks[req.CheckID] = &result
		c.queueCheckResult(result)
		return
	}
	c.checks[req.CheckID] = nil
	go func() {
		result := c.Backups.CheckOffsite(context.WithoutCancel(ctx), req)
		c.backupMu.Lock()
		c.checks[req.CheckID] = &result
		c.backupMu.Unlock()
		c.queueCheckResult(result)
	}()
}

func (c *Client) queueCheckResult(result backup.CheckResult) {
	select {
	case c.checkResults <- result:
	default:
		c.Log.Warn("offsite check result dropped: queue full", "check", result.CheckID)
	}
}

func (c *Client) forwardCheckResults(ctx context.Context, k *conn) {
	for {
		select {
		case <-ctx.Done():
			return
		case result := <-c.checkResults:
			err := k.send(ctx, protocol.TypeOffsiteCheckResult, func(h protocol.Header) any {
				return offsiteCheckResultFrame{Header: h, Result: result}
			})
			if err != nil {
				c.queueCheckResult(result) // the next connection sends it
				return
			}
		}
	}
}

type artifactFrame struct {
	protocol.Header
	Artifact backup.ArtifactRequest `json:"artifact"`
}

type artifactControlFrame struct {
	protocol.Header
	RequestID string `json:"requestId"`
}

type artifactChunkFrame struct {
	protocol.Header
	RequestID string `json:"requestId"`
	Data      string `json:"data"`
}

type artifactEndFrame struct {
	protocol.Header
	RequestID string `json:"requestId"`
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256,omitempty"`
	Error     string `json:"error,omitempty"`
}

// artifactSend is one download in progress: the credits the control plane has
// granted, and the way to stop it when the person closes the page.
type artifactSend struct {
	credits chan struct{}
	stop    context.CancelFunc
}

// startArtifact sends one backup back, paced by the control plane. A chunk
// leaves only against a credit, so a slow download cannot make this agent
// push a database's worth of bytes into a socket nobody is reading.
func (c *Client) startArtifact(ctx context.Context, k *conn, req backup.ArtifactRequest) {
	c.artifactMu.Lock()
	if c.artifacts == nil {
		c.artifacts = map[string]*artifactSend{}
	}
	if _, busy := c.artifacts[req.RequestID]; busy {
		c.artifactMu.Unlock()
		return
	}
	if c.Backups == nil {
		c.artifactMu.Unlock()
		c.sendArtifactEnd(ctx, k, artifactEndFrame{
			RequestID: req.RequestID,
			Error:     "this server does not keep backups",
		})
		return
	}
	sendCtx, cancel := context.WithCancel(ctx)
	send := &artifactSend{credits: make(chan struct{}, maxArtifactWindow), stop: cancel}
	for range initialArtifactWindow {
		send.credits <- struct{}{}
	}
	c.artifacts[req.RequestID] = send
	c.artifactMu.Unlock()

	go func() {
		defer cancel()
		defer func() {
			c.artifactMu.Lock()
			delete(c.artifacts, req.RequestID)
			c.artifactMu.Unlock()
		}()
		size, sum, err := c.Backups.Send(sendCtx, req, func(chunk []byte) error {
			select {
			case <-send.credits:
			case <-sendCtx.Done():
				return sendCtx.Err() //nolint:wrapcheck // the reason is the context's own
			}
			frame := artifactChunkFrame{
				RequestID: req.RequestID,
				Data:      base64.StdEncoding.EncodeToString(chunk),
			}
			return k.send(sendCtx, protocol.TypeArtifactChunk, func(h protocol.Header) any {
				frame.Header = h
				return frame
			})
		})
		end := artifactEndFrame{RequestID: req.RequestID, SizeBytes: size, SHA256: sum}
		if err != nil {
			end.SHA256 = ""
			end.Error = artifactReason(err)
		}
		c.sendArtifactEnd(ctx, k, end)
	}()
}

// artifactReason keeps the words a person reads free of Go's plumbing.
func artifactReason(err error) string {
	if errors.Is(err, context.Canceled) {
		return "the download was stopped"
	}
	if errors.Is(err, docker.ErrNoArtifact) {
		return docker.ErrNoArtifact.Error()
	}
	return "the backup could not be read from this server"
}

func (c *Client) sendArtifactEnd(ctx context.Context, k *conn, end artifactEndFrame) {
	if err := k.send(ctx, protocol.TypeArtifactEnd, func(h protocol.Header) any {
		end.Header = h
		return end
	}); err != nil {
		c.Log.Warn("a download could not be finished", "request", end.RequestID, "error", err)
	}
}

// grantArtifact lets one more chunk go, once the control plane has passed the
// last one on to whoever asked for it.
func (c *Client) grantArtifact(requestID string) {
	c.artifactMu.Lock()
	send := c.artifacts[requestID]
	c.artifactMu.Unlock()
	if send == nil {
		return
	}
	select {
	case send.credits <- struct{}{}:
	default: // the window is already full; nothing to grant
	}
}

func (c *Client) stopArtifact(requestID string) {
	c.artifactMu.Lock()
	send := c.artifacts[requestID]
	c.artifactMu.Unlock()
	if send != nil {
		send.stop()
	}
}
