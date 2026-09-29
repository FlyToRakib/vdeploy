// Package spec decodes desired-state frames from the control plane.
//
// A frame is first validated against the JSON Schema generated from
// packages/contracts (strict: no unknown field survives anywhere), and only
// then decoded into the Go types the agent acts on. The agent never accepts
// a container specification: it receives Application specs and composes
// every Docker call itself.
package spec

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

//go:embed desired_state.schema.json
var desiredStateSchema []byte

// SchemaSHA256 names the contract this agent reads desired state against.
// The control plane hashes the same bytes, so equal means every field it
// may send is one this agent knows (§25).
func SchemaSHA256() string {
	sum := sha256.Sum256(desiredStateSchema)
	return hex.EncodeToString(sum[:])
}

// Protocol is the desired-state protocol version this agent speaks.
const Protocol = 2

// AcmeDNS is the organization's DNS provider, for certificates proved
// through DNS (§13): its credentials sealed to this agent.
type AcmeDNS struct {
	Provider string          `json:"provider"`
	Env      []SealedSetting `json:"env"`
}

// SealedSetting is one named value, sealed to this agent.
type SealedSetting struct {
	Key    string `json:"key"`
	Sealed string `json:"sealed"`
}

// DesiredState is everything one server should be running.
type DesiredState struct {
	Protocol   int              `json:"protocol"`
	ServerID   string           `json:"serverId"`
	Generation int64            `json:"generation"`
	Projects   []DesiredProject `json:"projects"`
	AcmeDNS    *AcmeDNS         `json:"acmeDns,omitempty"`
	// Databases are the managed databases this server runs (§17.3). A
	// database is not a project: it is never deployed blue/green, because two
	// engines on one volume is how data is lost.
	Databases []DesiredDatabase `json:"databases"`
	// Mesh is private traffic to and from this organization's other servers
	// (§13, ADR 0018). An install with one server never sees it.
	Mesh Mesh `json:"mesh"`
}

// Mesh is this server's end of the private traffic between an
// organization's own servers.
type Mesh struct {
	// Listen is the port to accept peers on; nil accepts nothing, which is
	// the default and the common case. A server listens only because it
	// holds something another of their servers reaches.
	Listen *int `json:"listen"`
	// Peers are the other servers this one may talk to, by the same signing
	// key the control plane knows them by (ADR 0004).
	Peers []MeshPeer `json:"peers"`
	// Forwards are services on other servers, offered here under the name
	// they would have if they were local.
	Forwards []MeshForward `json:"forwards"`
	// Grants are what this server hands out, and to whom. The answer lives
	// with the server that owns the data, not the one that wants it.
	Grants []MeshGrant `json:"grants"`
	// Routes are the apps this server fronts, when it is an edge (§13).
	// Empty on every other server, which is most of them.
	Routes []EdgeRoute `json:"routes"`
}

// EdgeRoute is one app as the machine in front of it needs to know it: the
// hostnames, what they want doing to them, and which app server to hand
// the request to. Never what the app is, and never anything it holds.
type EdgeRoute struct {
	ProjectID  string  `json:"projectId"`
	Network    Network `json:"network"`
	Hosts      Hosts   `json:"hosts"`
	ToServerID string  `json:"toServerId"`
	// ListenPort reaches that server's own router, through the mesh.
	ListenPort int `json:"listenPort"`
}

// MeshPeer is another server, and how to reach it.
type MeshPeer struct {
	ServerID  string `json:"serverId"`
	PublicKey string `json:"publicKey"`
	// Endpoint is host:port to dial, or nil for a peer that only accepts.
	Endpoint *string `json:"endpoint"`
}

// MeshForward is one service on another server, offered on a project's own
// network under the name it would have if it were local. An edge's forward
// carries no alias and joins no project network: it is reached by the
// router on this machine, not by an app.
type MeshForward struct {
	ProjectID  string `json:"projectId"`
	Alias      string `json:"alias"`
	ListenPort int    `json:"listenPort"`
	ToServerID string `json:"toServerId"`
	// Kind is what is being asked for: a database, or a server's own router.
	Kind       string `json:"kind"`
	DatabaseID string `json:"databaseId,omitempty"`
}

