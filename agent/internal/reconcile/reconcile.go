// Package reconcile converges the server on the desired state (§4 OBSERVE,
// N6). It runs on a timer and on every new desired state, needs no control
// plane to keep apps alive, and only ever touches what the agent created.
package reconcile

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/FlyToRakib/vdeploy/agent/internal/compose"
	"github.com/FlyToRakib/vdeploy/agent/internal/docker"
	"github.com/FlyToRakib/vdeploy/agent/internal/guard"
	"github.com/FlyToRakib/vdeploy/agent/internal/health"
	"github.com/FlyToRakib/vdeploy/agent/internal/metrics"
	"github.com/FlyToRakib/vdeploy/agent/internal/spec"
)

// Engine is what the reconciler needs from Docker.
type Engine interface {
	ListManaged(ctx context.Context) ([]docker.Container, error)
	EnsureNetwork(ctx context.Context, name, projectID string) error
	// EnsureVolume reports whether it had to create the volume.
	EnsureVolume(ctx context.Context, name, projectID string) (bool, error)
	// CopyPath copies a folder from one container into another, not yet started.
	CopyPath(ctx context.Context, fromID, folder, toID string) (int64, error)
	EnsureImage(ctx context.Context, ref string) error
	Create(ctx context.Context, c compose.Container) (string, error)
	Start(ctx context.Context, id string) error
	Stop(ctx context.Context, id string, timeoutSeconds int) error
	Remove(ctx context.Context, id string) error
	// Finished is a stopped container's exit code and the end of its output.
	Finished(ctx context.Context, id string) (int, string, error)
	// ManagedNetworks lists project networks the agent created, by name → project.
	ManagedNetworks(ctx context.Context) (map[string]string, error)
	RemoveNetwork(ctx context.Context, name string) error
}

// Event is one thing the reconciler did, reported to the control plane.
type Event struct {
	Kind      string `json:"kind"` // created, healed, stopped, removed, refused, failed
	ProjectID string `json:"projectId"`
	Container string `json:"container,omitempty"`
	Message   string `json:"message,omitempty"`
}

// Replica is one container as observed after a pass.
type Replica struct {
	Name    string `json:"name"`
	State   string `json:"state"`
	Release string `json:"release"`
}

// ProjectState is what the agent observed for one project.
type ProjectState struct {
	ProjectID string    `json:"projectId"`
	Replicas  []Replica `json:"replicas"`
	Error     string    `json:"error,omitempty"`
	// Unsaved are folders holding files the next deploy would delete (§17.2).
	Unsaved []UnsavedFolder `json:"unsaved,omitempty"`
	// Evidence is what the agent saw of replicas that are not serving (§32).
	Evidence []ReplicaEvidence `json:"evidence,omitempty"`
}

// Report is the outcome of one reconciliation pass.
type Report struct {
	Generation int64           `json:"generation"`
	Projects   []ProjectState  `json:"projects"`
	Databases  []DatabaseState `json:"databases,omitempty"`
	Events     []Event         `json:"events"`
	// Settling means a replica is still starting or an old one draining: pass again soon.
	Settling bool `json:"settling"`
	// Usage is what the server and its apps are actually using (§27).
	Usage *metrics.Usage `json:"usage,omitempty"`
	// Health is what the server is made of (§18), on its own slower pace.
	Health *health.Report `json:"health,omitempty"`
}

// SecretSource opens a secret value sealed to this server for one project.
type SecretSource interface {
	Open(projectID, secretID string, version int, sealed string) (string, error)
}

