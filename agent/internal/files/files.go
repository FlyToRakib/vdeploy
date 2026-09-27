// Package files answers "did my upload actually arrive?" without a shell
// (§20 Runtime).
//
// A permanent folder is a Docker volume, and on this server that volume is a
// directory. The agent reads it directly — it is root on this machine, the
// same way it already reads /proc for diagnostics — rather than starting
// something inside a container to look around on its behalf.
//
// The one thing that must hold is that a browser given one folder cannot
// reach anything outside it. That is not left to checking strings: the
// folder is opened as an os.Root, and every read after that goes through the
// kernel confined to it, so a symlink inside a volume pointing at /etc is a
// dead end rather than a way out.
package files

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
)

// MaxEntries is how many entries one folder answers with. Past this nobody
// is reading by eye, and the answer still has to fit in one frame.
const MaxEntries = 500

// ChunkBytes is how much of a file is read at a time on its way out.
const ChunkBytes = 256 * 1024

var (
	// folderName is what the control plane may name: one of the project's
	// permanent folders, never a volume of its own choosing.
	folderName = regexp.MustCompile(`^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`)
	projectKey = regexp.MustCompile(`^prj_[0-9A-HJKMNP-TV-Z]{26}$`)
)

// ErrNoFile means the path is not there any more.
var ErrNoFile = errors.New("that file is not in the folder any more")

// Engine is the part of the Docker client this needs.
type Engine interface {
	VolumeOf(ctx context.Context, name, projectID string) (docker.Volume, error)
}

// Request names a folder to look in, and a path inside it.
type Request struct {
	RequestID string `json:"requestId"`
	ProjectID string `json:"projectId"`
	Folder    string `json:"folder"`
	Path      string `json:"path"`
}

// Entry is one file, folder or shortcut.
type Entry struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	SizeBytes  int64  `json:"sizeBytes"`
	ModifiedAt string `json:"modifiedAt"`
	LinkTo     string `json:"linkTo"`
}

// Result is what one listing answers with.
type Result struct {
	RequestID string  `json:"requestId"`
	Entries   []Entry `json:"entries"`
	Truncated bool    `json:"truncated"`
	Error     string  `json:"error,omitempty"`
}

// Reader looks inside a project's permanent folders.
type Reader struct {
	Engine Engine
	Log    *slog.Logger
}

// List answers with what is directly under the path asked for: one level,
// because one level is what a person reads.
func (r *Reader) List(ctx context.Context, req Request) Result {
	fail := func(why string) Result {
		return Result{RequestID: req.RequestID, Entries: []Entry{}, Error: why}
	}
	root, err := r.open(ctx, req)
	if err != nil {
		return fail(err.Error())
	}
	defer func() { _ = root.Close() }()

	where := req.Path
	if where == "" {
		where = "."
	}
	dir, err := root.Open(where)
	if err != nil {
		return fail(reason(err, "that folder"))
	}
	defer func() { _ = dir.Close() }()
	// One more than the cap, so "there is more" is known rather than guessed.
	found, err := dir.ReadDir(MaxEntries + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return fail("that is a file, not a folder")
	}
	truncated := len(found) > MaxEntries
	if truncated {
		found = found[:MaxEntries]
	}
	entries := make([]Entry, 0, len(found))
	for _, each := range found {
		if entry, ok := describe(root, path.Join(req.Path, each.Name()), each); ok {
			entries = append(entries, entry)
		}
	}
	// Folders first, then by name: the order a person expects to read.
	sort.Slice(entries, func(a, b int) bool {
		if (entries[a].Kind == "folder") != (entries[b].Kind == "folder") {
			return entries[a].Kind == "folder"
		}
		return entries[a].Name < entries[b].Name
	})
	return Result{RequestID: req.RequestID, Entries: entries, Truncated: truncated}
}

