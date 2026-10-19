/**
 * QStrategy — Quantitative Trading Calendar Service
 * Handles NSE trading sessions, holiday preponements, next-trading-day calculations,
 * and weekly Tuesday option expiry resolution with overnight rollover guarantees.
 */

import {
  isExchangeHoliday,
  isTradingDay,
  getPrecedingTradingDay,
  getAdjustedExpiryDate,
  formatDateKey,
  formatDateKeyIST,
} from '../constants/nseHolidays';

export interface ExpiryResolution {
  expiryStr: string; // e.g. "20-OCT-2026"
  expiryDateYMD: string; // e.g. "2026-10-20"
  daysToExpiry: number;
  timeToExpiryYears: number;
  isExpiryDay: boolean;
  rolledToNextExpiry: boolean;
  wasPreponed: boolean;
  holidayReason?: string;
}

export class TradingCalendarService {
  /**
   * Checks if a given date is a valid NSE trading day
   */
  public isTradingDay(date: Date = new Date()): boolean {
    return isTradingDay(date);
  }

  /**
   * Returns the immediate next valid NSE trading day (skipping weekends and exchange holidays)
   */
  public getNextTradingDay(startDate: Date = new Date()): Date {
    const cur = new Date(startDate.getTime());
    cur.setDate(cur.getDate() + 1);
    while (!this.isTradingDay(cur)) {
      cur.setDate(cur.getDate() + 1);
    }
    return cur;
  }

  /**
   * Returns the immediate preceding valid NSE trading day
   */
  public getPrecedingTradingDay(startDate: Date = new Date()): Date {
    return getPrecedingTradingDay(startDate);
  }

  /**
   * Computes the active weekly Tuesday expiry for NIFTY options.
   * If `skipIfTodayIsExpiry` is true and today is Tuesday/Expiry day,
   * rolls forward +7 days to the NEXT weekly expiry so overnight positions
   * are never opened on contracts ceasing trading at 15:30.
   */
  public getActiveWeeklyExpiry(now = new Date(), skipIfTodayIsExpiry = true): ExpiryResolution {
    const currentDay = now.getDay(); // 0 = Sun, 1 = Mon, 2 = Tue, ...
    const daysUntilTuesday = (2 - currentDay + 7) % 7;
    let candidateTuesday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilTuesday);

    let { adjustedDate, wasPreponed, holidayName } = getAdjustedExpiryDate(candidateTuesday);

    const nowDateStr = formatDateKey(now);
    let adjDateStr = formatDateKey(adjustedDate);

    const isTodayExpiryDay = nowDateStr === adjDateStr;
    let isExpiryDay = isTodayExpiryDay;
    let rolledToNextExpiry = false;

    const nowHours = now.getHours();
    const nowMins = now.getMinutes();
    const isPastExpiryTime = isExpiryDay && (nowHours > 15 || (nowHours === 15 && nowMins >= 30));
    const isPastDate = now.getTime() > adjustedDate.getTime() && !isExpiryDay && nowDateStr > adjDateStr;

    if ((skipIfTodayIsExpiry && isTodayExpiryDay) || isPastExpiryTime || isPastDate) {
      // Roll over to next weekly Tuesday (+7 days)
      candidateTuesday = new Date(
        candidateTuesday.getFullYear(),
        candidateTuesday.getMonth(),
        candidateTuesday.getDate() + 7
      );
      const nextAdj = getAdjustedExpiryDate(candidateTuesday);
      adjustedDate = nextAdj.adjustedDate;
      wasPreponed = nextAdj.wasPreponed;
      holidayName = nextAdj.holidayName;
      adjDateStr = formatDateKey(adjustedDate);
      rolledToNextExpiry = true;
    }

    // Set official expiry time to 15:30:00 IST
    adjustedDate.setHours(15, 30, 0, 0);

    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const dayStr = String(adjustedDate.getDate()).padStart(2, '0');
    const monthStr = months[adjustedDate.getMonth()];
    const yearStr = adjustedDate.getFullYear();
    const expiryStr = `${dayStr}-${monthStr}-${yearStr}`;

    const mNumStr = String(adjustedDate.getMonth() + 1).padStart(2, '0');
    const dNumStr = String(adjustedDate.getDate()).padStart(2, '0');
    const expiryDateYMD = `${yearStr}-${mNumStr}-${dNumStr}`;

    const diffMs = Math.max(60000, adjustedDate.getTime() - now.getTime());
    const daysToExpiry = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    const timeToExpiryYears = Math.max(0.0005, diffMs / (1000 * 60 * 60 * 24 * 365));

    return {
      expiryStr,
      expiryDateYMD,
      daysToExpiry,
      timeToExpiryYears,
      isExpiryDay,
      rolledToNextExpiry,
      wasPreponed,
      holidayReason: holidayName,
    };
  }
}

export const tradingCalendarService = new TradingCalendarService();
