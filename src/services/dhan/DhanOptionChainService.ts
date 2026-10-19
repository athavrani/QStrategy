/**
 * QStrategy — DhanHQ Option Chain Parsing & Analytics Service
 * Provides typed live option chain transformations, ATM strike detection,
 * Put-Call Ratio (PCR) analytics, and strict nullability (zero fabricated data).
 */

import { dhanHqRestClient, DhanHqRestClient, DhanOptionChainRawResponse, DhanOptionContractRaw } from './DhanHqRestClient';

export interface OptionLegData {
  ltp: number | null;
  oi: number | null;
  volume: number | null;
  iv: number | null;
  bid: number | null;
  ask: number | null;
  securityId?: string;
}

export interface OptionStrikeData {
  strikePrice: number;
  moneyness: 'ITM' | 'ATM' | 'OTM';
  ce: OptionLegData;
  pe: OptionLegData;
}

export interface OptionChainResult {
  underlyingScrip: number;
  underlyingSeg: string;
  expiry: string;
  spotPrice: number | null;
  atmStrike: number | null;
  pcr: number | null;
  totalCallOi: number;
  totalPutOi: number;
  strikes: OptionStrikeData[];
}

export class DhanOptionChainService {
  private restClient: DhanHqRestClient;

  constructor(client: DhanHqRestClient = dhanHqRestClient) {
    this.restClient = client;
  }

  /**
   * Fetches and transforms live option chain from DhanHQ
   */
  public async getOptionChain(
    underlyingScrip: number,
    underlyingSeg: string,
    expiry: string,
    strikeStep = 50
  ): Promise<OptionChainResult | null> {
    let targetExpiry = expiry;
    try {
      const expList = await this.restClient.fetchExpiryList(underlyingScrip, underlyingSeg);
      if (expList && expList.length > 0) {
        if (!targetExpiry || !expList.includes(targetExpiry)) {
          targetExpiry = expList[0];
        }
      }
    } catch {}

    const raw: DhanOptionChainRawResponse | null = await this.restClient.fetchOptionChain(
      underlyingScrip,
      underlyingSeg,
      targetExpiry
    );

    if (!raw || !raw.data || !raw.data.oc || Object.keys(raw.data.oc).length === 0) {
      return null;
    }

    const rawSpot = raw.data.last_price;
    const spotPrice = typeof rawSpot === 'number' && rawSpot > 0 ? Number(rawSpot.toFixed(2)) : null;

    let atmStrike: number | null = null;
    if (spotPrice !== null) {
      atmStrike = Math.round(spotPrice / strikeStep) * strikeStep;
    }

    let totalCallOi = 0;
    let totalPutOi = 0;

    const strikes: OptionStrikeData[] = [];

    const sortedStrikeEntries = Object.entries(raw.data.oc).sort(
      ([a], [b]) => parseFloat(a) - parseFloat(b)
    );

    for (const [strikeStr, strikeItem] of sortedStrikeEntries) {
      const strikePrice = Math.round(parseFloat(strikeStr));
      if (isNaN(strikePrice)) continue;

      const ceRaw = strikeItem.ce;
      const peRaw = strikeItem.pe;

      const ceOi = typeof ceRaw?.oi === 'number' ? ceRaw.oi : null;
      const peOi = typeof peRaw?.oi === 'number' ? peRaw.oi : null;

      if (ceOi) totalCallOi += ceOi;
      if (peOi) totalPutOi += peOi;

      let moneyness: 'ITM' | 'ATM' | 'OTM' = 'OTM';
      if (atmStrike !== null) {
        if (strikePrice === atmStrike) {
          moneyness = 'ATM';
        } else if (strikePrice < atmStrike) {
          moneyness = 'ITM'; // For Call, or ITM indicator
        } else {
          moneyness = 'OTM';
        }
      }

      const parseLeg = (contract?: DhanOptionContractRaw): OptionLegData => {
        if (!contract) {
          return {
            ltp: null,
            oi: null,
            volume: null,
            iv: null,
            bid: null,
            ask: null,
          };
        }

        const ltp = typeof contract.last_price === 'number' && contract.last_price > 0 ? contract.last_price : null;
        const oi = typeof contract.oi === 'number' ? contract.oi : null;
        const volume = typeof contract.volume === 'number' ? contract.volume : null;
        const rawIv = contract.implied_volatility ?? contract.iv;
        const iv = typeof rawIv === 'number' && rawIv > 0 ? Number(rawIv.toFixed(2)) : null;
        const bid = typeof contract.bid === 'number' ? contract.bid : (typeof contract.top_bid === 'number' ? contract.top_bid : null);
        const ask = typeof contract.ask === 'number' ? contract.ask : (typeof contract.top_ask === 'number' ? contract.top_ask : null);
        const secId = contract.security_id ?? contract.sec_id;

        return {
          ltp,
          oi,
          volume,
          iv,
          bid,
          ask,
          securityId: secId !== undefined ? String(secId) : undefined,
        };
      };

      strikes.push({
        strikePrice,
        moneyness,
        ce: parseLeg(ceRaw),
        pe: parseLeg(peRaw),
      });
    }

    const pcr = totalCallOi > 0 ? Number((totalPutOi / totalCallOi).toFixed(2)) : null;

    return {
      underlyingScrip,
      underlyingSeg,
      expiry: targetExpiry,
      spotPrice,
      atmStrike,
      pcr,
      totalCallOi,
      totalPutOi,
      strikes,
    };
  }

  /**
   * Finds the closest Call and Put strike to a given target premium (e.g. ₹62.50)
   * Strictly relies on genuine live quotes, returns null if market data unavailable
   */
  public selectAnchorStrikes(
    chain: OptionChainResult,
    targetPremium = 62.5
  ): {
    ceStrike: number;
    cePrice: number;
    peStrike: number;
    pePrice: number;
  } | null {
    if (!chain || chain.strikes.length === 0 || chain.spotPrice === null) {
      return null;
    }

    const atm = chain.atmStrike ?? chain.spotPrice;

    let bestCeStrike: number | null = null;
    let minCeDiff = Infinity;
    let bestCePrice = 0;

    let bestPeStrike: number | null = null;
    let minPeDiff = Infinity;
    let bestPePrice = 0;

    for (const strike of chain.strikes) {
      // CE: At or above ATM
      if (strike.strikePrice >= atm && strike.ce.ltp !== null && strike.ce.ltp > 0) {
        const diff = Math.abs(strike.ce.ltp - targetPremium);
        if (diff < minCeDiff) {
          minCeDiff = diff;
          bestCeStrike = strike.strikePrice;
          bestCePrice = strike.ce.ltp;
        }
      }

      // PE: At or below ATM
      if (strike.strikePrice <= atm && strike.pe.ltp !== null && strike.pe.ltp > 0) {
        const diff = Math.abs(strike.pe.ltp - targetPremium);
        if (diff < minPeDiff) {
          minPeDiff = diff;
          bestPeStrike = strike.strikePrice;
          bestPePrice = strike.pe.ltp;
        }
      }
    }

    if (bestCeStrike === null || bestPeStrike === null) {
      return null;
    }

    return {
      ceStrike: bestCeStrike,
      cePrice: bestCePrice,
      peStrike: bestPeStrike,
      pePrice: bestPePrice,
    };
  }
}

export const dhanOptionChainService = new DhanOptionChainService();
