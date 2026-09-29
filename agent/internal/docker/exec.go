package docker

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
)

/*
An interactive shell in a running container (§19, §20.1).

This is the one place the platform needs exec at all, and the shape of it is
the control: the caller names a container, and nothing else. There is no
field for a command, a user, an environment or a privilege — the shell below
is a constant in this file, so "open a terminal" can never become "run an
arbitrary command as root". The control plane cannot widen it, and neither
can anything that reaches the control plane.
*/

/*
shell is what a terminal runs: bash where an image has it, sh where it
does not. It is fixed here and never comes from a frame. Bash is looked
for before it is run: an exec that fails ends a non-interactive shell on
the spot, so "exec bash || exec sh" never reaches sh — on an image
without bash, such as any Alpine one, the terminal ended at once.
*/
var shell = []string{"/bin/sh", "-c", "if command -v bash >/dev/null 2>&1; then exec bash; fi; exec /bin/sh"}

// Exec opens an interactive shell in one container and hands back the raw
// duplex stream. The caller closes it when the person leaves.
func (c *Client) Exec(ctx context.Context, containerID string, cols, rows int) (net.Conn, string, error) {
	body := map[string]any{
		"AttachStdin":  true,
		"AttachStdout": true,
		"AttachStderr": true,
		"Tty":          true,
		"Cmd":          shell,
	}
	var created struct {
		ID string `json:"Id"`
	}
	path := "/containers/" + url.PathEscape(containerID) + "/exec"
	if err := c.do(ctx, http.MethodPost, path, nil, body, &created); err != nil {
		return nil, "", fmt.Errorf("open a terminal: %w", err)
	}
	conn, err := c.hijack(ctx, "/exec/"+url.PathEscape(created.ID)+"/start",
		map[string]any{"Detach": false, "Tty": true})
	if err != nil {
		return nil, "", err
	}
	if cols > 0 && rows > 0 {
		_ = c.ResizeExec(ctx, created.ID, cols, rows)
	}
	return conn, created.ID, nil
}

// ResizeExec tells the shell how big the window is, so what it draws fits.
func (c *Client) ResizeExec(ctx context.Context, execID string, cols, rows int) error {
	query := url.Values{"h": {strconv.Itoa(rows)}, "w": {strconv.Itoa(cols)}}
	return c.do(ctx, http.MethodPost, "/exec/"+url.PathEscape(execID)+"/resize", query, nil, nil)
}

// ExecFinished reports whether the shell has exited, and with what.
func (c *Client) ExecFinished(ctx context.Context, execID string) (bool, int, error) {
	var out struct {
		Running  bool `json:"Running"`
		ExitCode *int `json:"ExitCode"`
	}
	if err := c.do(ctx, http.MethodGet, "/exec/"+url.PathEscape(execID)+"/json", nil, nil, &out); err != nil {
		return false, 0, fmt.Errorf("terminal state: %w", err)
	}
	if out.Running {
		return false, 0, nil
	}
	code := 0
	if out.ExitCode != nil {
		code = *out.ExitCode
	}
	return true, code, nil
}

/*
hijack takes over the connection for a stream Docker upgrades rather than
answers. The request is written by hand because Go's client would buffer and
close it: a terminal needs the socket itself, in both directions, for as long
as the person is there.
*/
func (c *Client) hijack(ctx context.Context, path string, body any) (net.Conn, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("open a terminal: %w", err)
	}
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "unix", c.socket)
	if err != nil {
		return nil, fmt.Errorf("reach the container engine: %w", err)
	}
	request := fmt.Sprintf(
		"POST /%s%s HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n"+
			"Connection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: %d\r\n\r\n%s",
		APIVersion, path, len(payload), payload,
	)
	if _, err := conn.Write([]byte(request)); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("open a terminal: %w", err)
	}
	reader := bufio.NewReader(conn)
	res, err := http.ReadResponse(reader, nil)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("open a terminal: %w", err)
	}
	if res.StatusCode != http.StatusSwitchingProtocols && res.StatusCode != http.StatusOK {
		_ = conn.Close()
		return nil, &APIError{Status: res.StatusCode, Message: "open a terminal"}
	}
	// Anything the reader already buffered belongs to the stream.
	return &bufferedConn{Conn: conn, reader: reader}, nil
}

// bufferedConn hands back the bytes the response reader read ahead of itself.
type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (b *bufferedConn) Read(p []byte) (int, error) {
	return b.reader.Read(p) //nolint:wrapcheck // a pass-through stream
}