// Reconciler converges one server. Between passes it remembers which
// replicas passed their startup check, and since when an old release has
// been draining.
type Reconciler struct {
	Engine  Engine
	Policy  guard.Policy
	Log     *slog.Logger
	Routing Routing
	// Prober checks new replicas before they take traffic; nil trusts "running".
	Prober Prober
	// Secrets opens sealed secret values; nil (not enrolled) cannot start projects using them.
	Secrets SecretSource
	// Built says whether this agent built a local image for a project; nil runs none.
	Built func(imageID, projectID string) bool
	// Releases remembers which releases ran their release command.
	Releases *ReleaseLog
	// Storage lets the agent see what containers write outside permanent folders.
	Storage Storage
	// StorageScan paces that look (default unsavedEvery).
	StorageScan time.Duration
	// Metrics reads what the server and its apps are using; nil reads none.
	Metrics *metrics.Reader
	// MetricsEvery paces those readings (default metrics.Every).
	MetricsEvery time.Duration
	// Health reads what the server is made of (§18); nil reads none.
	Health *health.Reader
	// HealthEvery paces that look (default health.Every).
	HealthEvery time.Duration
	// Traffic reports how many requests each service answered and how many
	// failed, for a stepped rollout (§16); nil never steps one up.
	Traffic Traffic
	// Inspector gathers evidence on replicas that are not serving; nil gathers none.
	Inspector Inspector
	// Mesh carries private traffic to this organization's other servers
	// (§13); nil means every service an app uses is on its own machine.
	Mesh MeshRunner
	Now  func() time.Time

	ready         map[string]*readiness
	draining      map[string]time.Time
	releaseStarts map[string]time.Time
	unsaved       map[string][]UnsavedFolder
	unsavedAt     time.Time
	measured      time.Time
	healthAt      time.Time
	// canaries: how far each project's stepped rollout has got.
	canaries map[string]canary
	// moving: new permanent folders (by volume) whose files still have to be copied in.
	moving   map[string]bool
	evidence map[string]evidenceCache
	// databaseRevision is the revision each database container was created at.
	databaseRevision map[string]int
	// lastDesired is what this server was last told to run, read by tasks.
	desiredMu   sync.Mutex
	lastDesired map[string]spec.DesiredProject
}

func (r *Reconciler) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

type pass struct {
	r        *Reconciler
	existing map[string]docker.Container
	wanted   map[string]bool
	// states is each desired replica's assessed state in this pass.
	states map[string]string
	// desired and settled: which projects exist, and which have every replica ready.
	desired map[string]spec.DesiredProject
	settled map[string]bool
	// databaseIDs are the databases this server should run, for retiring the rest.
	databaseIDs map[string]bool
	report      Report
}

func (p *pass) event(kind, projectID, container, message string) {
	p.report.Events = append(p.report.Events, Event{kind, projectID, container, message})
}

// Reconcile runs one pass. Failures in one project never stop the others.
func (r *Reconciler) Reconcile(ctx context.Context, state *spec.DesiredState) (Report, error) {
	listed, err := r.Engine.ListManaged(ctx)
	if err != nil {
		return Report{}, fmt.Errorf("list managed containers: %w", err)
	}
	if r.ready == nil {
		r.ready = map[string]*readiness{}
		r.draining = map[string]time.Time{}
	}
	if r.databaseRevision == nil {
		r.databaseRevision = map[string]int{}
	}
	if r.canaries == nil {
		r.canaries = map[string]canary{}
	}
	p := &pass{
		r:        r,
		existing: map[string]docker.Container{},
		wanted:   map[string]bool{},
		states:   map[string]string{},
		desired:  map[string]spec.DesiredProject{},
		settled:  map[string]bool{},

		databaseIDs: map[string]bool{},
	}
	p.report.Generation = state.Generation
	for _, c := range listed {
		p.existing[c.Name] = c
	}
	// Before anything is planned: a container is told the names of services
	// on other servers when it is created, so the sockets that answer those
	// names have to exist first.
	if r.Mesh != nil {
		r.Mesh.Apply(ctx, state.Mesh)
	}
	for _, project := range state.Projects {
		p.desired[project.ProjectID] = project
		p.report.Projects = append(p.report.Projects, p.project(ctx, project))
	}
	// A one-off task runs the same container a replica does, so it reads the
	// state this pass just converged rather than a second description of it.
	r.remember(state.Projects)
	p.databases(ctx, state)
	// Traffic moves to new replicas only once all of them are ready, and old
	// ones are retired only after that, once they have drained.
	//
	// An edge routes to other servers' routers instead of to containers of
	// its own, and it has none: its desired state carries no projects, so
	// the ordinary pass above did nothing and this one does all of it.
	if edging := p.edgeRoutes(); len(edging) > 0 {
		p.edge(ctx, edging)
	} else {
		p.route(ctx, state)
	}
	p.watchUnsaved(ctx, state)
	for i := range p.report.Projects {
		p.report.Projects[i].Unsaved = r.unsaved[p.report.Projects[i].ProjectID]
	}
	p.measure(ctx)
	p.inspect(ctx, state)
	p.retire(ctx)
	return p.report, nil
}