// Send streams one file out of a folder, reporting its size and hash so the
// control plane can say whether what arrived is what was read.
func (r *Reader) Send(
	ctx context.Context,
	req Request,
	each func([]byte) error,
) (int64, string, error) {
	if req.Path == "" {
		return 0, "", errors.New("no file was named")
	}
	root, err := r.open(ctx, req)
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = root.Close() }()

	// A shortcut is shown but never followed, here as in a listing.
	info, err := root.Lstat(req.Path)
	if err != nil {
		return 0, "", ErrNoFile
	}
	if !info.Mode().IsRegular() {
		return 0, "", errors.New("only a file can be downloaded, not a folder or a shortcut")
	}
	file, err := root.Open(req.Path)
	if err != nil {
		return 0, "", ErrNoFile
	}
	defer func() { _ = file.Close() }()

	sum := sha256.New()
	buffer := make([]byte, ChunkBytes)
	var total int64
	for {
		if ctx.Err() != nil {
			return total, "", ctx.Err() //nolint:wrapcheck // the reason is the context's own
		}
		n, err := file.Read(buffer)
		if n > 0 {
			total += int64(n)
			sum.Write(buffer[:n])
			if sendErr := each(buffer[:n]); sendErr != nil {
				return total, "", sendErr
			}
		}
		if errors.Is(err, io.EOF) {
			return total, hex.EncodeToString(sum.Sum(nil)), nil
		}
		if err != nil {
			return total, "", errors.New("the file could not be read to the end")
		}
	}
}

// open resolves a project's folder to the directory behind it and confines
// everything that follows to it.
func (r *Reader) open(ctx context.Context, req Request) (*os.Root, error) {
	if !projectKey.MatchString(req.ProjectID) {
		return nil, errors.New("the app these folders belong to is not named properly")
	}
	if !folderName.MatchString(req.Folder) {
		return nil, errors.New("a folder name is not allowed")
	}
	if err := checkPath(req.Path); err != nil {
		return nil, err
	}
	volume, err := r.Engine.VolumeOf(ctx, compose.VolumeName(req.ProjectID, req.Folder), req.ProjectID)
	if err != nil {
		if docker.IsNotFound(err) {
			return nil, errors.New("this app has no folder by that name")
		}
		return nil, err //nolint:wrapcheck // VolumeOf's words are already for a person
	}
	root, err := os.OpenRoot(volume.Mountpoint)
	if err != nil {
		return nil, errors.New("this agent cannot read the server's disk, so it cannot show you the files")
	}
	return root, nil
}

// checkPath refuses anything that could climb out of the folder before the
// kernel has to. os.Root is the guarantee; this is so a person gets a plain
// answer rather than a confusing one.
func checkPath(p string) error {
	if len(p) > 1024 {
		return errors.New("that path is too long")
	}
	if p == "" {
		return nil
	}
	for _, part := range strings.Split(p, "/") {
		if part == "" || part == "." || part == ".." || strings.ContainsRune(part, 0) {
			return errors.New("that is not a path inside the folder")
		}
	}
	return nil
}

// describe turns one directory entry into what the dashboard shows. An entry
// that went between the listing and the look is left out rather than
// reported as a file of no bytes.
func describe(root *os.Root, full string, each fs.DirEntry) (Entry, bool) {
	name := each.Name()
	if len(name) > 255 {
		return Entry{}, false
	}
	info, err := each.Info()
	if err != nil {
		return Entry{}, false
	}
	entry := Entry{Name: name, ModifiedAt: info.ModTime().UTC().Format(time.RFC3339)}
	switch {
	case info.Mode()&fs.ModeSymlink != 0:
		entry.Kind = "link"
		// Where it points is shown as text; nothing here goes there.
		if target, err := root.Readlink(full); err == nil && len(target) <= 1024 {
			entry.LinkTo = target
		}
	case each.IsDir():
		entry.Kind = "folder"
	case info.Mode().IsRegular():
		entry.Kind = "file"
		entry.SizeBytes = max(info.Size(), 0)
	default:
		entry.Kind = "other"
	}
	return entry, true
}

// reason keeps Go's plumbing out of what a person reads.
func reason(err error, what string) string {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return what + " is not there"
	case errors.Is(err, fs.ErrPermission):
		return what + " cannot be read"
	default:
		return fmt.Sprintf("%s could not be opened", what)
	}
}
