package build

import (
	"archive/tar"
	"archive/zip"
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

// zipMagic starts every ZIP file; anything else is taken for a .tar.gz.
var zipMagic = []byte("PK\x03\x04")

// cleanName is an entry's path relative to the destination with its first
// strip components removed, or an error if it is absolute or climbs out.
// An empty result means the entry has nothing left to write.
func cleanName(name string, strip int) (string, error) {
	clean := path.Clean(strings.TrimPrefix(strings.ReplaceAll(name, "\\", "/"), "./"))
	if clean == "." {
		return "", nil
	}
	if path.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") || strings.ContainsRune(clean, 0) {
		return "", fmt.Errorf("%w: %q", ErrUnsafeArchive, name)
	}
	parts := strings.Split(clean, "/")
	if len(parts) <= strip {
		return "", nil
	}
	return strings.Join(parts[strip:], "/"), nil
}

// unpacker writes checked entries under dir, keeping count and size.
type unpacker struct {
	dir   string
	files int
	total int64
}

func (u *unpacker) count(size int64) error {
	u.files++
	if u.files > MaxFiles {
		return fmt.Errorf("the source has more than %d files", MaxFiles)
	}
	u.total += size
	if u.total > MaxUnpackedBytes {
		return fmt.Errorf("the source is larger than %d MB unpacked", MaxUnpackedBytes>>20)
	}
	return nil
}

func (u *unpacker) mkdir(name string) error {
	if err := os.MkdirAll(filepath.Join(u.dir, filepath.FromSlash(name)), 0o755); err != nil { // #nosec G301 -- builds read it
		return fmt.Errorf("unpack: %w", err)
	}
	return nil
}

func (u *unpacker) file(r io.Reader, name string, size int64, executable bool) error {
	target := filepath.Join(u.dir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil { // #nosec G301 -- builds read it
		return fmt.Errorf("unpack: %w", err)
	}
	// Refuse to write through a link placed by an earlier entry.
	if info, err := os.Lstat(target); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: %q replaces a link", ErrUnsafeArchive, name)
	}
	mode := os.FileMode(0o644)
	if executable {
		mode = 0o755
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode) // #nosec G304 -- cleaned above
	if err != nil {
		return fmt.Errorf("unpack: %w", err)
	}
	// Never more than the entry claims: a lying header cannot overfill the disk.
	written, err := io.Copy(f, io.LimitReader(r, size+1))
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("unpack: %w", err)
	}
	if written != size {
		return fmt.Errorf("%w: %q is not the size it claims", ErrUnsafeArchive, name)
	}
	return nil
}

func (u *unpacker) link(name, linkname, original string) error {
	// A link may only point somewhere inside the source.
	resolved := path.Clean(path.Join(path.Dir(name), linkname)) // #nosec G305 -- checked on the next line
	if path.IsAbs(linkname) || resolved == ".." || strings.HasPrefix(resolved, "../") {
		return fmt.Errorf("%w: link %q", ErrUnsafeArchive, original)
	}
	target := filepath.Join(u.dir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil { // #nosec G301 -- builds read it
		return fmt.Errorf("unpack: %w", err)
	}
	if err := os.Symlink(linkname, target); err != nil {
		return fmt.Errorf("unpack: %w", err)
	}
	return nil
}

// Unpack extracts a .tar.gz or .zip source into dir, removing the first
// strip path components (a GitHub tarball wraps everything in one folder).
func Unpack(f io.ReaderAt, size int64, dir string, strip int) error {
	head := make([]byte, len(zipMagic))
	if _, err := f.ReadAt(head, 0); err == nil && string(head) == string(zipMagic) {
		return ExtractZip(f, size, dir, strip)
	}
	return Extract(io.NewSectionReader(f, 0, size), dir, strip)
}

// Extract unpacks a gzipped tar into dir. Only regular files, directories
// and symlinks that stay inside dir are written; modes are normalized so
// nothing becomes setuid or world-writable.
func Extract(r io.Reader, dir string, strip int) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return fmt.Errorf("the source is not a .tar.gz or .zip archive: %w", err)
	}
	defer func() { _ = gz.Close() }()
	reader := tar.NewReader(gz)
	u := &unpacker{dir: dir}
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read the source archive: %w", err)
		}
		switch header.Typeflag {
		case tar.TypeXGlobalHeader, tar.TypeXHeader:
			continue
		case tar.TypeDir, tar.TypeReg, tar.TypeSymlink:
		default:
			return fmt.Errorf("%w: %q is not a file, folder or link", ErrUnsafeArchive, header.Name)
		}
		name, err := cleanName(header.Name, strip)
		if err != nil {
			return err
		}
		if name == "" {
			continue
		}
		if err := u.count(max(header.Size, 0)); err != nil {
			return err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			err = u.mkdir(name)
		case tar.TypeReg:
			err = u.file(reader, name, header.Size, header.Mode&0o111 != 0)
		default:
			err = u.link(name, header.Linkname, header.Name)
		}
		if err != nil {
			return err
		}
	}
}

// ExtractZip unpacks a ZIP into dir with the same rules; links in ZIPs are refused.
func ExtractZip(r io.ReaderAt, size int64, dir string, strip int) error {
	archive, err := zip.NewReader(r, size)
	if err != nil {
		return fmt.Errorf("the source is not a readable .zip archive: %w", err)
	}
	u := &unpacker{dir: dir}
	for _, entry := range archive.File {
		mode := entry.Mode()
		if mode&os.ModeSymlink != 0 || (!mode.IsDir() && !mode.IsRegular()) {
			return fmt.Errorf("%w: %q is not a file or folder", ErrUnsafeArchive, entry.Name)
		}
		name, err := cleanName(entry.Name, strip)
		if err != nil {
			return err
		}
		if name == "" {
			continue
		}
		size := int64(entry.UncompressedSize64) // #nosec G115 -- capped by count below
		if size < 0 {
			return fmt.Errorf("%w: %q", ErrUnsafeArchive, entry.Name)
		}
		if err := u.count(size); err != nil {
			return err
		}
		if mode.IsDir() {
			if err := u.mkdir(name); err != nil {
				return err
			}
			continue
		}
		body, err := entry.Open()
		if err != nil {
			return fmt.Errorf("read the source archive: %w", err)
		}
		err = u.file(body, name, size, mode&0o111 != 0)
		_ = body.Close()
		if err != nil {
			return err
		}
	}
	return nil
}
