import { secureVault, isDhanJwtToken } from '../services/SecureCredentialVault';
import { isBackgroundMonitorEnabled } from '../services/backgroundMonitorService';
import { positionRepository, type Position } from '../services/PositionRepository';
import { tradingCalendarService } from '../services/TradingCalendarService';
import { loadExecutionSettings } from './executionSettings';
import { ipPreflight } from './ipPreflight';
import { isLiveArmed } from './liveArm';
import { marketHoursBlock } from './orderMapping';
import type { ExecutionSettings } from './types';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface ReadinessCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface ReadinessDeps {
  loadSettings: () => Promise<ExecutionSettings>;
  token: () => Promise<string>;
  tokenSecondsLeft: (token: string) => number | null;
  /** Returns a refusal message, or null when this device's IP matches the Dhan whitelist. */
  checkIp: () => Promise<string | null>;
  isArmed: () => boolean;
  backgroundMonitoring: () => Promise<boolean>;
  activePositions: () => Promise<Position[]>;
  now: () => Date;
  isTradingDay: (d: Date) => boolean;
}

const defaults = (): ReadinessDeps => ({
  loadSettings: loadExecutionSettings,
  token: async () => (await secureVault.getEffectiveCredentials()).token,
  tokenSecondsLeft: (t) => secureVault.getTokenRemainingSeconds(t),
  checkIp: ipPreflight,
  isArmed: () => isLiveArmed(),
  backgroundMonitoring: isBackgroundMonitorEnabled,
  activePositions: () => positionRepository.loadActive(),
  now: () => new Date(),
  isTradingDay: (d) => tradingCalendarService.isTradingDay(d),
});

const minutes = (s: number) => Math.round(s / 60);

/** Everything worth checking before the first signal of the day. Each check fails on its own and never throws. */
export async function runReadinessChecks(overrides: Partial<ReadinessDeps> = {}): Promise<ReadinessCheck[]> {
  const d = { ...defaults(), ...overrides };
  const checks: ReadinessCheck[] = [];
  const add = (id: string, label: string, status: CheckStatus, detail: string) => checks.push({ id, label, status, detail });
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };

  const token = await safe(d.token, '');
  if (isDhanJwtToken(token)) add('token', 'Live Dhan token', 'PASS', 'A token is saved.');
  else add('token', 'Live Dhan token', 'FAIL', 'No valid live token is saved. Generate one and save it in Settings.');

  if (isDhanJwtToken(token)) {
    const left = d.tokenSecondsLeft(token);
    if (left === null) add('token-life', 'Token validity', 'WARN', 'Could not read when the token ends.');
    else if (left <= 0) add('token-life', 'Token validity', 'FAIL', 'The token has expired. Generate a new one.');
    else if (left < 2 * 3600) add('token-life', 'Token validity', 'WARN', `The token ends in about ${minutes(left)} min.`);
    else add('token-life', 'Token validity', 'PASS', `About ${Math.round(left / 3600)} h left.`);
  }

  const ipProblem = await safe(d.checkIp, 'The IP check failed to run.');
  add('ip', 'Device IP matches the Dhan whitelist', ipProblem ? 'FAIL' : 'PASS', ipProblem ?? 'This device IP is whitelisted.');

  const settings = await safe(d.loadSettings, null);
  if (!settings) {
    add('settings', 'Execution settings', 'FAIL', 'Settings could not be read.');
  } else {
    add(
      'mode',
      'Mode',
      settings.mode === 'CONFIRM' ? 'PASS' : 'WARN',
      settings.mode === 'CONFIRM' ? 'Confirm: live orders are sent only after you confirm them.' : settings.mode === 'PAPER' ? 'Paper: orders are recorded but not sent.' : 'Off: signals are ignored.'
    );
    add('kill', 'Kill switch', settings.killSwitch ? 'FAIL' : 'PASS', settings.killSwitch ? 'The kill switch is on, so every signal is blocked.' : 'Off.');
    const enabled = Object.values(settings.strategies).filter((s) => s.enabled).length;
    add('strategies', 'Strategies', enabled > 0 ? 'PASS' : 'WARN', enabled > 0 ? `${enabled} enabled.` : 'No strategy is enabled, so no signal can become an order.');
  }

  add('armed', 'Live trading armed', d.isArmed() ? 'PASS' : 'WARN', d.isArmed() ? 'Armed until 15:30 IST.' : 'Not armed. Live orders are refused until you arm it.');

  const bg = await safe(d.backgroundMonitoring, false);
  add('background', 'Background monitoring', bg ? 'PASS' : 'WARN', bg ? 'On, so the app keeps running when minimised.' : 'Off. The app may be stopped in the background and stop-losses would not be placed.');

  const positions = await safe(d.activePositions, [] as Position[]);
  const held = positions.filter((p) => p.filledQty > 0 && (p.state === 'PROTECTED' || p.state === 'OPEN_UNPROTECTED' || p.state === 'CLOSING'));
  const unprotected = held.filter((p) => p.state === 'OPEN_UNPROTECTED');
  if (unprotected.length > 0) add('positions', 'Open positions', 'FAIL', `${unprotected.length} held position${unprotected.length === 1 ? ' has' : 's have'} no stop-loss.`);
  else if (held.length > 0) add('positions', 'Open positions', 'PASS', `${held.length} held, all with a stop-loss.`);
  else add('positions', 'Open positions', 'PASS', 'None.');

  const closed = marketHoursBlock(d.now(), d.isTradingDay);
  add('hours', 'Order hours', closed ? 'WARN' : 'PASS', closed ?? 'Open (09:15 to 15:25 IST).');

  return checks;
}

export function summarizeReadiness(checks: ReadinessCheck[]): { fails: number; warns: number; ready: boolean } {
  const fails = checks.filter((c) => c.status === 'FAIL').length;
  const warns = checks.filter((c) => c.status === 'WARN').length;
  return { fails, warns, ready: fails === 0 && warns === 0 };
}
