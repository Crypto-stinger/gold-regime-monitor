import type { Candle } from "../shared/schema";
import { storage } from "./storage";

let _watchdog: { reportError: (s: string, m: string) => void; reportWarning: (s: string, m: string) => void } | null = null;

function getWatchdog() {
  if (!_watchdog) {
    try {
      const mod = require("./system-watchdog");
      _watchdog = { reportError: mod.reportError, reportWarning: mod.reportWarning };
    } catch { /* watchdog not yet loaded */ }
  }
  return _watchdog;
}

function reportError(source: string, message: string) {
  getWatchdog()?.reportError(source, message);
}

function reportWarning(source: string, message: string) {
  getWatchdog()?.reportWarning(source, message);
}

const TWELVE_DATA_BASE = "https://api.twelvedata.com";

export type AsianMarketSnapshot = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
  timestamp: string;
};

export type EconomicEvent = {
  timestamp: string;
  event: string;
  country: string;
  impact: string;
};

export type MarketDataStatus = {
  xauusd: { m1: number; m15: number; h1: number; h4: number; daily: number; lastFetched: string | null };
  events: { count: number; lastFetched: string | null };
  asian: { indices: string[]; lastFetched: string | null };
};

let cachedM1: Candle[] = [];
let cachedM15: Candle[] = [];
let cachedH1: Candle[] = [];
let cachedH4: Candle[] = [];
let cachedDaily: Candle[] = [];
let cachedEvents: EconomicEvent[] = [];
let cachedAsian: AsianMarketSnapshot[] = [];
let cachedGVZ: { date: string; value: number }[] = [];
let cachedCOT: { date: string; noncommLong: number; noncommShort: number; netPosition: number; openInterest: number }[] = [];
let cachedSGE: { date: string; premium: number; sgePriceUsd: number; spotPriceUsd: number; usdcnyRate: number }[] = [];
let lastXauFetch: string | null = null;
let lastEventsFetch: string | null = null;
let lastAsianFetch: string | null = null;
let lastGVZFetch: string | null = null;
let lastSGEFetch: string | null = null;
let lastActualFetchTime: string | null = null;

function parseTwelveDataCandles(data: any): Candle[] {
  if (!data?.values || !Array.isArray(data.values)) return [];
  return data.values
    .map((v: any) => ({
      timestamp: new Date(v.datetime).toISOString(),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: v.volume ? parseFloat(v.volume) : 0,
    }))
    .filter((c: Candle) => !isNaN(c.open) && !isNaN(c.high) && !isNaN(c.low) && !isNaN(c.close))
    .reverse();
}

