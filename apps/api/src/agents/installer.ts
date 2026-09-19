import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';

/** The processors VDeploy servers run on, as Go names them. */
export const AGENT_ARCHES = ['amd64', 'arm64'] as const;
export type AgentArch = (typeof AGENT_ARCHES)[number];

export const binaryName = (arch: AgentArch) => `vd-agent-linux-${arch}`;

/**
 * The agent binaries this control plane serves, with their SHA-256. Hashed
 * once, at the first request: the files never change while it runs.
 */
export class AgentBinaries {
  private sums: Promise<Record<AgentArch, string> | null> | null = null;

  constructor(private readonly dir: string) {}

  path(arch: AgentArch): string {
    return join(this.dir, binaryName(arch));
  }

  checksums(): Promise<Record<AgentArch, string> | null> {
    this.sums ??= (async () => {
      if (!AGENT_ARCHES.every((a) => existsSync(this.path(a)))) return null;
      const entries = await Promise.all(
        AGENT_ARCHES.map(
          (arch) =>
            new Promise<[AgentArch, string]>((resolve, reject) => {
              const hash = createHash('sha256');
              createReadStream(this.path(arch))
                .on('data', (chunk) => hash.update(chunk))
                .on('end', () => {
                  resolve([arch, hash.digest('hex')]);
                })
                .on('error', reject);
            }),
        ),
      );
      return Object.fromEntries(entries) as Record<AgentArch, string>;
    })();
    return this.sums;
  }
}

/** Single-quoted for sh: the only character that needs care inside is the quote itself. */
const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The one-command bootstrap (§25): `curl -fsSL <url>/api/v1/agent/install.sh
 * | sh -s -- --token <token>`. It checks before it changes anything, verifies
 * the download against checksums this control plane computed, and is safe
 * to run again: a second run updates the agent and changes nothing else.
 */
export function installScript(publicUrl: string, sums: Record<AgentArch, string>): string {
  return `#!/bin/sh
# VDeploy agent installer. Options:
#   --token <token>   the one-time token from the dashboard (first install only)
#   --dry-run         check this server and stop; nothing is installed or changed
#   --no-service      do not set up systemd (containers and test machines)
# Running it again updates the agent; it never touches anything else.
set -eu

CP_URL=${shQuote(publicUrl)}
SUM_amd64=${shQuote(sums.amd64)}
SUM_arm64=${shQuote(sums.arm64)}
STATE_DIR=/var/lib/vdeploy

TOKEN=''
DRY_RUN=0
SERVICE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="\${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-service) SERVICE=0; shift ;;
    *) echo "VDeploy: unknown option $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\\n' "$*"; }
fail() { printf 'VDeploy: %s\\n' "$*" >&2; exit 1; }
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
  else fail "curl or wget is needed to download the agent."; fi
}

[ "$(id -u)" = 0 ] || fail "run this as root (for example: sudo sh), so the agent can manage Docker."
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64; SUM="$SUM_amd64" ;;
  aarch64|arm64) ARCH=arm64; SUM="$SUM_arm64" ;;
  *) fail "this processor ($(uname -m)) is not supported: VDeploy runs on x86-64 and ARM64 servers." ;;
esac
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is needed to check the download."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
say "Downloading the VDeploy agent ($ARCH)..."
fetch "$CP_URL/api/v1/agent/download/vd-agent-linux-$ARCH" "$TMP/vd-agent"
echo "$SUM  $TMP/vd-agent" | sha256sum -c - >/dev/null 2>&1 \\
  || fail "the download is damaged (its checksum does not match); nothing was installed. Please try again."
chmod 755 "$TMP/vd-agent"

if [ -f "$STATE_DIR/identity.json" ]; then
  # Connected already: its own router holds ports 80 and 443, so the first-install checks do not apply.
  say "This server is already connected; updating the agent."
else
  say "Checking this server..."
  "$TMP/vd-agent" preflight || fail "this server is not ready; nothing was installed or changed."
fi
if [ "$DRY_RUN" = 1 ]; then
  say "Dry run: this server is ready. Nothing was installed or changed."
  exit 0
fi

install -m 755 "$TMP/vd-agent" /usr/local/bin/vd-agent
if [ -f "$STATE_DIR/identity.json" ]; then
  say "Already connected; the agent was updated."
else
  [ -n "$TOKEN" ] || fail "--token is needed the first time; copy the command from the dashboard."
  /usr/local/bin/vd-agent enroll --url "$CP_URL" --token "$TOKEN"
fi

if [ "$SERVICE" = 0 ]; then
  say "Installed. Start the agent with: vd-agent run"
  exit 0
fi
command -v systemctl >/dev/null 2>&1 || fail "systemd is needed to keep the agent running; start it yourself with: vd-agent run"
cat > /etc/systemd/system/vd-agent.service <<'UNIT'
[Unit]
Description=VDeploy agent
Documentation=https://github.com/FlyToRakib/vdeploy
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
ExecStart=/usr/local/bin/vd-agent run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable vd-agent >/dev/null 2>&1
systemctl restart vd-agent
say "Done: the agent is running, and starts again after a reboot. Watch the dashboard: this server shows as connected."
`;
}
