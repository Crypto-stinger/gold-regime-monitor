import { z } from "zod";

export * from "./models/auth";

export type RegimeState = "range" | "trend" | "no_trade";

export type StrategyMode = "regime" | "rsi_bot";

export const backtestConfigSchema = z.object({
  strategyMode: z.enum(["regime", "rsi_bot"]).default("regime"),
  startingBalance: z.number().min(100).max(1000000).default(3000),
  lotSize: z.number().min(0.01).max(100).default(1),
  atrPeriod: z.number().min(5).max(50).default(14),
  atrStopMultiplier: z.number().min(0.5).max(5).default(2.0),
  rewardRatio: z.number().min(1).max(20).default(2.0),
  rsiPeriod: z.number().min(5).max(50).default(14),
  rsiOverbought: z.number().min(50).max(95).default(70),
  rsiOversold: z.number().min(5).max(50).default(30),
  rsiRewardRatio: z.number().min(0).max(20).default(0),
  maxDailyLossUSD: z.number().min(0).max(100000).default(500),
  compressionThreshold: z.number().min(0.001).max(0.1).default(0.022),
  expansionThreshold: z.number().min(1.0).max(3).default(1.15),
  rangeWidthBars: z.number().min(5).max(50).default(8),
  midpointBandPct: z.number().min(0.01).max(0.5).default(0.10),
  retestBuffer: z.number().min(0.5).max(50).default(12.0),
  minRangeATR: z.number().min(0).max(10).default(1.5),
  maxTrendATRRatio: z.number().min(1).max(20).default(5.0),
  wickRatio: z.number().min(0.3).max(5).default(0.6),
  executionTimeframe: z.enum(["1h", "15min", "1min"]).default("1h"),
  sessionMode: z.enum(["London+NewYork", "London", "NewYork", "Asian", "Asian+London", "Asian+London+NewYork", "All"]).default("London+NewYork"),
  entryWindowBars: z.number().min(0).max(12).default(0),
  maxTradesPerDay: z.number().min(1).max(10).default(5),
  newsBeforeMin: z.number().min(0).max(240).default(30),
  newsAfterMin: z.number().min(0).max(240).default(30),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  gapFilterEnabled: z.boolean().default(true),
  gapThresholdAtr: z.number().min(0.1).max(5).default(0.5),
  gapCooldownBars: z.number().min(1).max(12).default(2),
  sessionORBEnabled: z.boolean().default(true),
  trailingStopEnabled: z.boolean().default(false),
  trailingStopTriggerR: z.number().min(0.5).max(10).default(1.0),
  riskPerTradePct: z.number().min(0.1).max(10).default(0.75),
  leverage: z.number().min(1).max(10).default(10),
  maxDrawdownPct: z.number().min(5).max(25).default(25),
  maxDailyLossPct: z.number().min(0.5).max(20).default(2.0),
  maxConsecutiveLosses: z.number().min(1).max(20).default(2),

  postLossCooldownBars: z.number().min(0).max(20).default(2),
  reduceSizeAfterLoss: z.boolean().default(true),
  reducedRiskPerTradePct: z.number().min(0.1).max(10).default(0.50),
  atrRiskScaleEnabled: z.boolean().default(true),
  atrRiskScaleThreshold: z.number().min(0.5).max(5).default(1.25),
  atrRiskScaleFactor: z.number().min(0.1).max(1).default(0.65),
  secondTradeRiskFactor: z.number().min(0.1).max(1).default(0.75),
  regimeAdaptiveSizing: z.boolean().default(false),
  regimeAdaptiveSizingCap: z.number().min(1).max(3).default(1.25),
  regimeAdaptiveAtrLookback: z.number().min(10).max(200).default(60),
  atrStopPeriod: z.number().min(3).max(50).default(14),
  ema200FilterEnabled: z.boolean().default(false),
  spreadPoints: z.number().min(0).max(5).default(0.30),
  slippagePoints: z.number().min(0).max(5).default(0.10),
  commissionPerLot: z.number().min(0).max(50).default(0),
  gvzEnabled: z.boolean().default(false),
  gvzRangeThreshold: z.number().min(5).max(50).default(25),
  gvzTrendThreshold: z.number().min(50).max(95).default(75),
  cotEnabled: z.boolean().default(false),
  cotBullishThreshold: z.number().min(50).max(95).default(75),
  cotBearishThreshold: z.number().min(5).max(50).default(25),
  peakHoursEnabled: z.boolean().default(false),
  peakHoursUTC: z.array(z.number().min(0).max(23)).default([]),
  avoidHoursEnabled: z.boolean().default(false),
  avoidHoursUTC: z.array(z.number().min(0).max(23)).default([21, 22, 23, 0]),
  volumeProfileEnabled: z.boolean().default(false),
  volumeProfilePeriod: z.number().min(10).max(200).default(50),
  volumeProfileBins: z.number().min(10).max(100).default(24),
  volumeProfileValueAreaPct: z.number().min(50).max(95).default(70),
  vpPocProximityPct: z.number().min(0.01).max(0.5).default(0.15),
  sgeEnabled: z.boolean().default(false),
  sgeBullishThreshold: z.number().min(0).max(100).default(10),
  sgeBearishThreshold: z.number().min(-50).max(10).default(-5),
  hmmEnabled: z.boolean().default(false),
  hmmConfidenceThreshold: z.number().min(0).max(1).default(0.85),
  mrsGarchEnabled: z.boolean().default(false),
  mrsGarchVolScaling: z.boolean().default(false),
  mrsGarchHighVolThreshold: z.number().min(50).max(99).default(75),
  mrsGarchLowVolThreshold: z.number().min(1).max(50).default(25),
});

