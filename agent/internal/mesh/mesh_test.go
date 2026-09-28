package mesh

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

const (
	serverA  = "srv_01J9Z3Q8S7M2K4X6V1B5N0C9D8"
	serverB  = "srv_01J9Z3Q8S7M2K4X6V1B5N0C9E9"
	outsider = "srv_01J9Z3Q8S7M2K4X6V1B5N0C9F0"
	project  = "prj_01J9Z3Q8S7M2K4X6V1B5N0C9D8"
	database = "db_01J9Z3Q8S7M2K4X6V1B5N0C9D8"
)

func keypair(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return public, private
}

// fakeEngine stands in for Docker: one gateway per network, one address per
// container, both handed out by the test.
type fakeEngine struct {
	asked     []string
	gateway   string
	container string
	noNetwork bool
}

func (f *fakeEngine) NetworkGateway(_ context.Context, name string) (string, error) {
	if f.noNetwork {
		return "", errors.New("no such network")
	}
	f.asked = append(f.asked, name)
	return f.gateway, nil
}

func (f *fakeEngine) ContainerIP(context.Context, string, string) (string, error) {
	if f.container == "" {
		return "", errors.New("not running")
	}
	return f.container, nil
}

// echoService stands in for a database: it says back whatever it is told,
// so a test can tell that bytes really crossed.
func echoService(t *testing.T) (string, int) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = conn.Close() }()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	host, port, _ := net.SplitHostPort(listener.Addr().String())
	number, _ := strconv.Atoi(port)
	return host, number
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	return port
}

func ptr[T any](v T) *T { return &v }

/*
pair sets up both ends: B holds the service and hands it out to A, and A
offers it on a project network of its own. It is the whole arrangement in
one place, because the arrangement is the thing worth testing — each half
alone proves nothing.
*/
type pair struct {
	a, b       *Runner
	localPort  int
	localHost  string
	grantedTo  string
	aPublic    ed25519.PublicKey
	bPublic    ed25519.PublicKey
	listenPort int
}

func setup(t *testing.T, grantTo string) *pair {
	t.Helper()
	aPublic, aPrivate := keypair(t)
	bPublic, bPrivate := keypair(t)
	serviceHost, servicePort := echoService(t)
	listenPort := freePort(t)
	localPort := freePort(t)

	b := &Runner{
		Identity: Identity{ServerID: serverB, Key: bPrivate},
		Engine:   &fakeEngine{container: serviceHost},
	}
	b.Apply(context.Background(), spec.Mesh{
		Listen: ptr(listenPort),
		Peers:  []spec.MeshPeer{{ServerID: serverA, PublicKey: Encode(aPublic)}},
		Grants: []spec.MeshGrant{{DatabaseID: database, FromServerID: grantTo, Port: servicePort}},
	})
	t.Cleanup(b.Close)

	endpoint := net.JoinHostPort("127.0.0.1", strconv.Itoa(listenPort))
	a := &Runner{
		Identity: Identity{ServerID: serverA, Key: aPrivate},
		Engine:   &fakeEngine{gateway: "127.0.0.1"},
	}
	a.Apply(context.Background(), spec.Mesh{
		Peers: []spec.MeshPeer{{ServerID: serverB, PublicKey: Encode(bPublic), Endpoint: &endpoint}},
		Forwards: []spec.MeshForward{{
			ProjectID:  project,
			Alias:      "vd-db-x",
			ListenPort: localPort,
			ToServerID: serverB,
			DatabaseID: database,
		}},
	})
	t.Cleanup(a.Close)
	return &pair{
		a: a, b: b, localPort: localPort, localHost: "127.0.0.1",
		grantedTo: grantTo, aPublic: aPublic, bPublic: bPublic, listenPort: listenPort,
	}
}

// say opens the local end the way an app would — by dialling a name on its
// own network — and reports what came back.
func (p *pair) say(t *testing.T, message string) (string, error) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(p.localHost, strconv.Itoa(p.localPort)), 5*time.Second)
	if err != nil {
		return "", err
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte(message)); err != nil {
		return "", err
	}
	buf := make([]byte, len(message))
	if _, err := io.ReadFull(conn, buf); err != nil {
		return "", err
	}
	return string(buf), nil
}

func TestAnAppReachesADatabaseOnAnotherServer(t *testing.T) {
	p := setup(t, serverA)
	back, err := p.say(t, "select 1")
	if err != nil {
		t.Fatalf("nothing crossed: %v", err)
	}
	if back != "select 1" {
		t.Fatalf("got %q back", back)
	}
}

