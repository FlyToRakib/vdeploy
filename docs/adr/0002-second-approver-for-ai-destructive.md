# 0002 — "Require 2nd approver for T3" applies to AI-proposed changes

**Status:** accepted · 2026-09-19

## Context

§8 L1 lists a guardrail "Require 2nd approver for T3", on by default. Read
literally for every tier-3 change, a one-person organization — the solo
builder VDeploy optimizes for — could never delete anything.

## Decision

The guardrail sits in the AI grant matrix, so it governs AI-proposed
changes: a destructive plan the AI made on behalf of user U must be approved
by a person other than U. A person's own destructive change still needs an
explicit confirmation with fresh step-up authentication, but not a second
person. The approver must always hold a role that could perform the change
directly, and is never an AI.

## Consequences

- In a solo org the AI can propose a destructive change but not get it
  approved until the owner turns the guardrail off; the grant matrix UI must
  say so plainly. Doing the change manually remains possible.
- Teams get four-eyes on everything destructive the AI suggests, by default.
