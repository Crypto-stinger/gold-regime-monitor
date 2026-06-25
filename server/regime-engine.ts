import type { Candle, EnrichedCandle, RegimeState } from "../shared/schema";
import { classifyHMMRegime, classifyHMMPerBar, hmmToRegimeSignal, trainHMM, isHMMTrained, type HMMResult } from "./hmm-engine";
import { trainMRSGARCH, classifyMRSGARCHPerBar, isMRSGARCHTrained } from "./mrs-garch";

export function calcATR(candles: Candle[], period: number): number[] {
  const trs: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      trs.push(candles[i].high - candles[i].low);
    } else {
      const hl = candles[i].high - candles[i].low;
      const hpc = Math.abs(candles[i].high - candles[i - 1].close);
      const lpc = Math.abs(candles[i].low - candles[i - 1].close);
      trs.push(Math.max(hl, hpc, lpc));
    }
  }

  const atrs: number[] = new Array(candles.length).fill(NaN);
  if (trs.length < period) return atrs;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  atrs[period - 1] = sum / period;
  for (let i = period; i < trs.length; i++) {
    atrs[i] = (atrs[i - 1] * (period - 1) + trs[i]) / period;
  }
  return atrs;
}

export function calcEMA(values: number[], period: number): number[] {
  const ema: number[] = new Array(values.length).fill(NaN);
  const k = 2 / (period + 1);

  let firstValid = -1;
  for (let i = 0; i < values.length; i++) {
    if (!isNaN(values[i])) { firstValid = i; break; }
  }
  if (firstValid === -1) return ema;

  let sum = 0;
  let count = 0;
  for (let i = firstValid; i < Math.min(firstValid + period, values.length); i++) {
    if (!isNaN(values[i])) { sum += values[i]; count++; }
  }
  if (count === 0) return ema;

  const seedIdx = firstValid + period - 1;
  if (seedIdx >= values.length) return ema;
  ema[seedIdx] = sum / count;

  for (let i = seedIdx + 1; i < values.length; i++) {
    const val = isNaN(values[i]) ? ema[i - 1] : values[i];
    ema[i] = val * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

export function calcBBWidth(closes: number[], period: number): number[] {
  const widths: number[] = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    if (mean === 0) continue;
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / slice.length;
    const std = Math.sqrt(variance);
    widths[i] = (2 * std) / mean;
  }
  return widths;
}

export function calcBBWidthPercentile(bbWidths: number[], index: number, lookback: number = 100): number {
  const start = Math.max(0, index - lookback + 1);
  const window = bbWidths.slice(start, index + 1).filter(v => !isNaN(v));
  if (window.length < 10) return 50;
  const currentVal = bbWidths[index];
  if (isNaN(currentVal)) return 50;
  const belowCount = window.filter(v => v < currentVal).length;
  return (belowCount / window.length) * 100;
}

export function addFeatures(
  h1: Candle[],
  h4: Candle[],
  daily: Candle[],
  atrPeriod: number,
  dailyEmaPeriod: number,
  gvzData?: { date: string; value: number }[],
  cotData?: { date: string; netPosition: number; openInterest: number }[],
  vpConfig?: { enabled: boolean; period: number; bins: number; valueAreaPct: number },
  sgeData?: { date: string; premium: number }[]
): EnrichedCandle[] {
  const h1Atrs = calcATR(h1, atrPeriod);
  const h4Atrs = calcATR(h4, atrPeriod);
  const h4Closes = h4.map((c) => c.close);
  const h4BBWidths = calcBBWidth(h4Closes, 20);
  const dailyCloses = daily.map((c) => c.close);
  const dailyEmas50 = calcEMA(dailyCloses, dailyEmaPeriod);
  const dailyEmas200 = calcEMA(dailyCloses, 200);
  const h4ADX = calcADX(h4, 14);

  const gvzValues = gvzData?.map(d => d.value) || [];
  const cotNetValues = cotData?.map(d => d.netPosition) || [];

  const enriched: EnrichedCandle[] = [];

  for (let i = 0; i < h1.length; i++) {
    const h1Time = new Date(h1[i].timestamp).getTime();
    const h1DateStr = new Date(h1[i].timestamp).toISOString().split("T")[0];

    let atrH4 = NaN;
    let bbWidthH4 = NaN;
    let bbPctH4 = 50;
    let adxH4 = NaN;
    for (let j = h4.length - 1; j >= 0; j--) {
      if (new Date(h4[j].timestamp).getTime() <= h1Time) {
        atrH4 = h4Atrs[j];
        bbWidthH4 = h4BBWidths[j];
        bbPctH4 = calcBBWidthPercentile(h4BBWidths, j, 100);
        adxH4 = h4ADX.adx[j];
        break;
      }
    }

    let dailyClose = NaN;
    let emaDailyVal = NaN;
    let emaDaily200Val = NaN;
    for (let j = daily.length - 1; j >= 0; j--) {
      if (new Date(daily[j].timestamp).getTime() <= h1Time) {
        dailyClose = daily[j].close;
        emaDailyVal = dailyEmas50[j];
        emaDaily200Val = dailyEmas200[j];
        break;
      }
    }

    let gvzVal = NaN;
    let gvzPct = 50;
    if (gvzData && gvzData.length > 0) {
      for (let j = gvzData.length - 1; j >= 0; j--) {
        if (gvzData[j].date <= h1DateStr) {
          gvzVal = gvzData[j].value;
          const lookbackStart = Math.max(0, j - 252);
          const lookbackSlice = gvzValues.slice(lookbackStart, j + 1);
          if (lookbackSlice.length > 10) {
            const sorted = [...lookbackSlice].sort((a, b) => a - b);
            const rank = sorted.filter(v => v < gvzVal).length;
            gvzPct = Math.round((rank / sorted.length) * 100);
          }
          break;
        }
      }
    }

    let cotNet = 0;
    let cotNetPct = 50;
    if (cotData && cotData.length > 0) {
      for (let j = cotData.length - 1; j >= 0; j--) {
        if (cotData[j].date <= h1DateStr) {
          cotNet = cotData[j].netPosition;
          const lookbackStart = Math.max(0, j - 156);
          const lookbackSlice = cotNetValues.slice(lookbackStart, j + 1);
          if (lookbackSlice.length > 10) {
            const sorted = [...lookbackSlice].sort((a, b) => a - b);
            const rank = sorted.filter(v => v < cotNet).length;
            cotNetPct = Math.round((rank / sorted.length) * 100);
          }
          break;
        }
      }
    }

    let sgePremium = 0;
    if (sgeData && sgeData.length > 0) {
      for (let j = sgeData.length - 1; j >= 0; j--) {
        if (sgeData[j].date <= h1DateStr) {
          sgePremium = sgeData[j].premium;
          break;
        }
      }
    }

    let vpPoc = 0, vpVah = 0, vpVal = 0;
    if (vpConfig?.enabled) {
      const vpPeriod = vpConfig.period || 50;
      let h4EndIdx = -1;
      for (let j = h4.length - 1; j >= 0; j--) {
        if (new Date(h4[j].timestamp).getTime() <= h1Time) {
          h4EndIdx = j;
          break;
        }
      }
      if (h4EndIdx >= 0) {
        const h4StartIdx = Math.max(0, h4EndIdx - vpPeriod + 1);
        const vpCandles = h4.slice(h4StartIdx, h4EndIdx + 1);
        if (vpCandles.length >= 5) {
          const vp = calcVolumeProfile(vpCandles, vpConfig.bins || 24, vpConfig.valueAreaPct || 70);
          vpPoc = vp.poc;
          vpVah = vp.vah;
          vpVal = vp.val;
        }
      }
    }

    enriched.push({
      ...h1[i],
      atr_h1: h1Atrs[i],
      atr_h4: atrH4,
      ema_daily: emaDailyVal,
      ema_daily_200: emaDaily200Val,
      daily_close: dailyClose,
      bb_width_h4: bbWidthH4,
      bb_width_percentile: bbPctH4,
      adx_h4: adxH4,
      gvz: gvzVal,
      gvz_percentile: gvzPct,
      cot_net: cotNet,
      cot_net_pct: cotNetPct,
      vp_poc: vpPoc,
      vp_vah: vpVah,
      vp_val: vpVal,
      sge_premium: sgePremium,
    });
  }

  if (enriched.length >= 50) {
    if (!isHMMTrained()) {
      trainHMM(enriched);
    }
    const perBarResults = classifyHMMPerBar(enriched);
    for (let i = 0; i < perBarResults.length; i++) {
      const canIdx = i + 1;
      if (canIdx < enriched.length) {
        enriched[canIdx].hmm_state = perBarResults[i].state;
        enriched[canIdx].hmm_confidence = perBarResults[i].confidence;
      }
    }

    if (enriched.length >= 100) {
      if (!isMRSGARCHTrained()) {
        trainMRSGARCH(enriched);
      }
      if (isMRSGARCHTrained()) {
        const garchResults = classifyMRSGARCHPerBar(enriched);
        for (let i = 0; i < garchResults.length; i++) {
          const canIdx = i + 1;
          if (canIdx < enriched.length) {
            enriched[canIdx].garch_volatility = garchResults[i].garchVolatility;
            enriched[canIdx].garch_forecast = garchResults[i].volForecast;
            enriched[canIdx].mrs_position_multiplier = garchResults[i].positionSizeMultiplier;
          }
        }
      }
    }
  }

  return enriched;
}

export type VolumeProfileResult = {
  poc: number;
  vah: number;
  val: number;
  bins: { priceLevel: number; volume: number }[];
};

export function calcVolumeProfile(
  candles: Candle[],
  numBins: number = 24,
  valueAreaPct: number = 70
): VolumeProfileResult {
  const defaultResult: VolumeProfileResult = { poc: 0, vah: 0, val: 0, bins: [] };
  if (candles.length < 5) return defaultResult;
  numBins = Math.max(1, Math.round(numBins));
  valueAreaPct = Math.max(10, Math.min(95, valueAreaPct));

  let highestHigh = -Infinity;
  let lowestLow = Infinity;
  for (const c of candles) {
    if (c.high > highestHigh) highestHigh = c.high;
    if (c.low < lowestLow) lowestLow = c.low;
  }

  const priceRange = highestHigh - lowestLow;
  if (priceRange <= 0) return defaultResult;

  const binSize = priceRange / numBins;
  const bins = new Array(numBins).fill(0);

  for (const c of candles) {
    const vol = c.volume && c.volume > 0 ? c.volume : 1;
    const candleRange = c.high - c.low;
    if (candleRange <= 0) {
      const idx = Math.min(Math.floor((c.close - lowestLow) / binSize), numBins - 1);
      bins[Math.max(0, idx)] += vol;
      continue;
    }
    const startBin = Math.max(0, Math.floor((c.low - lowestLow) / binSize));
    const endBin = Math.min(numBins - 1, Math.floor((c.high - lowestLow) / binSize));
    const actualBinCount = endBin - startBin + 1;
    const volPerBin = vol / Math.max(1, actualBinCount);
    for (let b = startBin; b <= endBin; b++) {
      bins[b] += volPerBin;
    }
  }

  let pocIdx = 0;
  for (let b = 1; b < numBins; b++) {
    if (bins[b] > bins[pocIdx]) pocIdx = b;
  }
  const poc = lowestLow + (pocIdx + 0.5) * binSize;

  const totalVol = bins.reduce((s, v) => s + v, 0);
  const targetVol = totalVol * (valueAreaPct / 100);
  let vaVol = bins[pocIdx];
  let vaLow = pocIdx;
  let vaHigh = pocIdx;

  while (vaVol < targetVol && (vaLow > 0 || vaHigh < numBins - 1)) {
    const leftVol = vaLow > 0 ? bins[vaLow - 1] : 0;
    const rightVol = vaHigh < numBins - 1 ? bins[vaHigh + 1] : 0;
    if (leftVol >= rightVol && vaLow > 0) {
      vaLow--;
      vaVol += bins[vaLow];
    } else if (vaHigh < numBins - 1) {
      vaHigh++;
      vaVol += bins[vaHigh];
    } else if (vaLow > 0) {
      vaLow--;
      vaVol += bins[vaLow];
    } else {
      break;
    }
  }

  const val = lowestLow + vaLow * binSize;
  const vah = lowestLow + (vaHigh + 1) * binSize;

  const binResult = bins.map((v, idx) => ({
    priceLevel: lowestLow + (idx + 0.5) * binSize,
    volume: v,
  }));

  return { poc, vah, val, bins: binResult };
}

export function calcRSI(closes: number[], period: number): number[] {
  const rsi: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return rsi;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  rsi[period] = (avgGain === 0 && avgLoss === 0) ? 50 : avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

export function calcSMA(values: number[], period: number): number[] {
  const sma: number[] = new Array(values.length).fill(NaN);
  if (values.length < period) return sma;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  sma[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    sum += values[i] - values[i - period];
    sma[i] = sum / period;
  }
  return sma;
}

export function calcMACD(closes: number[], fast = 12, slow = 26, signal = 9) {
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine: number[] = new Array(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    if (!isNaN(emaFast[i]) && !isNaN(emaSlow[i])) {
      macdLine[i] = emaFast[i] - emaSlow[i];
    }
  }
  const validMACD = macdLine.filter(v => !isNaN(v));
  const signalLine = calcEMA(validMACD, signal);
  const fullSignal: number[] = new Array(closes.length).fill(NaN);
  let j = 0;
  for (let i = 0; i < closes.length; i++) {
    if (!isNaN(macdLine[i])) {
      fullSignal[i] = j < signalLine.length ? signalLine[j] : NaN;
      j++;
    }
  }
  const histogram: number[] = new Array(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    if (!isNaN(macdLine[i]) && !isNaN(fullSignal[i])) {
      histogram[i] = macdLine[i] - fullSignal[i];
    }
  }
  return { macdLine, signalLine: fullSignal, histogram };
}

export function calcADX(candles: Candle[], period = 14) {
  const len = candles.length;
  const plusDI: number[] = new Array(len).fill(NaN);
  const minusDI: number[] = new Array(len).fill(NaN);
  const adx: number[] = new Array(len).fill(NaN);
  if (len < period + 1) return { plusDI, minusDI, adx };

  const trArr: number[] = [0];
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  for (let i = 1; i < len; i++) {
    const hl = candles[i].high - candles[i].low;
    const hpc = Math.abs(candles[i].high - candles[i - 1].close);
    const lpc = Math.abs(candles[i].low - candles[i - 1].close);
    trArr.push(Math.max(hl, hpc, lpc));
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  let smoothTR = 0, smoothPlusDM = 0, smoothMinusDM = 0;
  for (let i = 1; i <= period; i++) {
    smoothTR += trArr[i];
    smoothPlusDM += plusDM[i];
    smoothMinusDM += minusDM[i];
  }

  const dxArr: number[] = [];
  for (let i = period; i < len; i++) {
    if (i > period) {
      smoothTR = smoothTR - smoothTR / period + trArr[i];
      smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
      smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];
    }
    const pdi = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const mdi = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    plusDI[i] = pdi;
    minusDI[i] = mdi;
    const diSum = pdi + mdi;
    const dx = diSum > 0 ? (Math.abs(pdi - mdi) / diSum) * 100 : 0;
    dxArr.push(dx);
    if (dxArr.length === period) {
      adx[i] = dxArr.reduce((a, b) => a + b, 0) / period;
    } else if (dxArr.length > period) {
      adx[i] = (adx[i - 1] * (period - 1) + dx) / period;
    }
  }
  return { plusDI, minusDI, adx };
}

export function calcOBV(candles: Candle[]): number[] {
  const obv: number[] = new Array(candles.length).fill(0);
  if (candles.length === 0) return obv;
  obv[0] = candles[0].volume ?? 0;
  for (let i = 1; i < candles.length; i++) {
    const vol = candles[i].volume ?? 0;
    if (candles[i].close > candles[i - 1].close) {
      obv[i] = obv[i - 1] + vol;
    } else if (candles[i].close < candles[i - 1].close) {
      obv[i] = obv[i - 1] - vol;
    } else {
      obv[i] = obv[i - 1];
    }
  }
  return obv;
}

export function calcVWAP(candles: Candle[]): number[] {
  const vwap: number[] = new Array(candles.length).fill(NaN);
  let cumVol = 0;
  let cumTPVol = 0;
  for (let i = 0; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const vol = candles[i].volume ?? 0;
    cumVol += vol;
    cumTPVol += tp * vol;
    vwap[i] = cumVol > 0 ? cumTPVol / cumVol : tp;
  }
  return vwap;
}

export function calcVolumeSMA(candles: Candle[], period: number): number[] {
  const vols = candles.map(c => c.volume ?? 0);
  return calcSMA(vols, period);
}

export const regimeBlockCounters = { gvzTrend: 0, gvzRange: 0, cotTrend: 0, sgeTrend: 0, hmmTrend: 0, hmmRange: 0, wouldBeTrend: 0, wouldBeRange: 0 };

export function classifyRegime(
  row: EnrichedCandle,
  avgAtrH4: number,
  rangeHigh: number,
  rangeLow: number,
  compressionThreshold: number,
  expansionThreshold: number,
  midpointBandPct: number,
  gvzConfig?: { enabled: boolean; rangeThreshold: number; trendThreshold: number },
  cotConfig?: { enabled: boolean; bullishThreshold: number; bearishThreshold: number },
  sgeConfig?: { enabled: boolean; bullishThreshold: number; bearishThreshold: number },
  hmmConfig?: { enabled: boolean; confidenceThreshold: number },
  mrsGarchConfig?: { enabled: boolean; volScaling: boolean; highVolThreshold: number; lowVolThreshold: number }
): RegimeState {
  const price = row.close;
  const atrH4 = row.atr_h4;
  const bbWidth = row.bb_width_h4;
  const bbPercentile = row.bb_width_percentile ?? 50;
  const adxH4 = row.adx_h4;
  const gvzPct = row.gvz_percentile ?? 50;
  const cotPct = row.cot_net_pct ?? 50;
  const sgePrem = row.sge_premium ?? 0;
  const hasGVZ = !isNaN(row.gvz) && gvzConfig?.enabled;
  const hasCOT = (row.cot_net !== 0 || row.cot_net_pct !== 50) && cotConfig?.enabled;
  const hasSGE = sgePrem !== 0 && sgeConfig?.enabled;
  const hasHMM = hmmConfig?.enabled && row.hmm_state && (row.hmm_confidence ?? 0) >= (hmmConfig?.confidenceThreshold ?? 0.6);
  const rangeWidth = rangeHigh - rangeLow;

  if (isNaN(atrH4) || isNaN(avgAtrH4) || avgAtrH4 <= 0 || rangeWidth <= 0) {
    return "no_trade";
  }

  const mid = (rangeHigh + rangeLow) / 2;
  const band = rangeWidth * midpointBandPct;
  const inMidpoint = price >= mid - band && price <= mid + band;

  const atrExpanding = atrH4 > avgAtrH4 * expansionThreshold;
  const priceAboveRange = price > rangeHigh;
  const priceBelowRange = price < rangeLow;

  if (atrExpanding && (priceAboveRange || priceBelowRange)) {
    regimeBlockCounters.wouldBeTrend++;
    if (hasGVZ && gvzPct < (gvzConfig!.rangeThreshold)) {
      regimeBlockCounters.gvzTrend++;
      return "no_trade";
    }
    if (hasCOT && cotPct < (cotConfig!.bearishThreshold) && priceAboveRange) {
      regimeBlockCounters.cotTrend++;
      return "no_trade";
    }
    if (hasCOT && cotPct > (cotConfig!.bullishThreshold) && priceBelowRange) {
      regimeBlockCounters.cotTrend++;
      return "no_trade";
    }
    if (hasSGE && sgePrem < (sgeConfig!.bearishThreshold) && priceAboveRange) {
      regimeBlockCounters.sgeTrend++;
      return "no_trade";
    }
    if (hasSGE && sgePrem > (sgeConfig!.bullishThreshold) && priceBelowRange) {
      regimeBlockCounters.sgeTrend++;
      return "no_trade";
    }
    if (hasHMM && row.hmm_state === "low_vol") {
      regimeBlockCounters.hmmTrend++;
      return "no_trade";
    }
    return "trend";
  }

  if (inMidpoint) {
    return "no_trade";
  }

  const compressed = !isNaN(bbWidth) && bbWidth < compressionThreshold;
  const atrFlat = !atrExpanding;
  const priceInsideRange = price >= rangeLow && price <= rangeHigh;

  if (atrFlat && priceInsideRange && (compressed || atrH4 <= avgAtrH4)) {
    regimeBlockCounters.wouldBeRange++;
    if (hasGVZ && gvzPct > (gvzConfig!.trendThreshold)) {
      regimeBlockCounters.gvzRange++;
      return "no_trade";
    }
    if (hasHMM && row.hmm_state === "high_vol") {
      regimeBlockCounters.hmmRange++;
      return "no_trade";
    }
    return "range";
  }

  return "no_trade";
}
