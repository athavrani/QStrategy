import { detectPublicIp } from '../services/PublicIpService';
import { dhanIpService, evaluateIpGuard } from '../services/dhan/DhanIpService';

/**
 * Checks that this device's current public IP is one of the IPs whitelisted with Dhan.
 * Returns a message when an order must not be sent, or null when the IP matches.
 * Anything unclear (lookup failed, whitelist unreadable) counts as a refusal.
 */
export async function ipPreflight(): Promise<string | null> {
  const [detected, config] = await Promise.all([detectPublicIp(), dhanIpService.getIp()]);
  if (!detected.ok) return `Could not check this device's IP: ${detected.error}`;
  if (!config.ok) return `Could not read the Dhan IP whitelist: ${config.error}`;

  const state = evaluateIpGuard(detected.ip, config.data);
  if (state === 'MATCH') return null;
  if (state === 'NOT_WHITELISTED') return 'No IP is whitelisted with Dhan yet. Set it in Settings first.';
  return `This device's IP (${detected.ip}) is not the IP whitelisted with Dhan, so Dhan would reject the order.`;
}
