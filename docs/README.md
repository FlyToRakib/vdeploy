# VDeploy — Documentation Index

## ✅ The plan

**[vdeploy.md](vdeploy.md) — Architecture & Product Specification v2.0**

**This is the single, complete, current plan. Build from this file.** It is self-contained — nothing else in this folder is required.

| Part | Contents |
|---|---|
| **I — Foundation** | Vision · scope & locked decisions · the 8 non-negotiables · why AI-first |
| **II — The Kernel** | Change pipeline · resource model · system topology |
| **III — AI Architecture** | Capabilities · the 7-layer security gate · modes · proposals · context · site creation |
| **IV — The Platform** | Routing & load balancing · instant URLs (§13.1) · autoscaling · builds · deploy strategies · **data & persistence (§17)** · observability · low-resource engineering · manual control surface · **dashboard UX (§20.1)** · **auth & account security (§20.2)** |
| **V — Engineering** | Tech stack · repo layout · data model · operation catalog · agent protocol |
| **VI — Delivery** | Milestones M1–M6 · non-goals · positioning · the three invariants |
| **VII — Completeness Audit** | The non-coder journey · edge-case catalog · plain-language layer · AI edge cases · install & upgrade (§34.1) · **test & release strategy (§34.2)** · the completeness test |

**Locked decisions:** open source (AGPL-3.0 recommended) · BYOK for AI · self-host first, no billing.

**Build order:** `packages/contracts` → kernel + policy engine → auth + app shell → Go agent with L6 refusals → first end-to-end deploy.

---

## 📋 Historical — reference only, do not build from

| File | What it is |
|---|---|
| [vdeploy-review.md](vdeploy-review.md) | Gap analysis of the original draft. **Every finding is already folded into `vdeploy.md`.** Kept because it records *why* several core decisions were made — declarative state, immutable releases, the Traefik file provider, agent-side spec validation |
| [archive/vdeploy-draft-v1.md](archive/vdeploy-draft-v1.md) | The original first draft, preserved unchanged |
