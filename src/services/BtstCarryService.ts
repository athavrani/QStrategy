import { journalRepository } from './JournalRepository';
import { dailyStrategyLockService } from './DailyStrategyLockService';
import { marketData } from './marketdata/MarketDataService';
import type { CarryTrade } from '../engine/types';
import type { SignalJournalItem } from '../types/mobile';
import type { InstrumentSubscription } from './dhan/DhanBinaryCodec';

const CARRY_OWNER = 'btst-carry';
const LOOKBACK_DAYS = 5;

// Journal strategy id -> lock strategy id and option segment
const CARRY_STRATEGIES: Record<string, { lockId: string; segment: CarryTrade['segment'] }> = {
  OOBTST_NIFTY: { lockId: 'NIFTY_OOBTST', segment: 'NSE_FNO' },
  OOBTST_SENSEX: { lockId: 'SENSEX_OOBTST', segment: 'BSE_FNO' },
};

function daysBefore(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export interface CarryLoad {
  trades: CarryTrade[];
  /** Journal rows of the carried trades, so the UI can show and later close them. */
  journal: SignalJournalItem[];
}

/** Finds overnight (BTST) OOBTST positions from earlier sessions that are still open and can be priced. */
export class BtstCarryService {
  private subscribed = new Map<string, InstrumentSubscription>();

  async load(today: string): Promise<CarryLoad> {
    const rows = await journalRepository.loadOpenTrades(
      daysBefore(today, LOOKBACK_DAYS),
      today,
      Object.keys(CARRY_STRATEGIES)
    );

    const trades: CarryTrade[] = [];
    const journal: SignalJournalItem[] = [];
    for (const { item, tradeDate } of rows) {
      const cfg = CARRY_STRATEGIES[item.strategyId];
      const lock = await dailyStrategyLockService.getLock(tradeDate, cfg.lockId);
      if (!lock) continue;

      const securityId =
        item.symbol === lock.ce_symbol ? lock.ce_sec_id : item.symbol === lock.pe_symbol ? lock.pe_sec_id : undefined;
      // Without a security id the position cannot be priced; it stays OPEN in the journal.
      if (!securityId) continue;

      trades.push({
        journalId: item.id,
        strategyId: item.strategyId,
        symbol: item.symbol,
        tradeDate,
        entryPrice: item.entryPrice,
        slPrice: +(item.entryPrice / 2).toFixed(2),
        securityId: String(securityId),
        segment: cfg.segment,
      });
      journal.push(item);
    }
    return { trades, journal };
  }

  /** Streams exactly the given trades' contracts and releases any others. */
  watch(trades: CarryTrade[]): void {
    const wanted = new Map<string, InstrumentSubscription>();
    for (const t of trades) {
      wanted.set(`${t.segment}:${t.securityId}`, { exchangeSegment: t.segment, securityId: t.securityId });
    }
    const add = [...wanted].filter(([k]) => !this.subscribed.has(k)).map(([, s]) => s);
    const drop = [...this.subscribed].filter(([k]) => !wanted.has(k)).map(([, s]) => s);

    if (add.length > 0) marketData.acquire(CARRY_OWNER, add);
    if (drop.length > 0) marketData.release(CARRY_OWNER, drop);
    this.subscribed = wanted;
  }
}

export const btstCarryService = new BtstCarryService();