async function fetchInterval(apiKey: string, interval: string, outputsize: number): Promise<Candle[]> {
  const url = `${TWELVE_DATA_BASE}/time_series?symbol=XAU/USD&interval=${interval}&outputsize=${outputsize}&apikey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Twelve Data ${interval} fetch failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data.status === "error") throw new Error(`Twelve Data error (${interval}): ${data.message}`);
  return parseTwelveDataCandles(data);
}

async function fetchAndPersist(apiKey: string, interval: string, dbKey: string, outputsize: number): Promise<{ fetched: number; total: number }> {
  console.log(`Fetching ${interval} data from Twelve Data (outputsize=${outputsize})...`);
  const candles = await fetchInterval(apiKey, interval, outputsize);
  if (candles.length === 0) return { fetched: 0, total: 0 };

  await storage.upsertCandles(dbKey, candles);
  const dbCandles = await storage.getCandles(dbKey);
  const merged = dbCandles.length > candles.length ? dbCandles : candles;

  switch (dbKey) {
    case "1min": cachedM1 = merged; break;
    case "15min": cachedM15 = merged; break;
    case "1h": cachedH1 = merged; break;
    case "4h": cachedH4 = merged; break;
    case "1day": cachedDaily = merged; break;
  }

  console.log(`${interval}: fetched ${candles.length} new, total ${merged.length} in cache`);
  return { fetched: candles.length, total: merged.length };
}

export async function fetchLivePrice(): Promise<{ price: number; timestamp: string } | null> {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return null;
  try {
    const url = `${TWELVE_DATA_BASE}/price?symbol=XAU/USD&apikey=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.price) {
      return { price: parseFloat(data.price), timestamp: new Date().toISOString() };
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchXAUUSD(apiKey: string): Promise<{ h1: Candle[]; h4: Candle[]; daily: Candle[] }> {
  try {
    await fetchAndPersist(apiKey, "1h", "1h", 5000);
    await delay(1200);
    await fetchAndPersist(apiKey, "4h", "4h", 1250);
    await delay(1200);
    await fetchAndPersist(apiKey, "1day", "1day", 500);
  } catch (err) {
    console.error("Failed to fetch/persist core candles:", err);
  }

  lastXauFetch = new Date().toISOString();
  return { h1: cachedH1, h4: cachedH4, daily: cachedDaily };
}

export async function fetchLowerTimeframes(apiKey: string): Promise<{ m15: number; m1: number }> {
  let m15Count = 0, m1Count = 0;

  try {
    const r15 = await fetchAndPersist(apiKey, "15min", "15min", 5000);
    m15Count = r15.total;
  } catch (err: any) {
    console.error("Failed to fetch 15min data:", err.message);
  }

  await delay(1200);

  try {
    const r1 = await fetchAndPersist(apiKey, "1min", "1min", 5000);
    m1Count = r1.total;
  } catch (err: any) {
    console.error("Failed to fetch 1min data:", err.message);
  }

  return { m15: m15Count, m1: m1Count };
}

function getCacheForKey(dbKey: string): Candle[] {
  switch (dbKey) {
    case "1min": return cachedM1;
    case "15min": return cachedM15;
    case "1h": return cachedH1;
    case "4h": return cachedH4;
    case "1day": return cachedDaily;
    default: return [];
  }
}

function getExpectedCandleIntervalMs(dbKey: string): number {
  switch (dbKey) {
    case "1min": return 60_000;
    case "15min": return 15 * 60_000;
    case "1h": return 60 * 60_000;
    case "4h": return 4 * 60 * 60_000;
    case "1day": return 24 * 60 * 60_000;
    default: return 60 * 60_000;
  }
}

function isTimeframeFresh(dbKey: string): boolean {
  const candles = getCacheForKey(dbKey);
  if (candles.length === 0) return false;
  const latest = new Date(candles[candles.length - 1].timestamp).getTime();
  const now = Date.now();
  const interval = getExpectedCandleIntervalMs(dbKey);
  const staleness = now - latest;
  const threshold = Math.max(interval * 3, 2 * 60 * 60_000);
  return staleness < threshold;
}

export async function fetchAllTimeframes(apiKey: string, forceAll = false): Promise<{
  m1: number; m15: number; h1: number; h4: number; daily: number;
  errors: string[];
  skipped: string[];
}> {
  const errors: string[] = [];
  const skipped: string[] = [];
  const counts = { m1: 0, m15: 0, h1: 0, h4: 0, daily: 0 };

  const steps: { interval: string; dbKey: string; outputsize: number; countKey: keyof typeof counts }[] = [
    { interval: "1h", dbKey: "1h", outputsize: 5000, countKey: "h1" },
    { interval: "4h", dbKey: "4h", outputsize: 1250, countKey: "h4" },
    { interval: "1day", dbKey: "1day", outputsize: 500, countKey: "daily" },
    { interval: "15min", dbKey: "15min", outputsize: 5000, countKey: "m15" },
    { interval: "1min", dbKey: "1min", outputsize: 5000, countKey: "m1" },
  ];

  let needsDelay = false;
  for (const step of steps) {
    if (!forceAll && isTimeframeFresh(step.dbKey)) {
      counts[step.countKey] = getCacheForKey(step.dbKey).length;
      skipped.push(step.interval);
      console.log(`[fetch] ${step.interval}: fresh (${counts[step.countKey]} candles), skipping API call`);
      continue;
    }
    try {
      if (needsDelay) await delay(1500);
      const r = await fetchAndPersist(apiKey, step.interval, step.dbKey, step.outputsize);
      counts[step.countKey] = r.total;
      needsDelay = true;
    } catch (err: any) {
      errors.push(`${step.interval}: ${err.message}`);
      console.error(`Failed to fetch ${step.interval}:`, err.message);
      reportError("data-fetch", `${step.interval}: ${err.message}`);
      counts[step.countKey] = getCacheForKey(step.dbKey).length;
      needsDelay = true;
    }
  }

  lastXauFetch = new Date().toISOString();
  lastActualFetchTime = lastXauFetch;
  return { ...counts, errors, skipped };
}

function generateRecurringEvents(fromDate: Date, toDate: Date): EconomicEvent[] {
  const events: EconomicEvent[] = [];

  const current = new Date(fromDate);
  while (current <= toDate) {
    const year = current.getFullYear();
    const month = current.getMonth();

    const firstOfMonth = new Date(year, month, 1);

    const nfpDate = getNthWeekday(firstOfMonth, 5, 1);
    if (nfpDate >= fromDate && nfpDate <= toDate) {
      events.push({
        timestamp: setTimeUTC(nfpDate, 13, 30).toISOString(),
        event: "US Non-Farm Payrolls (NFP)",
        country: "US",
        impact: "high",
      });
    }

    const cpiDates = [10, 11, 12, 13, 14, 15];
    for (const d of cpiDates) {
      const cpiCandidate = new Date(year, month, d);
      if (cpiCandidate.getUTCDay() >= 1 && cpiCandidate.getUTCDay() <= 5) {
        if (cpiCandidate >= fromDate && cpiCandidate <= toDate) {
          events.push({
            timestamp: setTimeUTC(cpiCandidate, 13, 30).toISOString(),
            event: "US CPI (Consumer Price Index)",
            country: "US",
            impact: "high",
          });
        }
        break;
      }
    }

    const fomcMonths = [0, 2, 4, 5, 6, 8, 10, 11];
    if (fomcMonths.includes(month)) {
      const fomcDay = getThirdWednesday(year, month);
      if (fomcDay >= fromDate && fomcDay <= toDate) {
        events.push({
          timestamp: setTimeUTC(fomcDay, 19, 0).toISOString(),
          event: "FOMC Interest Rate Decision",
          country: "US",
          impact: "high",
        });
      }
    }

    const ppiDates = [11, 12, 13, 14, 15, 16, 17];
    for (const d of ppiDates) {
      const ppiCandidate = new Date(year, month, d);
      if (ppiCandidate.getUTCDay() >= 1 && ppiCandidate.getUTCDay() <= 5) {
        if (ppiCandidate >= fromDate && ppiCandidate <= toDate) {
          events.push({
            timestamp: setTimeUTC(ppiCandidate, 13, 30).toISOString(),
            event: "US PPI (Producer Price Index)",
            country: "US",
            impact: "medium",
          });
        }
        break;
      }
    }

    const retailDates = [13, 14, 15, 16, 17];
    for (const d of retailDates) {
      const candidate = new Date(year, month, d);
      if (candidate.getUTCDay() >= 1 && candidate.getUTCDay() <= 5) {
        if (candidate >= fromDate && candidate <= toDate) {
          events.push({
            timestamp: setTimeUTC(candidate, 13, 30).toISOString(),
            event: "US Retail Sales",
            country: "US",
            impact: "medium",
          });
        }
        break;
      }
    }

    current.setMonth(current.getMonth() + 1);
  }

  return events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

function getNthWeekday(firstOfMonth: Date, targetDay: number, n: number): Date {
  const d = new Date(firstOfMonth);
  let count = 0;
  while (count < n) {
    if (d.getUTCDay() === targetDay) count++;
    if (count < n) d.setDate(d.getDate() + 1);
  }
  return d;
}

function getThirdWednesday(year: number, month: number): Date {
  return getNthWeekday(new Date(year, month, 1), 3, 3);
}

function setTimeUTC(date: Date, hours: number, minutes: number): Date {
  const d = new Date(date);
  d.setUTCHours(hours, minutes, 0, 0);
  return d;
}

export async function fetchEconomicEvents(finnhubKey?: string): Promise<EconomicEvent[]> {
  const events: EconomicEvent[] = [];

  const now = new Date();
  const from = new Date(now.getTime() - 2 * 365 * 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const recurring = generateRecurringEvents(from, to);
  events.push(...recurring);

  if (finnhubKey) {
    try {
      const fromStr = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().substring(0, 10);
      const toStr = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().substring(0, 10);
      const url = `https://finnhub.io/api/v1/calendar/earnings?from=${fromStr}&to=${toStr}&token=${finnhubKey}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data?.earningsCalendar && Array.isArray(data.earningsCalendar)) {
          for (const e of data.earningsCalendar.slice(0, 20)) {
            if (e.date) {
              events.push({
                timestamp: new Date(e.date).toISOString(),
                event: `Earnings: ${e.symbol || "Unknown"}`,
                country: "US",
                impact: "low",
              });
            }
          }
        }
      }
    } catch {
    }
  }

  cachedEvents = events;
  lastEventsFetch = new Date().toISOString();
  return events;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchAsianMarkets(apiKey: string): Promise<AsianMarketSnapshot[]> {
  const indices = [
    { symbol: "1330:JPX", displayName: "Nikkei 225", fallback: "EWJ" },
    { symbol: "2800:HKEX", displayName: "Hang Seng", fallback: "EWH" },
    { symbol: "FXI", displayName: "China Large-Cap", fallback: "FXI" },
  ];

  const results: AsianMarketSnapshot[] = [];

  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (i > 0) await delay(500);

    const symbols = [idx.symbol, idx.fallback];
    let found = false;

    for (const sym of symbols) {
      if (found) break;
      try {
        const url = `${TWELVE_DATA_BASE}/quote?symbol=${encodeURIComponent(sym)}&apikey=${apiKey}`;
        const res = await fetch(url);
        if (!res.ok) continue;
        const data = await res.json();
        if (data.status === "error" || data.code === 429) continue;
        if (!data.close) continue;

        results.push({
          symbol: sym,
          name: idx.displayName,
          price: parseFloat(data.close) || 0,
          change: parseFloat(data.change) || 0,
          changePct: parseFloat(data.percent_change) || 0,
          timestamp: data.datetime || new Date().toISOString(),
        });
        found = true;
      } catch {
      }
    }
  }

  cachedAsian = results;
  lastAsianFetch = new Date().toISOString();
  return results;
}

export async function fetchGVZData(): Promise<{ date: string; value: number }[]> {
  try {
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 2);
    const startStr = startDate.toISOString().split("T")[0];
    const endStr = new Date().toISOString().split("T")[0];

    const fredKey = process.env.FRED_API_KEY;
    let data: { date: string; value: number }[] = [];

    if (fredKey) {
      const url = `https://api.stlouisfed.org/fred/series/observations?series_id=GVZCLS&observation_start=${startStr}&observation_end=${endStr}&api_key=${fredKey}&file_type=json`;
      console.log(`[GVZ] Fetching from FRED JSON API: ${startStr} to ${endStr}`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`FRED JSON API failed: ${res.status}`);

      const json = await res.json() as any;
      const observations = json.observations || [];
      for (const obs of observations) {
        if (!obs.date || obs.value === "." || obs.value === "") continue;
        const value = parseFloat(obs.value);
        if (!isNaN(value) && value > 0) {
          data.push({ date: obs.date, value });
        }
      }
    } else {
      const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=GVZCLS&cosd=${startStr}&coed=${endStr}`;
      console.log(`[GVZ] Fetching from FRED CSV: ${startStr} to ${endStr}`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`FRED CSV fetch failed: ${res.status}`);

      const csv = await res.text();
      const lines = csv.trim().split("\n").slice(1);
      for (const line of lines) {
        const [date, valStr] = line.split(",");
        if (!date || !valStr || valStr === "." || valStr === "") continue;
        const value = parseFloat(valStr);
        if (!isNaN(value) && value > 0) {
          data.push({ date, value });
        }
      }
    }

    if (data.length > 0) {
      const inserted = await storage.upsertGVZData(data);
      cachedGVZ = data;
      lastGVZFetch = new Date().toISOString();
      console.log(`[GVZ] Loaded ${data.length} data points (${inserted} upserted). Latest: ${data[data.length - 1].date} = ${data[data.length - 1].value}`);
    } else {
      console.warn("[GVZ] No valid data from FRED");
    }

    return data;
  } catch (err: any) {
    reportError("gvz-fetch", `GVZ fetch failed: ${err.message}`);
    console.error("[GVZ] Fetch error:", err.message);
    return cachedGVZ;
  }
}

export function getGVZData(): { date: string; value: number }[] {
  return cachedGVZ;
}

export function getLatestGVZ(): { value: number; percentile: number; date: string } | null {
  if (cachedGVZ.length === 0) return null;
  const latest = cachedGVZ[cachedGVZ.length - 1];
  const lookback = cachedGVZ.slice(-252);
  const sorted = [...lookback].map(d => d.value).sort((a, b) => a - b);
  const rank = sorted.filter(v => v < latest.value).length;
  const percentile = Math.round((rank / sorted.length) * 100);
  return { value: latest.value, percentile, date: latest.date };
}

export function getGVZPercentileForValue(gvzValue: number): number {
  if (cachedGVZ.length < 20) return 50;
  const lookback = cachedGVZ.slice(-252);
  const sorted = lookback.map(d => d.value).sort((a, b) => a - b);
  const rank = sorted.filter(v => v < gvzValue).length;
  return Math.round((rank / sorted.length) * 100);
}

export function getGVZForDate(targetDate: string): number | null {
  if (cachedGVZ.length === 0) return null;
  const target = targetDate.split("T")[0];
  for (let i = cachedGVZ.length - 1; i >= 0; i--) {
    if (cachedGVZ[i].date <= target) return cachedGVZ[i].value;
  }
  return null;
}

export async function fetchCOTData(): Promise<typeof cachedCOT> {
  try {
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 5);
    const startStr = startDate.toISOString().split("T")[0];
    const url = `https://publicreporting.cftc.gov/resource/6dca-aqww.json?$where=commodity_name='GOLD' AND market_and_exchange_names='GOLD - COMMODITY EXCHANGE INC.' AND report_date_as_yyyy_mm_dd>'${startStr}'&$order=report_date_as_yyyy_mm_dd ASC&$limit=300`;
    console.log(`[COT] Fetching from CFTC SODA API (Gold futures, last 5 years)...`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`CFTC API failed: ${res.status}`);

    const json = await res.json() as any[];
    const data: typeof cachedCOT = [];
    for (const row of json) {
      const date = row.report_date_as_yyyy_mm_dd?.split("T")[0];
      if (!date) continue;
      const noncommLong = parseInt(row.noncomm_positions_long_all) || 0;
      const noncommShort = parseInt(row.noncomm_positions_short_all) || 0;
      const netPosition = noncommLong - noncommShort;
      const openInterest = parseInt(row.open_interest_all) || 0;
      data.push({ date, noncommLong, noncommShort, netPosition, openInterest });
    }

    if (data.length > 0) {
      const inserted = await storage.upsertCOTData(data.map(d => ({
        ...d,
        commLong: 0,
        commShort: 0,
      })));
      cachedCOT = data;
      console.log(`[COT] Loaded ${data.length} weekly reports (${inserted} upserted). Latest: ${data[data.length - 1].date}, net=${data[data.length - 1].netPosition.toLocaleString()}`);
    } else {
      console.warn("[COT] No valid data from CFTC");
    }

    return data;
  } catch (err: any) {
    reportError("cot-fetch", `COT fetch failed: ${err.message}`);
    console.error("[COT] Fetch error:", err.message);
    return cachedCOT;
  }
}

export function getCOTData(): typeof cachedCOT {
  return cachedCOT;
}

export function getLatestCOT(): { netPosition: number; percentile: number; date: string; noncommLong: number; noncommShort: number; openInterest: number; sentiment: string } | null {
  if (cachedCOT.length === 0) return null;
  const latest = cachedCOT[cachedCOT.length - 1];
  const lookback = cachedCOT.slice(-156);
  const sorted = [...lookback].map(d => d.netPosition).sort((a, b) => a - b);
  const rank = sorted.filter(v => v < latest.netPosition).length;
  const percentile = Math.round((rank / sorted.length) * 100);
  const sentiment = percentile > 75 ? "EXTREMELY BULLISH" : percentile > 60 ? "BULLISH" : percentile < 25 ? "EXTREMELY BEARISH" : percentile < 40 ? "BEARISH" : "NEUTRAL";
  return { netPosition: latest.netPosition, percentile, date: latest.date, noncommLong: latest.noncommLong, noncommShort: latest.noncommShort, openInterest: latest.openInterest, sentiment };
}

export function getCOTPercentileForValue(netPos: number): number {
  if (cachedCOT.length < 20) return 50;
  const lookback = cachedCOT.slice(-156);
  const sorted = lookback.map(d => d.netPosition).sort((a, b) => a - b);
  const rank = sorted.filter(v => v < netPos).length;
  return Math.round((rank / sorted.length) * 100);
}

export function getCOTForDate(targetDate: string): { netPosition: number; openInterest: number } | null {
  if (cachedCOT.length === 0) return null;
  const target = targetDate.split("T")[0];
  for (let i = cachedCOT.length - 1; i >= 0; i--) {
    if (cachedCOT[i].date <= target) return { netPosition: cachedCOT[i].netPosition, openInterest: cachedCOT[i].openInterest };
  }
  return null;
}

export async function fetchSGEData(): Promise<typeof cachedSGE> {
  try {
    const fredKey = process.env.FRED_API_KEY;
    if (!fredKey) {
      console.warn("[SGE] No FRED_API_KEY, cannot fetch SGE data");
      return cachedSGE;
    }

    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 2);
    const startStr = startDate.toISOString().split("T")[0];
    const endStr = new Date().toISOString().split("T")[0];

    const usdcnyRes = await fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=DEXCHUS&observation_start=${startStr}&observation_end=${endStr}&api_key=${fredKey}&file_type=json`, {
      signal: AbortSignal.timeout(15000)
    });

    if (!usdcnyRes.ok) throw new Error(`FRED DEXCHUS API failed: status=${usdcnyRes.status}`);

    const usdcnyJson = await usdcnyRes.json() as any;

    const usdcnyMap = new Map<string, number>();
    for (const obs of (usdcnyJson.observations || [])) {
      if (obs.value !== "." && obs.value !== "") {
        const v = parseFloat(obs.value);
        if (!isNaN(v) && v > 0) usdcnyMap.set(obs.date, v);
      }
    }

    const goldFixMap = new Map<string, number>();
    for (const c of cachedDaily) {
      const ts = typeof c.timestamp === "string" ? c.timestamp : new Date(Number(c.timestamp) * 1000).toISOString();
      const d = ts.split("T")[0];
      if (c.close > 0 && d >= startStr) goldFixMap.set(d, c.close);
    }

    let sgeBenchmarkRes: any = null;
    try {
      const sgeRes = await fetch("https://en.sge.com.cn/graph/DayilyJzj", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          "Referer": "https://en.sge.com.cn/data_BenchmarkPrice",
          "Accept": "application/json, text/javascript, */*; q=0.01",
        },
        body: "variety=SHAU",
        signal: AbortSignal.timeout(10000),
      });
      if (sgeRes.ok) {
        const text = await sgeRes.text();
        if (text && text !== "..." && text.length > 10) {
          sgeBenchmarkRes = JSON.parse(text);
        }
      }
    } catch (e: any) {
      console.warn(`[SGE] SGE benchmark scrape failed: ${e.message}`);
    }

    const sgeBenchmarkMap = new Map<string, number>();
    if (sgeBenchmarkRes && Array.isArray(sgeBenchmarkRes)) {
      for (const item of sgeBenchmarkRes) {
        const date = item.date || item.reportdate;
        const price = parseFloat(item.price || item.jzj_price || item.am_price || "0");
        if (date && price > 0) {
          sgeBenchmarkMap.set(date.split("T")[0], price);
        }
      }
    }

    const data: { date: string; sgePriceCny: number; usdcnyRate: number; sgePriceUsd: number; spotPriceUsd: number; premium: number }[] = [];

    const allDates = [...new Set([...goldFixMap.keys()])].sort();
    let lastUsdcny = 7.0;

    for (const date of allDates) {
      const spotUsd = goldFixMap.get(date);
      if (!spotUsd) continue;

      const usdcny = usdcnyMap.get(date) ?? lastUsdcny;
      lastUsdcny = usdcny;

      let sgePriceCny = sgeBenchmarkMap.get(date) ?? 0;
      let sgePriceUsd: number;

      if (sgePriceCny > 0) {
        sgePriceUsd = (sgePriceCny / usdcny) * 31.1035;
      } else {
        const baseSpreadPct = 0.005 + (7.5 - usdcny) * 0.003;
        sgePriceUsd = spotUsd * (1 + baseSpreadPct);
        sgePriceCny = (sgePriceUsd / 31.1035) * usdcny;
      }

      const premium = sgePriceUsd - spotUsd;
      data.push({ date, sgePriceCny, usdcnyRate: usdcny, sgePriceUsd, spotPriceUsd: spotUsd, premium });
    }

    if (data.length > 0) {
      const inserted = await storage.upsertSGEData(data);
      cachedSGE = data.map(d => ({ date: d.date, premium: d.premium, sgePriceUsd: d.sgePriceUsd, spotPriceUsd: d.spotPriceUsd, usdcnyRate: d.usdcnyRate }));
      lastSGEFetch = new Date().toISOString();
      console.log(`[SGE] Loaded ${data.length} data points (${inserted} upserted). Latest: ${data[data.length - 1].date} premium=$${data[data.length - 1].premium.toFixed(2)}/oz`);
    } else {
      console.warn("[SGE] No valid data computed");
    }

    return cachedSGE;
  } catch (err: any) {
    reportError("sge-fetch", `SGE fetch failed: ${err.message}`);
    console.error("[SGE] Fetch error:", err.message);
    return cachedSGE;
  }
}

export function getSGEData(): typeof cachedSGE {
  return cachedSGE;
}

export function getLatestSGE(): { premium: number; date: string } | null {
  if (cachedSGE.length === 0) return null;
  const latest = cachedSGE[cachedSGE.length - 1];
  return { premium: latest.premium, date: latest.date };
}

export function getSGEForDate(targetDate: string): number | null {
  if (cachedSGE.length === 0) return null;
  const target = targetDate.split("T")[0];
  for (let i = cachedSGE.length - 1; i >= 0; i--) {
    if (cachedSGE[i].date <= target) return cachedSGE[i].premium;
  }
  return null;
}

export async function loadCachedDataFromDB(): Promise<{ m1: number; m15: number; h1: number; h4: number; daily: number }> {
  try {
    const dbM1 = await storage.getCandles("1min");
    const dbM15 = await storage.getCandles("15min");
    const dbH1 = await storage.getCandles("1h");
    const dbH4 = await storage.getCandles("4h");
    const dbDaily = await storage.getCandles("1day");
    if (dbM1.length > cachedM1.length) cachedM1 = dbM1;
    if (dbM15.length > cachedM15.length) cachedM15 = dbM15;
    if (dbH1.length > cachedH1.length) cachedH1 = dbH1;
    if (dbH4.length > cachedH4.length) cachedH4 = dbH4;
    if (dbDaily.length > cachedDaily.length) cachedDaily = dbDaily;
    if (dbH1.length > 0 || dbH4.length > 0 || dbDaily.length > 0) {
      lastXauFetch = lastXauFetch || "loaded from database";
    }
    const dbGVZ = await storage.getGVZData(600);
    if (dbGVZ.length > cachedGVZ.length) cachedGVZ = dbGVZ;
    const dbCOT = await storage.getCOTData(300);
    if (dbCOT.length > cachedCOT.length) cachedCOT = dbCOT;
    const dbSGE = await storage.getSGEData(600);
    if (dbSGE.length > cachedSGE.length) cachedSGE = dbSGE;
    console.log(`Loaded from DB: ${cachedM1.length} M1, ${cachedM15.length} M15, ${cachedH1.length} H1, ${cachedH4.length} H4, ${cachedDaily.length} Daily candles, ${cachedGVZ.length} GVZ, ${cachedCOT.length} COT, ${cachedSGE.length} SGE`);
    return { m1: cachedM1.length, m15: cachedM15.length, h1: cachedH1.length, h4: cachedH4.length, daily: cachedDaily.length };
  } catch (err) {
    console.error("Failed to load candles from DB:", err);
    return { m1: 0, m15: 0, h1: 0, h4: 0, daily: 0 };
  }
}

export async function getDbPriceStatus(): Promise<{
  m1: { count: number; range: { from: string; to: string } | null };
  m15: { count: number; range: { from: string; to: string } | null };
  h1: { count: number; range: { from: string; to: string } | null };
  h4: { count: number; range: { from: string; to: string } | null };
  daily: { count: number; range: { from: string; to: string } | null };
}> {
  const m1Count = await storage.getCandleCount("1min");
  const m15Count = await storage.getCandleCount("15min");
  const h1Count = await storage.getCandleCount("1h");
  const h4Count = await storage.getCandleCount("4h");
  const dailyCount = await storage.getCandleCount("1day");
  const m1Range = await storage.getCandleDateRange("1min");
  const m15Range = await storage.getCandleDateRange("15min");
  const h1Range = await storage.getCandleDateRange("1h");
  const h4Range = await storage.getCandleDateRange("4h");
  const dailyRange = await storage.getCandleDateRange("1day");
  return {
    m1: { count: m1Count, range: m1Range },
    m15: { count: m15Count, range: m15Range },
    h1: { count: h1Count, range: h1Range },
    h4: { count: h4Count, range: h4Range },
    daily: { count: dailyCount, range: dailyRange },
  };
}

export function getCachedData() {
  return {
    m1: cachedM1,
    m15: cachedM15,
    h1: cachedH1,
    h4: cachedH4,
    daily: cachedDaily,
    events: cachedEvents,
    asian: cachedAsian,
    gvz: cachedGVZ,
    cot: cachedCOT,
    sge: cachedSGE,
  };
}

export function appendLiveH1Bar(bar: Candle) {
  if (cachedH1.length > 0) {
    const lastTs = new Date(cachedH1[cachedH1.length - 1].timestamp).getTime();
    const newTs = new Date(bar.timestamp).getTime();
    if (newTs <= lastTs) return;
  }
  cachedH1.push(bar);
  if (cachedH1.length > 1000) cachedH1.splice(0, cachedH1.length - 500);
}

export function updateLiveH1Tip(price: number) {
  if (cachedH1.length === 0 || price <= 0) return;
  const tip = cachedH1[cachedH1.length - 1];
  tip.close = price;
  tip.high = Math.max(tip.high, price);
  tip.low = Math.min(tip.low, price);
}

export function updateLiveH4Tip(price: number) {
  if (cachedH4.length === 0 || price <= 0) return;
  const tip = cachedH4[cachedH4.length - 1];
  tip.close = price;
  tip.high = Math.max(tip.high, price);
  tip.low = Math.min(tip.low, price);
}

export function appendLiveH4Bar(bar: Candle) {
  if (cachedH4.length > 0) {
    const lastTs = new Date(cachedH4[cachedH4.length - 1].timestamp).getTime();
    const newTs = new Date(bar.timestamp).getTime();
    if (newTs <= lastTs) return;
  }
  cachedH4.push(bar);
  if (cachedH4.length > 500) cachedH4.splice(0, cachedH4.length - 300);
}

let ensureDataPromise: Promise<void> | null = null;

export async function ensureDataReady(): Promise<{ loaded: boolean; refreshed: boolean; errors: string[] }> {
  if (ensureDataPromise) {
    await ensureDataPromise;
    return { loaded: true, refreshed: false, errors: [] };
  }

  const errors: string[] = [];
  let loaded = false;
  let refreshed = false;

  const doWork = async () => {
    try {
      if (cachedH1.length === 0 || cachedH4.length === 0 || cachedDaily.length === 0) {
        console.log("[ensureDataReady] Cache empty, loading from DB...");
        await loadCachedDataFromDB();
        loaded = true;
      }

      if (cachedH1.length === 0 || cachedH4.length === 0 || cachedDaily.length === 0) {
        const apiKey = process.env.TWELVE_DATA_API_KEY;
        if (apiKey) {
          console.log("[ensureDataReady] DB empty too, fetching from API...");
          const result = await fetchAllTimeframes(apiKey);
          if (result.errors.length > 0) errors.push(...result.errors);
          refreshed = true;
        } else {
          errors.push("No data in database and TWELVE_DATA_API_KEY not set");
        }
      } else {
        const apiKey = process.env.TWELVE_DATA_API_KEY;
        const coreFresh = isTimeframeFresh("1h") && isTimeframeFresh("4h") && isTimeframeFresh("1day");
        if (!coreFresh && apiKey) {
          console.log("[ensureDataReady] Core data stale, refreshing only stale timeframes...");
          const result = await fetchAllTimeframes(apiKey);
          if (result.errors.length > 0) errors.push(...result.errors);
          refreshed = true;
        }
      }

      if (cachedEvents.length === 0) {
        console.log("[ensureDataReady] Loading economic events...");
        const finnhubKey = process.env.FINNHUB_API_KEY;
        await fetchEconomicEvents(finnhubKey);
      }

      const apiKey = process.env.TWELVE_DATA_API_KEY;
      if (apiKey && cachedAsian.length === 0) {
        console.log("[ensureDataReady] Loading Asian market data...");
        try {
          await fetchAsianMarkets(apiKey);
        } catch (err: any) {
          console.error("[ensureDataReady] Asian market fetch failed:", err.message);
        }
      }

      if (cachedGVZ.length === 0) {
        console.log("[ensureDataReady] Loading GVZ (Gold Volatility Index) data...");
        try {
          await fetchGVZData();
        } catch (err: any) {
          console.error("[ensureDataReady] GVZ fetch failed:", err.message);
        }
      }

      if (cachedCOT.length === 0) {
        console.log("[ensureDataReady] Loading COT (Commitment of Traders) data...");
        try {
          await fetchCOTData();
        } catch (err: any) {
          console.error("[ensureDataReady] COT fetch failed:", err.message);
        }
      }

      if (cachedSGE.length === 0) {
        console.log("[ensureDataReady] Loading SGE (Shanghai Gold Exchange) premium data...");
        try {
          await fetchSGEData();
        } catch (err: any) {
          console.error("[ensureDataReady] SGE fetch failed:", err.message);
        }
      }
    } finally {
      ensureDataPromise = null;
    }
  };

  ensureDataPromise = doWork();
  await ensureDataPromise;
  return { loaded, refreshed, errors };
}

export function getDataFreshness(): { latestTimestamp: string | null; ageMinutes: number; isStale: boolean; warning: string | null; lastFetchTime: string | null } {
  const h1 = cachedH1;
  if (h1.length === 0) {
    return { latestTimestamp: null, ageMinutes: Infinity, isStale: true, warning: "No market data loaded.", lastFetchTime: null };
  }

  const now = new Date();
  let ageMinutes: number;

  if (lastActualFetchTime) {
    const fetchDate = new Date(lastActualFetchTime);
    ageMinutes = Math.max(0, Math.round((now.getTime() - fetchDate.getTime()) / 60000));
  } else {
    const latestDate = new Date(h1[h1.length - 1].timestamp);
    ageMinutes = Math.max(0, Math.round((now.getTime() - latestDate.getTime()) / 60000));
  }

  const latestTs = h1[h1.length - 1].timestamp;
  const isWeekend = now.getUTCDay() === 0 || now.getUTCDay() === 6;
  const staleThresholdMinutes = isWeekend ? 48 * 60 : 120;
  const isStale = ageMinutes > staleThresholdMinutes;

  let warning: string | null = null;
  if (isStale) {
    const ageHours = Math.round(ageMinutes / 60);
    if (ageHours >= 24) {
      const ageDays = Math.round(ageHours / 24);
      warning = `WARNING: Candle data is ${ageDays} day(s) old (last fetch: ${lastActualFetchTime || 'unknown'}). Candle-based analysis may be outdated. Data refresh recommended.`;
    } else {
      warning = `WARNING: Candle data is ${ageHours} hour(s) old (last fetch: ${lastActualFetchTime || 'unknown'}). Candle-based analysis may be outdated. Data refresh recommended.`;
    }
  }
  return { latestTimestamp: latestTs, ageMinutes, isStale, warning, lastFetchTime: lastActualFetchTime };
}

export async function autoRefreshIfStale(): Promise<boolean> {
  const freshness = getDataFreshness();
  if (!freshness.isStale) {
    console.log(`[auto-refresh] Data is fresh (${freshness.ageMinutes} min old). No fetch needed.`);
    return false;
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    console.log("[auto-refresh] Data is stale but no TWELVE_DATA_API_KEY set. Skipping auto-refresh.");
    return false;
  }

  console.log(`[auto-refresh] Data is stale (${freshness.ageMinutes} min old). Fetching fresh data...`);
  try {
    const result = await fetchAllTimeframes(apiKey);
    console.log(`[auto-refresh] Fetched: M1=${result.m1}, M15=${result.m15}, H1=${result.h1}, H4=${result.h4}, Daily=${result.daily}`);
    if (result.errors.length > 0) {
      console.warn(`[auto-refresh] Partial failure (${result.errors.length} timeframe(s)):`, result.errors);
      reportWarning("data-fetch", `Auto-refresh partial failure: ${result.errors.join("; ")}`);
    }
    const postRefresh = getDataFreshness();
    if (postRefresh.isStale) {
      console.warn(`[auto-refresh] Data still stale after refresh (${postRefresh.ageMinutes} min old). Check API key or connectivity.`);
      reportError("data-fetch", `Data still stale after refresh (${postRefresh.ageMinutes}min). Check API key.`);
      return false;
    }

    try {
      const latestGVZ = cachedGVZ.length > 0 ? cachedGVZ[cachedGVZ.length - 1] : null;
      const gvzAge = latestGVZ ? (Date.now() - new Date(latestGVZ.date).getTime()) / (1000 * 60 * 60) : Infinity;
      if (gvzAge > 20) {
        console.log("[auto-refresh] Refreshing GVZ data...");
        await fetchGVZData();
      }
    } catch (err: any) {
      console.warn("[auto-refresh] GVZ refresh failed:", err.message);
    }

    try {
      const latestCOT = cachedCOT.length > 0 ? cachedCOT[cachedCOT.length - 1] : null;
      const cotAge = latestCOT ? (Date.now() - new Date(latestCOT.date).getTime()) / (1000 * 60 * 60 * 24) : Infinity;
      if (cotAge > 7) {
        console.log("[auto-refresh] Refreshing COT data...");
        await fetchCOTData();
      }
    } catch (err: any) {
      console.warn("[auto-refresh] COT refresh failed:", err.message);
    }

    try {
      const latestSGE = cachedSGE.length > 0 ? cachedSGE[cachedSGE.length - 1] : null;
      const sgeAge = latestSGE ? (Date.now() - new Date(latestSGE.date).getTime()) / (1000 * 60 * 60) : Infinity;
      if (sgeAge > 20) {
        console.log("[auto-refresh] Refreshing SGE premium data...");
        await fetchSGEData();
      }
    } catch (err: any) {
      console.warn("[auto-refresh] SGE refresh failed:", err.message);
    }

    return true;
  } catch (err: any) {
    console.error(`[auto-refresh] Failed to refresh data:`, err.message);
    reportError("data-fetch", `Auto-refresh failed: ${err.message}`);
    return false;
  }
}

export function getDataStatus(): MarketDataStatus {
  return {
    xauusd: {
      m1: cachedM1.length,
      m15: cachedM15.length,
      h1: cachedH1.length,
      h4: cachedH4.length,
      daily: cachedDaily.length,
      lastFetched: lastXauFetch,
    },
    events: {
      count: cachedEvents.length,
      lastFetched: lastEventsFetch,
    },
    asian: {
      indices: cachedAsian.map((a) => a.symbol),
      lastFetched: lastAsianFetch,
    },
  };
}

export function hasApiKeys(): { twelveData: boolean; finnhub: boolean } {
  return {
    twelveData: !!process.env.TWELVE_DATA_API_KEY,
    finnhub: !!process.env.FINNHUB_API_KEY,
  };
}
