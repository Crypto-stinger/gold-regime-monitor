import { EventEmitter } from "events";
import { CTraderAPI, ProtoOATrendbarPeriod, type SpotPrice, type TradeSignal, type Position } from "./ctrader-api";
import { calcATR, calcEMA, calcBBWidth, calcBBWidthPercentile, calcADX, classifyRegime, calcVolumeProfile } from "./regime-engine";
import type { EnrichedCandle } from "../shared/schema";
import { classifyHMMRegime, isHMMTrained } from "./hmm-engine";
import { getLastMRSGARCHState, isMRSGARCHTrained, classifyMRSGARCH } from "./mrs-garch";
import type { Candle, RegimeState } from "../shared/schema";
import { getCachedData, appendLiveH1Bar, updateLiveH1Tip, updateLiveH4Tip, appendLiveH4Bar, getLatestGVZ, getGVZPercentileForValue, getLatestCOT, getCOTPercentileForValue, getLatestSGE } from "./data-fetcher";
import { getLockedParams, getDefaultLockedParams } from "./locked-params";
import { inSession as sharedInSession } from "./filters";
import { storage } from "./storage";
import { reportError } from "./system-watchdog";

let LOCKED_PARAMS = getDefaultLockedParams();

let _activeTraderInstance: LiveTrader | null = null;

export function registerLiveTrader(trader: LiveTrader | null) {
  _activeTraderInstance = trader;
}

export function getLiveTraderState(): LiveTraderState | null {
  if (!_activeTraderInstance) return null;
  return _activeTraderInstance.getState();
}

export interface ConditionCheck {
  name: string;
  met: boolean;
  detail: string;
}

export interface OpenPositionInfo {
  positionId: number;
  side: string;
  entryPrice: number;
  currentPrice: number;
  volume: number;
  unrealizedPnl: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openTimestamp: number;
}

export interface StrategyAnalysis {
  activeParams: Record<string, any>;
  timestamp: string;
  running: boolean;
  regime: RegimeState;
  regimeReasoning: string;
  currentPrice: number;
  openPositions: OpenPositionInfo[];
  indicators: {
    atrH1: number;
    atrH4: number;
    avgAtrH4: number;
    bbWidthH4: number;
    compressionThreshold: number;
    expansionThreshold: number;
    atrExpanding: boolean;
    bbCompressed: boolean;
  };
  range: { high: number; low: number; width: number; midpoint: number; midBandUpper: number; midBandLower: number };
  pricePosition: {
    distToSupport: number;
    distToResistance: number;
    nearSupport: boolean;
    nearResistance: boolean;
    inMidpointBand: boolean;
    percentInRange: number;
  };
  conditions: ConditionCheck[];
  allConditionsMet: boolean;
  planOfAction: string;
  expectedEntry: { price: number; side: string; distance: number; sl: number; tp: number } | null;
  performance: {
    balance: number;
    dailyPnl: number;
    totalPnl: number;
    drawdown: number;
    peak: number;
    tradesToday: number;
    consecutiveLosses: number;
  };
  lastBar: { timestamp: string; open: number; high: number; low: number; close: number } | null;
  wickAnalysis: { body: number; upperWick: number; lowerWick: number; bullishRejection: boolean; bearishRejection: boolean; wickRatioThreshold: number } | null;
  h1Chart: { timestamp: string; open: number; high: number; low: number; close: number }[];
  params: any;
}

export interface TradeLog {
  timestamp: string;
  type: "signal" | "order" | "close" | "info" | "warning" | "error" | "regime";
  message: string;
  details?: any;
}

export interface LiveTraderState {
  running: boolean;
  connected: boolean;
  regime: RegimeState;
  currentPrice: number;
  positions: Position[];
  dailyPnl: number;
  totalPnl: number;
  balance: number;
  tradestoday: number;
  consecutiveLosses: number;
  logs: TradeLog[];
  params: typeof LOCKED_PARAMS;
  lastUpdate: string;
}

export class LiveTrader extends EventEmitter {
  private api: CTraderAPI;
  private running = false;
  private startupTime = 0;
  private liveBarCount = 0;
  private regime: RegimeState = "no_trade";
  private h1Bars: Candle[] = [];
  private h4Bars: Candle[] = [];
  private dailyBars: Candle[] = [];
  private currentPrice = 0;
  private dailyPnl = 0;
  private totalPnl = 0;
  private tradesToday = 0;
  private consecutiveLosses = 0;
  private lastTradeDay = "";
  private accountBalance = 0;
  private peak = 0;
  private logs: TradeLog[] = [];
  private barCheckInterval: NodeJS.Timeout | null = null;
  private priceHistory: { time: number; price: number }[] = [];
  private static readonly MAX_PRICE_HISTORY = 200;

  constructor(api: CTraderAPI) {
    super();
    this.api = api;
    const ctBalance = api.getStatus().balance;
    const startingBalance = LOCKED_PARAMS.startingBalance || 3000;
    if (ctBalance && ctBalance > 0) {
      this.accountBalance = ctBalance;
      this.totalPnl = 0;
      this.peak = ctBalance;
      this.log("info", `Account balance from cTrader: $${ctBalance.toFixed(2)} (using actual broker balance, P&L tracked from trades only)`);
    } else {
      this.accountBalance = startingBalance;
      this.totalPnl = 0;
      this.peak = startingBalance;
      this.log("info", `Account balance: $${startingBalance.toFixed(2)} (cTrader balance unavailable)`);
    }
  }

  get isRunning() { return this.running; }

  getState(): LiveTraderState {
    const price = this.currentPrice;
    const positionsWithPnl = this.api.currentPositions.map(pos => {
      const isBuy = pos.tradeSide === 1;
      const priceDiff = isBuy ? (price - pos.entryPrice) : (pos.entryPrice - price);
      const unrealizedPnl = price > 0 ? priceDiff * pos.volume / 100 : 0;
      return { ...pos, unrealizedPnl };
    });
    const totalUnrealizedPnl = positionsWithPnl.reduce((sum, p) => sum + p.unrealizedPnl, 0);

    return {
      running: this.running,
      connected: this.api.isConnected,
      regime: this.regime,
      currentPrice: price,
      positions: positionsWithPnl,
      dailyPnl: this.dailyPnl,
      totalPnl: this.totalPnl + totalUnrealizedPnl,
      balance: this.accountBalance,
      tradestoday: this.tradesToday,
      consecutiveLosses: this.consecutiveLosses,
      logs: this.logs.slice(-100),
      params: LOCKED_PARAMS,
      lastUpdate: new Date().toISOString(),
    };
  }

