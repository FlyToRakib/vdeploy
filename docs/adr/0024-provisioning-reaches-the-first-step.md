# 0024 — Provisioning reaches the first step, it is not a second one

**Status:** accepted · 2026-09-30

## Context

§26 M6's last item is server auto-provisioning at Hetzner, DigitalOcean
and Vultr: VDeploy makes the machine rather than asking somebody to go
and make one.

The way this usually goes wrong is that "we make the machine" becomes a
second way of setting a server up — its own bootstrap, its own SSH, its
own idea of when a server is ready — living beside the one that already
works. Then there are two installers, two enrollment paths, and one of
them is wrong on a Tuesday because nobody exercises it.

## Decision

**Provisioning is a way of reaching the existing first step.**

VDeploy asks the provider for a machine whose cloud-init user-data is
**the same one command** the dashboard shows somebody adding a server by
hand:

```
curl -fsSL <this VDeploy>/api/v1/agent/install.sh | sh -s -- --token <token>
```

The token is an ordinary enrollment token, minted the same way, with the
same fifteen minutes. The machine boots, runs the installer that is
already tested, and its agent connects **outbound** exactly as every
other agent does. Everything after "a machine exists" is the path that
was already there.

That is why there is no SSH anywhere in this. VDeploy never connects
*to* a server — not to install, not to provision — and provisioning does
not become the one exception.

Three consequences fall out of the same choice:

- **The row is written before the machine is ordered.** A machine that
  exists with nowhere to enroll is the failure that costs money quietly,
  so the order is: server row, enrollment token, then ask the provider.
  If the provider refuses, the row is removed — a pending server nobody
  can connect to would sit in the list forever.
- **A watcher records the address, and nothing else.** The agent is what
  makes a server online; the loop only learns where the machine is
  before that happens, and says so after half an hour if nothing ever
  connects. Without it, a machine that failed at the provider is a row
  saying "pending" with no explanation.
- **Forgetting a cloud account does not delete servers.** They keep
  running and keep costing money, and the answer says so. Deleting
  somebody's machines as a side effect of tidying up a token is not a
  thing to be clever about.

## Asking for a machine is a person's job

`server.provision` is **tier 4**, like `server.add` beside it — which only
adds a machine somebody already has and already pays for. Asking a
provider for a new one starts a monthly bill, and the AI's spend cap
(§8 L7) counts tokens: nothing in the grant matrix counts money that is
not tokens. "Costs money every month" is therefore a blast radius the
matrix has no answer for, and the honest place to stop it is where every
other money-shaped decision stops.

It was tier 2 first. Reading the catalog against itself — free
`server.add` at tier 4, billable `server.provision` at tier 2 — is what
made that obvious.

## Three providers, one file

Each provider's shapes live beside each other in `clouds.ts` because the
differences *are* the content: Hetzner names an image and reports memory
in gigabytes; DigitalOcean spells the same Ubuntu differently and hides
the public address in a list of networks; Vultr wants a numeric image id
it will only tell you if you ask, wants the boot script base64-encoded,
and answers `0.0.0.0` while it is still thinking. Splitting those into
three files with a shared base class would hide exactly the lines
somebody debugging needs to read.

## What this costs, honestly

- **These are implemented from each provider's documented API and
  exercised against a stand-in, not against live accounts.** The shapes
  are asserted in tests — the image name, the encoding, the placeholder
  address — but nobody here has watched a real Hetzner machine come up.
  The first person to try one may find a field named differently, and
  that is where it would show.
- **Ubuntu 24.04 only.** One image per provider, chosen by VDeploy. An
  organization with a different standard image has no way to say so.
- **No destroying.** VDeploy can make a machine and will not delete one:
  removing a server here leaves the machine running at the provider, and
  the dashboard says so. Deleting somebody's server is not a thing to add
  until it is a decision somebody makes twice, deliberately.
- **No SSH key management.** Keys already at the provider can be named,
  but VDeploy will not create one. Somebody who names none has a machine
  they can reach only through the provider's console — which is enough,
  because VDeploy itself never needs to log in.

## One thing it gets right

**The price is on the screen before the button.** Sizes are listed with
what they cost a month, in the provider's own currency, and the sentence
under them says it keeps costing that until the machine is deleted at
the provider. A platform that spends somebody's money should say how
much, in the place where they spend it.
