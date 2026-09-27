package build

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"regexp"
	"sync"
	"time"
)

// LocalImage matches a locally built image's ID.
var LocalImage = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// Images is the agent's own record of the images it built. A local image ID
// from the control plane runs only if it is in here: an ID alone could name
// any image on the server, including ones VDeploy never made.
type Images struct {
	Path string

	mu sync.Mutex
}

type imageRecord struct {
	BuildID   string    `json:"buildId"`
	ProjectID string    `json:"projectId"`
	BuiltAt   time.Time `json:"builtAt"`
}

func (i *Images) load() (map[string]imageRecord, error) {
	raw, err := os.ReadFile(i.Path)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]imageRecord{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read built images: %w", err)
	}
	records := map[string]imageRecord{}
	if err := json.Unmarshal(raw, &records); err != nil {
		return nil, fmt.Errorf("built images record is damaged: %w", err)
	}
	return records, nil
}

// Add records an image this agent built.
func (i *Images) Add(id, buildID, projectID string) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	records, err := i.load()
	if err != nil {
		return err
	}
	records[id] = imageRecord{BuildID: buildID, ProjectID: projectID, BuiltAt: time.Now().UTC()}
	return i.save(records)
}

// save writes the record atomically: a half-written file would make every
// locally built image unrunnable.
func (i *Images) save(records map[string]imageRecord) error {
	raw, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return fmt.Errorf("encode built images: %w", err)
	}
	tmp := i.Path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return fmt.Errorf("write built images: %w", err)
	}
	if err := os.Rename(tmp, i.Path); err != nil {
		return fmt.Errorf("write built images: %w", err)
	}
	return nil
}

// Built reports whether this agent built the image, for this project.
func (i *Images) Built(id, projectID string) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	records, err := i.load()
	if err != nil {
		return false
	}
	record, ok := records[id]
	return ok && record.ProjectID == projectID
}

// Ours reports whether this agent built the image, for any project. It is
// what makes freeing disk safe: an image VDeploy made is VDeploy's to
// remove, and an image somebody pulled themselves is not.
func (i *Images) Ours(id string) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	records, err := i.load()
	if err != nil {
		return false
	}
	_, ok := records[id]
	return ok
}

// Forget drops images that are no longer on this server, so the record does
// not grow forever with ids of things that are gone.
func (i *Images) Forget(ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	records, err := i.load()
	if err != nil {
		return err
	}
	for _, id := range ids {
		delete(records, id)
	}
	return i.save(records)
}