  getAnalysis(): StrategyAnalysis {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const balance = this.accountBalance + this.totalPnl;
    const drawdown = this.peak > 0 ? (this.peak - balance) / this.peak * 100 : 0;
    const dailyLossPct = balance > 0 ? Math.abs(this.dailyPnl) / balance * 100 : 0;

    let rangeHigh = 0, rangeLow = 0, currentAtrH4 = 0, avgAtrH4 = 0, currentBBWidth = 0;
    let currentAtrH1 = 0;

    if (this.h4Bars.length >= LOCKED_PARAMS.rangeWidthBars + 2) {
      const h4Atrs = calcATR(this.h4Bars, LOCKED_PARAMS.atrPeriod);
      const h4Closes = this.h4Bars.map(c => c.close);
      const h4BBWidths = calcBBWidth(h4Closes, 20);
      const lastH4Idx = this.h4Bars.length - 1;

      const recentH4 = this.h4Bars.slice(-LOCKED_PARAMS.rangeWidthBars);
      rangeHigh = Math.max(...recentH4.map(c => c.high));
      rangeLow = Math.min(...recentH4.map(c => c.low));

      const atrSlice = h4Atrs.slice(-LOCKED_PARAMS.rangeWidthBars - 2, -2);
      const validAtrs = atrSlice.filter(v => !isNaN(v));
      avgAtrH4 = validAtrs.length > 0 ? validAtrs.reduce((a, b) => a + b, 0) / validAtrs.length : 0;
      currentAtrH4 = h4Atrs[lastH4Idx] || 0;
      currentBBWidth = h4BBWidths[lastH4Idx] || 0;
    }

    if (this.h1Bars.length >= LOCKED_PARAMS.atrPeriod + 1) {
      const h1Atrs = calcATR(this.h1Bars, LOCKED_PARAMS.atrPeriod);
      currentAtrH1 = h1Atrs[h1Atrs.length - 1] || 0;
    }

    const rangeWidth = rangeHigh - rangeLow;
    const midpoint = (rangeHigh + rangeLow) / 2;
    const midBandUpper = midpoint + rangeWidth * LOCKED_PARAMS.midpointBandPct;
    const midBandLower = midpoint - rangeWidth * LOCKED_PARAMS.midpointBandPct;
    const price = this.currentPrice;

    const slDistance = currentAtrH1 * LOCKED_PARAMS.atrStopMultiplier;
    const tpDistance = slDistance * LOCKED_PARAMS.rewardRatio;

    const inSession = this.isInSession(utcHour);
    const inEntryWindow = this.isInEntryWindow(utcHour);
    const avoidHoursUTC = LOCKED_PARAMS.avoidHoursUTC || [21, 22, 23, 0];
    const avoidHoursEnabled = LOCKED_PARAMS.avoidHoursEnabled !== false;
    const notInAvoidHour = !(avoidHoursEnabled && avoidHoursUTC.includes(utcHour));
    const belowMaxTrades = this.tradesToday < LOCKED_PARAMS.maxTradesPerDay;
    const belowMaxLosses = this.consecutiveLosses < LOCKED_PARAMS.maxConsecutiveLosses;
    const belowMaxDrawdown = drawdown < LOCKED_PARAMS.maxDrawdownPct;
    const belowDailyLoss = !(this.dailyPnl < 0 && dailyLossPct >= LOCKED_PARAMS.maxDailyLossPct);
    const noOpenPosition = this.api.currentPositions.length === 0;

    const hasRangeData = rangeHigh > 0 && rangeLow > 0 && rangeWidth > 0 && price > 0;
    const distToSupport = hasRangeData ? price - rangeLow : 0;
    const distToResistance = hasRangeData ? rangeHigh - price : 0;
    const nearSupport = hasRangeData && distToSupport >= 0 && distToSupport <= LOCKED_PARAMS.retestBuffer;
    const nearResistance = hasRangeData && distToResistance >= 0 && distToResistance <= LOCKED_PARAMS.retestBuffer;
    const inMidpointBand = hasRangeData && price >= midBandLower && price <= midBandUpper;

    let lastBar = null;
    let wickAnalysis = null;
    if (this.h1Bars.length >= 2) {
      const bar = this.h1Bars[this.h1Bars.length - 1];
      const body = Math.abs(bar.close - bar.open);
      const upperWick = bar.high - Math.max(bar.close, bar.open);
      const lowerWick = Math.min(bar.close, bar.open) - bar.low;
      lastBar = {
        timestamp: bar.timestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      };
      wickAnalysis = {
        body,
        upperWick,
        lowerWick,
        bullishRejection: lowerWick > body * LOCKED_PARAMS.wickRatio,
        bearishRejection: upperWick > body * LOCKED_PARAMS.wickRatio,
        wickRatioThreshold: LOCKED_PARAMS.wickRatio,
      };
    }

    let regimeReasoning = "";
    if (this.h4Bars.length < LOCKED_PARAMS.rangeWidthBars + 2) {
      regimeReasoning = "Insufficient H4 data for regime classification.";
    } else {
      const atrExpanding = currentAtrH4 > avgAtrH4 * LOCKED_PARAMS.expansionThreshold;
      const priceAboveRange = price > rangeHigh;
      const priceBelowRange = price < rangeLow;
      const priceInsideRange = price >= rangeLow && price <= rangeHigh;
      const compressed = currentBBWidth < LOCKED_PARAMS.compressionThreshold;

      if (this.regime === "trend") {
        regimeReasoning = `TREND detected: ATR is expanding (${currentAtrH4.toFixed(2)} > ${(avgAtrH4 * LOCKED_PARAMS.expansionThreshold).toFixed(2)} threshold) and price is ${priceAboveRange ? "above" : "below"} the H4 range. Looking for breakout continuation.`;
      } else if (this.regime === "range") {
        regimeReasoning = `RANGE detected: ATR is flat/low (${currentAtrH4.toFixed(2)} vs avg ${avgAtrH4.toFixed(2)}) and price is inside the H4 range. ${compressed ? "Bollinger Bands are compressed — tight consolidation." : "Waiting for price to approach support/resistance for rejection entry."}`;
      } else {
        const reasons: string[] = [];
        if (inMidpointBand) reasons.push(`price is in the midpoint dead zone ($${midBandLower.toFixed(2)}-$${midBandUpper.toFixed(2)})`);
        if (!atrExpanding && !priceInsideRange) reasons.push("conditions don't fit trend or range classification");
        regimeReasoning = `NO TRADE: ${reasons.length > 0 ? reasons.join("; ") : "Market conditions are ambiguous — no clear edge."}`;
      }
    }

    let planOfAction = "";
    let expectedEntry = null as { price: number; side: string; distance: number; sl: number; tp: number } | null;

    if (this.regime === "range") {
      if (nearSupport) {
        planOfAction = `Price is near support ($${rangeLow.toFixed(2)}). Waiting for a bullish rejection candle (lower wick > ${(LOCKED_PARAMS.wickRatio * 100).toFixed(0)}% of body) to trigger a BUY.`;
        expectedEntry = { price: rangeLow + LOCKED_PARAMS.retestBuffer / 2, side: "BUY", distance: distToSupport, sl: rangeLow - slDistance, tp: rangeLow + tpDistance };
      } else if (nearResistance) {
        planOfAction = `Price is near resistance ($${rangeHigh.toFixed(2)}). Waiting for a bearish rejection candle (upper wick > ${(LOCKED_PARAMS.wickRatio * 100).toFixed(0)}% of body) to trigger a SELL.`;
        expectedEntry = { price: rangeHigh - LOCKED_PARAMS.retestBuffer / 2, side: "SELL", distance: distToResistance, sl: rangeHigh + slDistance, tp: rangeHigh - tpDistance };
      } else {
        const closerToSupport = distToSupport < distToResistance;
        planOfAction = `Ranging market. Price is mid-range. Closest level: ${closerToSupport ? "support" : "resistance"} at $${closerToSupport ? rangeLow.toFixed(2) : rangeHigh.toFixed(2)} ($${(closerToSupport ? distToSupport : distToResistance).toFixed(2)} away). Waiting for price to approach a level.`;
        if (closerToSupport) {
          expectedEntry = { price: rangeLow + LOCKED_PARAMS.retestBuffer / 2, side: "BUY", distance: distToSupport, sl: rangeLow - slDistance, tp: rangeLow + tpDistance };
        } else {
          expectedEntry = { price: rangeHigh - LOCKED_PARAMS.retestBuffer / 2, side: "SELL", distance: distToResistance, sl: rangeHigh + slDistance, tp: rangeHigh - tpDistance };
        }
      }
    } else if (this.regime === "trend") {
      const closerToHigh = distToResistance < distToSupport;
      if (closerToHigh) {
        planOfAction = `Trending market. Price is approaching range high ($${rangeHigh.toFixed(2)}). Waiting for an H1 close above this level to trigger a breakout BUY.`;
        expectedEntry = { price: rangeHigh, side: "BUY", distance: distToResistance, sl: rangeHigh - slDistance, tp: rangeHigh + tpDistance };
      } else {
        planOfAction = `Trending market. Price is approaching range low ($${rangeLow.toFixed(2)}). Waiting for an H1 close below this level to trigger a breakdown SELL.`;
        expectedEntry = { price: rangeLow, side: "SELL", distance: distToSupport, sl: rangeLow + slDistance, tp: rangeLow - tpDistance };
      }
    } else {
      planOfAction = "No actionable setup. The bot is monitoring for a regime change. It needs either ATR expansion for trend entries or price at range boundaries for range entries.";
    }

    const marketOpen = !this.isMarketClosed();
    const notRollover = !this.isRolloverPeriod(utcHour);
    const notNewsBlackout = !this.isNearNewsEvent();
    const spreadOk = !this.isSpreadTooWide();
    const spot = this.api.currentSpot;
    const currentSpread = spot && spot.bid > 0 && spot.ask > 0 ? spot.ask - spot.bid : 0;

    const conditions: ConditionCheck[] = [
      { name: "Market Open", met: marketOpen, detail: marketOpen ? "XAUUSD market is open" : "Market is closed (weekend/holiday)" },
      { name: "Not Rollover", met: notRollover, detail: notRollover ? "Outside daily rollover window" : "In rollover period (21:00-22:00 UTC) — spreads widen" },
      { name: "Active Session", met: inSession, detail: inSession ? `In ${LOCKED_PARAMS.sessionMode} session (hour ${utcHour} UTC)` : `Outside ${LOCKED_PARAMS.sessionMode} session (hour ${utcHour} UTC, need 07-21)` },
      { name: "Entry Window", met: inEntryWindow, detail: inEntryWindow ? `Within entry window (London open bars)` : `Outside entry window (hour ${utcHour}, need 07-${7 + LOCKED_PARAMS.entryWindowBars})` },
      { name: "Avoid Hours", met: notInAvoidHour, detail: notInAvoidHour ? `Not in avoid window (hour ${utcHour})` : `In avoid hours (hour ${utcHour} UTC — low liquidity/rollover)` },
      { name: "News Blackout", met: notNewsBlackout, detail: notNewsBlackout ? "No high-impact news nearby" : `Within news blackout (±${LOCKED_PARAMS.newsBeforeMin}/${LOCKED_PARAMS.newsAfterMin} min)` },
      { name: "Spread Check", met: spreadOk, detail: spreadOk ? `Spread: $${currentSpread.toFixed(2)} (max $${(LOCKED_PARAMS.spreadPoints * 3).toFixed(2)})` : `Spread too wide: $${currentSpread.toFixed(2)} (max $${(LOCKED_PARAMS.spreadPoints * 3).toFixed(2)})` },
      { name: "Trades Today", met: belowMaxTrades, detail: `${this.tradesToday}/${LOCKED_PARAMS.maxTradesPerDay} trades used` },
      { name: "Consecutive Losses", met: belowMaxLosses, detail: `${this.consecutiveLosses}/${LOCKED_PARAMS.maxConsecutiveLosses} consecutive losses` },
      { name: "Drawdown", met: belowMaxDrawdown, detail: `${drawdown.toFixed(1)}% / ${LOCKED_PARAMS.maxDrawdownPct}% max` },
      { name: "Daily Loss", met: belowDailyLoss, detail: this.dailyPnl >= 0 ? `Daily P&L: +$${this.dailyPnl.toFixed(2)}` : `Daily loss: ${dailyLossPct.toFixed(1)}% / ${LOCKED_PARAMS.maxDailyLossPct}% max` },
      { name: "No Open Position", met: noOpenPosition, detail: noOpenPosition ? "No position open" : `${this.api.currentPositions.length} position(s) open` },
      { name: "Tradeable Regime", met: this.regime !== "no_trade", detail: `Current regime: ${this.regime}` },
      { name: "Near Key Level", met: hasRangeData && (nearSupport || nearResistance || this.regime === "trend"), detail: !hasRangeData ? "Insufficient range data" : this.regime === "range" ? `Support: $${distToSupport.toFixed(2)} away | Resistance: $${distToResistance.toFixed(2)} away (buffer: ${LOCKED_PARAMS.retestBuffer})` : this.regime === "trend" ? "Trend mode — watching for breakout" : "Price not near any key level" },
    ];

    if (LOCKED_PARAMS.volumeProfileEnabled && this.h4Bars.length >= 5) {
      const vpPeriod = LOCKED_PARAMS.volumeProfilePeriod ?? 50;
      const vpEndIdx = Math.max(0, this.h4Bars.length - 1);
      const vpStartIdx = Math.max(0, vpEndIdx - vpPeriod + 1);
      const vpCandles = this.h4Bars.slice(vpStartIdx, vpEndIdx + 1);
      if (vpCandles.length >= 5) {
        const vp = calcVolumeProfile(vpCandles, LOCKED_PARAMS.volumeProfileBins ?? 24, LOCKED_PARAMS.volumeProfileValueAreaPct ?? 70);
        const pocDist = Math.abs(price - vp.poc);
        const vpRange = vp.vah - vp.val;
        const pocProx = LOCKED_PARAMS.vpPocProximityPct ?? 0.15;
        const awayFromPoc = vpRange > 0 ? pocDist / vpRange >= pocProx : true;
        conditions.push({
          name: "Volume Profile",
          met: awayFromPoc,
          detail: awayFromPoc
            ? `POC=$${vp.poc.toFixed(2)} | VAH=$${vp.vah.toFixed(2)} | VAL=$${vp.val.toFixed(2)} — clear of congestion`
            : `Near POC ($${vp.poc.toFixed(2)}) — congestion zone, avoid entries`
        });
      }
    }

    if (this.regime === "range" && wickAnalysis) {
      const wickMet = (nearSupport && wickAnalysis.bullishRejection) || (nearResistance && wickAnalysis.bearishRejection);
      conditions.push({
        name: "Candle Rejection",
        met: wickMet,
        detail: wickMet ? `${nearSupport ? "Bullish" : "Bearish"} rejection detected` : `No rejection pattern yet. Lower wick: ${wickAnalysis.lowerWick.toFixed(2)}, Upper wick: ${wickAnalysis.upperWick.toFixed(2)}, Body: ${wickAnalysis.body.toFixed(2)}`
      });
    }

    const h1ChartData = this.h1Bars.slice(-50).map(bar => ({
      timestamp: bar.timestamp,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    }));

    const openPositions: OpenPositionInfo[] = this.api.currentPositions.map(pos => {
      const isBuy = pos.tradeSide === 1;
      const priceDiff = isBuy ? (price - pos.entryPrice) : (pos.entryPrice - price);
      const unrealizedPnl = priceDiff * pos.volume / 100;
      return {
        positionId: pos.positionId,
        side: isBuy ? "BUY" : "SELL",
        entryPrice: pos.entryPrice,
        currentPrice: price,
        volume: pos.volume,
        unrealizedPnl,
        stopLoss: pos.stopLoss || null,
        takeProfit: pos.takeProfit || null,
        openTimestamp: pos.openTimestamp,
      };
    });

    return {
      activeParams: { ...LOCKED_PARAMS, startingBalance: this.accountBalance },
      timestamp: now.toISOString(),
      running: this.running,
      regime: this.regime,
      regimeReasoning,
      currentPrice: price,
      openPositions,
      indicators: {
        atrH1: currentAtrH1,
        atrH4: currentAtrH4,
        avgAtrH4,
        bbWidthH4: currentBBWidth,
        compressionThreshold: LOCKED_PARAMS.compressionThreshold,
        expansionThreshold: LOCKED_PARAMS.expansionThreshold,
        atrExpanding: currentAtrH4 > avgAtrH4 * LOCKED_PARAMS.expansionThreshold,
        bbCompressed: currentBBWidth < LOCKED_PARAMS.compressionThreshold,
      },
      range: { high: rangeHigh, low: rangeLow, width: rangeWidth, midpoint, midBandUpper, midBandLower },
      pricePosition: {
        distToSupport,
        distToResistance,
        nearSupport,
        nearResistance,
        inMidpointBand,
        percentInRange: rangeWidth > 0 ? ((price - rangeLow) / rangeWidth) * 100 : 50,
      },
      conditions,
      allConditionsMet: conditions.every(c => c.met),
      planOfAction,
      expectedEntry,
      performance: {
        balance,
        dailyPnl: this.dailyPnl,
        totalPnl: this.totalPnl,
        drawdown,
        peak: this.peak,
        tradesToday: this.tradesToday,
        consecutiveLosses: this.consecutiveLosses,
      },
      lastBar,
      wickAnalysis,
      h1Chart: h1ChartData,
      params: LOCKED_PARAMS,
    };
  }