// measure takes a reading of what the server and its apps are using, at its
// own pace: often enough to see a spike, rarely enough to cost nothing much.
func (p *pass) measure(ctx context.Context) {
	r := p.r
	if r.Metrics == nil {
		return
	}
	every := r.MetricsEvery
	if every <= 0 {
		every = metrics.Every
	}
	if !r.measured.IsZero() && r.now().Sub(r.measured) < every {
		return
	}
	r.measured = r.now()
	containers := make([]docker.Container, 0, len(p.existing))
	for _, c := range p.existing {
		containers = append(containers, c)
	}
	usage := r.Metrics.Read(ctx, containers, r.now())
	p.report.Usage = &usage
}

/*
inspect looks at what the server is made of (§18) — the disk broken down,
swap, inodes, load, and permanent folders whose app is gone. Asking Docker
what its disk holds walks the filesystem, so this runs on its own much
slower pace and never in the same breath as converging.
*/
func (p *pass) inspect(ctx context.Context, state *spec.DesiredState) {
	r := p.r
	if r.Health == nil {
		return
	}
	every := r.HealthEvery
	if every <= 0 {
		every = health.Every
	}
	if !r.healthAt.IsZero() && r.now().Sub(r.healthAt) < every {
		return
	}
	r.healthAt = r.now()
	// Every permanent folder the desired state still asks for. Anything
	// else VDeploy made is a folder nothing will ever mount again.
	wanted := map[string]bool{}
	for _, project := range state.Projects {
		for _, volume := range project.Spec.Runtime.Volumes {
			wanted[compose.VolumeName(project.ProjectID, volume.Name)] = true
		}
	}
	report := r.Health.Read(ctx, wanted, r.now())
	p.report.Health = &report
}

func (p *pass) project(ctx context.Context, project spec.DesiredProject) ProjectState {
	result := ProjectState{ProjectID: project.ProjectID}
	if err := guard.Check(project, p.r.Policy); err != nil {
		p.event("refused", project.ProjectID, "", err.Error())
		result.Error = err.Error()
		return result
	}
	containers, err := compose.Plan(project)
	// Anything this app reads that lives on another server is reached under
	// its ordinary name, pointed at this server's own agent (§13).
	if err == nil && p.r.Mesh != nil {
		if hosts := p.r.Mesh.Hosts(project.ProjectID); len(hosts) > 0 {
			for i := range containers {
				containers[i].ExtraHosts = hosts
			}
		}
	}
	if err == nil {
		err = p.converge(ctx, project, containers)
	}
	if err != nil {
		p.event("failed", project.ProjectID, "", err.Error())
		result.Error = err.Error()
	}
	settled := project.Running
	for _, c := range containers {
		state := p.assess(ctx, project, c)
		p.states[c.Name] = state
		settled = settled && state == StateReady
		result.Replicas = append(result.Replicas, Replica{Name: c.Name, State: state, Release: project.ReleaseID})
	}
	p.settled[project.ProjectID] = settled
	p.gatherEvidence(ctx, project, &result)
	return result
}

// edgeRoutes is what this server fronts, when it is an edge (§13).
func (p *pass) edgeRoutes() []spec.EdgeRoute {
	if p.r.Mesh == nil {
		return nil
	}
	return p.r.Mesh.Routes()
}

// old lists the containers of a project that are not in its desired set.
func (p *pass) old(projectID string) []docker.Container {
	var out []docker.Container
	for name, c := range p.existing {
		if !p.wanted[name] && c.Labels[compose.ProjectLabel] == projectID {
			out = append(out, c)
		}
	}
	return out
}

