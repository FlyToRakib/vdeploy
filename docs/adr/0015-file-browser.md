# 0015 — Browsing an app's files without a way out of the folder

**Status:** accepted · 2026-09-27

## Context

§20 Runtime asks for a **file/volume browser** beside the web terminal, and
M4's exit is that *nothing essential requires SSH*. The question it answers
is the most ordinary one a non-coder has: **did my upload actually arrive?**
Until now the only way to answer it was the terminal — which is Tier 4,
human-only and session-recorded, because it is a shell. Looking at a folder
should not cost that.

Three mechanisms were available.

**Run something in a container.** `ls` inside the app's own container, or a
helper mounting the volume. This is exactly what [ADR 0014](0014-web-terminal.md)
spent its whole argument keeping to one place. A second exec path for
listing files would undo that, and the command would have to be composed
from a path the control plane supplied — the shape every injection lives in.

**Docker's copy endpoint on a container created and never started**, the
pattern snapshots, downloads and imports already use (§17.4). It works for
*one known file*: `HEAD /containers/{id}/archive?path=…` stats it. It does
not work for listing, because there is no listing endpoint — the only way to
learn what is in a directory is to `GET` a tar of the **whole** directory and
read the headers. Listing a 5 GB uploads folder would move 5 GB through the
socket to print forty names, and a depth-first tar means a byte budget
truncates the answer somewhere arbitrary rather than at a page boundary.

**Read the directory on the host.** A local-driver volume is a directory
under Docker's root. The agent is already root on this machine and already
reads the host directly where that is the honest answer: `/proc/stat` and
`/proc/meminfo` for metrics, a container's listening sockets through
`/proc/net` for diagnosis (§32), `statfs` for free disk.

## Decision

**The agent reads the folder on the host, confined to it by the kernel.**

The folder is opened as an `os.Root` and every read after that goes through
it. On Linux that is `openat2` with `RESOLVE_BENEATH`: a symlink inside a
volume pointing at `/etc/shadow`, an absolute path, a `..` — none of them
resolve. The confinement is a property of the file descriptor, not of a
string check that has to be right every time somebody adds a code path.

Three things follow from that, and each is also a rule of its own:

- **A shortcut is shown and never followed.** It appears in a listing as
  what it is, with where it points as text. It cannot be downloaded. A
  symlink is data about the folder, not a way through it.
- **The control plane names a folder, never a path.** A request carries a
  project id and a permanent folder's name — `uploads`, as the dashboard
  writes it — and the agent derives the volume the same way it does when it
  creates a replica. The Engine is then asked for that volume and refuses
  any that does not carry VDeploy's own label for that project.
- **Only permanent folders.** Not the container's writable layer. Those
  files are deleted on the next deploy, and a browser over them would show
  people files that are not really theirs.

Taking one file away reuses the **credit-paced artifact channel** built for
backup downloads ([ADR 0013](0013-data-out-and-back.md)) rather than a second
one: the same chunking, the same acknowledgement per chunk, the same last
chunk held back until the whole file hashes to what the agent read.

## Consequences

An agent that cannot see the server's disk — one running in a container with
only the Docker socket mounted — cannot browse. It says so in those words
rather than failing obscurely. This is not the supported topology (§19 has
the agent on the host), and the terminal still works there.

Reading is all this does. Putting a file in, or taking one out of the
folder, is a change to what an app holds and belongs in the pipeline with
the other changes; it is not part of this decision.

`files.list` reads the `sourceFiles` category, which is the one read grant
**off by default** for the assistant (§8): what an app has written is the
customer's. `files.download` is Tier 4 for the same reason a backup download
is — data leaving VDeploy is a person's decision — while its role and
step-up stay proportionate to one file out of an uploads folder.
