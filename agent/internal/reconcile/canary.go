package reconcile

import (
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

/*
Weighted canary (§16).

Blue/green switches all the traffic the moment every new replica is ready.
That is right for most apps: the health check has already proved the new
version starts and answers. What it cannot prove is that the new version
answers *correctly* under real traffic — the request that only the tenth
customer makes, the query that is slow only against the production
database's size.

So a canary gives the new release a share of real requests and watches what
comes back. It steps up through the shares the spec names, holding each for
as long as the spec says, and it stops the moment the new release is
failing more requests than the spec allows — which is the whole reason to
do it this way rather than watching a graph by hand.

Two properties this deliberately has:

  - **It never steps up on no evidence.** A share that served no requests
    in its window proves nothing; the step is held, not passed. A canary
    that "succeeds" because nobody visited is a canary that lied.
  - **Failing rolls back to all-old, not to all-new.** The old release is
    still running and still serving most of the traffic; going back to it
    is one routing file, and it happens before anybody has to be woken up.
*/

// canary is where one project's stepped rollout has got to.
type canary struct {
	// release the steps are for; a new release starts the walk again.
	release string
	// step is the index into the spec's shares, -1 before the first.
	step int
	// since is when the current share began serving.
	since time.Time
	// requests and failures are the counters read when the share began, so
	// what happened *during* it is a subtraction rather than a total.
	requests, failures float64
	// done means the new release now has everything; failed means it lost it.
	done, failed bool
}

// CanaryVerdict is what one look at a stepping rollout concluded.
type CanaryVerdict struct {
	// Percent of traffic the new release should have right now.
	Percent int
	// Done means the canary finished and the new release takes everything.
	Done bool
	// Failed means it was rolled back; Reason says what a person is told.
	Failed bool
	Reason string
}

// canaryShares are the shares to walk, from the spec, always ending at 100.
func canaryShares(project spec.DesiredProject) []int {
	c := project.Spec.Deploy.Canary
	if c == nil || len(c.Steps) == 0 {
		return nil
	}
	out := make([]int, 0, len(c.Steps)+1)
	for _, step := range c.Steps {
		if step > 0 && step < 100 && (len(out) == 0 || step > out[len(out)-1]) {
			out = append(out, step)
		}
	}
	return append(out, 100)
}

// Traffic reports the error rate of one service over a window: how many
// requests it answered and how many of those failed.
type Traffic interface {
	Counts(service string) (requests, failures float64, ok bool)
}

/*
step advances one project's canary, or ends it.

It is called once a pass, and every decision is a function of the counters
now, the counters when this share began, and the clock. Nothing is
remembered that cannot be recomputed, so an agent that restarts mid-canary
simply starts the current share's window again rather than carrying a
half-finished belief across the gap.
*/
func (r *Reconciler) stepCanary(project spec.DesiredProject, service string) CanaryVerdict {
	shares := canaryShares(project)
	if len(shares) == 0 || project.Promoted {
		return CanaryVerdict{Percent: 100, Done: true}
	}
	state, seen := r.canaries[project.ProjectID]
	if !seen || state.release != project.ReleaseID {
		state = canary{release: project.ReleaseID, step: 0, since: r.now()}
		state.requests, state.failures = r.counts(service)
		r.canaries[project.ProjectID] = state
	}
	if state.done {
		return CanaryVerdict{Percent: 100, Done: true}
	}
	if state.failed {
		return CanaryVerdict{Percent: 0, Failed: true, Reason: canaryReason}
	}

	share := shares[state.step]
	if share == 100 {
		state.done = true
		r.canaries[project.ProjectID] = state
		return CanaryVerdict{Percent: 100, Done: true}
	}

	hold := stepDuration(project)
	requests, failures := r.counts(service)
	served := requests - state.requests
	failed := failures - state.failures
	// The router restarted: its counters begin again, and the difference
	// goes negative. This share has no evidence any more, so it begins
	// again too rather than waiting forever on numbers that cannot arrive.
	if served < 0 || failed < 0 {
		state.requests, state.failures = requests, failures
		state.since = r.now()
		r.canaries[project.ProjectID] = state
		return CanaryVerdict{Percent: share}
	}

	// Losing requests ends it at once: there is no reason to wait out a
	// window to confirm what is already going wrong.
	if allowed := errorRate(project); allowed > 0 && served > 0 && failed/served > allowed {
		state.failed = true
		r.canaries[project.ProjectID] = state
		return CanaryVerdict{Percent: 0, Failed: true, Reason: canaryReason}
	}
	if r.now().Sub(state.since) < hold {
		return CanaryVerdict{Percent: share}
	}
	// The window is up. A share that served nothing proves nothing, so it
	// waits rather than passing: time alone is not evidence.
	if served <= 0 {
		return CanaryVerdict{Percent: share}
	}
	state.step++
	state.since = r.now()
	state.requests, state.failures = requests, failures
	if state.step >= len(shares)-1 {
		state.done = true
		r.canaries[project.ProjectID] = state
		return CanaryVerdict{Percent: 100, Done: true}
	}
	r.canaries[project.ProjectID] = state
	return CanaryVerdict{Percent: shares[state.step]}
}

func (r *Reconciler) counts(service string) (requests, failures float64) {
	if r.Traffic == nil {
		return 0, 0
	}
	requests, failures, ok := r.Traffic.Counts(service)
	if !ok {
		return 0, 0
	}
	return requests, failures
}

// canaryReason is what a person reads, not what the counters said: the
// numbers are in the event, the sentence is what tells them what happened.
const canaryReason = "the new version answered too many requests with an error, so traffic went back to the version before it"

func stepDuration(project spec.DesiredProject) time.Duration {
	c := project.Spec.Deploy.Canary
	if c == nil {
		return time.Minute
	}
	d, err := time.ParseDuration(c.StepDuration)
	if err != nil || d <= 0 {
		return time.Minute
	}
	return d
}

func errorRate(project spec.DesiredProject) float64 {
	if c := project.Spec.Deploy.Canary; c != nil {
		return c.AutoRollbackErrorRate
	}
	return 0
}
