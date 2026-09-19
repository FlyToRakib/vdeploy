# 0009 — Notifications: a Postgres outbox, signed webhooks, internet-only targets

**Status:** accepted · 2026-09-20

## Context

§18 asks for notifications on deploy failures, failing health, an offline
agent, OOM kills and AI-applied changes. M2 delivers email and webhooks.
Slack, Discord and Telegram come later. Three questions were not obvious:

1. **When is a notification written, and by whom?** The events come from the
   worker (deploy outcomes, offline servers) and from the API's agent
   gateway (crashes and OOM kills in reports, unreachable ports). A send
   inside those paths would slow them down, lose messages on a crash, and
   send twice on a retry.
2. **How does a receiver know a webhook really came from VDeploy?**
3. **A webhook URL is typed by a person** (or proposed by the AI, through
   the gate), and the worker then makes a request to it. It could point at
   the control plane's own database, a cloud metadata endpoint
   (169.254.169.254) or anything else on the private network.

## Decision

- **Outbox in Postgres.** `notify()` writes one `notification_deliveries`
  row per interested channel, with a key per cause (`plan:<id>`,
  `offline:<server>:<last seen>`, `oom:<project>:<hour>`). A unique
  `(channel, key)` index means one cause is told once, however often it is
  seen. The worker leases due rows (`for update skip locked`) and sends
  them. It retries after 1 min, 5 min, 30 min, 2 h and 6 h, then marks the
  row failed with the reason. The same database already carries the queue
  (ADR 0005), so nothing new is needed to run it.
- **Signature.** Each webhook channel gets its own secret (`whsec_…`),
  shown once at creation and stored sealed by the installation key.
  Deliveries carry `x-vdeploy-signature: t=<unix>,v1=<hex HMAC-SHA256 of
  "<t>.<body>">`. The timestamp is signed, so a receiver can refuse replays.
  `verifyWebhook` in `@vdeploy/core` is the reference check.
- **Internet-only targets.** Before sending, the worker resolves the host.
  If any address it gets back is not public, it refuses: loopback, private,
  link-local, CGNAT, unique-local, NAT64 and IPv4-mapped forms all count.
  It then connects to the address it checked, not to a fresh lookup, so DNS
  rebinding cannot swap the target. Redirects are not followed. A LAN-only
  installation can switch this off with `WEBHOOK_ALLOW_PRIVATE=true`.
- **No app output in notifications.** Crash notifications carry only what
  the §32 rules name. The raw last output of a crash loop can contain
  anything, including secrets the app printed, so it stays in the dashboard.

## Consequences

- A notification exists as soon as its cause is recorded. Sending it is
  retried until it succeeds or is given up, and the attempt history is
  visible (`notification.deliveries`).
- Delivery is at least once: a worker that dies after sending but before
  recording it sends again. Receivers deduplicate on `x-vdeploy-delivery`.
- Channels are org settings: they are changed directly (audited, admin
  only), not through deploy plans.