// The name is the whole of what the app is told, and it points at its own
// server: the app never learns that anything crossed a machine.
func TestTheAppIsToldOnlyAName(t *testing.T) {
	p := setup(t, serverA)
	hosts := p.a.Hosts(project)
	if len(hosts) != 1 || !strings.HasPrefix(hosts[0], "vd-db-x:") {
		t.Fatalf("a project was told %v", hosts)
	}
	if p.a.Hosts("prj_01J9Z3Q8S7M2K4X6V1B5N0C9E9") != nil {
		t.Fatal("another project was told about it too")
	}
}

/*
The refusal that matters: the server holding the data decides.

An agent that connected wherever it was asked would be an open proxy on a
machine somebody else's app runs on, so the grant is checked where the data
is — not where the request came from.
*/
func TestTheServerWithTheDataDecides(t *testing.T) {
	p := setup(t, outsider) // granted to somebody else entirely
	if _, err := p.say(t, "select 1"); err == nil {
		t.Fatal("a database was handed to a server that was not given it")
	}
}

// A perfectly valid certificate from a server this one has not been told
// about is still nobody.
func TestAStrangerIsRefused(t *testing.T) {
	p := setup(t, serverA)
	_, strangerKey := keypair(t)
	stranger := Identity{ServerID: outsider, Key: strangerKey}
	config, err := clientTLS(stranger, Encode(p.bPublic))
	if err != nil {
		t.Fatal(err)
	}
	conn, err := tlsDial(net.JoinHostPort("127.0.0.1", strconv.Itoa(p.listenPort)), config)
	if err == nil {
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
		err = writeJSON(conn, Request{DatabaseID: database})
		if err == nil {
			var reply Reply
			err = readJSON(conn, &reply)
		}
		_ = conn.Close()
	}
	if err == nil {
		t.Fatal("a server nobody had been told about was answered")
	}
}

// A peer that answers with a different key than the one the control plane
// named is not the server that was asked.
func TestAnImpostorEndpointIsRefused(t *testing.T) {
	p := setup(t, serverA)
	otherPublic, _ := keypair(t)
	endpoint := net.JoinHostPort("127.0.0.1", strconv.Itoa(p.listenPort))
	p.a.Apply(context.Background(), spec.Mesh{
		Peers: []spec.MeshPeer{{ServerID: serverB, PublicKey: Encode(otherPublic), Endpoint: &endpoint}},
		Forwards: []spec.MeshForward{{
			ProjectID:  project,
			Alias:      "vd-db-x",
			ListenPort: p.localPort,
			ToServerID: serverB,
			DatabaseID: database,
		}},
	})
	if _, err := p.say(t, "select 1"); err == nil {
		t.Fatal("a server that answered with the wrong key was talked to")
	}
}

// Applying the same thing twice changes nothing, and applying nothing
// closes what was open: the agent calls this on every pass.
func TestApplyingIsIdempotent(t *testing.T) {
	p := setup(t, serverA)
	before := p.a.Hosts(project)
	p.a.Apply(context.Background(), p.a.config)
	if len(p.a.Hosts(project)) != len(before) {
		t.Fatal("applying the same arrangement twice changed it")
	}
	if _, err := p.say(t, "still here"); err != nil {
		t.Fatalf("the forward stopped working: %v", err)
	}
	p.a.Apply(context.Background(), spec.Mesh{})
	if p.a.Hosts(project) != nil {
		t.Fatal("a forward that is no longer wanted is still open")
	}
}

// A project's network may not exist yet when its forward first appears.
// That is not an error; it is a pass that opens nothing and tries again.
func TestAForwardWaitsForItsNetwork(t *testing.T) {
	_, private := keypair(t)
	public, _ := keypair(t)
	endpoint := "127.0.0.1:1"
	a := &Runner{
		Identity: Identity{ServerID: serverA, Key: private},
		Engine:   &fakeEngine{noNetwork: true},
	}
	t.Cleanup(a.Close)
	config := spec.Mesh{
		Peers: []spec.MeshPeer{{ServerID: serverB, PublicKey: Encode(public), Endpoint: &endpoint}},
		Forwards: []spec.MeshForward{{
			ProjectID: project, Alias: "vd-db-x", ListenPort: freePort(t),
			ToServerID: serverB, DatabaseID: database,
		}},
	}
	a.Apply(context.Background(), config)
	if a.Hosts(project) != nil {
		t.Fatal("a forward opened on a network that does not exist")
	}
	// And once it does exist, the next pass opens it.
	a.Engine = &fakeEngine{gateway: "127.0.0.1"}
	a.Apply(context.Background(), config)
	if a.Hosts(project) == nil {
		t.Fatal("a forward never opened once its network appeared")
	}
}

