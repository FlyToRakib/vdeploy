package docker

import (
	"archive/tar"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
)

// ArtifactChunkBytes is how much of a file is read at a time. It matches the
// control plane's frame size, so nothing is buffered on either side.
const ArtifactChunkBytes = 256 * 1024

// ReadVolumeFile streams one file out of a named volume.
//
// It creates a container and never starts it: Docker's copy endpoint reads a
// stopped container's filesystem, so handing a backup back needs no process,
// no shell and no path on the host. The file arrives as a tar stream, which
// is unwrapped here — the caller sees bytes.
func (c *Client) ReadVolumeFile(
	ctx context.Context,
	name, image, volume, mountPath, file string,
	each func([]byte) error,
) (int64, error) {
	if err := c.EnsureImage(ctx, image); err != nil {
		return 0, fmt.Errorf("image: %w", err)
	}
	created, err := c.createStopped(ctx, name, image, volume, mountPath)
	if err != nil {
		return 0, err
	}
	defer func() {
		_ = c.do(context.WithoutCancel(ctx), http.MethodDelete, "/containers/"+created,
			url.Values{"force": {"true"}}, nil, nil)
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		c.base+"/containers/"+url.PathEscape(created)+"/archive?"+
			url.Values{"path": {mountPath + "/" + file}}.Encode(), nil)
	if err != nil {
		return 0, fmt.Errorf("read %s: %w", file, err)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return 0, fmt.Errorf("read %s: %w", file, err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode == http.StatusNotFound {
		return 0, ErrNoArtifact
	}
	if res.StatusCode >= 300 {
		return 0, &APIError{Status: res.StatusCode, Message: "read " + file}
	}
	return copyOneFile(res.Body, each)
}

// ErrNoArtifact means the file is not in the store any more.
var ErrNoArtifact = errors.New("the backup file is no longer on this server")

// createStopped makes a container with the store mounted and never starts it.
// Docker's copy endpoints read and write a stopped container's filesystem, so
// moving a file in or out needs no process at all.
func (c *Client) createStopped(ctx context.Context, name, image, volume, mountPath string) (string, error) {
	body := helperCreate{
		Image:      image,
		Entrypoint: []string{"/bin/sh"},
		Cmd:        []string{"-c", "exit 0"},
		Env:        []string{},
		Labels:     map[string]string{InfraLabel: "artifact"},
		HostConfig: helperHostConfig{
			Mounts:      []mount{{Type: "volume", Source: volume, Target: mountPath}},
			NetworkMode: "none",
			SecurityOpt: []string{"no-new-privileges:true"},
			LogConfig:   logConfig{Type: "json-file", Config: map[string]string{"max-size": "1m", "max-file": "1"}},
		},
	}
	var created struct {
		ID string `json:"Id"`
	}
	// A leftover from a crashed transfer would block the name: it is ours.
	_ = c.do(ctx, http.MethodDelete, "/containers/"+url.PathEscape(name), url.Values{"force": {"true"}}, nil, nil)
	if err := c.do(ctx, http.MethodPost, "/containers/create", url.Values{"name": {name}}, body, &created); err != nil {
		return "", fmt.Errorf("create %s: %w", name, err)
	}
	return created.ID, nil
}

// copyOneFile unwraps the tar Docker returns and streams its single regular
// file. Anything else in the archive is refused rather than guessed at.
func copyOneFile(archive io.Reader, each func([]byte) error) (int64, error) {
	reader := tar.NewReader(archive)
	for {
		head, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return 0, ErrNoArtifact
		}
		if err != nil {
			return 0, fmt.Errorf("read archive: %w", err)
		}
		if head.Typeflag != tar.TypeReg {
			continue
		}
		var total int64
		buffer := make([]byte, ArtifactChunkBytes)
		for {
			n, err := reader.Read(buffer)
			if n > 0 {
				total += int64(n)
				if sendErr := each(buffer[:n]); sendErr != nil {
					return total, sendErr
				}
			}
			if errors.Is(err, io.EOF) {
				return total, nil
			}
			if err != nil {
				return total, fmt.Errorf("read archive: %w", err)
			}
		}
	}
}

// WriteVolumeFile puts one file into a named volume, streaming it straight
// from the reader. Like reading, it uses a container it creates and never
// starts: Docker's copy endpoint writes into a stopped container's mounts,
// so an imported dump reaches the store without a shell or a host path.
func (c *Client) WriteVolumeFile(
	ctx context.Context,
	name, image, volume, mountPath, file string,
	size int64,
	body io.Reader,
) error {
	if err := c.EnsureImage(ctx, image); err != nil {
		return fmt.Errorf("image: %w", err)
	}
	created, err := c.createStopped(ctx, name, image, volume, mountPath)
	if err != nil {
		return err
	}
	defer func() {
		_ = c.do(context.WithoutCancel(ctx), http.MethodDelete, "/containers/"+created,
			url.Values{"force": {"true"}}, nil, nil)
	}()

	// The tar is built as it is sent, so a large dump is never held in memory.
	reader, writer := io.Pipe()
	go func() {
		archive := tar.NewWriter(writer)
		head := &tar.Header{Name: file, Mode: 0o600, Size: size, Typeflag: tar.TypeReg}
		if err := archive.WriteHeader(head); err != nil {
			_ = writer.CloseWithError(err)
			return
		}
		if _, err := io.Copy(archive, body); err != nil {
			_ = writer.CloseWithError(err)
			return
		}
		_ = writer.CloseWithError(archive.Close())
	}()

	put, err := http.NewRequestWithContext(ctx, http.MethodPut,
		c.base+"/containers/"+url.PathEscape(created)+"/archive?"+
			url.Values{"path": {mountPath}}.Encode(), reader)
	if err != nil {
		return fmt.Errorf("write %s: %w", file, err)
	}
	put.Header.Set("Content-Type", "application/x-tar")
	res, err := c.http.Do(put)
	if err != nil {
		return fmt.Errorf("write %s: %w", file, err)
	}
	defer func() { _ = res.Body.Close() }()
	_, _ = io.Copy(io.Discard, res.Body)
	if res.StatusCode >= 300 {
		return &APIError{Status: res.StatusCode, Message: "write " + file}
	}
	return nil
}

// RemoveVolumeFile deletes one file from the store: an imported dump is not
// a backup, and nothing prunes it, so it goes as soon as it has been used.
func (c *Client) RemoveVolumeFile(ctx context.Context, name, image, volume, mountPath, file string) error {
	code, out, err := c.RunHelper(ctx, Helper{
		Name:        name,
		Image:       image,
		Entrypoint:  []string{"/bin/sh", "-c"},
		Cmd:         []string{`rm -f -- "$D/$F"`},
		Env:         []string{"D=" + mountPath, "F=" + file},
		Volumes:     map[string]string{volume: mountPath},
		Network:     "none",
		MemoryBytes: 64 << 20,
		SecurityOpt: []string{"no-new-privileges:true"},
	})
	if err != nil {
		return fmt.Errorf("remove %s: %w", file, err)
	}
	if code != 0 {
		return fmt.Errorf("remove %s: %s", file, out)
	}
	return nil
}

// ReadVolumesInto streams a tar of several named volumes, each under its own
// directory, into `out`. Like every copy here it runs on a container that is
// created and never started, so a snapshot of an app's permanent folders
// costs no process and touches nothing else.
func (c *Client) ReadVolumesInto(
	ctx context.Context,
	name, image string,
	mounts map[string]string,
	root string,
	out io.Writer,
) (int64, error) {
	created, err := c.createStoppedWith(ctx, name, image, mounts)
	if err != nil {
		return 0, err
	}
	defer func() {
		_ = c.do(context.WithoutCancel(ctx), http.MethodDelete, "/containers/"+created,
			url.Values{"force": {"true"}}, nil, nil)
	}()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		c.base+"/containers/"+url.PathEscape(created)+"/archive?"+
			url.Values{"path": {root}}.Encode(), nil)
	if err != nil {
		return 0, fmt.Errorf("read %s: %w", root, err)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return 0, fmt.Errorf("read %s: %w", root, err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode == http.StatusNotFound {
		return 0, ErrNoArtifact
	}
	if res.StatusCode >= 300 {
		return 0, &APIError{Status: res.StatusCode, Message: "read " + root}
	}
	written, err := io.Copy(out, res.Body)
	if err != nil {
		return written, fmt.Errorf("read %s: %w", root, err)
	}
	return written, nil
}

// WriteVolumesFrom extracts an archive back over those same folders. Docker
// accepts a gzipped tar here, so what went out goes back in as it is.
func (c *Client) WriteVolumesFrom(
	ctx context.Context,
	name, image string,
	mounts map[string]string,
	root string,
	body io.Reader,
) error {
	created, err := c.createStoppedWith(ctx, name, image, mounts)
	if err != nil {
		return err
	}
	defer func() {
		_ = c.do(context.WithoutCancel(ctx), http.MethodDelete, "/containers/"+created,
			url.Values{"force": {"true"}}, nil, nil)
	}()
	// The archive holds one directory per folder, so it extracts into the
	// parent they were all mounted under.
	put, err := http.NewRequestWithContext(ctx, http.MethodPut,
		c.base+"/containers/"+url.PathEscape(created)+"/archive?"+
			url.Values{"path": {path.Dir(root)}}.Encode(), body)
	if err != nil {
		return fmt.Errorf("write %s: %w", root, err)
	}
	put.Header.Set("Content-Type", "application/x-tar")
	res, err := c.http.Do(put)
	if err != nil {
		return fmt.Errorf("write %s: %w", root, err)
	}
	defer func() { _ = res.Body.Close() }()
	_, _ = io.Copy(io.Discard, res.Body)
	if res.StatusCode >= 300 {
		return &APIError{Status: res.StatusCode, Message: "write " + root}
	}
	return nil
}

// createStoppedWith is createStopped for several volumes at once.
func (c *Client) createStoppedWith(
	ctx context.Context,
	name, image string,
	mounts map[string]string,
) (string, error) {
	if err := c.EnsureImage(ctx, image); err != nil {
		return "", fmt.Errorf("image: %w", err)
	}
	list := make([]mount, 0, len(mounts))
	for volume, target := range mounts {
		list = append(list, mount{Type: "volume", Source: volume, Target: target})
	}
	body := helperCreate{
		Image:      image,
		Entrypoint: []string{"/bin/sh"},
		Cmd:        []string{"-c", "exit 0"},
		Env:        []string{},
		Labels:     map[string]string{InfraLabel: "artifact"},
		HostConfig: helperHostConfig{
			Mounts:      list,
			NetworkMode: "none",
			SecurityOpt: []string{"no-new-privileges:true"},
			LogConfig:   logConfig{Type: "json-file", Config: map[string]string{"max-size": "1m", "max-file": "1"}},
		},
	}
	var created struct {
		ID string `json:"Id"`
	}
	_ = c.do(ctx, http.MethodDelete, "/containers/"+url.PathEscape(name), url.Values{"force": {"true"}}, nil, nil)
	if err := c.do(ctx, http.MethodPost, "/containers/create", url.Values{"name": {name}}, body, &created); err != nil {
		return "", fmt.Errorf("create %s: %w", name, err)
	}
	return created.ID, nil
}
