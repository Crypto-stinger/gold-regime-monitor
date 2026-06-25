import { randomUUID } from "crypto";
import type {
  BacktestConfig, BacktestResult, BacktestStats, BacktestDiagnostics,
  Candle, EquityPoint, Trade,
  HourlyPerformance, DayOfWeekPerformance, UploadedData,
} from "../shared/schema";
import { calcATR, calcRSI } from "./regime-engine";
import { inSession } from "./filters";

export function runRSIBacktest(
  config: BacktestConfig,
  uploadedData?: UploadedData
): BacktestResult {
  let h1: Candle[], h4: Candle[], daily: Candle[];
  let m15: Candle[] = [], m1: Candle[] = [];
  let dataSource: "real" | "synthetic";

  if (uploadedData && uploadedData.h1.length > 0 && uploadedData.h4.length > 0 && uploadedData.daily.length > 0) {
    h1 = uploadedData.h1;
    h4 = uploadedData.h4;
    daily = uploadedData.daily;
    m15 = uploadedData.m15 ?? [];
    m1 = uploadedData.m1 ?? [];
    dataSource = "real";
  } else {
    throw new Error("No market data available. Fetch live data or upload CSV files before running a backtest.");
  }

  if (config.startDate) {
    const startMs = new Date(config.startDate).getTime();
    h1 = h1.filter(c => new Date(c.timestamp).getTime() >= startMs);
    h4 = h4.filter(c => new Date(c.timestamp).getTime() >= startMs);
    daily = daily.filter(c => new Date(c.timestamp).getTime() >= startMs);
    m15 = m15.filter(c => new Date(c.timestamp).getTime() >= startMs);
    m1 = m1.filter(c => new Date(c.timestamp).getTime() >= startMs);
  }
  if (config.endDate) {
    const endMs = new Date(config.endDate + "T23:59:59Z").getTime();
    h1 = h1.filter(c => new Date(c.timestamp).getTime() <= endMs);
    h4 = h4.filter(c => new Date(c.timestamp).getTime() <= endMs);
    daily = daily.filter(c => new Date(c.timestamp).getTime() <= endMs);
    m15 = m15.filter(c => new Date(c.timestamp).getTime() <= endMs);
    m1 = m1.filter(c => new Date(c.timestamp).getTime() <= endMs);
  }

  const execTF = config.executionTimeframe ?? "1h";
  let candles: Candle[];
  if (execTF === "15min" && m15.length > 0) {
    candles = m15;
  } else if (execTF === "1min" && m1.length > 0) {
    candles = m1;
  } else {
    candles = h1;
  }

  const rsiPeriod = config.rsiPeriod ?? 14;
  const rsiOverbought = config.rsiOverbought ?? 70;
  const rsiOversold = config.rsiOversold ?? 30;
  const atrMultiplier = config.atrStopMultiplier ?? 2.0;
  const rsiRewardRatio = config.rsiRewardRatio ?? 0;
  const maxDailyLossUSD = config.maxDailyLossUSD ?? 500;
  const riskPerTradePct = config.riskPerTradePct ?? 1.0;
  const leverageMultiplier = config.leverage ?? 1;

  const closes = candles.map(c => c.close);
  const rsiValues = calcRSI(closes, rsiPeriod);
  const atrValues = calcATR(candles, config.atrPeriod ?? 14);

  let balance = config.startingBalance;
  let peak = config.startingBalance;

  let openTrade: {
    entryTime: string;
    side: "buy" | "sell";
    entry: number;
    stop: number;
    target: number;
    entryReason: string;
    atrAtEntry: number;
    lotSize: number;
  } | null = null;

  const trades: Trade[] = [];
  const dailyLossTracker: Record<string, number> = {};
  const dailyTradeCounter: Record<string, number> = {};
  let consecutiveLosses = 0;
  let lastTradeWasLoss = false;
  let cooldownBarsRemaining = 0;

  const diagnostics: BacktestDiagnostics = {
    blockedBySession: 0,
    blockedByNews: 0,
    blockedByGap: 0,
    blockedByMidpointBand: 0,
    blockedByRetestDistance: 0,
    blockedByWickRatio: 0,
    blockedByCompression: 0,
    blockedByExpansion: 0,
    blockedByEntryWindow: 0,
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
    blockedByNarrowRange: 0,
    blockedByExtremeATR: 0,
    blockedByPeakHours: 0,
    blockedByAvoidHours: 0,
    blockedByVolumeProfile: 0,
  };

  const regimeCounts = { range: 0, trend: 0, no_trade: 0 };

  const startIdx = Math.max(rsiPeriod + 1, (config.atrPeriod ?? 14) + 1);

  for (let i = startIdx; i < candles.length; i++) {
    const candle = candles[i];
    const ts = candle.timestamp;
    const dayKey = ts.substring(0, 10);
    const prevRSI = rsiValues[i - 1];
    const atr = atrValues[i];

    if (openTrade) {
      let exitPrice: number | null = null;
      let reason: "stop" | "target" | null = null;

      if (openTrade.side === "buy") {
        if (candle.low <= openTrade.stop) {
          exitPrice = openTrade.stop;
          reason = "stop";
        } else if (openTrade.target > 0 && candle.high >= openTrade.target) {
          exitPrice = openTrade.target;
          reason = "target";
        }
      } else {
        if (candle.high >= openTrade.stop) {
          exitPrice = openTrade.stop;
          reason = "stop";
        } else if (openTrade.target > 0 && candle.low <= openTrade.target) {
          exitPrice = openTrade.target;
          reason = "target";
        }
      }

      if (!reason && openTrade.target === 0) {
        if (openTrade.side === "buy" && prevRSI >= rsiOverbought) {
          exitPrice = candle.close;
          reason = "target";
        } else if (openTrade.side === "sell" && prevRSI <= rsiOversold) {
          exitPrice = candle.close;
          reason = "target";
        }
      }

      if (exitPrice !== null && reason !== null) {
        let pnl = (exitPrice - openTrade.entry) * openTrade.lotSize;
        if (openTrade.side === "sell") pnl *= -1;
        balance += pnl;
        if (balance > peak) peak = balance;

        const riskDollars = Math.abs(openTrade.entry - openTrade.stop) * openTrade.lotSize;
        const resultR = riskDollars > 0 ? pnl / riskDollars : 0;

        if (pnl < 0) {
          dailyLossTracker[dayKey] = (dailyLossTracker[dayKey] ?? 0) + Math.abs(pnl);
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
          regime: "range",
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
          signalType: openTrade.entryReason,
        });
        openTrade = null;
      }
    }

    if (openTrade) continue;

    if (isNaN(prevRSI) || isNaN(atr) || atr <= 0) {
      regimeCounts.no_trade++;
      continue;
    }

    if (!inSession(ts, config.sessionMode)) {
      diagnostics.blockedBySession++;
      regimeCounts.no_trade++;
      continue;
    }

    if ((dailyTradeCounter[dayKey] ?? 0) >= config.maxTradesPerDay) {
      diagnostics.blockedByMaxTradesPerDay++;
      continue;
    }

    const currentDDPct = peak > 0 ? ((peak - balance) / peak) * 100 : 0;
    if (currentDDPct >= config.maxDrawdownPct) {
      diagnostics.blockedByMaxDrawdown++;
      continue;
    }

    const dailyLossSoFar = dailyLossTracker[dayKey] ?? 0;
    if (dailyLossSoFar >= maxDailyLossUSD) {
      diagnostics.blockedByDailyLossLimit++;
      continue;
    }

    if (cooldownBarsRemaining > 0) {
      cooldownBarsRemaining--;
      diagnostics.blockedByConsecutiveLossLimit++;
      continue;
    }

    const stopDistance = atr * atrMultiplier;
    if (stopDistance <= 0) continue;

    let effectiveRiskPct = riskPerTradePct;
    if (config.reduceSizeAfterLoss && lastTradeWasLoss) {
      effectiveRiskPct = config.reducedRiskPerTradePct;
      diagnostics.reducedSizeAfterLossCount++;
    }

    const riskDollarsPerTrade = balance * (effectiveRiskPct / 100);
    let tradeLotSize = Math.max(0.01, +(riskDollarsPerTrade / stopDistance).toFixed(2));
    const maxLotsByMargin = (balance * leverageMultiplier) / candle.close;
    if (tradeLotSize > maxLotsByMargin) tradeLotSize = Math.max(0.01, +maxLotsByMargin.toFixed(2));

    if (prevRSI < rsiOversold) {
      diagnostics.buyCandidates++;
      const entry = candle.close;
      const stop = candles[i - 1].low - stopDistance;
      const actualRisk = Math.abs(entry - stop);
      const target = rsiRewardRatio > 0 ? entry + actualRisk * rsiRewardRatio : 0;

      openTrade = {
        entryTime: ts,
        side: "buy",
        entry,
        stop,
        target,
        entryReason: `rsi_oversold_${prevRSI.toFixed(0)}`,
        atrAtEntry: atr,
        lotSize: tradeLotSize,
      };
      diagnostics.acceptedBuyTrades++;
      dailyTradeCounter[dayKey] = (dailyTradeCounter[dayKey] ?? 0) + 1;
      regimeCounts.range++;
    } else if (prevRSI > rsiOverbought) {
      diagnostics.sellCandidates++;
      const entry = candle.close;
      const stop = candles[i - 1].high + stopDistance;
      const actualRisk = Math.abs(entry - stop);
      const target = rsiRewardRatio > 0 ? entry - actualRisk * rsiRewardRatio : 0;

      openTrade = {
        entryTime: ts,
        side: "sell",
        entry,
        stop,
        target,
        entryReason: `rsi_overbought_${prevRSI.toFixed(0)}`,
        atrAtEntry: atr,
        lotSize: tradeLotSize,
      };
      diagnostics.acceptedSellTrades++;
      dailyTradeCounter[dayKey] = (dailyTradeCounter[dayKey] ?? 0) + 1;
      regimeCounts.range++;
    } else {
      regimeCounts.no_trade++;
    }
  }

  const equityCurve: EquityPoint[] = [];
  let runBal = config.startingBalance;
  let eqPeak = config.startingBalance;
  let maxDD = 0;
  let maxDDPct = 0;

  equityCurve.push({ time: candles[0]?.timestamp?.substring(0, 10) ?? "", balance: runBal, drawdown: 0, drawdownPct: 0, tradeIndex: 0 });

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
  const rangeTrades = trades;
  const trendTrades: Trade[] = [];
  const rangeWins = wins;
  const rangeLosses = losses;

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
    trendTrades: 0,
    noTradeBarCount: regimeCounts.no_trade,
    rangeWins: rangeWins.length,
    rangeLosses: rangeLosses.length,
    trendWins: 0,
    trendLosses: 0,
    rangePnl: +netPnl.toFixed(2),
    trendPnl: 0,
    rangeWinRate: trades.length > 0 ? +(wins.length / trades.length * 100).toFixed(1) : 0,
    trendWinRate: 0,
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
    bucket.rangeTrades++;
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
      trendTrades: 0,
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

  return {
    id: randomUUID(),
    config,
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
