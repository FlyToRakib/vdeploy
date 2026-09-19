import { connect } from 'node:net';
import { VDeployError, type PortReach, type Reachability } from '@vdeploy/contracts';
import { isPublicIpv4, reachabilityVerdict } from '@vdeploy/core';
import { servers, type Database } from '@vdeploy/db';
import { eq } from 'drizzle-orm';

/** Connects to one port and says what answered. */
export type PortProbe = (host: string, port: number) => Promise<PortReach>;

const TIMEOUT_MS = 5000;

/**
 * A plain TCP connect, from the control plane rather than the server itself:
 * a server can always reach its own ports, visitors often cannot (§30 ③).
 * Nothing is sent; the connection closes as soon as it opens.
 */
export const tcpProbe: PortProbe = (host, port) =>
  new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result: PortReach) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(TIMEOUT_MS, () => {
      done('filtered');
    });
    socket.once('connect', () => {
      done('open');
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      done(err.code === 'ECONNREFUSED' ? 'closed' : 'filtered');
    });
  });

/**
 * Checks whether visitors can reach a server's web ports and stores the
 * verdict. Only a public IPv4 the server row holds is ever probed, and only
 * ports 80 and 443: an agent cannot point the control plane anywhere else.
 */
export async function checkReachability(
  db: Database,
  serverId: string,
  probe: PortProbe,
  now: () => Date,
): Promise<Reachability> {
  const [server] = await db
    .select({ ipv4: servers.publicIpv4, provider: servers.provider })
    .from(servers)
    .where(eq(servers.id, serverId));
  if (!server) throw new VDeployError('not_found', 'Server not found');
  const ipv4 = server.ipv4 && isPublicIpv4(server.ipv4) ? server.ipv4 : null;
  const ports: { 80?: PortReach; 443?: PortReach } = {};
  if (ipv4) {
    const [http, https] = await Promise.all([probe(ipv4, 80), probe(ipv4, 443)]);
    ports[80] = http;
    ports[443] = https;
  }
  const result = reachabilityVerdict({
    ipv4,
    unusable: ipv4 ? null : server.ipv4,
    provider: server.provider,
    ports,
    checkedAt: now(),
  });
  await db.update(servers).set({ reachability: result }).where(eq(servers.id, serverId));
  return result;
}