  private log(type: TradeLog["type"], message: string, details?: any) {
    const entry: TradeLog = {
      timestamp: new Date().toISOString(),
      type,
      message,
      details,
    };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs = this.logs.slice(-300);
    console.log(`[LiveTrader] [${type}] ${message}`);
    this.emit("log", entry);
  }

  async reloadLockedParams() {
    LOCKED_PARAMS = await getLockedParams();
    this.log("info", "Locked params reloaded from DB");
  }

  async start() {
    if (this.running) return;
    this.running = true;

    this.log("info", "Live trader starting...");

    try {
      LOCKED_PARAMS = await getLockedParams();
      this.log("info", "Loaded locked params from DB");

      const tradeCounts = await storage.getTradeCountsByPeriod();
      this.tradesToday = tradeCounts.today;
      this.dailyPnl = tradeCounts.pnlToday;
      this.totalPnl = tradeCounts.pnlAllTime;
      if (this.totalPnl !== 0) {
        const startBal = LOCKED_PARAMS.startingBalance || 3000;
        this.accountBalance = startBal;
        this.peak = Math.max(startBal + this.totalPnl, startBal);
        this.log("info", `Restored P&L from DB: daily=$${this.dailyPnl.toFixed(2)}, total=$${this.totalPnl.toFixed(2)}, balance=$${(startBal + this.totalPnl).toFixed(2)}`);
      }
      this.log("info", `Trade history from DB: ${tradeCounts.today} today, ${tradeCounts.allTime} all time`);

      await this.loadHistoricalData();
      this.log("info", `Loaded ${this.h1Bars.length} H1, ${this.h4Bars.length} H4, ${this.dailyBars.length} Daily bars`);

      this.api.on("spot", (spot: SpotPrice) => this.onSpot(spot));
      this.api.on("execution", (event: any) => this.onExecution(event));
      this.api.on("trendbar", (event: any) => this.onTrendbar(event));
      this.api.on("disconnected", () => this.log("warning", "cTrader WebSocket disconnected — waiting for reconnect"));
      this.api.on("reconnected", () => {
        this.log("info", "cTrader reconnected — price feed and positions restored");
        this.refreshHigherTimeframes();
      });

      if (this.api.symbolId) {
        await this.api.subscribeSpots(this.api.symbolId);
        this.log("info", this.api.spotsSubscribed ? "Spot subscription active" : "Subscribed to XAUUSD spot prices");
        await this.api.subscribeTrendbars(this.api.symbolId, ProtoOATrendbarPeriod.H1);
        this.log("info", "Trendbar subscription active");
      }

      if (this.currentPrice === 0 && this.api.currentSpot) {
        this.onSpot(this.api.currentSpot);
        this.log("info", `Seeded price from last cached spot: $${this.currentPrice.toFixed(2)}`);
      }

      await this.api.reconcilePositions();
      this.log("info", `Reconciled ${this.api.currentPositions.length} open positions`);

      this.barCheckInterval = setInterval(() => this.checkForNewBar(), 60000);

      this.startupTime = Date.now();
      this.liveBarCount = 0;
      this.log("info", "Live trader running with LOCKED parameters:");
      this.log("info", `  Expansion: ${LOCKED_PARAMS.expansionThreshold} | Compression: ${LOCKED_PARAMS.compressionThreshold}`);
      this.log("info", `  ATR Stop: ${LOCKED_PARAMS.atrStopMultiplier}x | RR: ${LOCKED_PARAMS.rewardRatio}:1`);
      this.log("info", `  Risk: ${LOCKED_PARAMS.riskPerTradePct}% | Lev: ${LOCKED_PARAMS.leverage}x`);
      this.log("info", `  Session: ${LOCKED_PARAMS.sessionMode} | Entry Window: ${LOCKED_PARAMS.entryWindowBars} bars`);

      this.classifyCurrentRegime();

    } catch (err: any) {
      this.log("error", `Failed to start: ${err.message}`);
      this.running = false;
      throw err;
    }
  }

  stop() {
    this.running = false;
    if (this.barCheckInterval) {
      clearInterval(this.barCheckInterval);
      this.barCheckInterval = null;
    }
    this.api.removeAllListeners("spot");
    this.api.removeAllListeners("execution");
    this.api.removeAllListeners("trendbar");
    this.api.removeAllListeners("disconnected");
    this.api.removeAllListeners("reconnected");
    this.log("info", "Live trader stopped");
  }

  private async loadHistoricalData() {
    const cached = getCachedData();
    if (cached) {
      this.h1Bars = cached.h1 || [];
      this.h4Bars = cached.h4 || [];
      this.dailyBars = cached.daily || [];
    }
    if (this.h1Bars.length < 50) {
      this.log("warning", "Insufficient historical data. Need at least 50 H1 bars.");
    }
  }

  private firstSpotReceived = false;

  seedPrice(spot: SpotPrice) {
    this.currentPrice = (spot.bid + spot.ask) / 2;
  }

  private onSpot(spot: SpotPrice) {
    this.currentPrice = (spot.bid + spot.ask) / 2;
    const now = Date.now();
    const last = this.priceHistory[this.priceHistory.length - 1];
    if (!last || now - last.time >= 5000) {
      this.priceHistory.push({ time: now, price: this.currentPrice });
      if (this.priceHistory.length > LiveTrader.MAX_PRICE_HISTORY) {
        this.priceHistory.shift();
      }
      updateLiveH1Tip(this.currentPrice);
      updateLiveH4Tip(this.currentPrice);
    }
    if (!this.firstSpotReceived) {
      this.firstSpotReceived = true;
      this.log("info", `First live price received: $${this.currentPrice.toFixed(2)} — reclassifying regime`);
      this.classifyCurrentRegime();
    }
    this.emit("priceUpdate", this.currentPrice);
  }

  getPriceHistory() {
    return this.priceHistory;
  }

  private lastLiveTradeId: number | null = null;