func (p *pass) converge(ctx context.Context, project spec.DesiredProject, containers []compose.Container) error {
	for _, c := range containers {
		p.wanted[c.Name] = true
	}
	if !project.Running {
		return p.stopAll(ctx, project.ProjectID, containers)
	}
	engine := p.r.Engine
	if err := engine.EnsureNetwork(ctx, compose.NetworkName(project.ProjectID), project.ProjectID); err != nil {
		return fmt.Errorf("network: %w", err)
	}
	for _, v := range project.Spec.Runtime.Volumes {
		volume := compose.VolumeName(project.ProjectID, v.Name)
		created, err := engine.EnsureVolume(ctx, volume, project.ProjectID)
		if err != nil {
			return fmt.Errorf("volume %s: %w", v.Name, err)
		}
		if created {
			// A folder made permanent now: files the app already wrote there move in first.
			if p.r.moving == nil {
				p.r.moving = map[string]bool{}
			}
			p.r.moving[volume] = true
		}
	}
	if project.Spec.Deploy.Strategy == "recreate" {
		// Singletons and lock-holders: the old copy stops before the new one starts.
		// While its files still have to move into a new permanent folder, it is
		// only stopped, so they can be copied; it is removed once no longer wanted.
		for _, c := range p.old(project.ProjectID) {
			if p.moving(project) && c.Labels[compose.RoleLabel] == "" {
				p.stopOld(ctx, c)
			} else {
				p.remove(ctx, c)
			}
		}
	}
	// A new release's replicas start only after its release command succeeded.
	if ready, err := p.released(ctx, project, containers); err != nil || !ready {
		return err
	}
	var errs []error
	for _, c := range containers {
		errs = append(errs, p.ensureRunning(ctx, project, c))
	}
	return errors.Join(errs...)
}

func (p *pass) ensureRunning(ctx context.Context, project spec.DesiredProject, c compose.Container) error {
	projectID := project.ProjectID
	engine := p.r.Engine
	existing, ok := p.existing[c.Name]
	if ok && existing.State == "running" {
		return nil
	}
	if ok {
		if err := engine.Start(ctx, existing.ID); err != nil {
			return fmt.Errorf("start %s: %w", c.Name, err)
		}
		was := existing.State
		existing.State = "running"
		p.existing[c.Name] = existing
		p.event("healed", projectID, c.Name, "was "+was)
		return nil
	}
	if strings.HasPrefix(c.Image, "sha256:") {
		// A local image ID could name anything on this host: run it only if
		// we built it. Promoting a staging copy asks us to run bytes we
		// built for that copy, so the control plane names it and we widen
		// by exactly that one project — never to an id we never built.
		built := p.r.Built != nil && p.r.Built(c.Image, projectID)
		if !built && project.ImageFrom != "" && p.r.Built != nil {
			built = p.r.Built(c.Image, project.ImageFrom)
		}
		if !built {
			return fmt.Errorf("image %s was not built by this agent for this project", c.Image)
		}
	} else if err := engine.EnsureImage(ctx, c.Image); err != nil {
		return fmt.Errorf("image: %w", err)
	}
	secretEnv, err := compose.SecretEnv(project, func(id string, version int, sealed string) (string, error) {
		if p.r.Secrets == nil {
			return "", errors.New("this agent is not enrolled")
		}
		return p.r.Secrets.Open(projectID, id, version, sealed) //nolint:wrapcheck // wrapped by SecretEnv
	})
	if err != nil {
		return err //nolint:wrapcheck // already names the variable, never the value
	}
	c.Env = append(slices.Clip(c.Env), secretEnv...)
	id, err := engine.Create(ctx, c)
	if err != nil {
		return fmt.Errorf("create %s: %w", c.Name, err)
	}
	if err := p.moveIntoNewFolders(ctx, project, id); err != nil {
		_ = engine.Remove(ctx, id)
		return err
	}
	if err := engine.Start(ctx, id); err != nil {
		return fmt.Errorf("start %s: %w", c.Name, err)
	}
	p.existing[c.Name] = docker.Container{ID: id, Name: c.Name, State: "running", Labels: c.Labels}
	p.event("created", projectID, c.Name, "")
	return nil
}