// MeshGrant is one thing this server hands out, and the server allowed to
// have it.
type MeshGrant struct {
	Kind         string `json:"kind"`
	DatabaseID   string `json:"databaseId,omitempty"`
	FromServerID string `json:"fromServerId"`
	Port         int    `json:"port"`
}

// DesiredDatabase is one managed database as the agent must run it.
type DesiredDatabase struct {
	DatabaseID string `json:"databaseId"`
	Name       string `json:"name"`
	Engine     string `json:"engine"`
	Image      string `json:"image"`
	Port       int    `json:"port"`
	DataPath   string `json:"dataPath"`
	Env        []struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	} `json:"env"`
	// Credentials are environment values sealed to this agent's key.
	Credentials []struct {
		Key     string `json:"key"`
		Version int    `json:"version"`
		Sealed  string `json:"sealed"`
	} `json:"credentials"`
	MemoryBytes int64   `json:"memoryBytes"`
	CPU         float64 `json:"cpu"`
	Running     bool    `json:"running"`
	Revision    int     `json:"revision"`
	// PublicPort also publishes it on the server, when a person opened one.
	PublicPort int `json:"publicPort,omitempty"`
	// LinkedProjects may reach it: their networks are joined to its own.
	LinkedProjects []string `json:"linkedProjects"`
}

// DesiredProject is one project as the agent must converge it: a whole release.
type DesiredProject struct {
	ProjectID      string      `json:"projectId"`
	ReleaseID      string      `json:"releaseId"`
	ReleaseVersion int         `json:"releaseVersion"`
	Spec           Application `json:"spec"`
	Image          string      `json:"image"`
	// ImageFrom names the project this image was built for, when that is
	// not this one: promoting a staging copy runs the same bytes under a
	// different name (ADR 0021). The agent still runs only images it
	// built itself — this says which of its own records may vouch.
	ImageFrom string `json:"imageFrom,omitempty"`
	// Promoted takes every request at once, whatever the canary says: a
	// person ended it early, or this is a release gone back to (§7).
	Promoted bool `json:"promoted,omitempty"`
	// PullAuth signs in to a private registry for this project's image (§15),
	// its password sealed to this agent under the project.
	PullAuth *PullAuth `json:"pullAuth,omitempty"`
	Running  bool      `json:"running"`
	// Revision is bumped to replace every container without a new release.
	Revision int `json:"revision"`
	// Hosts the control plane assigned beyond the spec's own domains.
	Hosts Hosts `json:"hosts"`
	// Secrets are the values this release uses, each sealed to this agent's key.
	Secrets []Secret `json:"secrets"`
}

// PullAuth is a registry sign-in for one project's image.
type PullAuth struct {
	Username string `json:"username"`
	Sealed   string `json:"sealed"`
}

// Secret is one secret value sealed to this agent (package sealed opens it).
type Secret struct {
	ID      string `json:"id"`
	Version int    `json:"version"`
	Sealed  string `json:"sealed"`
}

// Hosts are a project's instant URL (§13.1) and the earlier ones that
// redirect to it.
type Hosts struct {
	Instant   string   `json:"instant"`
	Redirects []string `json:"redirects"`
	// Verified hosts point here in DNS: the only ones a certificate may be requested for.
	Verified []string `json:"verified"`
	// Twins are a domain's www or bare twin, sent on to it (§30 ⑤).
	Twins []Twin `json:"twins"`
	// InstantWildcard is the base domain whose wildcard certificate covers
	// the instant URL, proved through DNS (§13.1).
	InstantWildcard string `json:"instantWildcard,omitempty"`
}

