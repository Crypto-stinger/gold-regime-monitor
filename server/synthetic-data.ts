import type { Candle } from "../shared/schema";

export function generateSyntheticH1(fromDate: Date, toDate: Date): Candle[] {
  const candles: Candle[] = [];
  let price = 1980 + Math.random() * 80;
  const ms = 60 * 60 * 1000;
  let current = new Date(fromDate);

  let regimeTimer = 0;
  let nextSwitch = 100 + Math.floor(Math.random() * 200);
  let isUptrend = Math.random() > 0.5;
  let regimeType: "trend" | "range" | "neutral" = "range";

  while (current <= toDate) {
    const dow = current.getUTCDay();
    if (dow === 0 || dow === 6) {
      current = new Date(current.getTime() + ms);
      continue;
    }

    regimeTimer++;
    if (regimeTimer >= nextSwitch) {
      regimeTimer = 0;
      nextSwitch = 80 + Math.floor(Math.random() * 250);
      const roll = Math.random();
      if (roll < 0.35) { regimeType = "trend"; isUptrend = !isUptrend; }
      else if (roll < 0.70) { regimeType = "range"; }
      else { regimeType = "neutral"; }
    }

    let baseVol = 3.5 + Math.random() * 2;
    let drift = 0;

    if (regimeType === "trend") {
      baseVol *= 2.0;
      drift = isUptrend ? 0.6 + Math.random() * 0.5 : -(0.6 + Math.random() * 0.5);
    } else if (regimeType === "range") {
      baseVol *= 0.6;
      drift = (2000 - price) * 0.005;
    } else {
      drift = (Math.random() - 0.5) * 0.3;
    }

    const noise = (Math.random() - 0.5) * baseVol * 2;
    const change = drift + noise;
    const open = price;
    price = Math.max(1600, Math.min(2800, price + change));
    const close = price;
    const highExtra = Math.random() * baseVol * 1.5;
    const lowExtra = Math.random() * baseVol * 1.5;

    candles.push({
      timestamp: current.toISOString(),
      open: +open.toFixed(2),
      high: +Math.max(open, close, open + highExtra).toFixed(2),
      low: +Math.min(open, close, close - lowExtra).toFixed(2),
      close: +close.toFixed(2),
    });

    current = new Date(current.getTime() + ms);
  }

  return candles;
}

export function aggregateCandles(h1: Candle[], periodHours: number): Candle[] {
  const result: Candle[] = [];
  for (let i = 0; i < h1.length; i += periodHours) {
    const slice = h1.slice(i, i + periodHours);
    if (slice.length === 0) continue;
    result.push({
      timestamp: slice[0].timestamp,
      open: slice[0].open,
      high: Math.max(...slice.map((c) => c.high)),
      low: Math.min(...slice.map((c) => c.low)),
      close: slice[slice.length - 1].close,
    });
  }
  return result;
}

export function aggregateToDaily(h1: Candle[]): Candle[] {
  const dayMap = new Map<string, Candle[]>();
  for (const c of h1) {
    const day = c.timestamp.substring(0, 10);
    if (!dayMap.has(day)) dayMap.set(day, []);
    dayMap.get(day)!.push(c);
  }

  const result: Candle[] = [];
  const sortedDays = Array.from(dayMap.keys()).sort();
  for (const day of sortedDays) {
    const bars = dayMap.get(day)!;
    result.push({
      timestamp: bars[0].timestamp,
      open: bars[0].open,
      high: Math.max(...bars.map((c) => c.high)),
      low: Math.min(...bars.map((c) => c.low)),
      close: bars[bars.length - 1].close,
    });
  }
  return result;
}
