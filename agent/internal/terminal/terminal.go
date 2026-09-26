// Package terminal opens an interactive shell in one of a project's own
// running containers (§19, §20.1).
//
// Everything else this agent does avoids exec entirely — backups run a
// sidecar over TCP rather than a command inside the database, and tasks run
// their own container. This is the single exception, and what makes it safe
// is what the request cannot say.
//
// A request names a project and a replica number. It cannot name a
// container, a command, a user, an environment or a privilege: the shell is
// a constant in the docker package, and the container is resolved here from
// the desired state this agent already holds. So a compromised control
// plane cannot turn "open a terminal" into "run this as root on the host",
// and a terminal can never be opened into something that is not a replica
// of a project this server was told to run.
package terminal

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strings"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// Request is one terminal somebody opened.
type Request struct {
	SessionID string `json:"sessionId"`
	ProjectID string `json:"projectId"`
	// Replica is which copy of the app, by index. Never a container name.
	Replica int `json:"replica"`
	Cols    int `json:"cols"`
	Rows    int `json:"rows"`
}

// Engine is what a terminal needs from Docker.
type Engine interface {
	ListManaged(ctx context.Context) ([]docker.Container, error)
	Exec(ctx context.Context, containerID string, cols, rows int) (net.Conn, string, error)
	ResizeExec(ctx context.Context, execID string, cols, rows int) error
	ExecFinished(ctx context.Context, execID string) (bool, int, error)
}

// Session is one open shell.
type Session struct {
	conn   net.Conn
	execID string
	engine Engine
}

// Runner opens terminals.
type Runner struct {
	Engine Engine
	// Projects is the desired state this agent holds, so a terminal can only
	// ever reach a container this server was told to run.
	Projects func(projectID string) (spec.DesiredProject, bool)
	Log      *slog.Logger
	// MaxSessions bounds how many shells are open at once; 0 means the default.
	MaxSessions int
}

// defaultMaxSessions bounds concurrent shells on one server.
const defaultMaxSessions = 4

// idleLimit closes a shell nobody has touched. A terminal left open is a
// way in that nobody is watching.
const idleLimit = 30 * time.Minute

// Open starts a shell in one replica of a project.
func (r *Runner) Open(ctx context.Context, req Request) (*Session, error) {
	if r.Projects == nil {
		return nil, errors.New("this server is not running anything yet")
	}
	project, known := r.Projects(req.ProjectID)
	if !known {
		return nil, errors.New("this server is not running that app")
	}
	name, err := r.replica(ctx, project, req.Replica)
	if err != nil {
		return nil, err
	}
	conn, execID, err := r.Engine.Exec(ctx, name, req.Cols, req.Rows)
	if err != nil {
		return nil, fmt.Errorf("open a terminal: %w", err)
	}
	return &Session{conn: conn, execID: execID, engine: r.Engine}, nil
}

/*
replica resolves which container the person meant, from what this server was
told to run — never from the request. A name that is not a replica of this
project is not reachable through here however it is spelled.
*/
func (r *Runner) replica(ctx context.Context, project spec.DesiredProject, index int) (string, error) {
	containers, err := compose.Plan(project)
	if err != nil || len(containers) == 0 {
		return "", errors.New("this app has no copies to open a terminal in")
	}
	if index < 0 || index >= len(containers) {
		return "", fmt.Errorf("this app has %d copies running", len(containers))
	}
	want := containers[index].Name
	running, err := r.Engine.ListManaged(ctx)
	if err != nil {
		return "", errors.New("the containers on this server could not be listed")
	}
	for _, c := range running {
		if c.Name != want {
			continue
		}
		if c.State != "running" {
			return "", errors.New("that copy of the app is not running")
		}
		// Belt and braces: it is a replica of this project, or it is nothing.
		if c.Labels[compose.ProjectLabel] != project.ProjectID {
			return "", errors.New("that container does not belong to this app")
		}
		return c.ID, nil
	}
	return "", errors.New("that copy of the app is not running")
}

// Read takes whatever the shell has printed.
func (s *Session) Read(p []byte) (int, error) {
	n, err := s.conn.Read(p)
	if err != nil && !errors.Is(err, io.EOF) {
		return n, fmt.Errorf("read from the terminal: %w", err)
	}
	return n, err //nolint:wrapcheck // EOF is the end, not a failure
}

// Write sends what the person typed.
func (s *Session) Write(p []byte) (int, error) {
	if err := s.conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return 0, fmt.Errorf("write to the terminal: %w", err)
	}
	n, err := s.conn.Write(p)
	if err != nil {
		return n, fmt.Errorf("write to the terminal: %w", err)
	}
	return n, nil
}

// Resize tells the shell how big the window is now.
func (s *Session) Resize(ctx context.Context, cols, rows int) error {
	if cols <= 0 || rows <= 0 || cols > 1000 || rows > 1000 {
		return errors.New("that is not a window size")
	}
	return s.engine.ResizeExec(ctx, s.execID, cols, rows)
}

// Idle is how long a shell may sit untouched before it is closed.
func Idle() time.Duration { return idleLimit }

// Limit is how many shells may be open on this server at once.
func (r *Runner) Limit() int {
	if r.MaxSessions > 0 {
		return r.MaxSessions
	}
	return defaultMaxSessions
}

// Close ends the shell. Whatever happened, the connection goes.
func (s *Session) Close() {
	_ = s.conn.Close()
}

// Ended reports whether the shell has exited, and with what code.
func (s *Session) Ended(ctx context.Context) (bool, int) {
	done, code, err := s.engine.ExecFinished(ctx, s.execID)
	if err != nil {
		return true, -1
	}
	return done, code
}

// Reason turns an ended shell into words a person reads.
func Reason(code int) string {
	switch {
	case code == 0:
		return "the session ended"
	case code < 0:
		return "the connection to the server was lost"
	default:
		return fmt.Sprintf("the shell exited (%d)", code)
	}
}

// Sanitise keeps a recording readable: terminals emit control sequences that
// mean nothing outside a terminal, and a recording is read by people.
func Sanitise(chunk []byte) string {
	return strings.ToValidUTF8(string(chunk), "")
}
