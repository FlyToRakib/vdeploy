package mesh

import (
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// dialTimeout bounds reaching another server. A peer that is down should
// fail an app's connection quickly rather than hold it open hoping.
const dialTimeout = 10 * time.Second

// Engine is what the mesh needs from Docker: where a project's containers
// can reach this host, and where this host can reach a database.
type Engine interface {
	NetworkGateway(ctx context.Context, name string) (string, error)
	ContainerIP(ctx context.Context, name, network string) (string, error)
}

// Runner keeps this server's end of the mesh matching what the control
// plane last said, and is the only thing that opens a socket.
type Runner struct {
	Identity Identity
	Engine   Engine
	Log      *slog.Logger

	mu       sync.Mutex
	config   spec.Mesh
	listen   net.Listener
	listenOn int
	forwards map[string]*forward
	/*
	 * base outlives the pass that opened these sockets.
	 *
	 * Apply is called from a reconciliation pass, and that pass has a
	 * deadline — as it should, since a pass that never finishes is a
	 * server that stops converging. But a socket opened with the pass's
	 * context dies with the pass, so every connection that arrived
	 * afterwards was dialled with a context that had already been
	 * cancelled: an app's request reached the listener, went nowhere, and
	 * closed. The sockets belong to the agent's lifetime, not to one pass.
	 */
	base context.Context
	stop context.CancelFunc
}

// forward is one remote service offered on one project's network.
type forward struct {
	spec     spec.MeshForward
	listener net.Listener
	address  string
	cancel   context.CancelFunc
}

func (r *Runner) logf(msg string, args ...any) {
	if r.Log != nil {
		r.Log.Warn(msg, args...)
	}
}

/*
Apply makes this server's end of the mesh match what the control plane
said, and is safe to call on every pass: it opens what is missing, closes
what is no longer wanted, and leaves alone what already matches.

Being idempotent is what makes it robust rather than clever. A project's
network may not exist yet when its forward first appears, and a peer may be
unreachable for an hour; both simply do not open this time and are tried
again on the next pass, with no retry schedule to get wrong.
*/
func (r *Runner) Apply(ctx context.Context, config spec.Mesh) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.base == nil {
		// Detached from this pass, and ended only by Close.
		r.base, r.stop = context.WithCancel(context.WithoutCancel(ctx))
	}
	r.config = config
	r.applyListener(r.base, config)
	r.applyForwards(r.base, config)
}

// Hosts is what a project's containers must be told, so that the name of a
// service on another server resolves to this agent (§13). It is the whole
// of what an app learns about the arrangement: a name, and an address on
// the network it is already on.
func (r *Runner) Hosts(projectID string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, f := range r.forwards {
		if f.spec.ProjectID == projectID && f.address != "" && f.spec.Alias != "" {
			out = append(out, f.spec.Alias+":"+f.address)
		}
	}
	return out
}

// Close gives up every socket: on shutdown, and when the agent is told the
// mesh is off.
func (r *Runner) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stop != nil {
		r.stop()
		r.base, r.stop = nil, nil
	}
	if r.listen != nil {
		_ = r.listen.Close()
		r.listen, r.listenOn = nil, 0
	}
	for key, f := range r.forwards {
		f.cancel()
		_ = f.listener.Close()
		delete(r.forwards, key)
	}
}

// ── accepting: the server that holds the data ──────────────────────────

func (r *Runner) applyListener(ctx context.Context, config spec.Mesh) {
	want := 0
	if config.Listen != nil {
		want = *config.Listen
	}
	if r.listenOn == want && (want == 0 || r.listen != nil) {
		return
	}
	if r.listen != nil {
		_ = r.listen.Close()
		r.listen, r.listenOn = nil, 0
	}
	if want == 0 {
		return
	}
	tlsConfig, err := serverTLS(r.Identity, r.peerKeys)
	if err != nil {
		r.logf("the mesh could not be started", "error", err)
		return
	}
	// The one inbound thing VDeploy ever asks for, and only when somebody
	// turned it on: a server listens here solely because it holds something
	// another of their servers needs.
	listener, err := tls.Listen("tcp", ":"+strconv.Itoa(want), tlsConfig)
	if err != nil {
		r.logf("the mesh port could not be opened", "port", want, "error", err)
		return
	}
	r.listen, r.listenOn = listener, want
	go r.accept(ctx, listener)
}

