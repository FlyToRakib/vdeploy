// Package transport keeps the agent connected to its control plane over an
// outbound wss:// connection (§25): no inbound port is ever opened on the
// server. Losing the connection changes nothing on the server (N6); the
// agent reconnects with backoff and resumes.
package transport

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/FlyToRakib/vdeploy/agent/internal/backup"
	"github.com/FlyToRakib/vdeploy/agent/internal/build"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"github.com/FlyToRakib/vdeploy/agent/internal/files"
	"github.com/FlyToRakib/vdeploy/agent/internal/identity"
	"github.com/FlyToRakib/vdeploy/agent/internal/image"
	"github.com/FlyToRakib/vdeploy/agent/internal/logs"
	"github.com/FlyToRakib/vdeploy/agent/internal/protocol"
	"github.com/FlyToRakib/vdeploy/agent/internal/reclaim"
	"github.com/FlyToRakib/vdeploy/agent/internal/reconcile"
	"github.com/FlyToRakib/vdeploy/agent/internal/task"
	"github.com/FlyToRakib/vdeploy/agent/internal/terminal"
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
	// Tasks runs one-off commands and scheduled jobs; nil refuses them.
	Tasks TaskRunner
	// Terminals opens a shell in a container; nil refuses terminal requests.
	Terminals TerminalOpener
	// Files looks inside a project's permanent folders; nil refuses to look.
	Files FileReader
	// Exports hands out an image this server built for another (§15); nil
	// means this server never builds for anybody else.
	Exports ImageKeeper
	// Images takes an image built on another server; nil refuses to run
	// anything this server did not build itself (ADR 0008).
	Images ImageLoader
	// Reclaim frees disk on this server; nil refuses to free anything.
	Reclaim DiskReclaimer
	// Updater replaces this agent with the build the control plane serves (§25); nil refuses.
	Updater Updater
	// Logs streams a project's container output; nil refuses log requests.
	Logs func(ctx context.Context, projectID string, tail int, follow bool, emit func([]logs.Line) error) error

	buildMu sync.Mutex
	builds  map[string]*build.Result // by build id: nil while running
	results chan build.Result

	backupMu        sync.Mutex
	backups         map[string]*backup.Result        // by backup id: nil while running
	restores        map[string]*backup.RestoreResult // by restore id: nil while running
	backupResults   chan backup.Result
	restoreResults  chan backup.RestoreResult
	checks          map[string]*backup.CheckResult // by check id: nil while running
	checkResults    chan backup.CheckResult
	verifies        map[string]*backup.VerifyResult // by check id: nil while running
	verifyResults   chan backup.VerifyResult
	snapshots       map[string]*backup.SnapshotResult // by snapshot id: nil while running
	snapshotResults chan backup.SnapshotResult
	tasks           map[string]*task.Result // by task id: nil while running
	taskResults     chan task.Result

	terminalMu sync.Mutex
	terminals  map[string]*terminal.Session // by session id, while a shell is open

	artifactMu sync.Mutex
	artifacts  map[string]*artifactSend // by request id, while a download is running
}

// BackupTaker takes one backup to completion, and puts one back.
type BackupTaker interface {
	Take(ctx context.Context, req backup.Request) backup.Result
	Restore(ctx context.Context, req backup.RestoreRequest) backup.RestoreResult
	CheckOffsite(ctx context.Context, req backup.CheckRequest) backup.CheckResult
	Send(ctx context.Context, req backup.ArtifactRequest, each func([]byte) error) (int64, string, error)
	Verify(ctx context.Context, req backup.VerifyRequest) backup.VerifyResult
	Snapshot(ctx context.Context, req backup.SnapshotRequest) backup.SnapshotResult
}

// FileReader looks inside a project's permanent folders (§20 Runtime).
type FileReader interface {
	List(ctx context.Context, req files.Request) files.Result
	Send(ctx context.Context, req files.Request, each func([]byte) error) (int64, string, error)
}

// DiskReclaimer frees disk without freeing anything anyone could need (§18).
type DiskReclaimer interface {
	Run(ctx context.Context, req reclaim.Request) reclaim.Result
}

