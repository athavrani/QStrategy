export class TokenBucket {
  private state = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now
  ) {}

  /** Takes one token for the key; false means the caller is over its rate. */
  take(key = '_'): boolean {
    const t = this.now();
    if (this.state.size > 10_000) this.state.clear();
    const s = this.state.get(key) ?? { tokens: this.burst, at: t };
    const tokens = Math.min(this.burst, s.tokens + ((t - s.at) / 1000) * this.ratePerSec);
    if (tokens < 1) {
      this.state.set(key, { tokens, at: t });
      return false;
    }
    this.state.set(key, { tokens: tokens - 1, at: t });
    return true;
  }
}
