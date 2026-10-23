import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  EXECUTABLE_STRATEGIES,
  type ExecutableStrategyId,
  type ExecutionLimits,
  type ExecutionMode,
  type ExecutionSettings,
} from './types';

const STORAGE_KEY = '@qstrategy_execution_settings';

/** Safe by default: execution off, nothing enabled, small limits. */
export function defaultExecutionSettings(): ExecutionSettings {
  const strategies = {} as ExecutionSettings['strategies'];
  EXECUTABLE_STRATEGIES.forEach((id) => {
    strategies[id] = { enabled: false, lots: 1 };
  });
  return {
    mode: 'OFF',
    killSwitch: false,
    strategies,
    limits: { maxLotsPerOrder: 2, maxOrdersPerDay: 3, maxOrderValue: 50000, maxDailyValue: 100000 },
    limitBufferPct: 1,
  };
}

const MODES: ExecutionMode[] = ['OFF', 'PAPER', 'CONFIRM'];

function positive(value: unknown, fallback: number, integer = false): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return integer ? Math.floor(n) || fallback : n;
}

/** Repairs anything read from storage or the UI: unknown modes fall back to OFF, bad numbers to the defaults. */
export function sanitizeExecutionSettings(raw: any): ExecutionSettings {
  const base = defaultExecutionSettings();
  if (!raw || typeof raw !== 'object') return base;

  const limits: ExecutionLimits = {
    maxLotsPerOrder: positive(raw.limits?.maxLotsPerOrder, base.limits.maxLotsPerOrder, true),
    maxOrdersPerDay: positive(raw.limits?.maxOrdersPerDay, base.limits.maxOrdersPerDay, true),
    maxOrderValue: positive(raw.limits?.maxOrderValue, base.limits.maxOrderValue),
    maxDailyValue: positive(raw.limits?.maxDailyValue, base.limits.maxDailyValue),
  };

  const strategies = base.strategies;
  (Object.keys(strategies) as ExecutableStrategyId[]).forEach((id) => {
    const s = raw.strategies?.[id];
    strategies[id] = { enabled: s?.enabled === true, lots: positive(s?.lots, 1, true) };
  });

  return {
    mode: MODES.includes(raw.mode) ? raw.mode : 'OFF',
    killSwitch: raw.killSwitch === true,
    strategies,
    limits,
    limitBufferPct: Math.min(positive(raw.limitBufferPct, base.limitBufferPct), 10),
  };
}

export async function loadExecutionSettings(): Promise<ExecutionSettings> {
  try {
    const text = await AsyncStorage.getItem(STORAGE_KEY);
    return sanitizeExecutionSettings(text ? JSON.parse(text) : null);
  } catch {
    return defaultExecutionSettings();
  }
}

export async function saveExecutionSettings(settings: ExecutionSettings): Promise<ExecutionSettings> {
  const clean = sanitizeExecutionSettings(settings);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  return clean;
}
