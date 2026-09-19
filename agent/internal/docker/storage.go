package docker

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
)

// WritableLayers is the size of each managed running container's writable
// layer: what it wrote outside its image and its permanent folders.
func (c *Client) WritableLayers(ctx context.Context) (map[string]int64, error) {
	var raw []struct {
		ID     string            `json:"Id"`
		SizeRw int64             `json:"SizeRw"`
		Labels map[string]string `json:"Labels"`
	}
	query := labelFilter(compose.ManagedLabel + "=true")
	query.Set("size", "1")
	if err := c.do(ctx, http.MethodGet, "/containers/json", query, nil, &raw); err != nil {
		return nil, err
	}
	out := make(map[string]int64, len(raw))
	for _, r := range raw {
		if r.Labels[compose.ManagedLabel] == "true" {
			out[r.ID] = r.SizeRw
		}
	}
	return out, nil
}

// AddedFiles lists paths a container added to its writable layer.
func (c *Client) AddedFiles(ctx context.Context, id string) ([]string, error) {
	var changes []struct {
		Path string `json:"Path"`
		Kind int    `json:"Kind"` // 0 modified, 1 added, 2 deleted
	}
	if err := c.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(id)+"/changes", nil, nil, &changes); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(changes))
	for _, ch := range changes {
		if ch.Kind == 1 {
			out = append(out, ch.Path)
		}
	}
	return out, nil
}

// CopyPath copies a folder out of one container into another (created, not
// yet started) container at the same path — how files an app already wrote
// move into a new permanent folder before the new replica starts.
func (c *Client) CopyPath(ctx context.Context, fromID, folder, toID string) (int64, error) {
	get, err := http.NewRequestWithContext(ctx, http.MethodGet,
		c.base+"/containers/"+url.PathEscape(fromID)+"/archive?"+url.Values{"path": {folder}}.Encode(), nil)
	if err != nil {
		return 0, fmt.Errorf("copy %s: %w", folder, err)
	}
	res, err := c.http.Do(get)
	if err != nil {
		return 0, fmt.Errorf("copy %s: %w", folder, err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, res.Body)
		return 0, nil // nothing was written there: nothing to keep
	}
	if res.StatusCode >= 300 {
		return 0, &APIError{Status: res.StatusCode, Message: "read " + folder}
	}
	counted := &countingReader{r: res.Body}
	// The archive's top entry is the folder itself: extract it into its parent.
	put, err := http.NewRequestWithContext(ctx, http.MethodPut,
		c.base+"/containers/"+url.PathEscape(toID)+"/archive?"+url.Values{"path": {path.Dir(folder)}}.Encode(), counted)
	if err != nil {
		return 0, fmt.Errorf("copy %s: %w", folder, err)
	}
	put.Header.Set("Content-Type", "application/x-tar")
	done, err := c.http.Do(put)
	if err != nil {
		return 0, fmt.Errorf("copy %s: %w", folder, err)
	}
	defer func() { _ = done.Body.Close() }()
	_, _ = io.Copy(io.Discard, done.Body)
	if done.StatusCode >= 300 {
		return counted.n, &APIError{Status: done.StatusCode, Message: "write " + folder}
	}
	return counted.n, nil
}

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err //nolint:wrapcheck // a pass-through reader
}