// peerKeys is read at handshake time rather than captured, so a peer
// removed from the organization stops being accepted on the next pass
// instead of on the next restart.
func (r *Runner) peerKeys() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	keys := make([]string, 0, len(r.config.Peers))
	for _, peer := range r.config.Peers {
		keys = append(keys, peer.PublicKey)
	}
	return keys
}

func (r *Runner) accept(ctx context.Context, listener net.Listener) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			return // the listener was closed, or is being replaced
		}
		go r.serve(ctx, conn)
	}
}

/*
serve answers one peer's request for one service.

The order is the point. Who is asking is settled by the handshake, before a
byte of the request is read; whether they may have it is settled here,
against this server's own grants, before anything is dialled. An agent that
connected wherever it was asked to would be an open proxy sitting on a
machine that runs somebody else's app.
*/
func (r *Runner) serve(ctx context.Context, conn net.Conn) {
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(handshakeTimeout))
	tlsConn, ok := conn.(*tls.Conn)
	if !ok {
		return
	}
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		return
	}
	from, err := r.who(tlsConn)
	if err != nil {
		return
	}
	var req Request
	if err := readJSON(conn, &req); err != nil {
		return
	}
	target, err := r.granted(ctx, from, req)
	if err != nil {
		_ = writeJSON(conn, Reply{Error: err.Error()})
		return
	}
	service, err := net.DialTimeout("tcp", target, dialTimeout)
	if err != nil {
		_ = writeJSON(conn, Reply{Error: "that service did not answer on its own server"})
		return
	}
	defer func() { _ = service.Close() }()
	if err := writeJSON(conn, Reply{OK: true}); err != nil {
		return
	}
	// Carrying bytes is not bounded: a database connection is held open for
	// hours, and a deadline here would cut somebody's query in half.
	_ = conn.SetDeadline(time.Time{})
	splice(ctx, conn, service)
}

// who is the peer that proved possession of a listed key. The name in the
// certificate is not consulted: a key matches one peer or none.
func (r *Runner) who(conn *tls.Conn) (string, error) {
	key, err := presented(conn.ConnectionState())
	if err != nil {
		return "", err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, peer := range r.config.Peers {
		if known, err := decode(peer.PublicKey); err == nil && known.Equal(key) {
			return peer.ServerID, nil
		}
	}
	return "", errors.New("that server is not one this one has been told about")
}

/*
granted says where to connect, or refuses in words.

A database is reached at its address on its **own** network — the one
nothing else joins — so nothing here makes it any more reachable than it
was. A router is reached on this host, where it already listens for the
internet; the machine in front of it is simply another caller.

Routing an edge's traffic to a server's own router rather than to its
replicas is the whole reason that second kind exists. That router already
knows which replicas are ready, what share a canary is taking and where a
sticky visitor belongs. None of it should be worked out twice, in two
places, from two views of the world that can disagree.
*/
func (r *Runner) granted(ctx context.Context, from string, req Request) (string, error) {
	kind := req.Kind
	if kind == "" {
		kind = subjectDatabase
	}
	r.mu.Lock()
	port := 0
	for _, grant := range r.config.Grants {
		if grant.FromServerID != from || subjectOf(grant.Kind) != kind {
			continue
		}
		if kind == subjectDatabase && grant.DatabaseID != req.DatabaseID {
			continue
		}
		port = grant.Port
		break
	}
	r.mu.Unlock()
	if port == 0 {
		return "", errors.New("that server has not been given this")
	}
	if kind == subjectRouter {
		return net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), nil
	}
	name := compose.DatabaseName(req.DatabaseID)
	address, err := r.Engine.ContainerIP(ctx, name, compose.DatabaseNetwork(req.DatabaseID))
	if err != nil {
		return "", errors.New("that database is not running on its server")
	}
	return net.JoinHostPort(address, strconv.Itoa(port)), nil
}

// subjectOf defaults a missing kind to a database, so a peer running an
// older agent still means what it used to mean.
func subjectOf(kind string) string {
	if kind == "" {
		return subjectDatabase
	}
	return kind
}

// ── offering: the server whose app needs it ────────────────────────────

