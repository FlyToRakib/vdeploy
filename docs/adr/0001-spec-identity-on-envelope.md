# 0001 — Spec identity lives on the envelope, not in the document

**Status:** accepted · 2026-09-19

## Context

The §5 example shows `metadata.id` and `metadata.org` inside the Application
spec. The spec is the document humans edit, the AI proposes diffs to, and the
agent converges on. It is also hashed (`spec_hash`) into every Release.

## Decision

The spec document carries only desired state: `metadata` holds `name` and
`labels`. The project id and org id are server-assigned and travel on the
envelope around the spec (the database row, the agent `desired_state` frame).

## Consequences

- No spec edit — human, AI or API — can move a project to another org or
  impersonate another project id. The L3 scope check stays the only place ids
  are resolved.
- `spec_hash` is a hash of intent alone; identical intent hashes identically.
- `docs/vdeploy.md` §5 is illustrative on this point; this ADR is normative.