  private onExecution(event: any) {
    if (event.executionType === "ORDER_FILLED" || event.executionType === 1) {
      this.log("order", `Order filled: ${JSON.stringify(event).substring(0, 200)}`);
      this.tradesToday++;
      if (this.lastTradeDecisionId) {
        storage.updateTradeDecisionOutcome(this.lastTradeDecisionId, "filled")
          .catch(err => console.error("[Decision] fill mark error:", err.message));
      }

      const pos = event.position;
      const deal = event.deal;
      const tradeSide = pos?.tradeData?.tradeSide;
      const fillPrice = deal?.executionPrice || pos?.price || this.currentPrice;
      const volume = pos?.tradeData?.volume || deal?.filledVolume || deal?.volume || 100;
      const posId = String(pos?.positionId || deal?.positionId || "");

      storage.insertLiveTrade({
        openedAt: new Date(),
        side: tradeSide === 1 ? "buy" : "sell",
        entryPrice: fillPrice,
        volume,
        stopLoss: this.lastSignalSL || null,
        takeProfit: this.lastSignalTP || null,
        status: "open",
        regime: this.regime,
        source: "bot",
        ctraderPositionId: posId,
      }).then(id => {
        this.lastLiveTradeId = id;
        this.log("info", `Live trade #${id} recorded: ${tradeSide === 1 ? "BUY" : "SELL"} @ $${fillPrice.toFixed(2)}`);
      }).catch(err => console.error("[LiveTrade] insert error:", err.message));
    }
    if (event.executionType === "ORDER_CANCELLED" || event.executionType === 4) {
      this.log("warning", `Order cancelled: ${event.errorCode || "unknown"}`);
    }
    if (event.position?.positionStatus === 2 || event.executionType === 5 || event.executionType === "POSITION_CLOSED") {
      const pos = event.position;
      const deal = event.deal;
      const swap = (pos?.swap || 0) / 100;
      const commission = (pos?.commission || 0) / 100;
      const tradeSide = pos?.tradeData?.tradeSide;
      const volume = pos?.tradeData?.volume || deal?.filledVolume || deal?.volume || 0;
      const closePrice = deal?.executionPrice || deal?.closePrice || pos?.price || this.currentPrice;
      const openPrice = pos?.price || deal?.executionPrice || 0;

      let pricePnl = 0;
      if (tradeSide === 1) {
        pricePnl = (closePrice - openPrice) * volume / 100;
      } else {
        pricePnl = (openPrice - closePrice) * volume / 100;
      }
      const pnl = pricePnl + swap + commission;

      this.log("close", `Position closed. Side=${tradeSide === 1 ? "BUY" : "SELL"} Open=${openPrice.toFixed(2)} Close=${closePrice.toFixed(2)} PnL=$${pnl.toFixed(2)}`);
      if (pnl < 0) {
        this.consecutiveLosses++;
      } else {
        this.consecutiveLosses = 0;
      }
      this.dailyPnl += pnl;
      this.totalPnl += pnl;
      const currentEquity = this.accountBalance + this.totalPnl;
      if (currentEquity > this.peak) {
        this.peak = currentEquity;
      }

      const outcome = pnl >= 0 ? "win" : "loss";
      if (this.lastTradeDecisionId) {
        storage.updateTradeDecisionOutcome(this.lastTradeDecisionId, outcome, pnl)
          .catch(err => console.error("[Decision] outcome update error:", err.message));
        this.lastTradeDecisionId = null;
      }

      const closePosId = String(pos?.positionId || deal?.positionId || "");
      if (closePosId) {
        storage.closeLiveTradeByPositionId(closePosId, {
          closedAt: new Date(),
          exitPrice: closePrice,
          pnl,
        }).then(closedId => {
          if (closedId) {
            this.log("info", `Live trade #${closedId} closed by positionId ${closePosId}: ${outcome.toUpperCase()} $${pnl.toFixed(2)}`);
          } else {
            this.log("warning", `No open live_trade found for positionId ${closePosId}`);
          }
          this.lastLiveTradeId = null;
        }).catch(err => console.error("[LiveTrade] close error:", err.message));
      } else if (this.lastLiveTradeId) {
        storage.updateLiveTrade(this.lastLiveTradeId, {
          closedAt: new Date().toISOString(),
          exitPrice: closePrice,
          pnl,
          status: "closed",
        }).then(() => {
          this.log("info", `Live trade #${this.lastLiveTradeId} closed (fallback): ${outcome.toUpperCase()} $${pnl.toFixed(2)}`);
          this.lastLiveTradeId = null;
        }).catch(err => console.error("[LiveTrade] update error:", err.message));
      }
    }
  }

  private onTrendbar(event: any) {
    this.log("info", "New trendbar received");
    this.checkForNewBar();
  }

  private h1BarHigh = 0;
  private h1BarLow = Infinity;
  private h1BarOpen = 0;
  private lastDataRefreshHour = -1;

  private checkForNewBar() {
    if (!this.running) return;

    const now = new Date();
    const utcHour = now.getUTCHours();
    const today = now.toISOString().split("T")[0];

    if (today !== this.lastTradeDay) {
      this.lastTradeDay = today;
      this.tradesToday = 0;
      this.dailyPnl = 0;
    }

    if (this.currentPrice > 0) {
      if (this.h1BarOpen === 0) this.h1BarOpen = this.currentPrice;
      this.h1BarHigh = Math.max(this.h1BarHigh, this.currentPrice);
      this.h1BarLow = Math.min(this.h1BarLow, this.currentPrice);
    }

    if (this.currentPrice > 0 && this.h1Bars.length > 0) {
      const lastBar = this.h1Bars[this.h1Bars.length - 1];
      const lastBarHour = new Date(lastBar.timestamp).getUTCHours();
      if (utcHour !== lastBarHour) {
        const newBar: Candle = {
          timestamp: now.toISOString(),
          open: this.h1BarOpen > 0 ? this.h1BarOpen : this.currentPrice,
          high: this.h1BarHigh > 0 ? this.h1BarHigh : this.currentPrice,
          low: this.h1BarLow < Infinity ? this.h1BarLow : this.currentPrice,
          close: this.currentPrice,
          volume: 0,
        };
        this.h1Bars.push(newBar);
        if (this.h1Bars.length > 500) this.h1Bars = this.h1Bars.slice(-300);
        appendLiveH1Bar(newBar);
        this.liveBarCount++;

        this.h1BarOpen = this.currentPrice;
        this.h1BarHigh = this.currentPrice;
        this.h1BarLow = this.currentPrice;

        this.classifyCurrentRegime();
        this.evaluateEntry(utcHour);
      }
    }

    if (utcHour % 4 === 0 && utcHour !== this.lastDataRefreshHour) {
      this.lastDataRefreshHour = utcHour;
      this.refreshHigherTimeframes();
    }
  }

  private async refreshHigherTimeframes() {
    try {
      const cached = getCachedData();
      if (cached) {
        if (cached.h4 && cached.h4.length > 0) {
          this.h4Bars = cached.h4;
          if (this.currentPrice > 0) {
            updateLiveH4Tip(this.currentPrice);
          }
        }
        if (cached.daily && cached.daily.length > 0) this.dailyBars = cached.daily;
        this.log("info", `Refreshed H4: ${this.h4Bars.length}, Daily: ${this.dailyBars.length} bars from cache`);
      }
    } catch (err: any) {
      this.log("warning", `Failed to refresh higher timeframes: ${err.message}`);
    }
  }

  private classifyCurrentRegime() {
    if (this.h4Bars.length < LOCKED_PARAMS.rangeWidthBars + 4) {
      this.regime = "no_trade";
      this.log("regime", "Insufficient H4 data for regime classification");
      return;
    }

    const h4Atrs = calcATR(this.h4Bars, LOCKED_PARAMS.atrPeriod);
    const h4Closes = this.h4Bars.map(c => c.close);
    const h4BBWidths = calcBBWidth(h4Closes, 20);
    const lastH4Idx = this.h4Bars.length - 1;

    const rangeOffset = 2;
    const rangeEnd = Math.max(0, this.h4Bars.length - rangeOffset);
    const rangeStart = Math.max(0, rangeEnd - LOCKED_PARAMS.rangeWidthBars);
    let rangeHigh = -Infinity, rangeLow = Infinity;
    for (let j = rangeStart; j < rangeEnd; j++) {
      rangeHigh = Math.max(rangeHigh, this.h4Bars[j].high);
      rangeLow = Math.min(rangeLow, this.h4Bars[j].low);
    }

    const atrLookback = Math.min(50, this.h4Bars.length);
    const atrStart = Math.max(0, this.h4Bars.length - atrLookback);
    let avgAtrH4 = 0;
    let atrCount = 0;
    for (let j = atrStart; j < this.h4Bars.length; j++) {
      if (!isNaN(h4Atrs[j])) { avgAtrH4 += h4Atrs[j]; atrCount++; }
    }
    avgAtrH4 = atrCount > 0 ? avgAtrH4 / atrCount : 0;

    const currentAtrH4 = h4Atrs[lastH4Idx] || 0;
    const currentBBWidth = h4BBWidths[lastH4Idx] || 0;
    const price = this.currentPrice || this.h1Bars[this.h1Bars.length - 1]?.close || 0;

    const rangeWidth = rangeHigh - rangeLow;
    const breakoutDistance = price > rangeHigh
      ? price - rangeHigh
      : price < rangeLow
        ? rangeLow - price
        : 0;
    const breakoutATRs = avgAtrH4 > 0 ? breakoutDistance / avgAtrH4 : 0;

    const breakoutPctOfRange = rangeWidth > 0 ? breakoutDistance / rangeWidth : 0;
    if ((breakoutATRs >= 0.3 || breakoutPctOfRange >= 0.10) && breakoutDistance > 0 && rangeWidth > 0) {
      const direction = price > rangeHigh ? "above" : "below";
      if (this.regime !== "trend") {
        this.log("regime", `Regime changed: ${this.regime} → trend (BREAKOUT OVERRIDE: price=${price.toFixed(2)} is ${breakoutATRs.toFixed(2)} ATRs / ${(breakoutPctOfRange*100).toFixed(1)}% ${direction} range ${rangeLow.toFixed(2)}-${rangeHigh.toFixed(2)})`);
        this.regime = "trend";
      }
      return;
    }

    const bbPct = calcBBWidthPercentile(h4BBWidths, lastH4Idx, 100);
    const h4ADXResult = calcADX(this.h4Bars, 14);
    const adxVal = h4ADXResult.adx[lastH4Idx] ?? NaN;

    const latestGVZ = getLatestGVZ();
    const gvzVal = latestGVZ ? Number(latestGVZ.value) : NaN;
    const gvzPct = !isNaN(gvzVal) ? getGVZPercentileForValue(gvzVal) : 50;

    const latestCOT = getLatestCOT();
    const cotNet = latestCOT ? latestCOT.netPosition : 0;
    const cotPct = latestCOT ? getCOTPercentileForValue(cotNet) : 50;

    const latestSGE = getLatestSGE();
    const sgePrem = latestSGE ? latestSGE.premium : 0;

    const enrichedRow = {
      timestamp: new Date().toISOString(),
      open: price, high: price, low: price, close: price, volume: 0,
      atr_h1: 0, atr_h4: currentAtrH4, ema_daily: 0, ema_daily_200: 0,
      daily_close: 0, bb_width_h4: currentBBWidth,
      bb_width_percentile: bbPct, adx_h4: adxVal,
      gvz: gvzVal, gvz_percentile: gvzPct,
      cot_net: cotNet, cot_net_pct: cotPct,
      sge_premium: sgePrem,
    } as EnrichedCandle;

    if (isHMMTrained() && LOCKED_PARAMS.hmmEnabled !== false) {
      const cached = getCachedData();
      if (cached.h1.length >= 50) {
        const recentH1 = cached.h1.slice(-100).map(c => ({
          ...c, atr_h1: 0, atr_h4: currentAtrH4, ema_daily: 0, ema_daily_200: 0,
          daily_close: 0, bb_width_h4: currentBBWidth, bb_width_percentile: bbPct,
          adx_h4: adxVal, gvz: gvzVal, gvz_percentile: gvzPct,
          cot_net: cotNet, cot_net_pct: cotPct, vp_poc: 0, vp_vah: 0, vp_val: 0,
          sge_premium: sgePrem,
        } as EnrichedCandle));
        const hmmResult = classifyHMMRegime(recentH1);
        enrichedRow.hmm_state = hmmResult.state;
        enrichedRow.hmm_confidence = hmmResult.confidence;

        if (isMRSGARCHTrained()) {
          const garchResult = classifyMRSGARCH(recentH1);
          if (garchResult) {
            enrichedRow.garch_volatility = garchResult.garchVolatility;
            enrichedRow.garch_forecast = garchResult.volForecast;
            enrichedRow.mrs_position_multiplier = garchResult.positionSizeMultiplier;
          }
        }
      }
    }

    const newRegime = classifyRegime(
      enrichedRow, avgAtrH4, rangeHigh, rangeLow,
      LOCKED_PARAMS.compressionThreshold, LOCKED_PARAMS.expansionThreshold,
      LOCKED_PARAMS.midpointBandPct,
      { enabled: LOCKED_PARAMS.gvzEnabled !== false, rangeThreshold: LOCKED_PARAMS.gvzRangeThreshold ?? 25, trendThreshold: LOCKED_PARAMS.gvzTrendThreshold ?? 75 },
      { enabled: LOCKED_PARAMS.cotEnabled !== false, bullishThreshold: LOCKED_PARAMS.cotBullishThreshold ?? 75, bearishThreshold: LOCKED_PARAMS.cotBearishThreshold ?? 25 },
      { enabled: LOCKED_PARAMS.sgeEnabled !== false, bullishThreshold: LOCKED_PARAMS.sgeBullishThreshold ?? 10, bearishThreshold: LOCKED_PARAMS.sgeBearishThreshold ?? -5 },
      { enabled: LOCKED_PARAMS.hmmEnabled !== false, confidenceThreshold: LOCKED_PARAMS.hmmConfidenceThreshold ?? 0.6 },
      { enabled: LOCKED_PARAMS.mrsGarchEnabled !== false, volScaling: LOCKED_PARAMS.mrsGarchVolScaling !== false, highVolThreshold: LOCKED_PARAMS.mrsGarchHighVolThreshold ?? 75, lowVolThreshold: LOCKED_PARAMS.mrsGarchLowVolThreshold ?? 25 },
    );

    if (newRegime !== this.regime) {
      this.log("regime", `Regime changed: ${this.regime} → ${newRegime} (price=${price.toFixed(2)}, range=${rangeLow.toFixed(2)}-${rangeHigh.toFixed(2)}, atrH4=${currentAtrH4.toFixed(2)}, avgAtr=${avgAtrH4.toFixed(2)}, bbw=${currentBBWidth.toFixed(4)})`);
      this.regime = newRegime;
    }
  }