// Twin is one name that sends its visitors to another the app answers on.
type Twin struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// Application is the subset of the Application spec the agent acts on.
// Every other field was still validated by the schema.
type Application struct {
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Runtime Runtime  `json:"runtime"`
	Network *Network `json:"network,omitempty"`
	Health  Health   `json:"health"`
	Deploy  Deploy   `json:"deploy"`
}

// Probe checks one replica: an HTTP GET or a TCP connect.
type Probe struct {
	Type     string `json:"type"`
	Path     string `json:"path,omitempty"`
	Timeout  string `json:"timeout"`
	Interval string `json:"interval"`
	// FailureThreshold is how many checks in a row must fail before it counts.
	FailureThreshold int `json:"failureThreshold"`
}

// Health says how to know a replica is ready for traffic (§18). Startup
// gates a new replica; after that, readiness takes one out of the pool
// and puts it back, and liveness restarts one that stopped answering.
type Health struct {
	Startup   *Probe `json:"startup,omitempty"`
	Liveness  *Probe `json:"liveness,omitempty"`
	Readiness *Probe `json:"readiness,omitempty"`
}

// Deploy is how a new release replaces the old one.
type Deploy struct {
	Strategy    string `json:"strategy"`
	DrainPeriod string `json:"drainPeriod"`
	// Canary is the stepped rollout (§16); absent means switch all at once.
	Canary *Canary `json:"canary,omitempty"`
	// ReleaseCommand runs once per release before its replicas start.
	ReleaseCommand []string `json:"releaseCommand,omitempty"`
	ReleaseTimeout string   `json:"releaseTimeout"`
}

// Canary is how much traffic the new release takes, and when it stops.
type Canary struct {
	// Steps are the shares of traffic to walk through, 1–99.
	Steps []int `json:"steps"`
	// StepDuration is how long each share serves before the next.
	StepDuration string `json:"stepDuration"`
	// AutoRollbackErrorRate is the share of failed requests that ends it.
	AutoRollbackErrorRate float64 `json:"autoRollbackErrorRate"`
}

// Runtime is how the application's containers run.
type Runtime struct {
	Replicas        int       `json:"replicas"`
	Command         []string  `json:"command"`
	User            string    `json:"user,omitempty"`
	Resources       Resources `json:"resources"`
	RestartPolicy   string    `json:"restartPolicy"`
	StopGracePeriod string    `json:"stopGracePeriod"`
	Env             []EnvVar  `json:"env"`
	Volumes         []Volume  `json:"volumes"`
}

// Resources are the CPU and memory requests and limits.
type Resources struct {
	CPU struct {
		Request float64 `json:"request"`
		Limit   float64 `json:"limit"`
	} `json:"cpu"`
	Memory struct {
		Request string `json:"request"`
		Limit   string `json:"limit"`
	} `json:"memory"`
}

// EnvVar is an environment variable: a plain value, or a reference to a
// secret the agent cannot resolve yet and therefore refuses.
type EnvVar struct {
	Key       string `json:"key"`
	Value     string `json:"value"`
	SecretRef string `json:"secretRef,omitempty"`
	Version   int    `json:"version,omitempty"`
}

// Volume is a permanent folder: a named volume the agent owns.
type Volume struct {
	Name      string `json:"name"`
	MountPath string `json:"mountPath"`
}

// Network is how traffic reaches the application.
type Network struct {
	ContainerPort int `json:"containerPort"`
	// Protocol is "http", or "tcp" for an app the router passes bytes to (§13).
	Protocol     string       `json:"protocol"`
	Domains      []Domain     `json:"domains"`
	Redirects    []MovedPath  `json:"redirects"`
	Middleware   Middleware   `json:"middleware"`
	LoadBalancer LoadBalancer `json:"loadBalancer"`
}

// MovedPath sends a path, and everything under it, somewhere else (§13).
type MovedPath struct {
	From      string `json:"from"`
	To        string `json:"to"`
	Permanent bool   `json:"permanent"`
}

