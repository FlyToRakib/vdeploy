# 0026 — Object storage is a managed engine, served by RustFS

**Status:** accepted · 2026-09-29

## Context

§17.1 names three storage tiers. The third, object storage, is "bring your
own (S3/R2/B2/Spaces) or run managed MinIO": files every copy of an app
shares, which live outside any one container.

Two facts shaped how.

- **MinIO no longer publishes its images.** Checked on 2026-09-29:
  `minio/minio` no longer exists on Docker Hub, and `quay.io/minio/minio`
  refuses anonymous pulls. MinIO's community edition is source-only now,
  so "run managed MinIO" would mean VDeploy building and patching MinIO
  itself.
- **A managed store has everything a managed database has.** It lives on
  one server, in one volume, behind a generated credential. It is reached
  only from the apps given it, it can be opened on a port, and it has to
  be backed up, checked and put back. §17.3 already does all of that for
  databases, including linking across servers through the mesh.

## Decision

**Object storage is the `s3` database engine**, with its own profile in
`packages/core/src/databases.ts`. It is created, linked, stopped, opened,
moved and deleted by the same operations as a database.

**The image is RustFS** (`rustfs/rustfs:1.0.0`): Apache-2.0, an S3 server
with MinIO's shape (one data folder, root keys from its environment), and
it runs as its own non-root user. Garage was the other candidate. It needs
a config file and manual layout steps before it serves anything, which
does not fit a container that has to start unattended. A compose file
naming `minio/minio` is imported as this engine.

- **The bucket is made before the server starts.** RustFS treats a folder
  at the top of its data as a bucket and has no setting that names one.
  So the agent starts it through `/bin/sh -c` to make that folder, then
  runs the image's own entrypoint. That needs an entrypoint on the
  container; `compose.Container` gains one, set only for databases. The
  web console is turned off.
- **A link hands over what the S3 SDKs read by themselves:**
  `AWS_ENDPOINT_URL` (kept as a secret, like any address a link gives),
  `AWS_REGION`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, and
  `AWS_SECRET_ACCESS_KEY` as a secret. Unlinking removes every one of
  them. Links now record all the settings they set, which also fixes
  unlinking a database linked "in pieces": its password used to stay.
- **Bring your own bucket needs no new machinery.** The project's Object
  storage section stores the secret key with `secret.set` and sets the
  same five names with `env.import`: one deploy, and the app's code is
  the same whichever store it uses. It has presets for S3, R2, B2 and
  Spaces.
- **Backups are the store's folder.** They are archived through Docker's
  copy endpoints, the way a snapshot archives an app's folders, with no
  client and no shell. RustFS writes each object whole before moving it
  into place, so the store keeps running. A restore reads the whole
  archive first and refuses one that is cut short or is not a store. It
  then puts every object back as it was, over the running store, and
  leaves objects made since alone. Verifying a backup reads every byte
  back through its checksums and counts the buckets and objects in it.

## Consequences

- Virtual-hosted addressing (`bucket.host`) is not served, so apps ask
  their library for path-style requests (`forcePathStyle: true` in the
  AWS SDK). The dashboard says so where it links a store.
- A restore brings deleted objects back; it does not delete newer ones.
  Deleting objects is what the app does, not what a restore does.
- No bucket credential goes through the control plane in the clear. The
  managed store's key is generated and sealed like a database password.
  A key someone brings is a project secret like any other.
- Moving off RustFS later is a change to one profile. The data format is
  RustFS's own, and a backup restores only into RustFS. The S3 protocol
  is the way out: any S3 tool can copy a bucket elsewhere.