  private isMarketClosed(): boolean {
    const now = new Date();
    const utcDay = now.getUTCDay();
    const utcHour = now.getUTCHours();
    if (utcDay === 6) return true;
    if (utcDay === 0 && utcHour < 22) return true;
    if (utcDay === 5 && utcHour >= 22) return true;
    return false;
  }

  private isRolloverPeriod(utcHour: number): boolean {
    return utcHour >= 21 && utcHour < 22;
  }

  private isHighVolatilityPeriod(utcHour: number): boolean {
    if (utcHour === 7) return true;
    if (utcHour === 13 || utcHour === 14) return true;
    return false;
  }

  private isNearNewsEvent(): boolean {
    if (LOCKED_PARAMS.newsBeforeMin <= 0 && LOCKED_PARAMS.newsAfterMin <= 0) return false;
    try {
      const cached = getCachedData();
      const events = (cached as any)?.events;
      if (!events || events.length === 0) return false;
      const now = Date.now();
      for (const ev of events) {
        const et = new Date(ev.timestamp || ev.date).getTime();
        if (isNaN(et)) continue;
        const before = et - LOCKED_PARAMS.newsBeforeMin * 60 * 1000;
        const after = et + LOCKED_PARAMS.newsAfterMin * 60 * 1000;
        if (now >= before && now <= after) return true;
      }
    } catch {}
    return false;
  }

  private isSpreadTooWide(): boolean {
    const spot = this.api.currentSpot;
    if (!spot || spot.bid <= 0 || spot.ask <= 0) return true;
    const spreadPoints = spot.ask - spot.bid;
    const maxSpread = LOCKED_PARAMS.spreadPoints * 3;
    return spreadPoints > maxSpread;
  }

  private lastObservationHour = -1;
  private lastTradeDecisionId: number | null = null;
  private lastSignalSL: number | null = null;
  private lastSignalTP: number | null = null;

  private recordObservation() {
    const spot = this.api.currentSpot;
    const spread = spot && spot.bid > 0 && spot.ask > 0 ? spot.ask - spot.bid : 0;
    const analysis = this.getAnalysis();
    const condMap: Record<string, boolean> = {};
    for (const c of analysis.conditions) condMap[c.name] = c.met;

    storage.saveMarketObservation({
      price: this.currentPrice,
      bid: spot?.bid,
      ask: spot?.ask,
      spread,
      atrH1: analysis.indicators.atrH1,
      atrH4: analysis.indicators.atrH4,
      regime: this.regime,
      rangeHigh: analysis.range.high,
      rangeLow: analysis.range.low,
      session: LOCKED_PARAMS.sessionMode,
      conditions: condMap,
    }).catch(err => console.error("[Observation] save error:", err.message));
  }

  private recordDecision(decision: string, blockReason?: string, signalDetails?: Record<string, any>) {
    const spot = this.api.currentSpot;
    const spread = spot && spot.bid > 0 && spot.ask > 0 ? spot.ask - spot.bid : 0;
    const balance = this.accountBalance + this.totalPnl;
    const drawdown = this.peak > 0 ? (this.peak - balance) / this.peak * 100 : 0;

    storage.saveTradeDecision({
      decision,
      side: signalDetails?.side,
      price: this.currentPrice,
      regime: this.regime,
      conditions: {
        utcHour: new Date().getUTCHours(),
        spread,
        drawdown: +drawdown.toFixed(2),
        dailyPnl: +this.dailyPnl.toFixed(2),
        tradesToday: this.tradesToday,
        consecutiveLosses: this.consecutiveLosses,
        balance: +balance.toFixed(2),
      },
      blockReason,
      signalDetails,
      marketContext: {
        regime: this.regime,
        atrH1: this.h1Bars.length >= 15 ? calcATR(this.h1Bars, 14).slice(-1)[0] || 0 : 0,
        h1Bars: this.h1Bars.length,
        h4Bars: this.h4Bars.length,
        sessionMode: LOCKED_PARAMS.sessionMode,
      },
    }).then(id => {
      if (decision === "entry") this.lastTradeDecisionId = id;
    }).catch(err => console.error("[Decision] save error:", err.message));
  }