// RateLimitBy is whom a rate limit counts: each address ("ip"), or a header.
type RateLimitBy struct {
	Header string
}

// UnmarshalJSON reads "ip" or {"header": "X-Api-Key"}.
func (b *RateLimitBy) UnmarshalJSON(data []byte) error {
	if string(data) == `"ip"` {
		b.Header = ""
		return nil
	}
	var byHeader struct {
		Header string `json:"header"`
	}
	if err := json.Unmarshal(data, &byHeader); err != nil {
		return fmt.Errorf("rate limit by: %w", err)
	}
	b.Header = byHeader.Header
	return nil
}

// Auth is basic auth, whose password hashes arrive as a sealed secret, or
// a forward-auth service that answers for every request (§13).
type Auth struct {
	Type               string   `json:"type"`
	SecretRef          string   `json:"secretRef,omitempty"`
	Version            int      `json:"version,omitempty"`
	Realm              string   `json:"realm,omitempty"`
	Address            string   `json:"address,omitempty"`
	TrustForwardHeader bool     `json:"trustForwardHeader,omitempty"`
	ResponseHeaders    []string `json:"responseHeaders,omitempty"`
}

// Domain is one hostname routed to the application.
type Domain struct {
	Host string `json:"host"`
	TLS  struct {
		Provider string `json:"provider"`
		// Challenge is how its certificate is proved: "http-01" or "dns-01".
		Challenge string `json:"challenge"`
	} `json:"tls"`
	Paths []string `json:"paths"`
	// Wildcard is the base domain whose one wildcard certificate covers
	// this name (§13.1); set by the agent, never sent.
	Wildcard string `json:"-"`
}

// Middleware shapes traffic on its way in.
type Middleware struct {
	RateLimit *struct {
		Average int         `json:"average"`
		Burst   int         `json:"burst"`
		By      RateLimitBy `json:"by"`
	} `json:"rateLimit,omitempty"`
	Compression bool     `json:"compression"`
	IPAllowList []string `json:"ipAllowList"`
	// IPDenyList is turned away before it matches any route (§13).
	IPDenyList []string `json:"ipDenyList"`
	// Auth is who has to prove themselves before the app is reached.
	Auth    *Auth `json:"auth,omitempty"`
	Headers struct {
		HSTS      bool `json:"hsts"`
		FrameDeny bool `json:"frameDeny"`
	} `json:"headers"`
	// Custom are Traefik's own middlewares, applied last (§20).
	Custom []CustomMiddleware `json:"custom"`
}

/*
CustomMiddleware is one of Traefik's own middlewares, with Traefik's own
field names: the escape hatch (§20). Exactly one field is set.

These types are the whole of what reaches the router, on purpose. Traefik
refuses every routing file on the server over one field it does not know,
so nothing is passed through that is not named here — and a type that
could reach past this app (chain, errors, plugins, anything reading a
file) is not here to be named.
*/
type CustomMiddleware struct {
	Headers     *CustomHeaders `json:"headers,omitempty"`
	StripPrefix *struct {
		Prefixes []string `json:"prefixes"`
	} `json:"stripPrefix,omitempty"`
	StripPrefixRegex *struct {
		Regex []string `json:"regex"`
	} `json:"stripPrefixRegex,omitempty"`
	AddPrefix *struct {
		Prefix string `json:"prefix"`
	} `json:"addPrefix,omitempty"`
	ReplacePath *struct {
		Path string `json:"path"`
	} `json:"replacePath,omitempty"`
	ReplacePathRegex *struct {
		Regex       string `json:"regex"`
		Replacement string `json:"replacement"`
	} `json:"replacePathRegex,omitempty"`
	InFlightReq *struct {
		Amount int64 `json:"amount"`
	} `json:"inFlightReq,omitempty"`
	Buffering *struct {
		MaxRequestBodyBytes  int64 `json:"maxRequestBodyBytes,omitempty"`
		MemRequestBodyBytes  int64 `json:"memRequestBodyBytes,omitempty"`
		MaxResponseBodyBytes int64 `json:"maxResponseBodyBytes,omitempty"`
		MemResponseBodyBytes int64 `json:"memResponseBodyBytes,omitempty"`
	} `json:"buffering,omitempty"`
}

