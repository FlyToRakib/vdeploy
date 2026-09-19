package reconcile

import (
	"bufio"
	"context"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// §32: the control plane explains failures from facts, not guesses. For a
// replica that is not serving, the agent gathers what a person would look
// at — whether it is running, how it exited, whether the kernel killed it
// for memory, what it listens on, and its last words — without ever
// executing anything inside the container.

const (
	evidenceEvery = 10 * time.Second
	lastOutputMax = 2048
)

// ReplicaEvidence is what the agent saw of one replica that is not serving.
type ReplicaEvidence struct {
	Container string `json:"container"`
	State     string `json:"state"`
	ExitCode  *int   `json:"exitCode"`
	OOMKilled bool   `json:"oomKilled"`
	Restarts  int    `json:"restarts"`
	// Listening is every address:port the app listens on (nil when unknown).
	Listening  []string `json:"listening"`
	LastOutput string   `json:"lastOutput"`
}

// Inspector is what gathering evidence needs from Docker.
type Inspector interface {
	Facts(ctx context.Context, id string) (docker.ContainerFacts, error)
	LastOutput(ctx context.Context, id string, lines int) (string, error)
}

// ProcRoot is where the host's /proc is; tests point it elsewhere.
var ProcRoot = "/proc"

// listening reads the TCP sockets a process listens on from its network
// namespace, the same table `ss -ltn` reads.
func listening(pid int) ([]string, error) {
	var out []string
	for _, table := range []string{"tcp", "tcp6"} {
		f, err := os.Open(fmt.Sprintf("%s/%d/net/%s", ProcRoot, pid, table)) // #nosec G304 -- a fixed /proc path
		if err != nil {
			if table == "tcp6" {
				continue // no IPv6 in this container
			}
			return nil, fmt.Errorf("read sockets: %w", err)
		}
		scanner := bufio.NewScanner(f)
		scanner.Scan() // header
		for scanner.Scan() {
			fields := strings.Fields(scanner.Text())
			if len(fields) < 4 || fields[3] != "0A" { // 0A = LISTEN
				continue
			}
			if address, ok := decodeAddress(fields[1]); ok && !contains(out, address) {
				out = append(out, address)
			}
		}
		_ = f.Close()
	}
	return out, nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// decodeAddress turns /proc's "0100007F:0BB8" into "127.0.0.1:3000". The
// address is little-endian per 32-bit word; the port is big-endian.
func decodeAddress(field string) (string, bool) {
	host, portHex, ok := strings.Cut(field, ":")
	if !ok {
		return "", false
	}
	port, err := strconv.ParseUint(portHex, 16, 16)
	if err != nil {
		return "", false
	}
	raw, err := hex.DecodeString(host)
	if err != nil || (len(raw) != 4 && len(raw) != 16) {
		return "", false
	}
	ip := make(net.IP, len(raw))
	for word := 0; word < len(raw); word += 4 {
		for i := range 4 {
			ip[word+i] = raw[word+3-i]
		}
	}
	return net.JoinHostPort(ip.String(), strconv.FormatUint(port, 10)), true
}

// gatherEvidence looks at each replica of a project that is not serving,
// at most every evidenceEvery per container.
func (p *pass) gatherEvidence(ctx context.Context, project spec.DesiredProject, result *ProjectState) {
	r := p.r
	if r.Inspector == nil || !project.Running {
		return
	}
	if r.evidence == nil {
		r.evidence = map[string]evidenceCache{}
	}
	for _, replica := range result.Replicas {
		if replica.State == StateReady || replica.State == "missing" {
			delete(r.evidence, replica.Name)
			continue
		}
		existing, ok := p.existing[replica.Name]
		if !ok {
			continue
		}
		cached, seen := r.evidence[replica.Name]
		// Looked at again when the replica's state changes (starting → unhealthy),
		// or after a while: evidence from before it failed would name the wrong cause.
		if !seen || cached.evidence.State != replica.State || r.now().Sub(cached.at) >= evidenceEvery {
			cached = evidenceCache{at: r.now(), evidence: collect(ctx, r.Inspector, existing.ID, replica)}
			r.evidence[replica.Name] = cached
		}
		result.Evidence = append(result.Evidence, cached.evidence)
	}
}

type evidenceCache struct {
	at       time.Time
	evidence ReplicaEvidence
}

func collect(ctx context.Context, inspector Inspector, id string, replica Replica) ReplicaEvidence {
	evidence := ReplicaEvidence{Container: replica.Name, State: replica.State}
	facts, err := inspector.Facts(ctx, id)
	if err != nil {
		return evidence
	}
	evidence.OOMKilled = facts.OOMKilled
	evidence.Restarts = facts.Restarts
	if !facts.Running {
		code := facts.ExitCode
		evidence.ExitCode = &code
	} else if facts.Pid > 0 {
		if sockets, err := listening(facts.Pid); err == nil {
			evidence.Listening = sockets
			if evidence.Listening == nil {
				evidence.Listening = []string{}
			}
		}
	}
	if output, err := inspector.LastOutput(ctx, id, 20); err == nil {
		if len(output) > lastOutputMax {
			output = output[len(output)-lastOutputMax:]
		}
		evidence.LastOutput = output
	}
	return evidence
}
