/**
 * How many tool calls each AI session made in the last minute (§8 L3).
 *
 * A runaway loop has to stop here rather than at the bill, and it has to
 * stop on reads as well as changes — which is why this is counted where
 * every call passes, not read back out of the audit log, which records
 * changes and refusals but not reads. It lives in memory, like the HTTP
 * rate limit beside it: this is a brake on a loop, and a restart that
 * forgets the last minute forgets nothing that matters.
 */
export class AiCallWindow {
  private readonly calls = new Map<string, number[]>();

  constructor(private readonly spanMs = 60_000) {}

  /** Records a call, and says how many this session made before it inside the window. */
  hit(sessionId: string, now: number): number {
    const recent = (this.calls.get(sessionId) ?? []).filter((at) => now - at < this.spanMs);
    const before = recent.length;
    recent.push(now);
    this.calls.set(sessionId, recent);
    if (this.calls.size > 1000) this.forgetQuiet(now);
    return before;
  }

  /** Sessions that have gone quiet are dropped, so the map does not grow for ever. */
  private forgetQuiet(now: number) {
    for (const [session, at] of this.calls) {
      if (at.every((t) => now - t >= this.spanMs)) this.calls.delete(session);
    }
  }
}
