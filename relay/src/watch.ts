import type { Upstream } from './upstream.js';

export interface WatchDeps {
  upstream: Pick<Upstream, 'egressIp'>;
  webhookUrl?: string;
  log: (message: string) => void;
  post?: (url: string, body: string) => Promise<void>;
}

const defaultPost = async (url: string, body: string): Promise<void> => {
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, signal: AbortSignal.timeout(5000) });
};

/**
 * Notices when the host's public IP changes. Dhan only accepts orders from the whitelisted IP, so a change
 * means orders will start failing until the new IP is whitelisted.
 */
export function createEgressWatch(deps: WatchDeps) {
  let last: string | null = null;
  const post = deps.post ?? defaultPost;

  return {
    async checkOnce(): Promise<void> {
      const ip = await deps.upstream.egressIp();
      // A failed lookup is not a change.
      if (!ip) return;
      if (last && ip !== last) {
        const message = `QStrategy relay IP changed from ${last} to ${ip}. Dhan will reject orders until the new IP is whitelisted.`;
        deps.log(message);
        if (deps.webhookUrl) {
          try {
            await post(deps.webhookUrl, message);
          } catch (err) {
            deps.log(`Alert webhook failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      last = ip;
    },
  };
}
