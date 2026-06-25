import { randomUUID } from "crypto";
import type {
  BacktestConfig, BacktestResult, BacktestStats, BacktestDiagnostics,
  Candle, EquityPoint, Trade, UploadedData,
  HourlyPerformance, DayOfWeekPerformance,
} from "../shared/schema";
import { addFeatures, classifyRegime, calcATR } from "./regime-engine";
import { inSession, inEntryWindow, eventBlackout, midpointBlock, isBearishRejection, isBullishRejection, isGapBar, isSessionOpenCandle, buildORB, orbAligns, inPeakHours, inAvoidHours, type SessionORB } from "./filters";

function getParentH1Timestamp(ts: string): string {
  const d = new Date(ts);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function buildMultiTFData(
  execCandles: Candle[],
  h1Features: import("../shared/schema").EnrichedCandle[],
): import("../shared/schema").EnrichedCandle[] {
  const featureMap = new Map<string, import("../shared/schema").EnrichedCandle>();
  for (const f of h1Features) {
    featureMap.set(f.timestamp, f);
  }

  const result: import("../shared/schema").EnrichedCandle[] = [];
  let lastFeatures: import("../shared/schema").EnrichedCandle | null = null;

  for (const candle of execCandles) {
    const parentTs = getParentH1Timestamp(candle.timestamp);
    const features: import("../shared/schema").EnrichedCandle | undefined = featureMap.get(parentTs) ?? lastFeatures ?? undefined;
    if (!features) continue;
    lastFeatures = features;

    result.push({
      timestamp: candle.timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      atr_h1: features.atr_h1,
      atr_h4: features.atr_h4,
      ema_daily: features.ema_daily,
      ema_daily_200: features.ema_daily_200,
      daily_close: features.daily_close,
      bb_width_h4: features.bb_width_h4,
      bb_width_percentile: features.bb_width_percentile,
      vp_poc: features.vp_poc,
      vp_vah: features.vp_vah,
      vp_val: features.vp_val,
      adx_h4: features.adx_h4,
      gvz: features.gvz,
      gvz_percentile: features.gvz_percentile,
      cot_net: features.cot_net,
      cot_net_pct: features.cot_net_pct,
      hmm_state: features.hmm_state,
      hmm_confidence: features.hmm_confidence,
      garch_volatility: features.garch_volatility,
      garch_forecast: features.garch_forecast,
      mrs_position_multiplier: features.mrs_position_multiplier,
      sge_premium: features.sge_premium ?? 0,
    });
  }
  return result;
}

export function runBacktest(
  config: BacktestConfig,
  uploadedData?: UploadedData
): BacktestResult {
  let h1: Candle[], h4: Candle[], daily: Candle[];
  let m15: Candle[] = [], m1: Candle[] = [];
  let events: { timestamp: string }[] | undefined;
  let dataSource: "real" | "synthetic";

  if (uploadedData && uploadedData.h1.length > 0 && uploadedData.h4.length > 0 && uploadedData.daily.length > 0) {
    h1 = uploadedData.h1;
    h4 = uploadedData.h4;
    daily = uploadedData.daily;
    events = uploadedData.events;
    m15 = uploadedData.m15 ?? [];
    m1 = uploadedData.m1 ?? [];
    dataSource = "real";
  } else {
    throw new Error("No market data available. Fetch live data or upload CSV files before running a backtest.");
  }

  const fullH1 = h1;
  const fullH4 = h4;
  const fullDaily = daily;

  if (config.endDate) {
    const endMs = new Date(config.endDate + "T23:59:59Z").getTime();
    h1 = h1.filter(c => new Date(c.timestamp).getTime() <= endMs);
    h4 = h4.filter(c => new Date(c.timestamp).getTime() <= endMs);
    daily = daily.filter(c => new Date(c.timestamp).getTime() <= endMs);
    m15 = m15.filter(c => new Date(c.timestamp).getTime() <= endMs);
    m1 = m1.filter(c => new Date(c.timestamp).getTime() <= endMs);
  }

  if (config.startDate) {
    const startMs = new Date(config.startDate).getTime();
    m15 = m15.filter(c => new Date(c.timestamp).getTime() >= startMs);
    m1 = m1.filter(c => new Date(c.timestamp).getTime() >= startMs);
  }

  const execTF = config.executionTimeframe ?? "1h";

  const gvzData = uploadedData?.gvz;
  const cotData = uploadedData?.cot;
  const sgeData = uploadedData?.sge;
  const vpConfig = config.volumeProfileEnabled ? {
    enabled: true,
    period: config.volumeProfilePeriod ?? 50,
    bins: config.volumeProfileBins ?? 24,
    valueAreaPct: config.volumeProfileValueAreaPct ?? 70,
  } : undefined;
  const h1Enriched = addFeatures(h1, fullH4, fullDaily, config.atrPeriod, 50, gvzData, cotData, vpConfig, sgeData);

  const atrStopPeriod = config.atrStopPeriod ?? 10;
  const h1AtrForStops = calcATR(h1, atrStopPeriod);
  const h1StopAtrMap = new Map<string, number>();
  for (let i = 0; i < h1.length; i++) {
    h1StopAtrMap.set(h1[i].timestamp, h1AtrForStops[i]);
  }

  let data: import("../shared/schema").EnrichedCandle[];
  if (execTF === "15min" && m15.length > 0) {
    data = buildMultiTFData(m15, h1Enriched);
  } else if (execTF === "1min" && m1.length > 0) {
    data = buildMultiTFData(m1, h1Enriched);
  } else {
    data = h1Enriched;
  }

  let balance = config.startingBalance;
  let peak = config.startingBalance;
  let openTrade: {
    entryTime: string;
    side: "buy" | "sell";
    entry: number;
    stop: number;
    originalStop: number;
    target: number;
    regime: "range" | "trend";
    entryReason: string;
    entryIndex: number;
    atrAtEntry: number;
    rangeHigh: number;
    rangeLow: number;
    rangeMid: number;
    wickSize: number;
    bodySize: number;
    wickToBodyRatio: number;
    signalType: string;
    lotSize: number;
    trailedToBreakeven: boolean;
  } | null = null;

  const trades: Trade[] = [];
  const regimeCounts = { range: 0, trend: 0, no_trade: 0 };
  const dailyTradeCounter: Record<string, number> = {};
  const dailyLossTracker: Record<string, number> = {};

  let consecutiveLosses = 0;
  let cooldownBarsRemaining = 0;
  let lastTradeWasLoss = false;

  const diagnostics: BacktestDiagnostics = {
    blockedBySession: 0,
    blockedByNews: 0,
    blockedByGap: 0,
    blockedByMidpointBand: 0,
    blockedByRetestDistance: 0,
    blockedByNarrowRange: 0,
    blockedByExtremeATR: 0,
    blockedByWickRatio: 0,
    blockedByCompression: 0,
    blockedByExpansion: 0,
    blockedByEntryWindow: 0,
    blockedByPeakHours: 0,
    blockedByAvoidHours: 0,
    blockedByVolumeProfile: 0,
    blockedByMaxTradesPerDay: 0,
    blockedByMaxDrawdown: 0,
    blockedByDailyLossLimit: 0,
    blockedByConsecutiveLossLimit: 0,
    reducedSizeAfterLossCount: 0,
    atrScaledRiskCount: 0,
    secondTradeReducedRiskCount: 0,
    buyCandidates: 0,
    sellCandidates: 0,
    acceptedBuyTrades: 0,
    acceptedSellTrades: 0,
  };

  let gapCooldownRemaining = 0;
  let currentORB: SessionORB | null = null;

  const h4Times = fullH4.map(c => new Date(c.timestamp).getTime());
  const h4TRs: number[] = fullH4.map((c, j) =>
    j === 0 ? c.high - c.low
    : Math.max(c.high - c.low, Math.abs(c.high - fullH4[j-1].close), Math.abs(c.low - fullH4[j-1].close))
  );
  let startIdx = Math.max(100, config.rangeWidthBars);

  if (config.startDate) {
    const startMs = new Date(config.startDate).getTime();
    for (let j = startIdx; j < data.length; j++) {
      if (new Date(data[j].timestamp).getTime() >= startMs) {
        startIdx = j;
        break;
      }
    }
  }

  let h4Ptr = 0;

  for (let i = startIdx; i < data.length; i++) {
    const row = data[i];
    const ts = row.timestamp;
    const dayKey = ts.substring(0, 10);

    if (openTrade) {
      if (config.trailingStopEnabled && !openTrade.trailedToBreakeven) {
        const riskDistance = Math.abs(openTrade.entry - openTrade.originalStop);
        const triggerDistance = riskDistance * config.trailingStopTriggerR;
        if (openTrade.side === "buy") {
          if (row.high >= openTrade.entry + triggerDistance) {
            openTrade.stop = openTrade.entry;
            openTrade.trailedToBreakeven = true;
          }
        } else {
          if (row.low <= openTrade.entry - triggerDistance) {
            openTrade.stop = openTrade.entry;
            openTrade.trailedToBreakeven = true;
          }
        }
      }

      let exitPrice: number | null = null;
      let reason: "stop" | "target" | null = null;

      if (openTrade.side === "buy") {
        if (row.low <= openTrade.stop) {
          exitPrice = openTrade.stop;
          reason = "stop";
        } else if (row.high >= openTrade.target) {
          exitPrice = openTrade.target;
          reason = "target";
        }
      } else {
        if (row.high >= openTrade.stop) {
          exitPrice = openTrade.stop;
          reason = "stop";
        } else if (row.low <= openTrade.target) {
          exitPrice = openTrade.target;
          reason = "target";
        }
      }

      if (exitPrice !== null && reason !== null) {
        let pnl = (exitPrice - openTrade.entry) * openTrade.lotSize;
        if (openTrade.side === "sell") pnl *= -1;
        const commissionCost = (config.commissionPerLot ?? 0) * openTrade.lotSize;
        pnl -= commissionCost;
        balance += pnl;
        if (balance > peak) peak = balance;

        const riskDollars = Math.abs(openTrade.entry - openTrade.originalStop) * openTrade.lotSize;
        const resultR = riskDollars > 0 ? pnl / riskDollars : 0;

        const exitDayKey = ts.substring(0, 10);
        if (pnl < 0) {
          dailyLossTracker[exitDayKey] = (dailyLossTracker[exitDayKey] ?? 0) + Math.abs(pnl);
          consecutiveLosses++;
          lastTradeWasLoss = true;
          if (consecutiveLosses >= config.maxConsecutiveLosses) {
            cooldownBarsRemaining = config.postLossCooldownBars;
          }
        } else {
          consecutiveLosses = 0;
          lastTradeWasLoss = false;
        }

        trades.push({
          id: randomUUID(),
          entryTime: openTrade.entryTime,
          exitTime: ts,
          side: openTrade.side,
          regime: openTrade.regime,
          entryReason: openTrade.entryReason,
          exitReason: reason,
          entryPrice: +openTrade.entry.toFixed(2),
          exitPrice: +exitPrice.toFixed(2),
          stopLoss: +openTrade.stop.toFixed(2),
          takeProfit: +openTrade.target.toFixed(2),
          pnl: +pnl.toFixed(2),
          resultR: +resultR.toFixed(2),
          balance: +balance.toFixed(2),
          atrAtEntry: +openTrade.atrAtEntry.toFixed(2),
          rangeHigh: +openTrade.rangeHigh.toFixed(2),
          rangeLow: +openTrade.rangeLow.toFixed(2),
          rangeMid: +openTrade.rangeMid.toFixed(2),
          wickSize: +openTrade.wickSize.toFixed(2),
          bodySize: +openTrade.bodySize.toFixed(2),
          wickToBodyRatio: +openTrade.wickToBodyRatio.toFixed(2),
          signalType: openTrade.signalType,
        });
        openTrade = null;
      }
    }

    if (openTrade) continue;

    if (config.gapFilterEnabled && i > 0) {
      if (isGapBar(row, data[i - 1], row.atr_h1, config.gapThresholdAtr)) {
        gapCooldownRemaining = config.gapCooldownBars;
      }
    }

    if (config.sessionORBEnabled) {
      if (isSessionOpenCandle(ts, config.sessionMode)) {
        currentORB = buildORB(row);
      }
      if (currentORB && currentORB.dayKey !== dayKey) {
        currentORB = null;
      }
    }

    if ((dailyTradeCounter[dayKey] ?? 0) >= config.maxTradesPerDay) {
      diagnostics.blockedByMaxTradesPerDay++;
      continue;
    }

    if (!inSession(ts, config.sessionMode)) {
      diagnostics.blockedBySession++;
      regimeCounts.no_trade++;
      continue;
    }

    if (config.entryWindowBars > 0 && !inEntryWindow(ts, config.sessionMode, config.entryWindowBars)) {
      diagnostics.blockedByEntryWindow++;
      regimeCounts.no_trade++;
      continue;
    }

    if (config.avoidHoursEnabled && config.avoidHoursUTC && config.avoidHoursUTC.length > 0 && inAvoidHours(ts, config.avoidHoursUTC)) {
      diagnostics.blockedByAvoidHours++;
      regimeCounts.no_trade++;
      continue;
    }

    if (config.peakHoursEnabled && config.peakHoursUTC && config.peakHoursUTC.length > 0 && !inPeakHours(ts, config.peakHoursUTC)) {
      diagnostics.blockedByPeakHours++;
      regimeCounts.no_trade++;
      continue;
    }

    if (eventBlackout(ts, events, config.newsBeforeMin, config.newsAfterMin)) {
      diagnostics.blockedByNews++;
      regimeCounts.no_trade++;
      continue;
    }

    if (config.gapFilterEnabled && gapCooldownRemaining > 0) {
      gapCooldownRemaining--;
      diagnostics.blockedByGap++;
      regimeCounts.no_trade++;
      continue;
    }

    if (config.sessionORBEnabled && !currentORB) {
      regimeCounts.no_trade++;
      continue;
    }

    if (isNaN(row.atr_h1) || isNaN(row.atr_h4) || isNaN(row.ema_daily) || isNaN(row.daily_close)) {
      regimeCounts.no_trade++;
      continue;
    }

    const h1Time = new Date(ts).getTime();
    while (h4Ptr < h4Times.length - 1 && h4Times[h4Ptr + 1] <= h1Time) h4Ptr++;
    const h4End = h4Ptr + 1;

    const rangeOffset = 2;
    const rangeEnd = Math.max(0, h4End - rangeOffset);
    const rangeStart = Math.max(0, rangeEnd - config.rangeWidthBars);
    if (rangeEnd - rangeStart < config.rangeWidthBars) {
      regimeCounts.no_trade++;
      continue;
    }

    let rangeHigh = -Infinity, rangeLow = Infinity;
    for (let j = rangeStart; j < rangeEnd; j++) {
      if (fullH4[j].high > rangeHigh) rangeHigh = fullH4[j].high;
      if (fullH4[j].low < rangeLow) rangeLow = fullH4[j].low;
    }
    const rangeMid = (rangeHigh + rangeLow) / 2;

    const atrLookback = 50;
    const atrStart = Math.max(0, h4End - atrLookback);
    let avgAtrH4 = 0;
    let atrCount = 0;
    for (let j = atrStart; j < h4End; j++) {
      avgAtrH4 += h4TRs[j];
      atrCount++;
    }
    avgAtrH4 = atrCount > 0 ? avgAtrH4 / atrCount : 0;

    const regime = classifyRegime(
      row,
      avgAtrH4,
      rangeHigh,
      rangeLow,
      config.compressionThreshold,
      config.expansionThreshold,
      config.midpointBandPct,
      { enabled: config.gvzEnabled !== false, rangeThreshold: config.gvzRangeThreshold ?? 25, trendThreshold: config.gvzTrendThreshold ?? 75 },
      { enabled: config.cotEnabled !== false, bullishThreshold: config.cotBullishThreshold ?? 75, bearishThreshold: config.cotBearishThreshold ?? 25 },
      { enabled: config.sgeEnabled !== false, bullishThreshold: config.sgeBullishThreshold ?? 10, bearishThreshold: config.sgeBearishThreshold ?? -5 },
      { enabled: config.hmmEnabled !== false, confidenceThreshold: config.hmmConfidenceThreshold ?? 0.6 },
      { enabled: config.mrsGarchEnabled !== false, volScaling: config.mrsGarchVolScaling !== false, highVolThreshold: config.mrsGarchHighVolThreshold ?? 75, lowVolThreshold: config.mrsGarchLowVolThreshold ?? 25 },
    );
    regimeCounts[regime]++;

    if (regime === "no_trade") {
      const atrExpanding = row.atr_h4 > avgAtrH4 * config.expansionThreshold;
      const priceInside = row.close >= rangeLow && row.close <= rangeHigh;
      if (atrExpanding && priceInside) {
        diagnostics.blockedByExpansion++;
      } else if (!atrExpanding && priceInside) {
        const compressed = !isNaN(row.bb_width_h4) && row.bb_width_h4 < config.compressionThreshold;
        if (!compressed && row.atr_h4 > avgAtrH4) {
          diagnostics.blockedByCompression++;
        }
      }
      continue;
    }

    const currentDDPct = peak > 0 ? ((peak - balance) / peak) * 100 : 0;
    if (currentDDPct >= config.maxDrawdownPct) {
      diagnostics.blockedByMaxDrawdown++;
      continue;
    }

    const dailyLossSoFar = dailyLossTracker[dayKey] ?? 0;
    const dailyLossCapDollars = config.startingBalance * (config.maxDailyLossPct / 100);
    if (dailyLossSoFar >= dailyLossCapDollars) {
      diagnostics.blockedByDailyLossLimit++;
      continue;
    }

    if (cooldownBarsRemaining > 0) {
      cooldownBarsRemaining--;
      diagnostics.blockedByConsecutiveLossLimit++;
      continue;
    }

    const parentH1Ts = getParentH1Timestamp(ts);
    const stopAtr = h1StopAtrMap.get(parentH1Ts) ?? row.atr_h1;
    const stopDistance = (isNaN(stopAtr) ? row.atr_h1 : stopAtr) * config.atrStopMultiplier;
    if (stopDistance <= 0) continue;

    let effectiveRiskPct = config.riskPerTradePct;

    if (config.reduceSizeAfterLoss && lastTradeWasLoss) {
      effectiveRiskPct = config.reducedRiskPerTradePct;
      diagnostics.reducedSizeAfterLossCount++;
    }

    const dayTradesSoFar = dailyTradeCounter[dayKey] ?? 0;
    if (dayTradesSoFar >= 1) {
      effectiveRiskPct *= config.secondTradeRiskFactor;
      diagnostics.secondTradeReducedRiskCount++;
    }

    if (config.atrRiskScaleEnabled && avgAtrH4 > 0) {
      const atrRatio = row.atr_h4 / avgAtrH4;
      if (atrRatio > config.atrRiskScaleThreshold) {
        effectiveRiskPct *= config.atrRiskScaleFactor;
        diagnostics.atrScaledRiskCount++;
      }
    }

    if (config.regimeAdaptiveSizing && avgAtrH4 > 0 && row.atr_h4 > 0) {
      const adaptiveScale = Math.min(config.regimeAdaptiveSizingCap ?? 1.25, avgAtrH4 / row.atr_h4);
      effectiveRiskPct *= adaptiveScale;
    }

    if (config.mrsGarchEnabled !== false && config.mrsGarchVolScaling !== false && row.mrs_position_multiplier) {
      effectiveRiskPct *= row.mrs_position_multiplier;
    }

    const leverageMultiplier = config.leverage ?? 1;
    const riskDollarsPerTrade = balance * (effectiveRiskPct / 100);
    let tradeLotSize = stopDistance > 0 ? Math.max(0.01, +(riskDollarsPerTrade / stopDistance).toFixed(2)) : config.lotSize;
    const maxLotsByMargin = (balance * leverageMultiplier) / row.close;
    if (tradeLotSize > maxLotsByMargin) tradeLotSize = Math.max(0.01, +maxLotsByMargin.toFixed(2));

    if (midpointBlock(row.close, rangeHigh, rangeLow, config.midpointBandPct)) {
      diagnostics.blockedByMidpointBand++;
      continue;
    }

    const bullishBias50 = row.daily_close > row.ema_daily;
    const bearishBias50 = row.daily_close < row.ema_daily;
    const ema200Valid = !isNaN(row.ema_daily_200) && row.ema_daily_200 > 0;
    const bullishBias200 = ema200Valid ? row.daily_close > row.ema_daily_200 : true;
    const bearishBias200 = ema200Valid ? row.daily_close < row.ema_daily_200 : true;
    const useEma200 = config.ema200FilterEnabled !== false;
    const bullishBias = useEma200 ? (bullishBias50 && bullishBias200) : bullishBias50;
    const bearishBias = useEma200 ? (bearishBias50 && bearishBias200) : bearishBias50;
    const prevClose = data[i - 1].close;
    const curr = row;

    const body = Math.abs(curr.close - curr.open);
    const upperWick = curr.high - Math.max(curr.open, curr.close);
    const lowerWick = Math.min(curr.open, curr.close) - curr.low;

    const halfSpread = (config.spreadPoints ?? 0) / 2;
    const slippage = config.slippagePoints ?? 0;
    const entryCostBuy = halfSpread + slippage;
    const entryCostSell = halfSpread + slippage;

    const vpEnabled = config.volumeProfileEnabled && row.vp_poc > 0;
    const vpPocProx = config.vpPocProximityPct ?? 0.15;

    if (regime === "range") {
      const rangeWidth = rangeHigh - rangeLow;
      if (config.minRangeATR > 0 && row.atr_h1 > 0 && rangeWidth < row.atr_h1 * config.minRangeATR) {
        diagnostics.blockedByNarrowRange++;
        continue;
      }

      if (vpEnabled) {
        const pocDist = Math.abs(row.close - row.vp_poc);
        const vpRange = row.vp_vah - row.vp_val;
        if (vpRange > 0 && pocDist / vpRange < vpPocProx) {
          diagnostics.blockedByVolumeProfile++;
          continue;
        }
      }

      const nearResistance = curr.high >= rangeHigh - config.retestBuffer;
      const nearSupport = curr.low <= rangeLow + config.retestBuffer;

      if (nearResistance && (bearishBias || !bullishBias)) {
        diagnostics.sellCandidates++;
        if (!isBearishRejection(curr, config.wickRatio)) {
          diagnostics.blockedByWickRatio++;
        } else if (config.sessionORBEnabled && !orbAligns(currentORB, "sell")) {
        } else {
          const entry = curr.close - entryCostSell;
          const stop = entry + stopDistance;
          const target = entry - stopDistance * config.rewardRatio;
          openTrade = {
            entryTime: ts,
            side: "sell",
            entry,
            stop,
            originalStop: stop,
            target,
            regime: "range",
            entryReason: "range_resistance_rejection",
            entryIndex: i,
            atrAtEntry: row.atr_h1,
            rangeHigh,
            rangeLow,
            rangeMid,
            wickSize: +upperWick.toFixed(2),
            bodySize: +body.toFixed(2),
            wickToBodyRatio: body > 0 ? +(upperWick / body).toFixed(2) : 0,
            signalType: "range_sell",
            lotSize: tradeLotSize,
            trailedToBreakeven: false,
          };
          diagnostics.acceptedSellTrades++;
          dailyTradeCounter[dayKey] = (dailyTradeCounter[dayKey] ?? 0) + 1;
          continue;
        }
      } else if (nearResistance) {
      } else if (!nearResistance && !nearSupport) {
        diagnostics.blockedByRetestDistance++;
      }

      if (nearSupport && (bullishBias || !bearishBias)) {
        diagnostics.buyCandidates++;
        if (!isBullishRejection(curr, config.wickRatio)) {
          diagnostics.blockedByWickRatio++;
        } else if (config.sessionORBEnabled && !orbAligns(currentORB, "buy")) {
        } else {
          const entry = curr.close + entryCostBuy;
          const stop = entry - stopDistance;
          const target = entry + stopDistance * config.rewardRatio;
          openTrade = {
            entryTime: ts,
            side: "buy",
            entry,
            stop,
            originalStop: stop,
            target,
            regime: "range",
            entryReason: "range_support_rejection",
            entryIndex: i,
            atrAtEntry: row.atr_h1,
            rangeHigh,
            rangeLow,
            rangeMid,
            wickSize: +lowerWick.toFixed(2),
            bodySize: +body.toFixed(2),
            wickToBodyRatio: body > 0 ? +(lowerWick / body).toFixed(2) : 0,
            signalType: "range_buy",
            lotSize: tradeLotSize,
            trailedToBreakeven: false,
          };
          diagnostics.acceptedBuyTrades++;
          dailyTradeCounter[dayKey] = (dailyTradeCounter[dayKey] ?? 0) + 1;
          continue;
        }
      } else if (nearSupport) {
      } else if (!nearSupport && !nearResistance) {
      }
    }

    if (regime === "trend") {
      if (config.maxTrendATRRatio > 0 && avgAtrH4 > 0 && row.atr_h4 / avgAtrH4 > config.maxTrendATRRatio) {
        diagnostics.blockedByExtremeATR++;
        continue;
      }

      if (vpEnabled) {
        const buyBreakout = curr.close > rangeHigh && curr.close < row.vp_vah;
        const sellBreakout = curr.close < rangeLow && curr.close > row.vp_val;
        if (buyBreakout || sellBreakout) {
          diagnostics.blockedByVolumeProfile++;
          continue;
        }
      }

      const priceAboveRange = curr.close > rangeHigh;
      const priceBelowRange = curr.close < rangeLow;
      const rangeWidth = rangeHigh - rangeLow;
      const strongBreakout = rangeWidth > 0 && (
        (priceAboveRange && (curr.close - rangeHigh) > rangeWidth * 0.1) ||
        (priceBelowRange && (rangeLow - curr.close) > rangeWidth * 0.1)
      );

      if (priceAboveRange && (bullishBias || strongBreakout)) {
        diagnostics.buyCandidates++;
        const accepted = curr.low >= rangeHigh - config.retestBuffer;
        if (!accepted) {
          diagnostics.blockedByRetestDistance++;
        } else if (config.sessionORBEnabled && !orbAligns(currentORB, "buy")) {
        } else {
          const entry = curr.close + entryCostBuy;
          const stop = entry - stopDistance;
          const target = entry + stopDistance * config.rewardRatio;
          openTrade = {
            entryTime: ts,
            side: "buy",
            entry,
            stop,
            originalStop: stop,
            target,
            regime: "trend",
            entryReason: strongBreakout && !bullishBias ? "trend_momentum_long" : "trend_breakout_acceptance_long",
            entryIndex: i,
            atrAtEntry: row.atr_h1,
            rangeHigh,
            rangeLow,
            rangeMid,
            wickSize: +lowerWick.toFixed(2),
            bodySize: +body.toFixed(2),
            wickToBodyRatio: body > 0 ? +(lowerWick / body).toFixed(2) : 0,
            signalType: "trend_long",
            lotSize: tradeLotSize,
            trailedToBreakeven: false,
          };
          diagnostics.acceptedBuyTrades++;
          dailyTradeCounter[dayKey] = (dailyTradeCounter[dayKey] ?? 0) + 1;
          continue;
        }
      }

      if (priceBelowRange && (bearishBias || strongBreakout)) {
        diagnostics.sellCandidates++;
        const accepted = curr.high <= rangeLow + config.retestBuffer;
        if (!accepted) {
          diagnostics.blockedByRetestDistance++;
        } else if (config.sessionORBEnabled && !orbAligns(currentORB, "sell")) {
        } else {
          const entry = curr.close - entryCostSell;
          const stop = entry + stopDistance;
          const target = entry - stopDistance * config.rewardRatio;
          openTrade = {
            entryTime: ts,
            side: "sell",
            entry,
            stop,
            originalStop: stop,
            target,
            regime: "trend",
            entryReason: strongBreakout && !bearishBias ? "trend_momentum_short" : "trend_breakout_acceptance_short",
            entryIndex: i,
            atrAtEntry: row.atr_h1,
            rangeHigh,
            rangeLow,
            rangeMid,
            wickSize: +upperWick.toFixed(2),
            bodySize: +body.toFixed(2),
            wickToBodyRatio: body > 0 ? +(upperWick / body).toFixed(2) : 0,
            signalType: "trend_short",
            lotSize: tradeLotSize,
            trailedToBreakeven: false,
          };
          diagnostics.acceptedSellTrades++;
          dailyTradeCounter[dayKey] = (dailyTradeCounter[dayKey] ?? 0) + 1;
          continue;
        }
      }
    }
  }

  const equityCurve: EquityPoint[] = [];
  let runBal = config.startingBalance;
  let eqPeak = config.startingBalance;
  let maxDD = 0;
  let maxDDPct = 0;

  equityCurve.push({ time: data[0]?.timestamp?.substring(0, 10) ?? "", balance: runBal, drawdown: 0, drawdownPct: 0, tradeIndex: 0 });

  for (let t = 0; t < trades.length; t++) {
    runBal = trades[t].balance;
    if (runBal > eqPeak) eqPeak = runBal;
    const dd = eqPeak - runBal;
    const ddPct = eqPeak > 0 ? (dd / eqPeak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
    if (ddPct > maxDDPct) maxDDPct = ddPct;
    equityCurve.push({
      time: trades[t].exitTime.substring(0, 10),
      balance: +runBal.toFixed(2),
      drawdown: +dd.toFixed(2),
      drawdownPct: +ddPct.toFixed(2),
      tradeIndex: t + 1,
    });
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const rangeTrades = trades.filter((t) => t.regime === "range");
  const trendTrades = trades.filter((t) => t.regime === "trend");
  const rangeWins = rangeTrades.filter((t) => t.pnl > 0);
  const rangeLosses = rangeTrades.filter((t) => t.pnl <= 0);
  const trendWins = trendTrades.filter((t) => t.pnl > 0);
  const trendLosses = trendTrades.filter((t) => t.pnl <= 0);

  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : grossWin > 0 ? 999 : 0;
  const netPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgR = trades.length > 0 ? +(trades.reduce((s, t) => s + t.resultR, 0) / trades.length).toFixed(2) : 0;

  let maxConsecW = 0, maxConsecL = 0, cw = 0, cl = 0;
  for (const t of trades) {
    if (t.pnl > 0) { cw++; cl = 0; maxConsecW = Math.max(maxConsecW, cw); }
    else { cl++; cw = 0; maxConsecL = Math.max(maxConsecL, cl); }
  }

  const monthMap = new Map<string, { pnl: number; trades: number }>();
  for (const t of trades) {
    const month = t.exitTime.substring(0, 7);
    const ex = monthMap.get(month) ?? { pnl: 0, trades: 0 };
    monthMap.set(month, { pnl: ex.pnl + t.pnl, trades: ex.trades + 1 });
  }
  const monthlyReturns = Array.from(monthMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, d]) => ({
      month,
      return: +((d.pnl / config.startingBalance) * 100).toFixed(2),
      trades: d.trades,
    }));

  const stats: BacktestStats = {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? +(wins.length / trades.length * 100).toFixed(1) : 0,
    netPnl: +netPnl.toFixed(2),
    returnPct: +((netPnl / config.startingBalance) * 100).toFixed(2),
    profitFactor,
    maxDrawdown: +maxDD.toFixed(2),
    maxDrawdownPct: +maxDDPct.toFixed(2),
    avgR,
    rangeTrades: rangeTrades.length,
    trendTrades: trendTrades.length,
    noTradeBarCount: regimeCounts.no_trade,
    rangeWins: rangeWins.length,
    rangeLosses: rangeLosses.length,
    trendWins: trendWins.length,
    trendLosses: trendLosses.length,
    rangePnl: +rangeTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2),
    trendPnl: +trendTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2),
    rangeWinRate: rangeTrades.length > 0 ? +(rangeWins.length / rangeTrades.length * 100).toFixed(1) : 0,
    trendWinRate: trendTrades.length > 0 ? +(trendWins.length / trendTrades.length * 100).toFixed(1) : 0,
    finalBalance: +balance.toFixed(2),
    avgHoldingBars: trades.length > 0
      ? Math.round(trades.reduce((sum, t) => {
          const entry = new Date(t.entryTime).getTime();
          const exit = new Date(t.exitTime).getTime();
          return sum + (exit - entry) / (60 * 60 * 1000);
        }, 0) / trades.length)
      : 0,
    consecutiveWins: maxConsecW,
    consecutiveLosses: maxConsecL,
  };

  const hourlyMap = new Map<number, { trades: number; wins: number; losses: number; pnl: number; totalR: number; rangeTrades: number; trendTrades: number }>();
  for (let h = 0; h < 24; h++) hourlyMap.set(h, { trades: 0, wins: 0, losses: 0, pnl: 0, totalR: 0, rangeTrades: 0, trendTrades: 0 });
  for (const t of trades) {
    const entryHour = new Date(t.entryTime).getUTCHours();
    const bucket = hourlyMap.get(entryHour)!;
    bucket.trades++;
    if (t.pnl > 0) bucket.wins++; else bucket.losses++;
    bucket.pnl += t.pnl;
    bucket.totalR += t.resultR;
    if (t.regime === "range") bucket.rangeTrades++; else if (t.regime === "trend") bucket.trendTrades++;
  }
  const hourlyPerformance: HourlyPerformance[] = Array.from(hourlyMap.entries())
    .filter(([_, d]) => d.trades > 0)
    .map(([hour, d]) => ({
      hour,
      trades: d.trades,
      wins: d.wins,
      losses: d.losses,
      winRate: +(d.wins / d.trades * 100).toFixed(1),
      pnl: +d.pnl.toFixed(2),
      avgR: +(d.totalR / d.trades).toFixed(2),
      rangeTrades: d.rangeTrades,
      trendTrades: d.trendTrades,
    }))
    .sort((a, b) => a.hour - b.hour);

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dowMap = new Map<number, { trades: number; wins: number; losses: number; pnl: number; totalR: number }>();
  for (let d = 0; d < 7; d++) dowMap.set(d, { trades: 0, wins: 0, losses: 0, pnl: 0, totalR: 0 });
  for (const t of trades) {
    const dow = new Date(t.entryTime).getUTCDay();
    const bucket = dowMap.get(dow)!;
    bucket.trades++;
    if (t.pnl > 0) bucket.wins++; else bucket.losses++;
    bucket.pnl += t.pnl;
    bucket.totalR += t.resultR;
  }
  const dayOfWeekPerformance: DayOfWeekPerformance[] = Array.from(dowMap.entries())
    .filter(([_, d]) => d.trades > 0)
    .map(([day, d]) => ({
      day,
      dayName: dayNames[day],
      trades: d.trades,
      wins: d.wins,
      losses: d.losses,
      winRate: +(d.wins / d.trades * 100).toFixed(1),
      pnl: +d.pnl.toFixed(2),
      avgR: +(d.totalR / d.trades).toFixed(2),
    }))
    .sort((a, b) => a.day - b.day);

  const effectiveConfig = { ...config };
  if (!effectiveConfig.startDate && data.length > startIdx) {
    effectiveConfig.startDate = data[startIdx].timestamp.substring(0, 10);
  }
  if (!effectiveConfig.endDate && data.length > 0) {
    effectiveConfig.endDate = data[data.length - 1].timestamp.substring(0, 10);
  }

  return {
    id: randomUUID(),
    config: effectiveConfig,
    trades,
    stats,
    equityCurve,
    regimeCounts,
    monthlyReturns,
    hourlyPerformance,
    dayOfWeekPerformance,
    diagnostics,
    dataSource,
    createdAt: new Date().toISOString(),
  };
}