func TestManyConnectionsAtOnce(t *testing.T) {
	p := setup(t, serverA)
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			message := "query " + strconv.Itoa(i)
			back, err := p.say(t, message)
			if err != nil {
				errs <- err
			} else if back != message {
				errs <- errors.New("crossed answers: " + back)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
}

// A peer taken out of the organization stops being let in, and stops on
// the next pass rather than on the next restart.
func TestARemovedPeerIsRefused(t *testing.T) {
	p := setup(t, serverA)
	if _, err := p.say(t, "while allowed"); err != nil {
		t.Fatalf("an allowed peer was refused: %v", err)
	}
	// B forgets A entirely: same grants, no peers.
	p.b.Apply(context.Background(), spec.Mesh{
		Listen: ptr(p.listenPort),
		Grants: []spec.MeshGrant{{DatabaseID: database, FromServerID: serverA, Port: 1}},
	})
	if _, err := p.say(t, "after removal"); err == nil {
		t.Fatal("a peer that was removed is still being answered")
	}
}

/*
The key check has to run on a **resumed** session too.

TLS 1.3 lets a client come back without a fresh certificate exchange, and
Go's client does exactly that by default — the second connection in this
test is a resumption, which is why the test asserts that before it asserts
anything else. A check written as VerifyPeerCertificate is not called on
those connections at all, so a peer removed from the organization would
keep completing handshakes. VerifyConnection runs either way.

The agent would still refuse such a peer a moment later, when it looks up
who is asking. This is the gate in front of that one, and it is tested on
its own because defence in depth that was never actually in depth is worth
knowing about.
*/
func TestTheKeyCheckRunsOnAResumedSession(t *testing.T) {
	aPublic, aPrivate := keypair(t)
	_, bPrivate := keypair(t)
	bPublic := bPrivate.Public().(ed25519.PublicKey)

	var mu sync.Mutex
	allowed := []string{Encode(aPublic)}
	config, err := serverTLS(Identity{ServerID: serverB, Key: bPrivate}, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), allowed...)
	})
	if err != nil {
		t.Fatal(err)
	}
	listener, err := tls.Listen("tcp", "127.0.0.1:0", config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = conn.Close() }()
				// Reading is what drives the handshake to completion.
				buf := make([]byte, 1)
				_, _ = conn.Read(buf)
				_, _ = conn.Write([]byte("x"))
			}()
		}
	}()

	client, err := clientTLS(Identity{ServerID: serverA, Key: aPrivate}, Encode(bPublic))
	if err != nil {
		t.Fatal(err)
	}
	client.ClientSessionCache = tls.NewLRUClientSessionCache(4)
	address := listener.Addr().String()

	knock := func() (bool, error) {
		conn, err := tls.Dial("tcp", address, client)
		if err != nil {
			return false, err
		}
		defer func() { _ = conn.Close() }()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		if _, err := conn.Write([]byte("?")); err != nil {
			return false, err
		}
		buf := make([]byte, 1)
		if _, err := io.ReadFull(conn, buf); err != nil {
			return conn.ConnectionState().DidResume, err
		}
		return conn.ConnectionState().DidResume, nil
	}

	if _, err := knock(); err != nil {
		t.Fatalf("an allowed peer was refused: %v", err)
	}
	// A second attempt, which must actually resume or this proves nothing.
	resumed, err := knock()
	if err != nil {
		t.Fatalf("an allowed peer was refused on its second visit: %v", err)
	}
	if !resumed {
		t.Skip("this Go version did not resume the session; nothing to prove here")
	}

	mu.Lock()
	allowed = nil
	mu.Unlock()
	if _, err := knock(); err == nil {
		t.Fatal("a removed peer resumed its way past the key check")
	}
}