// CustomHeaders sets headers and CORS, as Traefik's headers middleware.
type CustomHeaders struct {
	CustomRequestHeaders          map[string]string `json:"customRequestHeaders,omitempty"`
	CustomResponseHeaders         map[string]string `json:"customResponseHeaders,omitempty"`
	AccessControlAllowCredentials bool              `json:"accessControlAllowCredentials,omitempty"`
	AccessControlAllowHeaders     []string          `json:"accessControlAllowHeaders,omitempty"`
	AccessControlAllowMethods     []string          `json:"accessControlAllowMethods,omitempty"`
	AccessControlAllowOriginList  []string          `json:"accessControlAllowOriginList,omitempty"`
	AccessControlExposeHeaders    []string          `json:"accessControlExposeHeaders,omitempty"`
	AccessControlMaxAge           int64             `json:"accessControlMaxAge,omitempty"`
	AddVaryHeader                 bool              `json:"addVaryHeader,omitempty"`
	ContentSecurityPolicy         string            `json:"contentSecurityPolicy,omitempty"`
	PermissionsPolicy             string            `json:"permissionsPolicy,omitempty"`
	ReferrerPolicy                string            `json:"referrerPolicy,omitempty"`
}

// LoadBalancer spreads traffic across replicas.
type LoadBalancer struct {
	Sticky struct {
		Enabled bool   `json:"enabled"`
		Cookie  string `json:"cookie"`
	} `json:"sticky"`
	HealthCheck *struct {
		Path     string `json:"path"`
		Interval string `json:"interval"`
		Timeout  string `json:"timeout"`
	} `json:"healthCheck,omitempty"`
	// CircuitBreaker stops sending to replicas that are failing, as a
	// Traefik expression the control plane validated.
	CircuitBreaker string `json:"circuitBreaker,omitempty"`
	// Retry sends a request that got nowhere to another replica.
	Retry *struct {
		Attempts int `json:"attempts"`
	} `json:"retry,omitempty"`
	// ResponseTimeout is how long a replica has to start answering.
	ResponseTimeout string `json:"responseTimeout,omitempty"`
}

var (
	compileOnce sync.Once
	compiled    *jsonschema.Schema
	compileErr  error
)

func schema() (*jsonschema.Schema, error) {
	compileOnce.Do(func() {
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(desiredStateSchema))
		if err != nil {
			compileErr = fmt.Errorf("read embedded schema: %w", err)
			return
		}
		c := jsonschema.NewCompiler()
		if err := c.AddResource("desired_state.schema.json", doc); err != nil {
			compileErr = fmt.Errorf("load embedded schema: %w", err)
			return
		}
		compiled, compileErr = c.Compile("desired_state.schema.json")
		if compileErr != nil {
			compileErr = fmt.Errorf("compile embedded schema: %w", compileErr)
		}
	})
	return compiled, compileErr
}

// Decode validates a desired-state frame against the contract schema and
// decodes it. Anything the schema does not describe is refused.
func Decode(frame []byte) (*DesiredState, error) {
	s, err := schema()
	if err != nil {
		return nil, err
	}
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(frame))
	if err != nil {
		return nil, fmt.Errorf("desired state is not JSON: %w", err)
	}
	if err := s.Validate(doc); err != nil {
		return nil, fmt.Errorf("desired state does not match the contract: %w", err)
	}
	var state DesiredState
	if err := json.Unmarshal(frame, &state); err != nil {
		return nil, fmt.Errorf("decode desired state: %w", err)
	}
	if state.Protocol != Protocol {
		return nil, fmt.Errorf("unsupported protocol %d", state.Protocol)
	}
	return &state, nil
}
