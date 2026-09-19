package build

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Limits on a source archive once unpacked: a decompression bomb or a
// million tiny files must not fill the server.
const (
	MaxUnpackedBytes = 2 << 30
	MaxFiles         = 100_000
)

// ErrUnsafeArchive is returned for an entry that would land outside the
// source directory or is not a plain file, directory or contained link.
var ErrUnsafeArchive = errors.New("the source archive contains an unsafe entry")

// cleanName is an entry's path relative to the destination, or an error if
// it is absolute, climbs out, or is empty.
func cleanName(name string) (string, error) {
	clean := path.Clean(strings.TrimPrefix(name, "./"))
	if clean == "." {
		return "", nil
	}
	if path.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") || strings.ContainsRune(clean, 0) {
		return "", fmt.Errorf("%w: %q", ErrUnsafeArchive, name)
	}
	return clean, nil
}

// Extract unpacks a gzipped tar into dir. Only regular files, directories
// and symlinks that stay inside dir are written; modes are normalized so
// nothing becomes setuid or world-writable.
func Extract(r io.Reader, dir string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return fmt.Errorf("the source is not a .tar.gz archive: %w", err)
	}
	defer func() { _ = gz.Close() }()
	reader := tar.NewReader(gz)
	var total int64
	files := 0
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read the source archive: %w", err)
		}
		name, err := cleanName(header.Name)
		if err != nil {
			return err
		}
		if name == "" {
			continue
		}
		files++
		if files > MaxFiles {
			return fmt.Errorf("the source has more than %d files", MaxFiles)
		}
		target := filepath.Join(dir, filepath.FromSlash(name))
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil { // #nosec G301 -- builds read it
				return fmt.Errorf("unpack: %w", err)
			}
		case tar.TypeReg:
			total += header.Size
			if total > MaxUnpackedBytes {
				return fmt.Errorf("the source is larger than %d MB unpacked", MaxUnpackedBytes>>20)
			}
			if err := writeFile(reader, target, header); err != nil {
				return err
			}
		case tar.TypeSymlink:
			// A link may only point somewhere inside the source.
			resolved := path.Clean(path.Join(path.Dir(name), header.Linkname)) // #nosec G305 -- checked on the next line
			if path.IsAbs(header.Linkname) || resolved == ".." || strings.HasPrefix(resolved, "../") {
				return fmt.Errorf("%w: link %q", ErrUnsafeArchive, header.Name)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil { // #nosec G301 -- builds read it
				return fmt.Errorf("unpack: %w", err)
			}
			if err := os.Symlink(header.Linkname, target); err != nil {
				return fmt.Errorf("unpack: %w", err)
			}
		case tar.TypeXGlobalHeader, tar.TypeXHeader:
			continue
		default:
			return fmt.Errorf("%w: %q is not a file, folder or link", ErrUnsafeArchive, header.Name)
		}
	}
}

func writeFile(r io.Reader, target string, header *tar.Header) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil { // #nosec G301 -- builds read it
		return fmt.Errorf("unpack: %w", err)
	}
	// Refuse to write through a link placed by an earlier entry.
	if info, err := os.Lstat(target); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: %q replaces a link", ErrUnsafeArchive, header.Name)
	}
	mode := os.FileMode(0o644)
	if header.Mode&0o111 != 0 {
		mode = 0o755
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode) // #nosec G304 -- cleaned above
	if err != nil {
		return fmt.Errorf("unpack: %w", err)
	}
	if _, err := io.CopyN(f, r, header.Size); err != nil {
		_ = f.Close()
		return fmt.Errorf("unpack: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("unpack: %w", err)
	}
	return nil
}
