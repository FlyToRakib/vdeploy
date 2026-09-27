package transport

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/FlyToRakib/vdeploy/agent/internal/backup"
	"github.com/FlyToRakib/vdeploy/agent/internal/files"
	"github.com/FlyToRakib/vdeploy/agent/internal/firewall"
	"github.com/FlyToRakib/vdeploy/agent/internal/health"
	"github.com/FlyToRakib/vdeploy/agent/internal/metrics"
	"github.com/FlyToRakib/vdeploy/agent/internal/reclaim"
	"github.com/FlyToRakib/vdeploy/agent/internal/task"
)

/*
A nil slice in Go encodes as `null`, and every list in the control plane's
schema says `array`. The two disagree only when a list happens to be empty
— which is the ordinary case, not the odd one — and the control plane's
answer to a frame it cannot read is to close the connection.

So this is not a formatting preference. An empty list that says `null` costs
the connection, over and over, and the failure looks like a network problem
rather than a schema one. Every result type gets checked at its zero value,
which is exactly when a list is empty.
*/
func TestNoResultEncodesAnEmptyListAsNull(t *testing.T) {
	cases := map[string]any{
		"snapshot": backup.SnapshotResult{},
		"backup":   backup.Result{},
		"verify":   backup.VerifyResult{},
		"check":    backup.CheckResult{},
		"task":     task.Result{},
		"files":    files.Result{},
		"reclaim":  reclaim.Result{},
		"usage":    metrics.Usage{},
		"health":   health.Report{},
		"firewall": firewall.Report{},
	}
	// The one field that means null: a check that never ran counted no
	// tables, which is not the same as counting none.
	nullable := map[string]bool{"verify.tables": true}
	for name, zero := range cases {
		encoded, err := json.Marshal(zero)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(encoded, &fields); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		for key, raw := range fields {
			if string(raw) != "null" || nullable[name+"."+key] {
				continue
			}
			t.Errorf("%s.%s encodes as null; a list must encode as []", name, key)
		}
	}
}

// And the ones a person actually meets: the empty answers.
func TestAnEmptyAnswerIsAnEmptyList(t *testing.T) {
	for name, value := range map[string]any{
		"firewall": (&firewall.Reader{Root: t.TempDir()}).Read(),
		"files":    files.Result{RequestID: "r", Entries: []files.Entry{}},
	} {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if strings.Contains(string(encoded), ":null") {
			t.Errorf("%s answered with null somewhere: %s", name, encoded)
		}
	}
}