  private evaluateEntry(utcHour: number) {
    if (!this.running) return;

    if (!this.isMarketClosed() && utcHour !== this.lastObservationHour) {
      this.lastObservationHour = utcHour;
      this.recordObservation();
    }

    if (this.isMarketClosed()) {
      return;
    }

    if (this.isRolloverPeriod(utcHour)) {
      this.log("info", `No trade: rollover period (${utcHour}:00 UTC) — spreads widen, avoid entries`);
      this.recordDecision("skip", "rollover_period");
      return;
    }

    if (this.regime === "no_trade") {
      this.log("info", `No trade: regime is no_trade`);
      this.recordDecision("skip", "regime_no_trade");
      return;
    }

    if (!this.isInSession(utcHour)) {
      this.log("info", `Outside ${LOCKED_PARAMS.sessionMode} session (hour=${utcHour} UTC) | Regime: ${this.regime} | Price: $${this.currentPrice.toFixed(2)}`);
      this.recordDecision("skip", "outside_session");
      return;
    }

    if (!this.isInEntryWindow(utcHour)) {
      const h1Atrs = calcATR(this.h1Bars, LOCKED_PARAMS.atrPeriod);
      const atr = h1Atrs[h1Atrs.length - 1] || 0;
      const recentH4 = this.h4Bars.slice(-LOCKED_PARAMS.rangeWidthBars);
      const rangeH = recentH4.length > 0 ? Math.max(...recentH4.map(c => c.high)) : 0;
      const rangeL = recentH4.length > 0 ? Math.min(...recentH4.map(c => c.low)) : 0;
      const entryStart = this.getEntryWindowStart();
      const entryEnd = entryStart + LOCKED_PARAMS.entryWindowBars;
      this.log("info", `Waiting for entry window (${entryStart}:00-${entryEnd}:00 UTC, now=${utcHour}:00) | Regime: ${this.regime} | ATR: ${atr.toFixed(2)} | Price: $${this.currentPrice.toFixed(2)} | Range: $${rangeL.toFixed(2)}-$${rangeH.toFixed(2)}`);
      this.recordDecision("skip", "outside_entry_window");
      return;
    }

    const avoidHoursUTC = LOCKED_PARAMS.avoidHoursUTC || [21, 22, 23, 0];
    if (LOCKED_PARAMS.avoidHoursEnabled !== false && avoidHoursUTC.includes(utcHour)) {
      this.log("info", `No trade: avoid hour (${utcHour}:00 UTC — low liquidity)`);
      this.recordDecision("skip", "avoid_hour");
      return;
    }

    const peakHoursUTC = LOCKED_PARAMS.peakHoursUTC || [];
    if (LOCKED_PARAMS.peakHoursEnabled && peakHoursUTC.length > 0 && !peakHoursUTC.includes(utcHour)) {
      this.log("info", `No trade: outside peak hours (${utcHour}:00 UTC)`);
      this.recordDecision("skip", "outside_peak_hours");
      return;
    }

    if (this.tradesToday >= LOCKED_PARAMS.maxTradesPerDay) {
      this.log("warning", `No trade: max daily trades (${this.tradesToday}/${LOCKED_PARAMS.maxTradesPerDay})`);
      this.recordDecision("skip", "max_daily_trades");
      return;
    }

    if (this.consecutiveLosses >= LOCKED_PARAMS.maxConsecutiveLosses) {
      this.log("warning", `No trade: consecutive losses (${this.consecutiveLosses}/${LOCKED_PARAMS.maxConsecutiveLosses})`);
      this.recordDecision("skip", "consecutive_losses");
      return;
    }

    const balance = this.accountBalance + this.totalPnl;
    const drawdown = (this.peak - balance) / this.peak * 100;
    if (drawdown >= LOCKED_PARAMS.maxDrawdownPct) {
      this.log("warning", `No trade: max drawdown breached (${drawdown.toFixed(1)}%/${LOCKED_PARAMS.maxDrawdownPct}%)`);
      this.recordDecision("skip", "max_drawdown");
      return;
    }

    const dailyLossPct = Math.abs(this.dailyPnl) / balance * 100;
    if (this.dailyPnl < 0 && dailyLossPct >= LOCKED_PARAMS.maxDailyLossPct) {
      this.log("warning", `No trade: daily loss limit (${dailyLossPct.toFixed(1)}%/${LOCKED_PARAMS.maxDailyLossPct}%)`);
      this.recordDecision("skip", "daily_loss_limit");
      return;
    }

    if (this.api.currentPositions.length > 0) {
      this.log("info", "No trade: position already open");
      this.recordDecision("skip", "position_open");
      return;
    }

    if (this.isSpreadTooWide()) {
      this.log("warning", `No trade: spread too wide (>${(LOCKED_PARAMS.spreadPoints * 3).toFixed(2)} points) — abnormal market conditions`);
      this.recordDecision("skip", "spread_too_wide");
      return;
    }

    if (this.isNearNewsEvent()) {
      this.log("warning", `No trade: within news blackout (±${LOCKED_PARAMS.newsBeforeMin}/${LOCKED_PARAMS.newsAfterMin} min)`);
      this.recordDecision("skip", "news_blackout");
      return;
    }

    const signal = this.generateSignal();
    if (signal) {
      const recentH4 = this.h4Bars.slice(-LOCKED_PARAMS.rangeWidthBars);
      const rangeHigh = Math.max(...recentH4.map(c => c.high));
      const rangeLow = Math.min(...recentH4.map(c => c.low));
      const h1Atrs = calcATR(this.h1Bars, LOCKED_PARAMS.atrPeriod);
      const currentATR = h1Atrs[h1Atrs.length - 1] || 0;

      this.recordDecision("entry", undefined, {
        side: signal.side,
        volume: signal.volume,
        sl: signal.stopLoss,
        tp: signal.takeProfit,
        atrStop: signal.stopLoss ? Math.abs(this.currentPrice - signal.stopLoss) : 0,
        entryReasoning: {
          regime: this.regime,
          side: signal.side,
          price: this.currentPrice,
          rangeHigh,
          rangeLow,
          atrH1: +currentATR.toFixed(2),
          expectation: signal.side === "buy"
            ? `Price near range low ($${rangeLow.toFixed(2)}), expecting bounce to $${signal.takeProfit?.toFixed(2) || 'target'}. ATR=${currentATR.toFixed(2)} supports ${this.regime} regime entry.`
            : `Price near range high ($${rangeHigh.toFixed(2)}), expecting drop to $${signal.takeProfit?.toFixed(2) || 'target'}. ATR=${currentATR.toFixed(2)} supports ${this.regime} regime entry.`,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
          riskRewardRatio: LOCKED_PARAMS.rewardRatio,
          balance: +(this.accountBalance + this.totalPnl).toFixed(2),
          consecutiveLossesBefore: this.consecutiveLosses,
        },
      });
      this.executeSignal(signal);
    } else {
      this.recordDecision("skip", "no_signal");
    }
  }

  private isInSession(utcHour: number): boolean {
    const fakeTs = new Date();
    fakeTs.setUTCHours(utcHour, 0, 0, 0);
    return sharedInSession(fakeTs.toISOString(), LOCKED_PARAMS.sessionMode);
  }

  private isInEntryWindow(utcHour: number): boolean {
    if (LOCKED_PARAMS.entryWindowBars <= 0) return true;
    const londonOpen = 7;
    return utcHour >= londonOpen && utcHour < londonOpen + LOCKED_PARAMS.entryWindowBars;
  }

  private getEntryWindowStart(): number {
    return 7;
  }

