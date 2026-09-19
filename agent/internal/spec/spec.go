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
}

// Application is the subset of the Application spec the agent acts on.
// Every other field was still validated by the schema.
type Application struct {
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Runtime Runtime  `json:"runtime"`
	Network *Network `json:"network,omitempty"`
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
}

// Volume is a permanent folder: a named volume the agent owns.
type Volume struct {
	Name      string `json:"name"`
	MountPath string `json:"mountPath"`
}

// Network is how traffic reaches the application.
type Network struct {
	ContainerPort int `json:"containerPort"`
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