export type BacktestConfig = z.infer<typeof backtestConfigSchema>;

export type Candle = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type EnrichedCandle = Candle & {
  atr_h1: number;
  atr_h4: number;
  ema_daily: number;
  ema_daily_200: number;
  daily_close: number;
  bb_width_h4: number;
  bb_width_percentile: number;
  adx_h4: number;
  gvz: number;
  gvz_percentile: number;
  cot_net: number;
  cot_net_pct: number;
  vp_poc: number;
  vp_vah: number;
  vp_val: number;
  sge_premium: number;
  hmm_state?: string;
  hmm_confidence?: number;
  garch_volatility?: number;
  garch_forecast?: number;
  mrs_position_multiplier?: number;
};

export type Trade = {
  id: string;
  entryTime: string;
  exitTime: string;
  side: "buy" | "sell";
  regime: RegimeState;
  entryReason: string;
  exitReason: "stop" | "target";
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  takeProfit: number;
  pnl: number;
  resultR: number;
  balance: number;
  atrAtEntry?: number;
  rangeHigh?: number;
  rangeLow?: number;
  rangeMid?: number;
  wickSize?: number;
  bodySize?: number;
  wickToBodyRatio?: number;
  signalType?: string;
};

export type EquityPoint = {
  time: string;
  balance: number;
  drawdown: number;
  drawdownPct: number;
  tradeIndex: number;
};

export type BacktestDiagnostics = {
  blockedBySession: number;
  blockedByNews: number;
  blockedByGap: number;
  blockedByMidpointBand: number;
  blockedByRetestDistance: number;
  blockedByNarrowRange: number;
  blockedByExtremeATR: number;
  blockedByWickRatio: number;
  blockedByCompression: number;
  blockedByExpansion: number;
  blockedByEntryWindow: number;
  blockedByPeakHours: number;
  blockedByAvoidHours: number;
  blockedByVolumeProfile: number;
  blockedByMaxTradesPerDay: number;
  blockedByMaxDrawdown: number;
  blockedByDailyLossLimit: number;
  blockedByConsecutiveLossLimit: number;
  reducedSizeAfterLossCount: number;
  atrScaledRiskCount: number;
  secondTradeReducedRiskCount: number;
  buyCandidates: number;
  sellCandidates: number;
  acceptedBuyTrades: number;
  acceptedSellTrades: number;
};

export type BacktestStats = {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  returnPct: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  avgR: number;
  rangeTrades: number;
  trendTrades: number;
  noTradeBarCount: number;
  rangeWins: number;
  rangeLosses: number;
  trendWins: number;
  trendLosses: number;
  rangePnl: number;
  trendPnl: number;
  rangeWinRate: number;
  trendWinRate: number;
  finalBalance: number;
  avgHoldingBars: number;
  consecutiveWins: number;
  consecutiveLosses: number;
};

export type HourlyPerformance = {
  hour: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnl: number;
  avgR: number;
  rangeTrades: number;
  trendTrades: number;
};

export type DayOfWeekPerformance = {
  day: number;
  dayName: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnl: number;
  avgR: number;
};

export type BacktestResult = {
  id: string;
  config: BacktestConfig;
  trades: Trade[];
  stats: BacktestStats;
  equityCurve: EquityPoint[];
  regimeCounts: { range: number; trend: number; no_trade: number };
  monthlyReturns: { month: string; return: number; trades: number }[];
  hourlyPerformance?: HourlyPerformance[];
  dayOfWeekPerformance?: DayOfWeekPerformance[];
  diagnostics: BacktestDiagnostics;
  dataSource: "real" | "synthetic";
  archived?: boolean;
  archiveReason?: string | null;
  label?: string | null;
  createdAt: string;
};

export type SavedStrategy = {
  id: string;
  name: string;
  category: string;
  config: BacktestConfig;
  stats: BacktestStats;
  diagnostics?: BacktestDiagnostics;
  notes?: string;
  createdAt: string;
};

export type UploadedData = {
  m1?: Candle[];
  m15?: Candle[];
  h1: Candle[];
  h4: Candle[];
  daily: Candle[];
  events?: { timestamp: string }[];
  gvz?: { date: string; value: number }[];
  cot?: { date: string; noncommLong: number; noncommShort: number; netPosition: number; openInterest: number }[];
  sge?: { date: string; premium: number }[];
};
