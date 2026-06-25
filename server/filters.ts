import type { Candle } from "../shared/schema";

export function inSession(timestamp: string, sessionMode: string): boolean {
  const d = new Date(timestamp);
  const hour = d.getUTCHours();

  switch (sessionMode) {
    case "Asian":
      return hour >= 0 && hour < 7;
    case "Asian+London":
      return hour >= 0 && hour < 16;
    case "London":
      return hour >= 7 && hour < 16;
    case "NewYork":
      return hour >= 12 && hour < 21;
    case "London+NewYork":
      return hour >= 7 && hour < 21;
    case "Asian+London+NewYork":
      return hour >= 0 && hour < 21;
    case "All":
      return true;
    default:
      return hour >= 7 && hour < 21;
  }
}

export function eventBlackout(
  timestamp: string,
  events: { timestamp: string }[] | undefined,
  minutesBefore: number,
  minutesAfter: number
): boolean {
  if (!events || events.length === 0) return false;

  const t = new Date(timestamp).getTime();
  for (const ev of events) {
    const et = new Date(ev.timestamp).getTime();
    const before = et - minutesBefore * 60 * 1000;
    const after = et + minutesAfter * 60 * 1000;
    if (t >= before && t <= after) return true;
  }
  return false;
}

export function midpointBlock(
  price: number,
  rangeHigh: number,
  rangeLow: number,
  midpointBandPct: number
): boolean {
  const rangeWidth = rangeHigh - rangeLow;
  if (rangeWidth <= 0) return true;
  const mid = (rangeHigh + rangeLow) / 2;
  const band = rangeWidth * midpointBandPct;
  return price >= mid - band && price <= mid + band;
}

export function isBearishRejection(candle: Candle, minRatio: number): boolean {
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  if (body <= 0) return false;
  if (upperWick / body < minRatio) return false;
  return candle.close < candle.open;
}

export function isBullishRejection(candle: Candle, minRatio: number): boolean {
  const body = Math.abs(candle.close - candle.open);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  if (body <= 0) return false;
  if (lowerWick / body < minRatio) return false;
  return candle.close > candle.open;
}

export function detectGap(current: Candle, previous: Candle): number {
  return Math.abs(current.open - previous.close);
}

export function isGapBar(current: Candle, previous: Candle, atr: number, thresholdMultiple: number): boolean {
  if (atr <= 0) return false;
  const gap = detectGap(current, previous);
  return gap >= atr * thresholdMultiple;
}

export type SessionORB = {
  high: number;
  low: number;
  bullish: boolean;
  dayKey: string;
};

export function getSessionOpenHour(sessionMode: string): number {
  switch (sessionMode) {
    case "Asian": return 0;
    case "Asian+London": return 0;
    case "Asian+London+NewYork": return 0;
    case "London": return 7;
    case "NewYork": return 12;
    case "London+NewYork": return 7;
    case "All": return 0;
    default: return 7;
  }
}

export function inEntryWindow(timestamp: string, sessionMode: string, entryWindowBars: number): boolean {
  if (entryWindowBars <= 0) return true;
  const d = new Date(timestamp);
  const hour = d.getUTCHours();
  const openHour = getSessionOpenHour(sessionMode);
  const windowEnd = openHour + entryWindowBars;
  if (windowEnd <= 24) {
    return hour >= openHour && hour < windowEnd;
  }
  return hour >= openHour || hour < (windowEnd % 24);
}

export function inPeakHours(timestamp: string, peakHoursUTC: number[]): boolean {
  if (peakHoursUTC.length === 0) return true;
  const hour = new Date(timestamp).getUTCHours();
  return peakHoursUTC.includes(hour);
}

export function inAvoidHours(timestamp: string, avoidHoursUTC: number[]): boolean {
  if (avoidHoursUTC.length === 0) return false;
  const hour = new Date(timestamp).getUTCHours();
  return avoidHoursUTC.includes(hour);
}

export function isSessionOpenCandle(timestamp: string, sessionMode: string): boolean {
  const d = new Date(timestamp);
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  return hour === getSessionOpenHour(sessionMode) && minute === 0;
}

export function buildORB(candle: Candle): SessionORB {
  return {
    high: candle.high,
    low: candle.low,
    bullish: candle.close > candle.open,
    dayKey: candle.timestamp.substring(0, 10),
  };
}

export function orbAligns(orb: SessionORB | null, side: "buy" | "sell"): boolean {
  if (!orb) return false;
  if (side === "buy") return orb.bullish;
  return !orb.bullish;
}