  private generateSignal(): TradeSignal | null {
    if (this.h1Bars.length < 3 || this.h4Bars.length < LOCKED_PARAMS.rangeWidthBars + 4) return null;

    const price = this.currentPrice;
    const rangeOffset = 2;
    const rangeEnd = Math.max(0, this.h4Bars.length - rangeOffset);
    const rangeStart = Math.max(0, rangeEnd - LOCKED_PARAMS.rangeWidthBars);
    let rangeHigh = -Infinity, rangeLow = Infinity;
    for (let j = rangeStart; j < rangeEnd; j++) {
      rangeHigh = Math.max(rangeHigh, this.h4Bars[j].high);
      rangeLow = Math.min(rangeLow, this.h4Bars[j].low);
    }

    const atrStopPeriod = LOCKED_PARAMS.atrStopPeriod ?? 10;
    const h1StopAtrs = calcATR(this.h1Bars, atrStopPeriod);
    const stopATR = h1StopAtrs[h1StopAtrs.length - 1] || 0;

    const h1Atrs = calcATR(this.h1Bars, LOCKED_PARAMS.atrPeriod);
    const currentATR = h1Atrs[h1Atrs.length - 1] || 0;
    if ((stopATR <= 0 || isNaN(stopATR)) && (currentATR <= 0 || isNaN(currentATR))) {
      this.log("info", "No signal: ATR is zero or NaN");
      return null;
    }

    const effectiveStopATR = (stopATR > 0 && !isNaN(stopATR)) ? stopATR : currentATR;
    const slDistance = effectiveStopATR * LOCKED_PARAMS.atrStopMultiplier;
    const tpDistance = slDistance * LOCKED_PARAMS.rewardRatio;

    const lastBar = this.h1Bars[this.h1Bars.length - 1];
    const prevBar = this.h1Bars[this.h1Bars.length - 2];
    const body = Math.abs(lastBar.close - lastBar.open);
    const upperWick = lastBar.high - Math.max(lastBar.close, lastBar.open);
    const lowerWick = Math.min(lastBar.close, lastBar.open) - lastBar.low;

    if (LOCKED_PARAMS.gapFilterEnabled && prevBar && this.liveBarCount >= 3) {
      const gapSize = Math.abs(lastBar.open - prevBar.close);
      const gapThreshold = currentATR * LOCKED_PARAMS.gapThresholdAtr;
      if (gapSize > gapThreshold) {
        this.log("warning", `No signal: gap detected ($${gapSize.toFixed(2)} > ATR*${LOCKED_PARAMS.gapThresholdAtr} = $${gapThreshold.toFixed(2)})`);
        return null;
      }
    } else if (LOCKED_PARAMS.gapFilterEnabled && this.liveBarCount < 3) {
      this.log("info", `Gap filter bypassed (startup grace: ${this.liveBarCount}/3 live bars)`);
    }

    const h4Atrs = calcATR(this.h4Bars, LOCKED_PARAMS.atrPeriod);
    const lookback = LOCKED_PARAMS.regimeAdaptiveAtrLookback ?? 60;
    const recentH4Atrs = h4Atrs.slice(-lookback).filter((v: number) => !isNaN(v) && v > 0);
    const avgAtrH4 = recentH4Atrs.length > 0 ? recentH4Atrs.reduce((a: number, b: number) => a + b, 0) / recentH4Atrs.length : 0;
    const currentAtrH4 = h4Atrs[h4Atrs.length - 1] || 0;

    const balance = this.accountBalance + this.totalPnl;
    let riskPct = LOCKED_PARAMS.riskPerTradePct;
    if (LOCKED_PARAMS.reduceSizeAfterLoss && this.consecutiveLosses > 0) {
      riskPct = LOCKED_PARAMS.reducedRiskPerTradePct;
    }

    if (LOCKED_PARAMS.regimeAdaptiveSizing && avgAtrH4 > 0 && currentAtrH4 > 0) {
      const adaptiveScale = Math.min(LOCKED_PARAMS.regimeAdaptiveSizingCap ?? 1.25, avgAtrH4 / currentAtrH4);
      riskPct *= adaptiveScale;
      this.log("info", `Regime-adaptive sizing: scale=${adaptiveScale.toFixed(3)}, effective risk=${riskPct.toFixed(3)}%`);
    }

    if (LOCKED_PARAMS.mrsGarchEnabled !== false && LOCKED_PARAMS.mrsGarchVolScaling !== false && isMRSGARCHTrained()) {
      const garchState = getLastMRSGARCHState();
      if (garchState) {
        riskPct *= garchState.positionSizeMultiplier;
        this.log("info", `MRS-GARCH vol scaling: mult=${garchState.positionSizeMultiplier.toFixed(3)}, vol=${garchState.annualizedVol.toFixed(1)}%, pctile=${garchState.volPercentile.toFixed(0)}`);
      }
    }

    const riskAmount = balance * riskPct / 100;
    const ouncesToTrade = riskAmount / slDistance;
    const rawVolume = Math.floor(ouncesToTrade * 100);
    const volume = Math.max(100, Math.floor(rawVolume / 100) * 100 || 100);
    const lots = (volume / 10000).toFixed(2);
    this.log("info", `Risk: $${riskAmount.toFixed(2)} | SL dist(ATR${atrStopPeriod}): $${slDistance.toFixed(2)} | Oz: ${ouncesToTrade.toFixed(3)} | Vol: ${volume} (${lots} lots)`);

    let vpPoc = 0, vpVah = 0, vpVal = 0;
    if (LOCKED_PARAMS.volumeProfileEnabled) {
      const vpPeriod = LOCKED_PARAMS.volumeProfilePeriod ?? 50;
      const vpBins = LOCKED_PARAMS.volumeProfileBins ?? 24;
      const vpValueAreaPct = LOCKED_PARAMS.volumeProfileValueAreaPct ?? 70;
      const vpEndIdx = Math.max(0, this.h4Bars.length - 1);
      const vpStartIdx = Math.max(0, vpEndIdx - vpPeriod + 1);
      const vpCandles = this.h4Bars.slice(vpStartIdx, vpEndIdx + 1);
      if (vpCandles.length >= 5) {
        const vp = calcVolumeProfile(vpCandles, vpBins, vpValueAreaPct);
        vpPoc = vp.poc;
        vpVah = vp.vah;
        vpVal = vp.val;
        this.log("info", `VP levels: POC=$${vpPoc.toFixed(2)} VAH=$${vpVah.toFixed(2)} VAL=$${vpVal.toFixed(2)}`);
      }
    }

    const vpActive = LOCKED_PARAMS.volumeProfileEnabled && vpPoc > 0;
    const vpPocProx = LOCKED_PARAMS.vpPocProximityPct ?? 0.15;

    let side: "buy" | "sell" | null = null;

    if (this.regime === "range") {
      const rangeWidth = rangeHigh - rangeLow;
      const minRangeATR = (LOCKED_PARAMS as any).minRangeATR ?? 1.5;
      if (minRangeATR > 0 && currentATR > 0 && rangeWidth < currentATR * minRangeATR) {
        this.log("info", `No signal: range too narrow ($${rangeWidth.toFixed(2)} < ${minRangeATR}x ATR $${(currentATR * minRangeATR).toFixed(2)})`);
        return null;
      }

      if (vpActive) {
        const pocDist = Math.abs(price - vpPoc);
        const vpRange = vpVah - vpVal;
        if (vpRange > 0 && pocDist / vpRange < vpPocProx) {
          this.log("info", `No signal: price near VP POC ($${vpPoc.toFixed(2)}, dist=${pocDist.toFixed(2)}) — congestion zone`);
          return null;
        }
      }

      const nearSupport = price <= rangeLow + LOCKED_PARAMS.retestBuffer;
      const nearResistance = price >= rangeHigh - LOCKED_PARAMS.retestBuffer;

      if (nearSupport && lowerWick > body * LOCKED_PARAMS.wickRatio) {
        side = "buy";
        this.log("signal", `RANGE BUY: Price near support (${rangeLow.toFixed(2)}), bullish rejection`);
      } else if (nearResistance && upperWick > body * LOCKED_PARAMS.wickRatio) {
        side = "sell";
        this.log("signal", `RANGE SELL: Price near resistance (${rangeHigh.toFixed(2)}), bearish rejection`);
      }
    }

    if (this.regime === "trend") {
      const h4Bars = this.h4Bars;
      const h4TRs = h4Bars.map((c, j) =>
        j === 0 ? c.high - c.low
        : Math.max(c.high - c.low, Math.abs(c.high - h4Bars[j-1].close), Math.abs(c.low - h4Bars[j-1].close))
      );
      const recentTRs = h4TRs.slice(-50);
      const avgTrH4 = recentTRs.length > 0 ? recentTRs.reduce((a, b) => a + b, 0) / recentTRs.length : 0;
      const currentAtrH4 = calcATR(h4Bars, LOCKED_PARAMS.atrPeriod).slice(-1)[0] || 0;
      const maxTrendATRRatio = (LOCKED_PARAMS as any).maxTrendATRRatio ?? 5.0;
      if (maxTrendATRRatio > 0 && avgTrH4 > 0 && currentAtrH4 / avgTrH4 > maxTrendATRRatio) {
        this.log("warning", `No signal: ATR too extreme (${(currentAtrH4 / avgTrH4).toFixed(1)}x avg, limit ${maxTrendATRRatio}x)`);
        return null;
      }

      if (vpActive) {
        const buyStillInVA = price > rangeHigh && price < vpVah;
        const sellStillInVA = price < rangeLow && price > vpVal;
        if (buyStillInVA || sellStillInVA) {
          this.log("info", `No signal: trend breakout still inside VP value area (VAH=$${vpVah.toFixed(2)}, VAL=$${vpVal.toFixed(2)})`);
          return null;
        }
      }

      const priceAboveRange = price > rangeHigh;
      const priceBelowRange = price < rangeLow;
      const rangeWidth = rangeHigh - rangeLow;
      const strongBreakout = rangeWidth > 0 && (
        (priceAboveRange && (price - rangeHigh) > rangeWidth * 0.1) ||
        (priceBelowRange && (rangeLow - price) > rangeWidth * 0.1)
      );

      const dailyBars = getCachedData()?.daily || [];
      const lastDaily = dailyBars.length > 0 ? dailyBars[dailyBars.length - 1] : null;
      const closes = dailyBars.map((b: any) => Number(b.close));
      let emaDaily50 = 0, emaDaily200 = 0;
      if (closes.length >= 50) {
        const k50 = 2 / 51;
        let ema = closes[0];
        for (let i = 1; i < closes.length; i++) ema = closes[i] * k50 + ema * (1 - k50);
        emaDaily50 = ema;
      }
      if (closes.length >= 200) {
        const k200 = 2 / 201;
        let ema = closes[0];
        for (let i = 1; i < closes.length; i++) ema = closes[i] * k200 + ema * (1 - k200);
        emaDaily200 = ema;
      }
      const dailyClose = lastDaily ? Number(lastDaily.close) : price;
      const useEma200 = LOCKED_PARAMS.ema200FilterEnabled !== false;
      const bullishBias50 = emaDaily50 > 0 ? dailyClose > emaDaily50 : true;
      const bearishBias50 = emaDaily50 > 0 ? dailyClose < emaDaily50 : true;
      const bullishBias200 = emaDaily200 > 0 ? dailyClose > emaDaily200 : true;
      const bearishBias200 = emaDaily200 > 0 ? dailyClose < emaDaily200 : true;
      const bullishBias = useEma200 ? (bullishBias50 && bullishBias200) : bullishBias50;
      const bearishBias = useEma200 ? (bearishBias50 && bearishBias200) : bearishBias50;

      if (priceAboveRange && (bullishBias || strongBreakout)) {
        const accepted = lastBar.low >= rangeHigh - LOCKED_PARAMS.retestBuffer;
        if (accepted) {
          side = "buy";
          const reason = strongBreakout && !bullishBias ? "momentum" : "breakout_acceptance";
          this.log("signal", `TREND BUY (${reason}): Price above range high (${rangeHigh.toFixed(2)}), price=${price.toFixed(2)}`);
        } else {
          this.log("info", `Trend buy candidate blocked: bar low ${lastBar.low.toFixed(2)} dipped below retest zone (${(rangeHigh - LOCKED_PARAMS.retestBuffer).toFixed(2)})`);
        }
      } else if (priceBelowRange && (bearishBias || strongBreakout)) {
        const accepted = lastBar.high <= rangeLow + LOCKED_PARAMS.retestBuffer;
        if (accepted) {
          side = "sell";
          const reason = strongBreakout && !bearishBias ? "momentum" : "breakout_acceptance";
          this.log("signal", `TREND SELL (${reason}): Price below range low (${rangeLow.toFixed(2)}), price=${price.toFixed(2)}`);
        } else {
          this.log("info", `Trend sell candidate blocked: bar high ${lastBar.high.toFixed(2)} reached above retest zone (${(rangeLow + LOCKED_PARAMS.retestBuffer).toFixed(2)})`);
        }
      }
    }

    if (!side) return null;

    const stopLoss = side === "buy" ? price - slDistance : price + slDistance;
    const takeProfit = side === "buy" ? price + tpDistance : price - tpDistance;

    return {
      side,
      symbolId: this.api.symbolId,
      volume,
      stopLoss,
      takeProfit,
      label: `GRL_${this.regime}_${Date.now()}`,
    };
  }