/*
The sockets outlive the pass that opened them.

Apply is called from a reconciliation pass, and that pass has a deadline —
as it should, since a pass that never finishes is a server that stops
converging. But a socket opened with the pass's context dies with the
pass, so every connection arriving afterwards is dialled with a context
that was cancelled minutes ago: the app's request reaches the listener,
goes nowhere, and closes. Nothing in the agent says so; the app just sees
a connection that shut.

Every other test here passes a context that stays alive, which is exactly
why none of them noticed.
*/
func TestTheMeshOutlivesThePassThatOpenedIt(t *testing.T) {
	aPublic, aPrivate := keypair(t)
	bPublic, bPrivate := keypair(t)
	serviceHost, servicePort := echoService(t)
	listenPort := freePort(t)
	localPort := freePort(t)

	// One pass, with its own deadline, exactly as the reconciler does it.
	pass, endPass := context.WithCancel(context.Background())

	b := &Runner{
		Identity: Identity{ServerID: serverB, Key: bPrivate},
		Engine:   &fakeEngine{container: serviceHost},
	}
	b.Apply(pass, spec.Mesh{
		Listen: ptr(listenPort),
		Peers:  []spec.MeshPeer{{ServerID: serverA, PublicKey: Encode(aPublic)}},
		Grants: []spec.MeshGrant{{DatabaseID: database, FromServerID: serverA, Port: servicePort}},
	})
	t.Cleanup(b.Close)

	endpoint := net.JoinHostPort("127.0.0.1", strconv.Itoa(listenPort))
	a := &Runner{
		Identity: Identity{ServerID: serverA, Key: aPrivate},
		Engine:   &fakeEngine{gateway: "127.0.0.1"},
	}
	a.Apply(pass, spec.Mesh{
		Peers: []spec.MeshPeer{{ServerID: serverB, PublicKey: Encode(bPublic), Endpoint: &endpoint}},
		Forwards: []spec.MeshForward{{
			ProjectID: project, Alias: "vd-db-x", ListenPort: localPort,
			ToServerID: serverB, DatabaseID: database,
		}},
	})
	t.Cleanup(a.Close)

	// The pass is over. Everything it set up must still work.
	endPass()

	p := &pair{a: a, b: b, localHost: "127.0.0.1", localPort: localPort}
	back, err := p.say(t, "after the pass")
	if err != nil {
		t.Fatalf("the mesh stopped working when the pass that opened it ended: %v", err)
	}
	if back != "after the pass" {
		t.Fatalf("got %q back", back)
	}
}

/*
Whatever reaches a forward is a container, so a forward never binds the
loopback.

A container's 127.0.0.1 is its own, so binding there binds somewhere
nothing that matters can reach — and from a shell on the host it looks
perfectly fine, which is the worst way for it to be wrong. Each kind binds
the gateway of the network the thing that needs it is on: a project's own
network for a database, so only that project's containers can reach it,
and the default bridge for a router, which this machine's containers can
reach and the internet cannot.
*/
func TestAForwardBindsWhereTheThingThatNeedsItCanReach(t *testing.T) {
	_, private := keypair(t)
	public, _ := keypair(t)
	endpoint := "127.0.0.1:1"
	// The gateway is whatever Docker says; here it has to be bindable.
	engine := &fakeEngine{gateway: "127.0.0.1"}
	a := &Runner{Identity: Identity{ServerID: serverA, Key: private}, Engine: engine}
	t.Cleanup(a.Close)
	peer := []spec.MeshPeer{{ServerID: serverB, PublicKey: Encode(public), Endpoint: &endpoint}}

	a.Apply(context.Background(), spec.Mesh{
		Peers: peer,
		Forwards: []spec.MeshForward{
			{
				ProjectID: project, Alias: "vd-db-x", ListenPort: freePort(t),
				ToServerID: serverB, Kind: "database", DatabaseID: database,
			},
			{
				ProjectID: project, ListenPort: freePort(t),
				ToServerID: serverB, Kind: "router",
			},
		},
	})

	asked := strings.Join(engine.asked, " ")
	if !strings.Contains(asked, "vd-"+strings.ToLower(strings.TrimPrefix(project, "prj_"))) {
		t.Fatalf("a database was not offered on its project's own network: %v", engine.asked)
	}
	if !strings.Contains(asked, "bridge") {
		t.Fatalf("a router was not offered where this machine's containers can reach: %v", engine.asked)
	}
	// And the address a router is offered on is the one it says it is.
	if at := a.RouterAddress(serverB); !strings.HasPrefix(at, engine.gateway+":") {
		t.Fatalf("a router was offered at %q", at)
	}
}
