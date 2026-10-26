import { describe, expect, it, vi } from 'vitest';
import { createEgressWatch } from '../src/watch.js';

const upstreamReturning = (ips: Array<string | null>) => {
  let i = 0;
  return { egressIp: async () => ips[Math.min(i++, ips.length - 1)] };
};

describe('egress watch', () => {
  it('alerts once when the IP changes, not on the first reading or when it is unchanged', async () => {
    const post = vi.fn(async (_url: string, _body: string) => {});
    const log = vi.fn();
    const watch = createEgressWatch({ upstream: upstreamReturning(['1.1.1.1', '1.1.1.1', '2.2.2.2', '2.2.2.2']), webhookUrl: 'https://ntfy.test/x', log, post });

    await watch.checkOnce();
    await watch.checkOnce();
    expect(post).not.toHaveBeenCalled();

    await watch.checkOnce();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toContain('1.1.1.1 to 2.2.2.2');

    await watch.checkOnce();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('treats a failed lookup as no change', async () => {
    const post = vi.fn(async () => {});
    const watch = createEgressWatch({ upstream: upstreamReturning(['1.1.1.1', null, '1.1.1.1']), webhookUrl: 'https://ntfy.test/x', log: () => {}, post });
    await watch.checkOnce();
    await watch.checkOnce();
    await watch.checkOnce();
    expect(post).not.toHaveBeenCalled();
  });

  it('still logs the change when no webhook is set, and survives a failing webhook', async () => {
    const log = vi.fn();
    const quiet = createEgressWatch({ upstream: upstreamReturning(['1.1.1.1', '2.2.2.2']), log });
    await quiet.checkOnce();
    await quiet.checkOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('changed from 1.1.1.1 to 2.2.2.2'));

    const failing = createEgressWatch({
      upstream: upstreamReturning(['1.1.1.1', '2.2.2.2']),
      webhookUrl: 'https://ntfy.test/x',
      log,
      post: async () => {
        throw new Error('down');
      },
    });
    await failing.checkOnce();
    await expect(failing.checkOnce()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Alert webhook failed: down'));
  });
});
