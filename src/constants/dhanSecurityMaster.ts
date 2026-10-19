// =====================================================================
// QStrategy — Dhan HQ Direct Security ID Master
// Official NSE Equity & Index Security IDs for Dhan HQ API v2
// Zero Middleman: Direct mapping for mobile terminal
// =====================================================================

export const DHAN_BASE_URL = 'https://api.dhan.co/v2';
export const DHAN_WS_FEED_URL = 'wss://api-feed.dhan.co';

export interface DhanInstrumentMeta {
  securityId: string;
  segment: 'NSE_EQ' | 'NSE_FNO' | 'IDX_I' | 'BSE_EQ';
  lotSize: number;
  strikeStep: number;
}

export const DHAN_NIFTY_INDEX_ID = '13'; // NIFTY 50 Index on Dhan
export const DHAN_SENSEX_INDEX_ID = '51'; // SENSEX Index on Dhan

/**
 * Pre-mapped Dhan Security IDs for all 60 SENSEX & NIFTY 50 constituents.
 * Corresponds to official Dhan SEM_SMST_SECURITY_ID registry.
 */
export const DHAN_SECURITY_MAP: Record<string, DhanInstrumentMeta> = {
  ADANIENT: { securityId: '25', segment: 'NSE_EQ', lotSize: 300, strikeStep: 50 },
  ADANIPORTS: { securityId: '15083', segment: 'NSE_EQ', lotSize: 400, strikeStep: 20 },
  APOLLOHOSP: { securityId: '157', segment: 'NSE_EQ', lotSize: 125, strikeStep: 50 },
  ASIANPAINT: { securityId: '236', segment: 'NSE_EQ', lotSize: 200, strikeStep: 20 },
  AXISBANK: { securityId: '5900', segment: 'NSE_EQ', lotSize: 625, strikeStep: 20 },
  'BAJAJ-AUTO': { securityId: '16669', segment: 'NSE_EQ', lotSize: 75, strikeStep: 100 },
  BAJFINANCE: { securityId: '317', segment: 'NSE_EQ', lotSize: 125, strikeStep: 100 },
  BAJAJFINSV: { securityId: '16675', segment: 'NSE_EQ', lotSize: 500, strikeStep: 20 },
  BEL: { securityId: '383', segment: 'NSE_EQ', lotSize: 2850, strikeStep: 5 },
  BHARTIARTL: { securityId: '10604', segment: 'NSE_EQ', lotSize: 475, strikeStep: 20 },
  BPCL: { securityId: '526', segment: 'NSE_EQ', lotSize: 1800, strikeStep: 5 },
  BRITANNIA: { securityId: '547', segment: 'NSE_EQ', lotSize: 100, strikeStep: 50 },
  CIPLA: { securityId: '694', segment: 'NSE_EQ', lotSize: 375, strikeStep: 20 },
  COALINDIA: { securityId: '20374', segment: 'NSE_EQ', lotSize: 2100, strikeStep: 5 },
  DIVISLAB: { securityId: '10940', segment: 'NSE_EQ', lotSize: 100, strikeStep: 50 },
  DRREDDY: { securityId: '881', segment: 'NSE_EQ', lotSize: 125, strikeStep: 50 },
  EICHERMOT: { securityId: '910', segment: 'NSE_EQ', lotSize: 150, strikeStep: 50 },
  GRASIM: { securityId: '1232', segment: 'NSE_EQ', lotSize: 250, strikeStep: 20 },
  HCLTECH: { securityId: '7229', segment: 'NSE_EQ', lotSize: 350, strikeStep: 20 },
  HDFCBANK: { securityId: '1333', segment: 'NSE_EQ', lotSize: 550, strikeStep: 20 },
  HDFCLIFE: { securityId: '467', segment: 'NSE_EQ', lotSize: 1100, strikeStep: 10 },
  HEROMOTOCO: { securityId: '1348', segment: 'NSE_EQ', lotSize: 150, strikeStep: 50 },
  HINDALCO: { securityId: '1363', segment: 'NSE_EQ', lotSize: 1400, strikeStep: 10 },
  HINDUNILVR: { securityId: '1394', segment: 'NSE_EQ', lotSize: 300, strikeStep: 50 },
  ICICIBANK: { securityId: '4963', segment: 'NSE_EQ', lotSize: 700, strikeStep: 20 },
  INDUSINDBK: { securityId: '5258', segment: 'NSE_EQ', lotSize: 500, strikeStep: 20 },
  INFY: { securityId: '1594', segment: 'NSE_EQ', lotSize: 400, strikeStep: 20 },
  ITC: { securityId: '1660', segment: 'NSE_EQ', lotSize: 1600, strikeStep: 10 },
  JIOFIN: { securityId: '18143', segment: 'NSE_EQ', lotSize: 1, strikeStep: 5 },
  JSWSTEEL: { securityId: '11723', segment: 'NSE_EQ', lotSize: 675, strikeStep: 10 },
  KOTAKBANK: { securityId: '1922', segment: 'NSE_EQ', lotSize: 400, strikeStep: 20 },
  LT: { securityId: '11483', segment: 'NSE_EQ', lotSize: 150, strikeStep: 50 },
  LTM: { securityId: '17818', segment: 'NSE_EQ', lotSize: 150, strikeStep: 50 },
  'M&M': { securityId: '2031', segment: 'NSE_EQ', lotSize: 350, strikeStep: 20 },
  MARUTI: { securityId: '10999', segment: 'NSE_EQ', lotSize: 50, strikeStep: 200 },
  NESTLEIND: { securityId: '17963', segment: 'NSE_EQ', lotSize: 250, strikeStep: 20 },
  NTPC: { securityId: '11630', segment: 'NSE_EQ', lotSize: 1500, strikeStep: 5 },
  ONGC: { securityId: '2475', segment: 'NSE_EQ', lotSize: 3850, strikeStep: 2.5 },
  POWERGRID: { securityId: '14977', segment: 'NSE_EQ', lotSize: 1800, strikeStep: 5 },
  RELIANCE: { securityId: '2885', segment: 'NSE_EQ', lotSize: 250, strikeStep: 50 },
  SBILIFE: { securityId: '21808', segment: 'NSE_EQ', lotSize: 750, strikeStep: 20 },
  SBIN: { securityId: '3045', segment: 'NSE_EQ', lotSize: 750, strikeStep: 10 },
  SHRIRAMFIN: { securityId: '4306', segment: 'NSE_EQ', lotSize: 150, strikeStep: 50 },
  SUNPHARMA: { securityId: '3351', segment: 'NSE_EQ', lotSize: 350, strikeStep: 20 },
  TATACONSUM: { securityId: '3432', segment: 'NSE_EQ', lotSize: 900, strikeStep: 10 },
  TATAMOTORS: { securityId: '3456', segment: 'NSE_EQ', lotSize: 550, strikeStep: 20 },
  TMCV: { securityId: '3456', segment: 'NSE_EQ', lotSize: 550, strikeStep: 20 },
  TATASTEEL: { securityId: '3499', segment: 'NSE_EQ', lotSize: 5500, strikeStep: 2.5 },
  TCS: { securityId: '11536', segment: 'NSE_EQ', lotSize: 175, strikeStep: 50 },
  TECHM: { securityId: '13538', segment: 'NSE_EQ', lotSize: 600, strikeStep: 20 },
  TITAN: { securityId: '3506', segment: 'NSE_EQ', lotSize: 175, strikeStep: 50 },
  TRENT: { securityId: '1964', segment: 'NSE_EQ', lotSize: 100, strikeStep: 50 },
  ULTRACEMCO: { securityId: '11532', segment: 'NSE_EQ', lotSize: 100, strikeStep: 100 },
  UPL: { securityId: '11287', segment: 'NSE_EQ', lotSize: 1300, strikeStep: 5 },
  WIPRO: { securityId: '3787', segment: 'NSE_EQ', lotSize: 1500, strikeStep: 10 },
  ZOMATO: { securityId: '5097', segment: 'NSE_EQ', lotSize: 2500, strikeStep: 5 },
  ETERNAL: { securityId: '5097', segment: 'NSE_EQ', lotSize: 2500, strikeStep: 5 },
};

/**
 * Returns the Dhan Security ID for any given symbol
 */
export function getDhanSecurityId(ticker: string): string {
  const clean = ticker.trim().toUpperCase();
  if (clean === 'TMCV' || clean === 'TATAMOTORS') return DHAN_SECURITY_MAP['TMCV']?.securityId || '3456';
  if (clean === 'ETERNAL' || clean === 'ZOMATO') return DHAN_SECURITY_MAP['ETERNAL']?.securityId || '5097';
  return DHAN_SECURITY_MAP[clean]?.securityId || '1330';
}
