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
	_ "embed"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

//go:embed desired_state.schema.json
var desiredStateSchema []byte

// Protocol is the desired-state protocol version this agent speaks.
const Protocol = 1

// DesiredState is everything one server should be running.
type DesiredState struct {
	Protocol   int              `json:"protocol"`
	ServerID   string           `json:"serverId"`
	Generation int64            `json:"generation"`
	Projects   []DesiredProject `json:"projects"`
}

// DesiredProject is one project as the agent must converge it: a whole release.
type DesiredProject struct {
	ProjectID      string      `json:"projectId"`
	ReleaseID      string      `json:"releaseId"`
	ReleaseVersion int         `json:"releaseVersion"`
	Spec           Application `json:"spec"`
	Image          string      `json:"image"`
	Running        bool        `json:"running"`
	// Revision is bumped to replace every container without a new release.
	Revision int `json:"revision"`
	// Hosts the control plane assigned beyond the spec's own domains.
	Hosts Hosts `json:"hosts"`
	// Secrets are the values this release uses, each sealed to this agent's key.
	Secrets []Secret `json:"secrets"`
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
	Type    string `json:"type"`
	Path    string `json:"path,omitempty"`
	Timeout string `json:"timeout"`
}

// Health says how to know a replica is ready for traffic.
type Health struct {
	Startup *Probe `json:"startup,omitempty"`
}

// Deploy is how a new release replaces the old one.
type Deploy struct {
	Strategy    string `json:"strategy"`
	DrainPeriod string `json:"drainPeriod"`
	// ReleaseCommand runs once per release before its replicas start.
	ReleaseCommand []string `json:"releaseCommand,omitempty"`
	ReleaseTimeout string   `json:"releaseTimeout"`
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
	ContainerPort int          `json:"containerPort"`
	Domains       []Domain     `json:"domains"`
	Middleware    Middleware   `json:"middleware"`
	LoadBalancer  LoadBalancer `json:"loadBalancer"`
}

// Domain is one hostname routed to the application.
type Domain struct {
	Host string `json:"host"`
	TLS  struct {
		Provider string `json:"provider"`
	} `json:"tls"`
	Paths []string `json:"paths"`
}

// Middleware shapes traffic on its way in.
type Middleware struct {
	RateLimit *struct {
		Average int `json:"average"`
		Burst   int `json:"burst"`
	} `json:"rateLimit,omitempty"`
	Compression bool     `json:"compression"`
	IPAllowList []string `json:"ipAllowList"`
	Headers     struct {
		HSTS      bool `json:"hsts"`
		FrameDeny bool `json:"frameDeny"`
	} `json:"headers"`
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