// TerminalOpener opens an interactive shell in one of a project's containers.
type TerminalOpener interface {
	Open(ctx context.Context, req terminal.Request) (*terminal.Session, error)
	Limit() int
}

// TaskRunner runs one command for a project to completion.
type TaskRunner interface {
	Run(ctx context.Context, req task.Request) task.Result
}

// Builder runs one build to completion.
type Builder interface {
	Run(ctx context.Context, req build.Request) build.Result
}

// ImageKeeper holds images this server built for servers that will run
// them (§15), and hands each out exactly once.
type ImageKeeper interface {
	OpenExport(buildID string) (*os.File, int64, error)
	DropExport(buildID string)
}

// ImageLoader takes an image built elsewhere and makes it runnable here.
type ImageLoader interface {
	Load(ctx context.Context, req image.Arrival) image.Result
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
		c.verifyResults = make(chan backup.VerifyResult, 8)
		c.verifies = map[string]*backup.VerifyResult{}
		c.snapshotResults = make(chan backup.SnapshotResult, 8)
		c.snapshots = map[string]*backup.SnapshotResult{}
		c.taskResults = make(chan task.Result, 16)
		c.tasks = map[string]*task.Result{}
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
	// Every shell ends with the connection: a terminal nobody can reach is
	// a way in that nobody is watching.
	defer c.closeTerminals()
	go c.forwardReports(ctx, k)
	go c.forwardBuildResults(ctx, k)
	go c.forwardBackupResults(ctx, k)
	go c.forwardRestoreResults(ctx, k)
	go c.forwardCheckResults(ctx, k)
	go c.forwardVerifyResults(ctx, k)
	go c.forwardSnapshotResults(ctx, k)
	go c.forwardTaskResults(ctx, k)
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
	if head.Type == protocol.TypeUpdate {
		var frame updateFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		go c.selfUpdate(ctx, k, frame.Update.SHA256)
		return nil
	}
	if head.Type == protocol.TypeReclaim {
		var frame reclaimFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		go c.freeDisk(ctx, k, frame.Reclaim)
		return nil
	}
	switch head.Type {
	case protocol.TypeFiles:
		var frame filesFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		go c.listFiles(ctx, k, frame.Files)
		return nil
	case protocol.TypeFileRead:
		var frame filesFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		c.sendFile(ctx, k, frame.Files)
		return nil
	case protocol.TypeImageRead:
		var frame imageReadFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		c.sendImage(ctx, k, frame.Image)
		return nil
	case protocol.TypeImageLoad:
		var frame imageLoadFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		go c.takeImage(ctx, k, frame.Image)
		return nil
	case protocol.TypeArtifact:
		var frame artifactFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		req := frame.Artifact
		if c.Backups == nil {
			c.sendArtifactEnd(ctx, k, artifactEndFrame{
				RequestID: req.RequestID,
				Error:     "this server does not keep backups",
			})
			return nil
		}
		c.startArtifact(ctx, k, req.RequestID, "backup",
			func(sendCtx context.Context, each func([]byte) error) (int64, string, error) {
				return c.Backups.Send(sendCtx, req, each)
			})
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
	switch head.Type {
	case protocol.TypeTerminalOpen:
		var frame terminalOpenFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		go c.openTerminal(ctx, k, frame.Terminal)
		return nil
	case protocol.TypeTerminalInput:
		var frame terminalInputFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		typed, err := base64.StdEncoding.DecodeString(frame.Data)
		if err != nil {
			return fmt.Errorf("terminal input is not encoded properly")
		}
		c.typed(frame.SessionID, typed)
		return nil
	case protocol.TypeTerminalResize:
		var frame terminalResizeFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		c.resizeTerminal(ctx, frame.SessionID, frame.Cols, frame.Rows)
		return nil
	case protocol.TypeTerminalClose:
		var frame terminalCloseFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		go c.closeTerminal(context.WithoutCancel(ctx), k, frame.SessionID, "the session was closed")
		return nil
	}
	if head.Type == protocol.TypeTask {
		var frame taskFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		c.startTask(ctx, frame.Task)
		return nil
	}
	if head.Type == protocol.TypeSnapshot {
		var frame snapshotFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		c.startSnapshot(ctx, frame.Snapshot)
		return nil
	}
	if head.Type == protocol.TypeVerify {
		var frame verifyFrame
		if err := strictDecode(body, &frame); err != nil {
			return err
		}
		if err := k.session.Check(frame.Header); err != nil {
			return err
		}
		c.startVerify(ctx, frame.Verify)
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

// Updater replaces the running agent; it returns only if it could not.
type Updater interface {
	Apply(ctx context.Context, sha256 string) error
}

type updateFrame struct {
	protocol.Header
	Update struct {
		SHA256 string `json:"sha256"`
	} `json:"update"`
}

type updateResultFrame struct {
	protocol.Header
	SHA256 string `json:"sha256"`
	Error  string `json:"error"`
}

// selfUpdate becomes the build the control plane named. On success it
// never returns — the process is the new agent, which reconnects and says
// so in its hello. What it can report is only why it did not.
func (c *Client) selfUpdate(ctx context.Context, k *conn, sha string) {
	err := errors.New("this agent cannot update itself")
	if c.Updater != nil {
		c.Log.Info("updating to the agent the control plane serves", "sha256", sha)
		err = c.Updater.Apply(ctx, sha)
	}
	if err == nil {
		return // already that build
	}
	c.Log.Warn("could not update", "error", err)
	if sendErr := k.send(ctx, protocol.TypeUpdateResult, func(h protocol.Header) any {
		return updateResultFrame{Header: h, SHA256: sha, Error: err.Error()}
	}); sendErr != nil {
		c.Log.Warn("why the update failed could not be reported", "error", sendErr)
	}
}

type reclaimFrame struct {
	protocol.Header
	Reclaim reclaim.Request `json:"reclaim"`
}

type reclaimResultFrame struct {
	protocol.Header
	Result reclaim.Result `json:"result"`
}

// freeDisk frees what is safe to free and says what it actually freed. It
// takes minutes on a full server, so the answer comes as its own frame
// rather than holding anything open waiting for it.
func (c *Client) freeDisk(ctx context.Context, k *conn, req reclaim.Request) {
	result := reclaim.Result{
		RequestID: req.RequestID,
		At:        c.Now().UTC().Format(time.RFC3339),
		Error:     "this agent cannot free disk on this server",
	}
	if c.Reclaim != nil {
		result = c.Reclaim.Run(ctx, req)
	}
	if err := k.send(ctx, protocol.TypeReclaimResult, func(h protocol.Header) any {
		return reclaimResultFrame{Header: h, Result: result}
	}); err != nil {
		c.Log.Warn("what was freed could not be reported", "request", req.RequestID, "error", err)
	}
}

type filesFrame struct {
	protocol.Header
	Files files.Request `json:"files"`
}

type filesResultFrame struct {
	protocol.Header
	Result files.Result `json:"result"`
}

// listFiles answers with what is in one of a project's permanent folders. A
// listing is a question, not a change, so it is answered and forgotten: the
// agent keeps nothing about who looked at what.
func (c *Client) listFiles(ctx context.Context, k *conn, req files.Request) {
	result := files.Result{RequestID: req.RequestID, Entries: []files.Entry{}}
	if c.Files == nil {
		result.Error = "this agent cannot show you the files on this server"
	} else {
		result = c.Files.List(ctx, req)
	}
	if err := k.send(ctx, protocol.TypeFilesResult, func(h protocol.Header) any {
		return filesResultFrame{Header: h, Result: result}
	}); err != nil {
		c.Log.Warn("a folder listing could not be sent", "request", req.RequestID, "error", err)
	}
}

// sendFile hands one file out of a permanent folder back, on the same paced
// channel a backup uses.
func (c *Client) sendFile(ctx context.Context, k *conn, req files.Request) {
	if c.Files == nil {
		c.sendArtifactEnd(ctx, k, artifactEndFrame{
			RequestID: req.RequestID,
			Error:     "this agent cannot read the files on this server",
		})
		return
	}
	c.startArtifact(ctx, k, req.RequestID, "file",
		func(sendCtx context.Context, each func([]byte) error) (int64, string, error) {
			return c.Files.Send(sendCtx, req, each)
		})
}

type imageReadFrame struct {
	protocol.Header
	Image struct {
		RequestID string `json:"requestId"`
		BuildID   string `json:"buildId"`
	} `json:"image"`
}

type imageLoadFrame struct {
	protocol.Header
	Image image.Arrival `json:"image"`
}

type imageResultFrame struct {
	protocol.Header
	Result image.Result `json:"result"`
}

// sendImage hands an image this server built to the server that will run
// it, on the same paced channel a backup uses — an image is as big as a
// database and fills a small control plane in exactly the same way.
//
// The copy here is dropped as soon as it has gone out. The token that
// fetched it was good once, so a second reader would be a mistake, and a
// builder that keeps every image it has ever made is a builder that fills
// up. A build whose image did not survive the trip is one to run again.
func (c *Client) sendImage(ctx context.Context, k *conn, req struct {
	RequestID string `json:"requestId"`
	BuildID   string `json:"buildId"`
},
) {
	if c.Exports == nil {
		c.sendArtifactEnd(ctx, k, artifactEndFrame{
			RequestID: req.RequestID,
			Error:     "this server does not build for other servers",
		})
		return
	}
	file, size, err := c.Exports.OpenExport(req.BuildID)
	if err != nil {
		c.sendArtifactEnd(ctx, k, artifactEndFrame{RequestID: req.RequestID, Error: err.Error()})
		return
	}
	c.startArtifact(ctx, k, req.RequestID, "image",
		func(_ context.Context, each func([]byte) error) (int64, string, error) {
			defer func() {
				_ = file.Close()
				c.Exports.DropExport(req.BuildID)
			}()
			sum := sha256.New()
			buf := make([]byte, files.ChunkBytes)
			for {
				n, readErr := file.Read(buf)
				if n > 0 {
					sum.Write(buf[:n])
					if sendErr := each(buf[:n]); sendErr != nil {
						return 0, "", sendErr
					}
				}
				if errors.Is(readErr, io.EOF) {
					break
				}
				if readErr != nil {
					return 0, "", fmt.Errorf("read the kept image: %w", readErr)
				}
			}
			return size, hex.EncodeToString(sum.Sum(nil)), nil
		})
}

// takeImage loads an image built on another server, and says whether this
// server can now run it. The deploy waiting on the build is waiting on
// this answer, so a failure is a sentence rather than a silence.
func (c *Client) takeImage(ctx context.Context, k *conn, req image.Arrival) {
	result := image.Result{
		BuildID: req.BuildID,
		Error:   "this agent cannot take an image built on another server",
	}
	if c.Images != nil {
		result = c.Images.Load(ctx, req)
	}
	if err := k.send(ctx, protocol.TypeImageResult, func(h protocol.Header) any {
		return imageResultFrame{Header: h, Result: result}
	}); err != nil {
		c.Log.Warn("an arrived image could not be reported", "build", req.BuildID, "error", err)
	}
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

// startArtifact sends one file back, paced by the control plane. A chunk
// leaves only against a credit, so a slow download cannot make this agent
// push a database's worth of bytes into a socket nobody is reading.
//
// What is being sent — a backup out of the store, or a file out of an app's
// permanent folder — is the `read` it is given; the pacing is the same, and
// so is the promise that the last chunk is held until the whole thing hashes
// to what the agent read.
func (c *Client) startArtifact(
	ctx context.Context,
	k *conn,
	requestID string,
	what string,
	read func(ctx context.Context, each func([]byte) error) (int64, string, error),
) {
	c.artifactMu.Lock()
	if c.artifacts == nil {
		c.artifacts = map[string]*artifactSend{}
	}
	if _, busy := c.artifacts[requestID]; busy {
		c.artifactMu.Unlock()
		return
	}
	sendCtx, cancel := context.WithCancel(ctx)
	send := &artifactSend{credits: make(chan struct{}, maxArtifactWindow), stop: cancel}
	for range initialArtifactWindow {
		send.credits <- struct{}{}
	}
	c.artifacts[requestID] = send
	c.artifactMu.Unlock()

	go func() {
		defer cancel()
		defer func() {
			c.artifactMu.Lock()
			delete(c.artifacts, requestID)
			c.artifactMu.Unlock()
		}()
		size, sum, err := read(sendCtx, func(chunk []byte) error {
			select {
			case <-send.credits:
			case <-sendCtx.Done():
				return sendCtx.Err() //nolint:wrapcheck // the reason is the context's own
			}
			frame := artifactChunkFrame{
				RequestID: requestID,
				Data:      base64.StdEncoding.EncodeToString(chunk),
			}
			// The write itself uses the connection's context, never this
			// download's: a cancelled write would take the whole connection
			// down with it, and a stopped download must cost nothing else.
			return k.send(ctx, protocol.TypeArtifactChunk, func(h protocol.Header) any {
				frame.Header = h
				return frame
			})
		})
		end := artifactEndFrame{RequestID: requestID, SizeBytes: size, SHA256: sum}
		if err != nil {
			end.SHA256 = ""
			end.Error = artifactReason(err, what)
		}
		c.sendArtifactEnd(ctx, k, end)
	}()
}

// artifactReason keeps the words a person reads free of Go's plumbing.
func artifactReason(err error, what string) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "the download was stopped"
	case errors.Is(err, docker.ErrNoArtifact):
		return docker.ErrNoArtifact.Error()
	case errors.Is(err, files.ErrNoFile):
		return files.ErrNoFile.Error()
	}
	return "the " + what + " could not be read from this server"
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

type verifyFrame struct {
	protocol.Header
	Verify backup.VerifyRequest `json:"verify"`
}

type verifyResultFrame struct {
	protocol.Header
	Result backup.VerifyResult `json:"result"`
}

// startVerify proves one backup by putting it back. Asked twice, it answers
// with the result it already has rather than standing up a second engine.
func (c *Client) startVerify(ctx context.Context, req backup.VerifyRequest) {
	c.backupMu.Lock()
	defer c.backupMu.Unlock()
	if done, seen := c.verifies[req.VerifyID]; seen {
		if done != nil {
			c.queueVerifyResult(*done)
		}
		return
	}
	if c.Backups == nil {
		result := backup.VerifyResult{VerifyID: req.VerifyID, Error: "this server does not keep backups"}
		c.verifies[req.VerifyID] = &result
		c.queueVerifyResult(result)
		return
	}
	c.verifies[req.VerifyID] = nil
	go func() {
		result := c.Backups.Verify(context.WithoutCancel(ctx), req)
		c.backupMu.Lock()
		c.verifies[req.VerifyID] = &result
		c.backupMu.Unlock()
		c.queueVerifyResult(result)
	}()
}

func (c *Client) queueVerifyResult(result backup.VerifyResult) {
	select {
	case c.verifyResults <- result:
	default:
		c.Log.Warn("restore check result dropped: queue full", "check", result.VerifyID)
	}
}

func (c *Client) forwardVerifyResults(ctx context.Context, k *conn) {
	for {
		select {
		case <-ctx.Done():
			return
		case result := <-c.verifyResults:
			err := k.send(ctx, protocol.TypeVerifyResult, func(h protocol.Header) any {
				return verifyResultFrame{Header: h, Result: result}
			})
			if err != nil {
				c.queueVerifyResult(result) // the next connection sends it
				return
			}
		}
	}
}

type snapshotFrame struct {
	protocol.Header
	Snapshot backup.SnapshotRequest `json:"snapshot"`
}

type snapshotResultFrame struct {
	protocol.Header
	Result backup.SnapshotResult `json:"result"`
}

// startSnapshot takes one snapshot of a project's permanent folders, or puts
// one back. Asked twice, it answers with the result it already has rather
// than writing the same files over themselves again.
func (c *Client) startSnapshot(ctx context.Context, req backup.SnapshotRequest) {
	c.backupMu.Lock()
	defer c.backupMu.Unlock()
	if done, seen := c.snapshots[req.SnapshotID]; seen {
		if done != nil {
			c.queueSnapshotResult(*done)
		}
		return
	}
	if c.Backups == nil {
		result := backup.SnapshotResult{
			SnapshotID: req.SnapshotID,
			Error:      "this server does not keep backups",
		}
		c.snapshots[req.SnapshotID] = &result
		c.queueSnapshotResult(result)
		return
	}
	c.snapshots[req.SnapshotID] = nil
	go func() {
		result := c.Backups.Snapshot(context.WithoutCancel(ctx), req)
		c.backupMu.Lock()
		c.snapshots[req.SnapshotID] = &result
		c.backupMu.Unlock()
		c.queueSnapshotResult(result)
	}()
}

func (c *Client) queueSnapshotResult(result backup.SnapshotResult) {
	select {
	case c.snapshotResults <- result:
	default:
		c.Log.Warn("snapshot result dropped: queue full", "snapshot", result.SnapshotID)
	}
}

func (c *Client) forwardSnapshotResults(ctx context.Context, k *conn) {
	for {
		select {
		case <-ctx.Done():
			return
		case result := <-c.snapshotResults:
			err := k.send(ctx, protocol.TypeSnapshotResult, func(h protocol.Header) any {
				return snapshotResultFrame{Header: h, Result: result}
			})
			if err != nil {
				c.queueSnapshotResult(result) // the next connection sends it
				return
			}
		}
	}
}

type taskFrame struct {
	protocol.Header
	Task task.Request `json:"task"`
}

type taskResultFrame struct {
	protocol.Header
	Result task.Result `json:"result"`
}

// startTask runs one command for a project. Asked twice, it answers with the
// result it already has: a scheduled job must not run twice because a
// connection dropped between the run and the answer.
func (c *Client) startTask(ctx context.Context, req task.Request) {
	c.backupMu.Lock()
	defer c.backupMu.Unlock()
	if done, seen := c.tasks[req.TaskID]; seen {
		if done != nil {
			c.queueTaskResult(*done)
		}
		return
	}
	if c.Tasks == nil {
		result := task.Result{TaskID: req.TaskID, ExitCode: -1, Error: "this server does not run tasks"}
		c.tasks[req.TaskID] = &result
		c.queueTaskResult(result)
		return
	}
	c.tasks[req.TaskID] = nil
	go func() {
		result := c.Tasks.Run(context.WithoutCancel(ctx), req)
		c.backupMu.Lock()
		c.tasks[req.TaskID] = &result
		c.backupMu.Unlock()
		c.queueTaskResult(result)
	}()
}

func (c *Client) queueTaskResult(result task.Result) {
	select {
	case c.taskResults <- result:
	default:
		c.Log.Warn("task result dropped: queue full", "task", result.TaskID)
	}
}

func (c *Client) forwardTaskResults(ctx context.Context, k *conn) {
	for {
		select {
		case <-ctx.Done():
			return
		case result := <-c.taskResults:
			err := k.send(ctx, protocol.TypeTaskResult, func(h protocol.Header) any {
				return taskResultFrame{Header: h, Result: result}
			})
			if err != nil {
				c.queueTaskResult(result) // the next connection sends it
				return
			}
		}
	}
}

type terminalOpenFrame struct {
	protocol.Header
	Terminal terminal.Request `json:"terminal"`
}

type terminalInputFrame struct {
	protocol.Header
	SessionID string `json:"sessionId"`
	Data      string `json:"data"`
}

type terminalResizeFrame struct {
	protocol.Header
	SessionID string `json:"sessionId"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
}

type terminalCloseFrame struct {
	protocol.Header
	SessionID string `json:"sessionId"`
}

type terminalOutputFrame struct {
	protocol.Header
	SessionID string `json:"sessionId"`
	Data      string `json:"data"`
}

type terminalEndFrame struct {
	protocol.Header
	SessionID string `json:"sessionId"`
	Reason    string `json:"reason"`
}

// openTerminal starts one shell and pumps its output back until it ends.
func (c *Client) openTerminal(ctx context.Context, k *conn, req terminal.Request) {
	c.terminalMu.Lock()
	if c.terminals == nil {
		c.terminals = map[string]*terminal.Session{}
	}
	if _, busy := c.terminals[req.SessionID]; busy {
		c.terminalMu.Unlock()
		return
	}
	if c.Terminals == nil {
		c.terminalMu.Unlock()
		c.endTerminal(ctx, k, req.SessionID, "this server does not open terminals")
		return
	}
	if len(c.terminals) >= c.Terminals.Limit() {
		c.terminalMu.Unlock()
		c.endTerminal(ctx, k, req.SessionID, "too many terminals are open on this server already")
		return
	}
	c.terminalMu.Unlock()

	session, err := c.Terminals.Open(ctx, req)
	if err != nil {
		c.endTerminal(ctx, k, req.SessionID, err.Error())
		return
	}
	c.terminalMu.Lock()
	c.terminals[req.SessionID] = session
	c.terminalMu.Unlock()

	go func() {
		defer c.closeTerminal(context.WithoutCancel(ctx), k, req.SessionID, "")
		buffer := make([]byte, 8192)
		for {
			n, readErr := session.Read(buffer)
			if n > 0 {
				out := terminalOutputFrame{
					SessionID: req.SessionID,
					Data:      base64.StdEncoding.EncodeToString(buffer[:n]),
				}
				if err := k.send(ctx, protocol.TypeTerminalOutput, func(h protocol.Header) any {
					out.Header = h
					return out
				}); err != nil {
					return
				}
			}
			if readErr != nil {
				return
			}
		}
	}()
}

// closeTerminal ends one session and says why, once.
func (c *Client) closeTerminal(ctx context.Context, k *conn, sessionID, reason string) {
	c.terminalMu.Lock()
	session := c.terminals[sessionID]
	delete(c.terminals, sessionID)
	c.terminalMu.Unlock()
	if session == nil {
		return
	}
	if reason == "" {
		ended, code := session.Ended(ctx)
		if ended {
			reason = terminal.Reason(code)
		} else {
			reason = "the session was closed"
		}
	}
	session.Close()
	c.endTerminal(ctx, k, sessionID, reason)
}

func (c *Client) endTerminal(ctx context.Context, k *conn, sessionID, reason string) {
	frame := terminalEndFrame{SessionID: sessionID, Reason: reason}
	if err := k.send(ctx, protocol.TypeTerminalEnd, func(h protocol.Header) any {
		frame.Header = h
		return frame
	}); err != nil {
		c.Log.Warn("a terminal could not be closed cleanly", "session", sessionID, "error", err)
	}
}

// typed sends what the person typed to the shell.
func (c *Client) typed(sessionID string, data []byte) {
	c.terminalMu.Lock()
	session := c.terminals[sessionID]
	c.terminalMu.Unlock()
	if session == nil {
		return
	}
	if _, err := session.Write(data); err != nil {
		c.Log.Warn("a terminal would not take input", "session", sessionID, "error", err)
	}
}

func (c *Client) resizeTerminal(ctx context.Context, sessionID string, cols, rows int) {
	c.terminalMu.Lock()
	session := c.terminals[sessionID]
	c.terminalMu.Unlock()
	if session == nil {
		return
	}
	if err := session.Resize(ctx, cols, rows); err != nil {
		c.Log.Warn("a terminal would not resize", "session", sessionID, "error", err)
	}
}

// closeTerminals ends every shell when the connection goes: a terminal
// nobody can reach is a way in that nobody is watching.
func (c *Client) closeTerminals() {
	c.terminalMu.Lock()
	open := c.terminals
	c.terminals = map[string]*terminal.Session{}
	c.terminalMu.Unlock()
	for _, session := range open {
		session.Close()
	}
}
