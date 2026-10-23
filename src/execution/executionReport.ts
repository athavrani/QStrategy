import type { StoredOrder } from '../services/OrderRepository';
import type { Position } from '../services/PositionRepository';
import { MANUAL_TEST_ID } from '../config/orderConfig';

export interface ExecutionReport {
  /** Signals that reached the execution layer (proposed, planned or blocked). Manual test orders are not counted. */
  signals: number;
  proposed: number;
  sent: number;
  /** Proposals that ran out of time before being confirmed. */
  missed: number;
  dismissed: number;
  failed: number;
  uncertain: number;
  blocked: number;
  /** Most common reasons for blocking, with numbers masked so similar messages group together. */
  blockedReasons: Array<{ reason: string; count: number }>;
  filled: number;
  /** Average fill price minus the order's limit price, per share. Negative means filled below the limit. */
  avgFillVsLimit: number | null;
  open: number;
  closed: number;
  wins: number;
  losses: number;
  pnl: number;
}

const PROPOSAL = ['PENDING_CONFIRM', 'CONFIRMING', 'CONFIRMED', 'CONFIRM_FAILED', 'CONFIRM_UNCERTAIN', 'PROPOSAL_EXPIRED', 'PROPOSAL_DISMISSED'];

/** Summarises the day: what the strategies asked for and what actually happened to it. */
export function buildExecutionReport(paperOrders: StoredOrder[], positions: Position[]): ExecutionReport {
  const signalRows = paperOrders.filter((o) => o.strategyId && o.strategyId !== MANUAL_TEST_ID);
  const count = (status: string) => signalRows.filter((o) => o.status === status).length;

  const reasons = new Map<string, number>();
  signalRows
    .filter((o) => o.status === 'PAPER_BLOCKED')
    .forEach((o) => {
      const key = (o.errorMessage ?? 'No reason recorded').replace(/\d+(\.\d+)?/g, '#');
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    });

  const real = positions.filter((p) => p.strategyId !== MANUAL_TEST_ID && p.filledQty > 0);
  const slippages = real
    .map((p) => {
      const order = paperOrders.find((o) => o.correlationId === p.id);
      return order && p.entryAvg > 0 ? p.entryAvg - order.price : null;
    })
    .filter((v): v is number => v !== null);
  const closed = real.filter((p) => p.state === 'CLOSED' && p.pnl !== null);

  return {
    signals: signalRows.length,
    proposed: signalRows.filter((o) => PROPOSAL.includes(o.status)).length,
    sent: count('CONFIRMED'),
    missed: count('PROPOSAL_EXPIRED'),
    dismissed: count('PROPOSAL_DISMISSED'),
    failed: count('CONFIRM_FAILED'),
    uncertain: count('CONFIRM_UNCERTAIN'),
    blocked: count('PAPER_BLOCKED'),
    blockedReasons: [...reasons.entries()].map(([reason, n]) => ({ reason, count: n })).sort((a, b) => b.count - a.count),
    filled: real.length,
    avgFillVsLimit: slippages.length ? Number((slippages.reduce((a, b) => a + b, 0) / slippages.length).toFixed(2)) : null,
    open: real.filter((p) => p.state === 'PROTECTED' || p.state === 'OPEN_UNPROTECTED' || p.state === 'CLOSING').length,
    closed: closed.length,
    wins: closed.filter((p) => (p.pnl as number) > 0).length,
    losses: closed.filter((p) => (p.pnl as number) < 0).length,
    pnl: Number(closed.reduce((sum, p) => sum + (p.pnl as number), 0).toFixed(2)),
  };
}
