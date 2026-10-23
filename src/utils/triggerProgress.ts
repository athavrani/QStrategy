/** Progress of the highest price seen since arming towards a trigger, 0-100. Never falls as the LTP pulls back. */
export function triggerProgressPct(armedHigh: number, trigger: number): number {
  if (!(trigger > 0) || !(armedHigh > 0)) return 0;
  return Math.min(100, Math.round((armedHigh / trigger) * 100));
}
