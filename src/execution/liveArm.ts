import { create } from 'zustand';
import { formatDateKeyIST } from '../constants/nseHolidays';

const CLOSE_MINUTES = 15 * 60 + 30;

interface LiveArmState {
  /** IST date the app was armed on; null when disarmed. Held in memory only, so a restart disarms. */
  armedDate: string | null;
  arm: (now?: Date) => void;
  disarm: () => void;
}

export const useLiveArm = create<LiveArmState>((set) => ({
  armedDate: null,
  arm: (now = new Date()) => set({ armedDate: formatDateKeyIST(now) }),
  disarm: () => set({ armedDate: null }),
}));

/** Armed only for the day it was armed, and not after the 15:30 IST close. */
export function isLiveArmed(now: Date = new Date()): boolean {
  const { armedDate } = useLiveArm.getState();
  if (!armedDate || armedDate !== formatDateKeyIST(now)) return false;
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes() < CLOSE_MINUTES;
}
