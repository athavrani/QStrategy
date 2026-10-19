// =====================================================================
// QStrategy — Official National Stock Exchange of India (NSE) Holiday Master
// Source of Truth: NSE Circular Download Ref No: NSE/CMTR/71775 (Circular 172/2025)
// Governing Rule: NSE Derivatives Regulations Chapter 4
// "When scheduled expiry day falls on an exchange trading holiday,
// the expiry date is preponed to the immediately preceding trading day."
// =====================================================================

export interface NseHoliday {
  date: string; // YYYY-MM-DD
  day: string;
  description: string;
}

/**
 * Official NSE Trading Holidays for Calendar Year 2026
 * Sourced from NSE Official Circular NSE/CMTR/71775
 */
export const NSE_TRADING_HOLIDAYS_2026: NseHoliday[] = [
  { date: '2026-01-26', day: 'Monday', description: 'Republic Day' },
  { date: '2026-03-03', day: 'Tuesday', description: 'Holi' },
  { date: '2026-03-26', day: 'Thursday', description: 'Shri Ram Navami' },
  { date: '2026-03-31', day: 'Tuesday', description: 'Shri Mahavir Jayanti' },
  { date: '2026-04-03', day: 'Friday', description: 'Good Friday' },
  { date: '2026-04-14', day: 'Tuesday', description: 'Dr. Baba Saheb Ambedkar Jayanti' },
  { date: '2026-05-01', day: 'Friday', description: 'Maharashtra Day' },
  { date: '2026-05-28', day: 'Thursday', description: 'Bakri Id' },
  { date: '2026-06-26', day: 'Friday', description: 'Muharram' },
  { date: '2026-09-14', day: 'Monday', description: 'Ganesh Chaturthi' },
  { date: '2026-10-02', day: 'Friday', description: 'Mahatma Gandhi Jayanti' },
  { date: '2026-10-20', day: 'Tuesday', description: 'Dussehra' },
  { date: '2026-11-10', day: 'Tuesday', description: 'Diwali-Balipratipada' },
  { date: '2026-11-24', day: 'Tuesday', description: 'Guru Nanak Jayanti' },
  { date: '2026-12-25', day: 'Friday', description: 'Christmas' },
];

/**
 * 2025 Baseline holidays for historical context
 */
export const NSE_TRADING_HOLIDAYS_2025: NseHoliday[] = [
  { date: '2025-01-26', day: 'Sunday', description: 'Republic Day' },
  { date: '2025-02-26', day: 'Wednesday', description: 'Mahashivratri' },
  { date: '2025-03-14', day: 'Friday', description: 'Holi' },
  { date: '2025-03-31', day: 'Monday', description: 'Id-Ul-Fitr' },
  { date: '2025-04-10', day: 'Thursday', description: 'Shri Mahavir Jayanti' },
  { date: '2025-04-14', day: 'Monday', description: 'Dr. Baba Saheb Ambedkar Jayanti' },
  { date: '2025-04-18', day: 'Friday', description: 'Good Friday' },
  { date: '2025-05-01', day: 'Thursday', description: 'Maharashtra Day' },
  { date: '2025-06-07', day: 'Saturday', description: 'Bakri Id' },
  { date: '2025-08-15', day: 'Friday', description: 'Independence Day' },
  { date: '2025-08-27', day: 'Wednesday', description: 'Ganesh Chaturthi' },
  { date: '2025-10-02', day: 'Thursday', description: 'Mahatma Gandhi Jayanti' },
  { date: '2025-10-21', day: 'Tuesday', description: 'Diwali-Balipratipada' },
  { date: '2025-11-05', day: 'Wednesday', description: 'Prakash Gurpurb Sri Guru Nanak Dev' },
  { date: '2025-12-25', day: 'Thursday', description: 'Christmas' },
];

const ALL_HOLIDAYS = [...NSE_TRADING_HOLIDAYS_2025, ...NSE_TRADING_HOLIDAYS_2026];
const HOLIDAY_MAP = new Map<string, string>(
  ALL_HOLIDAYS.map((h) => [h.date, h.description])
);

/**
 * Formats a Date object to YYYY-MM-DD in local time
 */
export function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Formats a Date object to YYYY-MM-DD in Indian Standard Time (IST, UTC+5:30)
 */
export function formatDateKeyIST(date: Date = new Date()): string {
  const istMs = date.getTime() + 5.5 * 60 * 60 * 1000;
  const istDate = new Date(istMs);
  const year = istDate.getUTCFullYear();
  const month = String(istDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(istDate.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Checks if a given date is an official NSE trading holiday
 */
export function isExchangeHoliday(date: Date): { isHoliday: boolean; holidayName?: string } {
  const key = formatDateKey(date);
  const holidayName = HOLIDAY_MAP.get(key);
  return {
    isHoliday: !!holidayName,
    holidayName,
  };
}

/**
 * Checks if a given date is a valid trading day (neither weekend nor exchange holiday)
 */
export function isTradingDay(date: Date): boolean {
  const dayOfWeek = date.getDay();
  // 0 = Sunday, 6 = Saturday
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  return !isExchangeHoliday(date).isHoliday;
}

/**
 * Steps backward from a date one day at a time until a valid trading day is found
 */
export function getPrecedingTradingDay(startDate: Date): Date {
  const cur = new Date(startDate.getTime());
  while (!isTradingDay(cur)) {
    cur.setDate(cur.getDate() - 1);
  }
  return cur;
}

/**
 * Resolves the official expiry date for a scheduled expiry date.
 * If the scheduled date is a weekend or an exchange holiday (e.g. Dussehra Oct 20),
 * it prepones the expiry to the immediately preceding trading day (e.g. Monday Oct 19).
 */
export function getAdjustedExpiryDate(scheduledDate: Date): {
  adjustedDate: Date;
  wasPreponed: boolean;
  scheduledDate: Date;
  holidayName?: string;
} {
  const holidayCheck = isExchangeHoliday(scheduledDate);
  const isWeekend = scheduledDate.getDay() === 0 || scheduledDate.getDay() === 6;

  if (!holidayCheck.isHoliday && !isWeekend) {
    return {
      adjustedDate: new Date(scheduledDate.getTime()),
      wasPreponed: false,
      scheduledDate: new Date(scheduledDate.getTime()),
    };
  }

  // Prepone to preceding trading day
  const adjusted = getPrecedingTradingDay(scheduledDate);
  return {
    adjustedDate: adjusted,
    wasPreponed: true,
    scheduledDate: new Date(scheduledDate.getTime()),
    holidayName: holidayCheck.holidayName || (isWeekend ? 'Weekend' : undefined),
  };
}
