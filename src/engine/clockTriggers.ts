/** Wall-clock moments (IST) at which strategies change state without needing a tick. */
export const CLOCK_TRIGGERS = ['09:20:00', '09:25:00', '09:45:00', '15:30:00'];

/** Parses "HH:MM:SS" (optionally followed by " IST") into seconds since midnight. */
export function parseClockSeconds(istTime: string): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})/.exec(istTime.trim());
  if (!m) return null;
  const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (h > 23 || min > 59 || s > 59) return null;
  return h * 3600 + min * 60 + s;
}

/** True from `beforeSec` seconds before a trigger until `afterSec` seconds after it. */
export function isNearTrigger(
  istTime: string,
  beforeSec = 2,
  afterSec = 8,
  triggers: string[] = CLOCK_TRIGGERS
): boolean {
  const now = parseClockSeconds(istTime);
  if (now === null) return false;
  return triggers.some((t) => {
    const at = parseClockSeconds(t) as number;
    return now >= at - beforeSec && now <= at + afterSec;
  });
}