func (p *pass) stopAll(ctx context.Context, projectID string, containers []compose.Container) error {
	var errs []error
	for _, c := range containers {
		existing, ok := p.existing[c.Name]
		if !ok || existing.State != "running" {
			continue
		}
		if err := p.r.Engine.Stop(ctx, existing.ID, c.StopTimeout); err != nil {
			errs = append(errs, fmt.Errorf("stop %s: %w", c.Name, err))
			continue
		}
		existing.State = "exited"
		p.existing[c.Name] = existing
		p.event("stopped", projectID, c.Name, "")
	}
	return errors.Join(errs...)
}

func (p *pass) remove(ctx context.Context, c docker.Container) {
	projectID := c.Labels[compose.ProjectLabel]
	if c.State == "running" {
		if err := p.r.Engine.Stop(ctx, c.ID, 30); err != nil {
			p.event("failed", projectID, c.Name, "stop: "+err.Error())
			return
		}
	}
	if err := p.r.Engine.Remove(ctx, c.ID); err != nil {
		p.event("failed", projectID, c.Name, "remove: "+err.Error())
		return
	}
	delete(p.existing, c.Name)
	delete(p.r.ready, c.Name)
	p.event("removed", projectID, c.Name, "")
}

// retire removes containers no desired project accounts for: old releases,
// surplus replicas, deleted projects. An old release of a running project
// keeps serving until every new replica is ready, and then drains first.
// Volumes and networks stay: data is never removed implicitly.
func (p *pass) retire(ctx context.Context) {
	for name, c := range p.existing {
		if p.wanted[name] {
			continue
		}
		if id := c.Labels[compose.DatabaseLabel]; id != "" {
			if p.databaseIDs[id] {
				continue
			}
			p.remove(ctx, c)
			delete(p.r.databaseRevision, id)
			continue
		}
		projectID := c.Labels[compose.ProjectLabel]
		serving := c.State == "running" && (p.r.ready[name] == nil || p.r.ready[name].failed == "")
		if project, ok := p.desired[projectID]; ok && project.Running && serving && !p.drained(project) {
			p.report.Settling = true
			continue
		}
		p.remove(ctx, c)
	}
	for projectID := range p.r.draining {
		if len(p.old(projectID)) == 0 {
			delete(p.r.draining, projectID)
		}
	}
	p.pruneNetworks(ctx)
}

// pruneNetworks removes the networks of projects no longer here once none
// of their containers is left. A network holds no data, but each takes an
// address range, and a server that deploys and deletes many projects would
// otherwise run out of them.
func (p *pass) pruneNetworks(ctx context.Context) {
	networks, err := p.r.Engine.ManagedNetworks(ctx)
	if err != nil {
		return
	}
	busy := map[string]bool{}
	for _, c := range p.existing {
		busy[c.Labels[compose.ProjectLabel]] = true
	}
	for name, projectID := range networks {
		if p.databaseIDs[projectID] {
			continue
		}
		if _, desired := p.desired[projectID]; desired || busy[projectID] {
			continue
		}
		if err := p.r.Engine.RemoveNetwork(ctx, name); err != nil {
			p.event("failed", projectID, "", "remove network: "+err.Error())
		}
	}
}

// drained reports whether a running project's old release may go now: every
// new replica is ready and the drain period since the switch has passed.
func (p *pass) drained(project spec.DesiredProject) bool {
	if !p.settled[project.ProjectID] {
		return false
	}
	since, draining := p.r.draining[project.ProjectID]
	if !draining {
		p.r.draining[project.ProjectID] = p.r.now()
		return false
	}
	drain, err := time.ParseDuration(project.Spec.Deploy.DrainPeriod)
	if err != nil {
		drain = 30 * time.Second
	}
	return p.r.now().Sub(since) >= drain
}

// remember keeps the projects this server was last told to run, so a task
// can be given exactly what a replica gets (§17.6).
func (r *Reconciler) remember(projects []spec.DesiredProject) {
	r.desiredMu.Lock()
	defer r.desiredMu.Unlock()
	r.lastDesired = make(map[string]spec.DesiredProject, len(projects))
	for _, project := range projects {
		r.lastDesired[project.ProjectID] = project
	}
}

// Project is what this server was last told to run for one project.
func (r *Reconciler) Project(projectID string) (spec.DesiredProject, bool) {
	r.desiredMu.Lock()
	defer r.desiredMu.Unlock()
	project, ok := r.lastDesired[projectID]
	return project, ok
}
