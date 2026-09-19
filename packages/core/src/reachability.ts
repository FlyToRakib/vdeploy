import type { PortReach, Reachability } from '@vdeploy/contracts';

/**
 * The provider quirk matrix (§30): where each provider blocks web traffic
 * before it reaches the server, and the exact place to open it.
 */
const PROVIDER_FIREWALLS: Record<string, string[]> = {
  'Oracle Cloud': [
    'Oracle blocks web traffic in two places, and both must allow it.',
    'In the Oracle Cloud console: Networking → Virtual Cloud Networks → your network → Security Lists → Default Security List → Add Ingress Rules: source 0.0.0.0/0, TCP, destination ports 80,443.',
    "On the server itself (Oracle's images ship with a firewall that rejects them): sudo iptables -I INPUT 6 -p tcp -m multiport --dports 80,443 -j ACCEPT && sudo netfilter-persistent save",
  ],
  AWS: [
    'In the AWS console: EC2 → Instances → your server → Security → the security group → Edit inbound rules → add HTTP and HTTPS from 0.0.0.0/0 (Anywhere-IPv4).',
  ],
  'Google Cloud': [
    'In the Google Cloud console: Compute Engine → VM instances → your server → Edit → tick "Allow HTTP traffic" and "Allow HTTPS traffic" → Save.',
  ],
  Azure: [
    'In the Azure portal: your virtual machine → Networking → Add inbound port rule: ports 80 and 443, TCP, source Any.',
  ],
  Hetzner: [
    'In the Hetzner Cloud console: Firewalls → the firewall attached to this server → Inbound rules → add TCP 80 and TCP 443 from any IPv4 and IPv6. (A server with no firewall attached is not blocked by Hetzner.)',
  ],
  DigitalOcean: [
    'In the DigitalOcean control panel: Networking → Firewalls → the firewall on this Droplet → Inbound Rules → add HTTP and HTTPS.',
  ],
  Vultr: [
    'In the Vultr dashboard: Network → Firewall → the group on this server → add TCP 80 and TCP 443 from anywhere.',
  ],
  'Akamai (Linode)': [
    'In the Akamai (Linode) Cloud Manager: Firewalls → the firewall on this Linode → Inbound Rules → add HTTP and HTTPS, action Accept.',
  ],
};

const HOST_FIREWALL =
  'If the server runs its own firewall, allow the ports there too: sudo ufw allow 80/tcp && sudo ufw allow 443/tcp (Ubuntu/Debian), or sudo firewall-cmd --permanent --add-service=http --add-service=https && sudo firewall-cmd --reload (Rocky/Alma/RHEL).';

const GENERIC =
  "In your hosting provider's dashboard, find the firewall (sometimes called a security group or network rules) for this server and allow incoming TCP on ports 80 and 443 from anywhere.";

/**
 * Turns what a connect from the control plane found into a verdict and the
 * steps to fix it, written for the provider the agent recognised.
 */
export function reachabilityVerdict(input: {
  ipv4: string | null;
  provider: string | null;
  ports: { 80?: PortReach; 443?: PortReach };
  checkedAt: Date;
}): Reachability {
  const base = {
    ipv4: input.ipv4,
    ports: input.ports,
    provider: input.provider,
    checkedAt: input.checkedAt.toISOString(),
  };
  if (input.ipv4 === null) {
    return {
      ...base,
      status: 'unknown',
      plain:
        'This server has no public address we know of, so we cannot check whether visitors can reach it.',
      fix: ['Set the address visitors reach the server at (Servers → Address), then check again.'],
    };
  }
  const blocked = ([80, 443] as const).filter((p) => input.ports[p] !== 'open');
  if (blocked.length === 0) {
    return {
      ...base,
      status: 'reachable',
      plain: `Visitors can reach this server at ${input.ipv4} on ports 80 and 443.`,
      fix: [],
    };
  }
  const which = blocked.join(' and ');
  const refused = blocked.every((p) => input.ports[p] === 'closed');
  if (refused) {
    return {
      ...base,
      status: blocked.length === 2 ? 'blocked' : 'partly',
      plain: `The server at ${input.ipv4} answers, but refuses connections on port ${which}: the VDeploy router may not be running yet, or a firewall on the server rejects them.`,
      fix: ['Wait a minute and check again: the router starts with the agent.', HOST_FIREWALL],
    };
  }
  const provider = input.provider ? PROVIDER_FIREWALLS[input.provider] : undefined;
  return {
    ...base,
    status: blocked.length === 2 ? 'blocked' : 'partly',
    plain: `Visitors cannot reach this server on port ${which}: connections to ${input.ipv4} get no answer, which almost always means a firewall${input.provider ? ` at ${input.provider}` : ' at your hosting provider'} is dropping them. Your sites stay unreachable, and no certificate can be issued, until it is opened.`,
    fix: [
      ...(provider ?? [GENERIC]),
      ...(input.provider === 'Oracle Cloud' ? [] : [HOST_FIREWALL]),
    ],
  };
}