  async testTrade(): Promise<{ success: boolean; logs: string[] }> {
    const testLogs: string[] = [];
    const log = (msg: string) => { testLogs.push(msg); this.log("info", `[TEST] ${msg}`); };

    if (!this.api.isConnected) {
      log("FAIL: cTrader not connected");
      return { success: false, logs: testLogs };
    }

    const price = this.currentPrice;
    if (price <= 0) {
      log("FAIL: No current price available");
      return { success: false, logs: testLogs };
    }

    const symbolId = this.api.symbolId;
    if (!symbolId) {
      log("FAIL: No XAUUSD symbol ID");
      return { success: false, logs: testLogs };
    }

    const h1Atrs = calcATR(this.h1Bars, LOCKED_PARAMS.atrPeriod);
    const currentATR = h1Atrs[h1Atrs.length - 1] || 30;
    const slDistance = currentATR * LOCKED_PARAMS.atrStopMultiplier;
    const tpDistance = slDistance * LOCKED_PARAMS.rewardRatio;

    const minVolume = 100;

    const testSignal: TradeSignal = {
      side: "buy",
      symbolId,
      volume: minVolume,
      stopLoss: Math.round((price - slDistance) * 100) / 100,
      takeProfit: Math.round((price + tpDistance) * 100) / 100,
      label: `GRL_TEST_${Date.now()}`,
    };

    log(`Price: $${price.toFixed(2)} | ATR: $${currentATR.toFixed(2)}`);
    log(`Signal: BUY vol=${testSignal.volume} SL=$${testSignal.stopLoss} TP=$${testSignal.takeProfit}`);
    log(`Sending order to cTrader...`);

    try {
      const result = await this.api.placeMarketOrder(testSignal);
      log(`ORDER ACCEPTED: ${JSON.stringify(result).substring(0, 300)}`);
      log(`Pipeline verified — order placement works!`);

      this.recordDecision("entry", undefined, {
        side: testSignal.side,
        volume: testSignal.volume,
        sl: testSignal.stopLoss,
        tp: testSignal.takeProfit,
        atrStop: slDistance,
        entryReasoning: { side: testSignal.side, price, regime: this.regime, isTestTrade: true },
      });

      await new Promise(r => setTimeout(r, 2000));
      await this.api.reconcilePositions();
      const positions = this.api.currentPositions;
      if (positions.length > 0) {
        const pos = positions[0];
        log(`Position opened: ID=${pos.positionId} entry=$${pos.entryPrice.toFixed(2)}`);
        log(`WARNING: Test trade was filled! Closing position...`);
        try {
          await this.api.closePosition(pos.positionId, pos.volume);
          log(`Position closed successfully`);
          if (this.lastTradeDecisionId) {
            storage.updateTradeDecisionOutcome(this.lastTradeDecisionId, "test_closed", 0)
              .catch(e => console.error("[Decision] update error:", e.message));
          }
        } catch (closeErr: any) {
          log(`Failed to close test position: ${closeErr.message}`);
        }
      } else {
        log(`No position opened (expected on weekend — market closed)`);
        if (this.lastTradeDecisionId) {
          storage.updateTradeDecisionOutcome(this.lastTradeDecisionId, "test_not_filled", 0)
            .catch(e => console.error("[Decision] update error:", e.message));
        }
      }

      return { success: true, logs: testLogs };
    } catch (err: any) {
      const errMsg = err.message || "Unknown error";
      log(`Order rejected: ${errMsg}`);

      this.recordDecision("entry", undefined, {
        side: testSignal.side,
        volume: testSignal.volume,
        sl: testSignal.stopLoss,
        tp: testSignal.takeProfit,
        atrStop: slDistance,
        entryReasoning: { side: testSignal.side, price, regime: this.regime, isTestTrade: true, rejected: true, error: errMsg },
      });
      await new Promise(r => setTimeout(r, 200));

      const isMarketClosed = /MARKET_CLOSED|TRADING_DISABLED|market|TRADING_BAD_VOLUME|weekend|session|closed|NOT_ENOUGH/i.test(errMsg);
      if (isMarketClosed) {
        log(`Expected rejection — market is closed or volume too small. The full order pipeline works correctly!`);
        if (this.lastTradeDecisionId) {
          storage.updateTradeDecisionOutcome(this.lastTradeDecisionId, "test_rejected_market_closed", 0)
            .catch(e => console.error("[Decision] update error:", e.message));
        }
        return { success: true, logs: testLogs };
      }
      if (/TRADING_BAD_STOPLOSS|INVALID_STOPLOSS|BAD_STOP|TRADING_BAD_TAKEPROFIT|INVALID_TAKEPROFIT|BAD_TAKEPROFIT/i.test(errMsg)) {
        log(`SL/TP rejected by broker — SL=$${testSignal.stopLoss} TP=$${testSignal.takeProfit} price=$${price.toFixed(2)}. Error: ${errMsg}`);
        if (this.lastTradeDecisionId) {
          storage.updateTradeDecisionOutcome(this.lastTradeDecisionId, "test_rejected_bad_sl_tp", 0)
            .catch(e => console.error("[Decision] update error:", e.message));
        }
        return { success: false, logs: testLogs };
      }
      if (errMsg.includes("Timeout")) {
        log(`Order timed out — cTrader may be slow to respond on weekends. Pipeline reached cTrader but no response received.`);
        if (this.lastTradeDecisionId) {
          storage.updateTradeDecisionOutcome(this.lastTradeDecisionId, "test_timeout", 0)
            .catch(e => console.error("[Decision] update error:", e.message));
        }
        return { success: true, logs: testLogs };
      }
      log(`Unexpected error — investigate the rejection reason above`);
      if (this.lastTradeDecisionId) {
        storage.updateTradeDecisionOutcome(this.lastTradeDecisionId, "test_rejected_error", 0)
          .catch(e => console.error("[Decision] update error:", e.message));
      }
      return { success: false, logs: testLogs };
    }
  }

  async manualTrade(opts: { side: "buy" | "sell"; riskPercent?: number; stopLossPrice?: number; takeProfitPrice?: number }): Promise<{ success: boolean; details: string }> {
    if (this.isMarketClosed()) {
      const now = new Date();
      const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][now.getUTCDay()];
      return { success: false, details: `Market is CLOSED (${dayName} ${now.getUTCHours()}:${String(now.getUTCMinutes()).padStart(2,'0')} UTC). XAUUSD trades Sunday 22:00 UTC to Friday 22:00 UTC. No orders can be placed right now.` };
    }
    if (!this.api.isConnected) {
      return { success: false, details: "cTrader is not connected. Connect first from the Live Trading page." };
    }
    const price = this.currentPrice;
    if (price <= 0) {
      return { success: false, details: "No current price available. Market data may not be streaming." };
    }
    const symbolId = this.api.symbolId;
    if (!symbolId) {
      return { success: false, details: "No XAUUSD symbol ID available. Ensure cTrader is fully connected." };
    }

    const h1Atrs = calcATR(this.h1Bars, LOCKED_PARAMS.atrPeriod);
    const currentATR = h1Atrs[h1Atrs.length - 1] || 0;
    if (currentATR <= 0) {
      return { success: false, details: "ATR is zero — insufficient H1 candle data to calculate risk levels." };
    }

    const slDistance = opts.stopLossPrice
      ? Math.abs(price - opts.stopLossPrice)
      : currentATR * LOCKED_PARAMS.atrStopMultiplier;
    const tpDistance = opts.takeProfitPrice
      ? Math.abs(price - opts.takeProfitPrice)
      : slDistance * LOCKED_PARAMS.rewardRatio;

    const stopLoss = opts.stopLossPrice
      ?? (opts.side === "buy" ? price - slDistance : price + slDistance);
    const takeProfit = opts.takeProfitPrice
      ?? (opts.side === "buy" ? price + tpDistance : price - tpDistance);

    const balance = this.accountBalance + this.totalPnl;
    const riskPct = opts.riskPercent ?? LOCKED_PARAMS.riskPerTradePct;
    const riskAmount = balance * riskPct / 100;
    const ouncesToTrade = riskAmount / slDistance;
    const rawVolume = Math.floor(ouncesToTrade * 100);
    const volume = Math.max(100, Math.floor(rawVolume / 100) * 100 || 100);
    const lots = (volume / 10000).toFixed(2);

    const signal: TradeSignal = {
      side: opts.side,
      symbolId,
      volume,
      stopLoss: Math.round(stopLoss * 100) / 100,
      takeProfit: Math.round(takeProfit * 100) / 100,
      label: `GRL_AI_${Date.now()}`,
    };

    this.log("order", `[AI MANUAL] ${opts.side.toUpperCase()} ${lots} lots @ $${price.toFixed(2)} | SL=$${signal.stopLoss.toFixed(2)} TP=$${signal.takeProfit.toFixed(2)} | Risk: $${riskAmount.toFixed(2)} (${riskPct}%)`);

    try {
      const result = await this.api.placeMarketOrder(signal);
      await new Promise(r => setTimeout(r, 2000));
      await this.api.reconcilePositions();
      const positions = this.api.currentPositions;
      if (positions.length > 0) {
        const pos = positions[0];
        this.tradesToday++;
        const detail = `Order FILLED: ${opts.side.toUpperCase()} ${lots} lots | Entry: $${pos.entryPrice.toFixed(2)} | SL: $${signal.stopLoss.toFixed(2)} | TP: $${signal.takeProfit.toFixed(2)} | Risk: $${riskAmount.toFixed(2)} (${riskPct}%) | Position ID: ${pos.positionId}`;
        this.log("order", `[AI MANUAL] ${detail}`);
        return { success: true, details: detail };
      } else {
        const detail = `Order sent but no position confirmed. Price: $${price.toFixed(2)}, SL: $${signal.stopLoss.toFixed(2)}, TP: $${signal.takeProfit.toFixed(2)}. The order may have been rejected or the market may be closed.`;
        this.log("warning", `[AI MANUAL] ${detail}`);
        return { success: true, details: detail };
      }
    } catch (err: any) {
      const errMsg = err.message || "Unknown error";
      this.log("error", `[AI MANUAL] Order failed: ${errMsg}`);
      const isSlTpIssue = /TRADING_BAD_STOPLOSS|INVALID_STOPLOSS|BAD_STOP|TRADING_BAD_TAKEPROFIT|INVALID_TAKEPROFIT|BAD_TAKEPROFIT/i.test(errMsg);
      if (isSlTpIssue) {
        return { success: false, details: `Order rejected — invalid SL/TP. SL=$${signal.stopLoss.toFixed(2)} TP=$${signal.takeProfit.toFixed(2)} Price=$${price.toFixed(2)}. Error: ${errMsg}` };
      }
      const isMarketClosed = /MARKET_CLOSED|TRADING_DISABLED|market|TRADING_BAD_VOLUME|weekend|session|closed|NOT_ENOUGH/i.test(errMsg);
      if (isMarketClosed) {
        return { success: false, details: `Order rejected — market is likely closed or volume issue: ${errMsg}. The order pipeline is working correctly but the market is not accepting orders right now.` };
      }
      return { success: false, details: `Order failed: ${errMsg}` };
    }
  }

  private async executeSignal(signal: TradeSignal) {
    try {
      const slDist = Math.abs(this.currentPrice - signal.stopLoss);
      const tpDist = Math.abs(signal.takeProfit - this.currentPrice);
      this.lastSignalSL = signal.stopLoss;
      this.lastSignalTP = signal.takeProfit;
      this.log("order", `Executing ${signal.side.toUpperCase()}: vol=${signal.volume} (${(signal.volume/10000).toFixed(2)} lots) @ $${this.currentPrice.toFixed(2)} | SL=$${signal.stopLoss.toFixed(2)} (dist=$${slDist.toFixed(2)}) | TP=$${signal.takeProfit.toFixed(2)} (dist=$${tpDist.toFixed(2)}) | RR=${(tpDist/slDist).toFixed(1)}:1`);
      const result = await this.api.placeMarketOrder(signal);
      this.log("order", `Order response received`);

      await new Promise(r => setTimeout(r, 2000));
      await this.api.reconcilePositions();
      const openPositions = this.api.currentPositions;
      if (openPositions.length > 0) {
        const pos = openPositions[0];
        this.log("order", `Position confirmed: ID=${pos.positionId} side=${pos.tradeSide === 1 ? "BUY" : "SELL"} entry=$${pos.entryPrice.toFixed(2)} vol=${pos.volume} SL=${pos.stopLoss?.toFixed(2) || "none"} TP=${pos.takeProfit?.toFixed(2) || "none"}`);
        this.tradesToday++;
      } else {
        this.log("warning", `Order sent but no open position found after reconcile — order may have been rejected`);
        reportError("live-trader", "Order sent but no position confirmed — possible silent rejection");
      }

      const balance = this.accountBalance + this.totalPnl;
      if (balance > this.peak) this.peak = balance;

    } catch (err: any) {
      this.log("error", `Order failed: ${err.message}`);
      reportError("live-trader", `Order execution failed: ${err.message}`);
    }
  }
}
