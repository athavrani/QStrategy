import { useEffect, useState } from 'react';

interface SharedTimer {
  id: ReturnType<typeof setInterval>;
  listeners: Set<() => void>;
}

const timers = new Map<number, SharedTimer>();

/** One interval per period, shared by every subscriber; it stops when the last one leaves. */
export function subscribeTick(intervalMs: number, listener: () => void): () => void {
  let timer = timers.get(intervalMs);
  if (!timer) {
    const listeners = new Set<() => void>();
    const id = setInterval(() => listeners.forEach((l) => l()), intervalMs);
    timer = { id, listeners };
    timers.set(intervalMs, timer);
  }
  timer.listeners.add(listener);

  return () => {
    const current = timers.get(intervalMs);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      clearInterval(current.id);
      timers.delete(intervalMs);
    }
  };
}

/** Re-renders the calling component every `intervalMs` while `enabled`. */
export function useSharedTick(enabled: boolean, intervalMs: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    return subscribeTick(intervalMs, () => setTick((t) => t + 1));
  }, [enabled, intervalMs]);
  return tick;
}