func (r *Runner) applyForwards(ctx context.Context, config spec.Mesh) {
	if r.forwards == nil {
		r.forwards = map[string]*forward{}
	}
	wanted := map[string]spec.MeshForward{}
	for _, f := range config.Forwards {
		wanted[forwardKey(f)] = f
	}
	for key, open := range r.forwards {
		if _, keep := wanted[key]; keep {
			continue
		}
		open.cancel()
		_ = open.listener.Close()
		delete(r.forwards, key)
	}
	for key, want := range wanted {
		if _, already := r.forwards[key]; already {
			continue
		}
		r.open(ctx, key, want)
	}
}

func forwardKey(f spec.MeshForward) string {
	return f.ProjectID + "|" + f.Alias + "|" + strconv.Itoa(f.ListenPort)
}

// Routes is what this server should put in front of, when it is an edge.
func (r *Runner) Routes() []spec.EdgeRoute {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]spec.EdgeRoute(nil), r.config.Routes...)
}

/*
open starts listening for one remote service, on the gateway address of the
project's own network.

That address is the whole of the confinement, and it is worth being exact
about. It is reachable by the containers of this project and by nothing
else: not the host's other services, not another project on the same
machine, and not the internet. Binding to every interface would have been
one character shorter and would have published somebody's database to the
world.
*/
func (r *Runner) open(ctx context.Context, key string, want spec.MeshForward) {
	gateway := "127.0.0.1"
	if subjectOf(want.Kind) == subjectDatabase {
		// An app reaches it, so it is offered on that app's own network.
		found, err := r.Engine.NetworkGateway(ctx, compose.NetworkName(want.ProjectID))
		if err != nil {
			// The network may simply not exist yet: the next pass tries again.
			return
		}
		gateway = found
	}
	// A router's forward is reached by this machine's own Traefik, which is
	// on this machine: the loopback is as far as it needs to go, and any
	// wider a binding would publish another server's router to the world.
	address := net.JoinHostPort(gateway, strconv.Itoa(want.ListenPort))
	listener, err := net.Listen("tcp", address)
	if err != nil {
		r.logf("a service from another server could not be offered", "alias", want.Alias, "error", err)
		return
	}
	inner, cancel := context.WithCancel(ctx)
	r.forwards[key] = &forward{spec: want, listener: listener, address: gateway, cancel: cancel}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go r.carry(inner, want, conn)
		}
	}()
}

// carry takes one connection from a local app to the server that has what
// it is asking for.
func (r *Runner) carry(ctx context.Context, want spec.MeshForward, conn net.Conn) {
	defer func() { _ = conn.Close() }()
	remote, err := r.reach(ctx, want)
	if err != nil {
		// The app sees a connection that closed, which is what it would see
		// if the database were down — because from where it stands, it is.
		r.logf("a service on another server could not be reached",
			"alias", want.Alias, "server", want.ToServerID, "error", err)
		return
	}
	defer func() { _ = remote.Close() }()
	splice(ctx, conn, remote)
}

func (r *Runner) reach(ctx context.Context, want spec.MeshForward) (net.Conn, error) {
	r.mu.Lock()
	var endpoint, key string
	for _, peer := range r.config.Peers {
		if peer.ServerID == want.ToServerID {
			key = peer.PublicKey
			if peer.Endpoint != nil {
				endpoint = *peer.Endpoint
			}
		}
	}
	r.mu.Unlock()
	if endpoint == "" {
		return nil, errors.New("that server cannot be reached from here")
	}
	tlsConfig, err := clientTLS(r.Identity, key)
	if err != nil {
		return nil, err
	}
	dialer := &tls.Dialer{NetDialer: &net.Dialer{Timeout: dialTimeout}, Config: tlsConfig}
	conn, err := dialer.DialContext(ctx, "tcp", endpoint)
	if err != nil {
		return nil, fmt.Errorf("reach %s: %w", want.ToServerID, err)
	}
	_ = conn.SetDeadline(time.Now().Add(handshakeTimeout))
	if err := writeJSON(conn, Request{Kind: subjectOf(want.Kind), DatabaseID: want.DatabaseID}); err != nil {
		_ = conn.Close()
		return nil, err
	}
	var reply Reply
	if err := readJSON(conn, &reply); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if !reply.OK {
		_ = conn.Close()
		return nil, errors.New(reply.Error)
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, nil
}

// PublicKey is how this agent's identity is published to its peers.
func PublicKey(key ed25519.PrivateKey) string {
	public, ok := key.Public().(ed25519.PublicKey)
	if !ok {
		return ""
	}
	return Encode(public)
}
