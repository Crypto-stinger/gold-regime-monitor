import type { BacktestConfig, BacktestStats, SavedStrategy } from "../shared/schema";
import { validateStrategy, getRiskRating } from "./risk-validator";

function generateParamSection(c: BacktestConfig, locked: boolean): string {
  if (!locked) {
    return `// ── Core Parameters ──────────────────────────────────────────
        [Parameter("Starting Balance", Group = "Account", DefaultValue = ${c.startingBalance})]
        public double StartingBalance { get; set; }

        [Parameter("Lot Size (fallback)", Group = "Account", DefaultValue = ${c.lotSize}, MinValue = 0.01, MaxValue = 100)]
        public double LotSize { get; set; }

        [Parameter("ATR Period", Group = "Indicators", DefaultValue = ${c.atrPeriod}, MinValue = 5, MaxValue = 50)]
        public int AtrPeriod { get; set; }

        [Parameter("ATR Stop Multiplier", Group = "Entry", DefaultValue = ${c.atrStopMultiplier}, MinValue = 0.5, MaxValue = 5.0, Step = 0.1)]
        public double AtrStopMultiplier { get; set; }

        [Parameter("Reward:Risk Ratio", Group = "Entry", DefaultValue = ${c.rewardRatio}, MinValue = 1.0, MaxValue = 20.0, Step = 0.1)]
        public double RewardRatio { get; set; }

        // ── Regime Detection ─────────────────────────────────────────
        [Parameter("Compression Threshold", Group = "Regime", DefaultValue = ${c.compressionThreshold}, MinValue = 0.001, MaxValue = 0.1, Step = 0.001)]
        public double CompressionThreshold { get; set; }

        [Parameter("Expansion Threshold", Group = "Regime", DefaultValue = ${c.expansionThreshold}, MinValue = 1.01, MaxValue = 3.0, Step = 0.01)]
        public double ExpansionThreshold { get; set; }

        [Parameter("Range Width Bars (H4)", Group = "Regime", DefaultValue = ${c.rangeWidthBars}, MinValue = 5, MaxValue = 50)]
        public int RangeWidthBars { get; set; }

        [Parameter("Midpoint Band %", Group = "Regime", DefaultValue = ${c.midpointBandPct}, MinValue = 0.01, MaxValue = 0.5, Step = 0.01)]
        public double MidpointBandPct { get; set; }

        [Parameter("Min Range ATR", Group = "Regime", DefaultValue = ${c.minRangeATR ?? 1.5}, MinValue = 0.5, MaxValue = 10.0, Step = 0.1)]
        public double MinRangeATR { get; set; }

        [Parameter("Max Trend ATR Ratio", Group = "Regime", DefaultValue = ${c.maxTrendATRRatio ?? 5.0}, MinValue = 1.0, MaxValue = 20.0, Step = 0.5)]
        public double MaxTrendATRRatio { get; set; }

        // ── Entry Filters ────────────────────────────────────────────
        [Parameter("Retest Buffer", Group = "Entry", DefaultValue = ${c.retestBuffer}, MinValue = 0.5, MaxValue = 50.0, Step = 0.5)]
        public double RetestBuffer { get; set; }

        [Parameter("Wick Ratio", Group = "Entry", DefaultValue = ${c.wickRatio}, MinValue = 0.3, MaxValue = 5.0, Step = 0.1)]
        public double WickRatio { get; set; }

        // ── Session Filter ───────────────────────────────────────────
        [Parameter("Execution Timeframe", Group = "Session", DefaultValue = "${c.executionTimeframe ?? '1h'}")]
        public string ExecutionTimeframe { get; set; }

        [Parameter("Session Mode", Group = "Session", DefaultValue = "${c.sessionMode}")]
        public string SessionMode { get; set; }

        [Parameter("Entry Window Bars", Group = "Session", DefaultValue = ${c.entryWindowBars}, MinValue = 0, MaxValue = 12)]
        public int EntryWindowBars { get; set; }

        [Parameter("Max Trades Per Day", Group = "Session", DefaultValue = ${c.maxTradesPerDay}, MinValue = 1, MaxValue = 10)]
        public int MaxTradesPerDay { get; set; }

        // ── News Blackout Filter ─────────────────────────────────────
        [Parameter("News Before Minutes", Group = "News", DefaultValue = ${c.newsBeforeMin}, MinValue = 0, MaxValue = 240)]
        public int NewsBeforeMin { get; set; }

        [Parameter("News After Minutes", Group = "News", DefaultValue = ${c.newsAfterMin}, MinValue = 0, MaxValue = 240)]
        public int NewsAfterMin { get; set; }

        // ── Gap Filter ───────────────────────────────────────────────
        [Parameter("Gap Filter Enabled", Group = "Filters", DefaultValue = ${c.gapFilterEnabled})]
        public bool GapFilterEnabled { get; set; }

        [Parameter("Gap Threshold ATR", Group = "Filters", DefaultValue = ${c.gapThresholdAtr}, MinValue = 0.1, MaxValue = 5.0, Step = 0.1)]
        public double GapThresholdAtr { get; set; }

        [Parameter("Gap Cooldown Bars", Group = "Filters", DefaultValue = ${c.gapCooldownBars}, MinValue = 1, MaxValue = 12)]
        public int GapCooldownBars { get; set; }

        // ── Trailing Stop ────────────────────────────────────────────
        [Parameter("Trailing Stop Enabled", Group = "StopManagement", DefaultValue = ${c.trailingStopEnabled})]
        public bool TrailingStopEnabled { get; set; }

        [Parameter("Trailing Trigger (R)", Group = "StopManagement", DefaultValue = ${c.trailingStopTriggerR}, MinValue = 0.5, MaxValue = 10.0, Step = 0.1)]
        public double TrailingStopTriggerR { get; set; }

        // ── Risk Management ──────────────────────────────────────────
        [Parameter("Risk Per Trade %", Group = "Risk", DefaultValue = ${c.riskPerTradePct}, MinValue = 0.1, MaxValue = 10.0, Step = 0.05)]
        public double RiskPerTradePct { get; set; }

        [Parameter("Leverage", Group = "Risk", DefaultValue = ${Math.min(c.leverage, 10)}, MinValue = 1, MaxValue = 10)]
        public int Leverage { get; set; }

        [Parameter("Max Drawdown %", Group = "Risk", DefaultValue = ${Math.min(c.maxDrawdownPct, 25)}, MinValue = 5, MaxValue = 25)]
        public double MaxDrawdownPct { get; set; }

        [Parameter("Max Daily Loss %", Group = "Risk", DefaultValue = ${c.maxDailyLossPct}, MinValue = 0.5, MaxValue = 20.0, Step = 0.5)]
        public double MaxDailyLossPct { get; set; }

        [Parameter("Max Consecutive Losses", Group = "Risk", DefaultValue = ${c.maxConsecutiveLosses}, MinValue = 1, MaxValue = 20)]
        public int MaxConsecutiveLosses { get; set; }

        [Parameter("Post-Loss Cooldown Bars", Group = "Risk", DefaultValue = ${c.postLossCooldownBars}, MinValue = 0, MaxValue = 20)]
        public int PostLossCooldownBars { get; set; }

        [Parameter("Reduce Size After Loss", Group = "Risk", DefaultValue = ${c.reduceSizeAfterLoss})]
        public bool ReduceSizeAfterLoss { get; set; }

        [Parameter("Reduced Risk %", Group = "Risk", DefaultValue = ${c.reducedRiskPerTradePct}, MinValue = 0.1, MaxValue = 10.0, Step = 0.05)]
        public double ReducedRiskPerTradePct { get; set; }

        // ── ATR Risk Scaling ─────────────────────────────────────────
        [Parameter("ATR Risk Scale Enabled", Group = "Risk", DefaultValue = ${c.atrRiskScaleEnabled})]
        public bool AtrRiskScaleEnabled { get; set; }

        [Parameter("ATR Risk Scale Threshold", Group = "Risk", DefaultValue = ${c.atrRiskScaleThreshold}, MinValue = 1.01, MaxValue = 5.0, Step = 0.01)]
        public double AtrRiskScaleThreshold { get; set; }

        [Parameter("ATR Risk Scale Factor", Group = "Risk", DefaultValue = ${c.atrRiskScaleFactor}, MinValue = 0.1, MaxValue = 1.0, Step = 0.05)]
        public double AtrRiskScaleFactor { get; set; }

        [Parameter("2nd Trade Risk Factor", Group = "Risk", DefaultValue = ${c.secondTradeRiskFactor}, MinValue = 0.1, MaxValue = 1.0, Step = 0.05)]
        public double SecondTradeRiskFactor { get; set; }

        // ── ORB Filter ───────────────────────────────────────────────
        [Parameter("Session ORB Enabled", Group = "Filters", DefaultValue = ${c.sessionORBEnabled})]
        public bool SessionORBEnabled { get; set; }`;
  }
  
  // LOCKED VERSION — Critical params are hardcoded constants
  return `// ── LOCKED PARAMETERS (Hardcoded) ──────────────────────────────
        private const double EXPANSION_THRESHOLD = ${c.expansionThreshold};
        private const double COMPRESSION_THRESHOLD = ${c.compressionThreshold};
        private const double ATR_STOP_MULTIPLIER = ${c.atrStopMultiplier};
        private const double REWARD_RATIO = ${c.rewardRatio};
        private const int RANGE_WIDTH_BARS = ${c.rangeWidthBars};
        private const int ENTRY_WINDOW_BARS = ${c.entryWindowBars};
        private const double WICK_RATIO = ${c.wickRatio};
        private const double MIDPOINT_BAND_PCT = ${c.midpointBandPct};
        private const double MIN_RANGE_ATR = ${c.minRangeATR ?? 1.5};
        private const double MAX_TREND_ATR_RATIO = ${c.maxTrendATRRatio ?? 5.0};
        private const string SESSION_MODE = "${c.sessionMode}";

        // ── Core Parameters (Adjustable) ────────────────────────────────────────
        [Parameter("Starting Balance", Group = "Account", DefaultValue = ${c.startingBalance})]
        public double StartingBalance { get; set; }

        [Parameter("Lot Size (fallback)", Group = "Account", DefaultValue = ${c.lotSize}, MinValue = 0.01, MaxValue = 100)]
        public double LotSize { get; set; }

        [Parameter("ATR Period", Group = "Indicators", DefaultValue = ${c.atrPeriod}, MinValue = 5, MaxValue = 50)]
        public int AtrPeriod { get; set; }

        // ── Entry Filters (Adjustable) ──────────────────────────────────────────
        [Parameter("Retest Buffer", Group = "Entry", DefaultValue = ${c.retestBuffer}, MinValue = 0.5, MaxValue = 50.0, Step = 0.5)]
        public double RetestBuffer { get; set; }

        // ── Session Filter (Adjustable) ─────────────────────────────────────────
        [Parameter("Execution Timeframe", Group = "Session", DefaultValue = "${c.executionTimeframe ?? '1h'}")]
        public string ExecutionTimeframe { get; set; }

        [Parameter("Max Trades Per Day", Group = "Session", DefaultValue = ${c.maxTradesPerDay}, MinValue = 1, MaxValue = 10)]
        public int MaxTradesPerDay { get; set; }

        // ── News Blackout Filter (Adjustable) ───────────────────────────────────
        [Parameter("News Before Minutes", Group = "News", DefaultValue = ${c.newsBeforeMin}, MinValue = 0, MaxValue = 240)]
        public int NewsBeforeMin { get; set; }

        [Parameter("News After Minutes", Group = "News", DefaultValue = ${c.newsAfterMin}, MinValue = 0, MaxValue = 240)]
        public int NewsAfterMin { get; set; }

        // ── Gap Filter (Adjustable) ─────────────────────────────────────────────
        [Parameter("Gap Filter Enabled", Group = "Filters", DefaultValue = ${c.gapFilterEnabled})]
        public bool GapFilterEnabled { get; set; }

        [Parameter("Gap Threshold ATR", Group = "Filters", DefaultValue = ${c.gapThresholdAtr}, MinValue = 0.1, MaxValue = 5.0, Step = 0.1)]
        public double GapThresholdAtr { get; set; }

        [Parameter("Gap Cooldown Bars", Group = "Filters", DefaultValue = ${c.gapCooldownBars}, MinValue = 1, MaxValue = 12)]
        public int GapCooldownBars { get; set; }

        // ── Trailing Stop (Adjustable) ──────────────────────────────────────────
        [Parameter("Trailing Stop Enabled", Group = "StopManagement", DefaultValue = ${c.trailingStopEnabled})]
        public bool TrailingStopEnabled { get; set; }

        [Parameter("Trailing Trigger (R)", Group = "StopManagement", DefaultValue = ${c.trailingStopTriggerR}, MinValue = 0.5, MaxValue = 10.0, Step = 0.1)]
        public double TrailingStopTriggerR { get; set; }

        // ── Risk Management (Adjustable) ────────────────────────────────────────
        [Parameter("Risk Per Trade %", Group = "Risk", DefaultValue = ${c.riskPerTradePct}, MinValue = 0.1, MaxValue = 10.0, Step = 0.05)]
        public double RiskPerTradePct { get; set; }

        [Parameter("Leverage", Group = "Risk", DefaultValue = ${Math.min(c.leverage, 10)}, MinValue = 1, MaxValue = 10)]
        public int Leverage { get; set; }

        [Parameter("Max Drawdown %", Group = "Risk", DefaultValue = ${Math.min(c.maxDrawdownPct, 25)}, MinValue = 5, MaxValue = 25)]
        public double MaxDrawdownPct { get; set; }

        [Parameter("Max Daily Loss %", Group = "Risk", DefaultValue = ${c.maxDailyLossPct}, MinValue = 0.5, MaxValue = 20.0, Step = 0.5)]
        public double MaxDailyLossPct { get; set; }

        [Parameter("Max Consecutive Losses", Group = "Risk", DefaultValue = ${c.maxConsecutiveLosses}, MinValue = 1, MaxValue = 20)]
        public int MaxConsecutiveLosses { get; set; }

        [Parameter("Post-Loss Cooldown Bars", Group = "Risk", DefaultValue = ${c.postLossCooldownBars}, MinValue = 0, MaxValue = 20)]
        public int PostLossCooldownBars { get; set; }

        [Parameter("Reduce Size After Loss", Group = "Risk", DefaultValue = ${c.reduceSizeAfterLoss})]
        public bool ReduceSizeAfterLoss { get; set; }

        [Parameter("Reduced Risk %", Group = "Risk", DefaultValue = ${c.reducedRiskPerTradePct}, MinValue = 0.1, MaxValue = 10.0, Step = 0.05)]
        public double ReducedRiskPerTradePct { get; set; }

        // ── ATR Risk Scaling (Adjustable) ───────────────────────────────────────
        [Parameter("ATR Risk Scale Enabled", Group = "Risk", DefaultValue = ${c.atrRiskScaleEnabled})]
        public bool AtrRiskScaleEnabled { get; set; }

        [Parameter("ATR Risk Scale Threshold", Group = "Risk", DefaultValue = ${c.atrRiskScaleThreshold}, MinValue = 1.01, MaxValue = 5.0, Step = 0.01)]
        public double AtrRiskScaleThreshold { get; set; }

        [Parameter("ATR Risk Scale Factor", Group = "Risk", DefaultValue = ${c.atrRiskScaleFactor}, MinValue = 0.1, MaxValue = 1.0, Step = 0.05)]
        public double AtrRiskScaleFactor { get; set; }

        [Parameter("2nd Trade Risk Factor", Group = "Risk", DefaultValue = ${c.secondTradeRiskFactor}, MinValue = 0.1, MaxValue = 1.0, Step = 0.05)]
        public double SecondTradeRiskFactor { get; set; }

        // ── ORB Filter (Adjustable) ─────────────────────────────────────────────
        [Parameter("Session ORB Enabled", Group = "Filters", DefaultValue = ${c.sessionORBEnabled})]
        public bool SessionORBEnabled { get; set;}`;
}

export function generateCTraderBot(strategy: SavedStrategy, locked: boolean = false): string {
  const c = strategy.config;
  const label = sanitizeLabel(strategy.name);
  const className = toPascalCase(label);
  const warnings = validateStrategy(c);
  const riskRating = getRiskRating(c, warnings);

  let warningBlock = "";
  if (warnings.length > 0) {
    warningBlock = `//
// ╔═══════════════════════════════════════════════════════════╗
// ║  RISK WARNINGS — ${warnings.length} parameter(s) outside safe definitions  ║
// ║  Computed Risk Rating: ${riskRating.padEnd(8)} RR=${c.rewardRatio}:1 Risk=${c.riskPerTradePct}% Lev=${c.leverage}x  ║
// ╚═══════════════════════════════════════════════════════════╝
${warnings.map(w => `// ${w.severity === "CRITICAL" ? "▲ CRITICAL" : w.severity === "WARN" ? "● WARNING " : "○ INFO    "}: ${w.message}`).join("\n")}
`;
  } else {
    warningBlock = `//
// ✓ All parameters within safe definitions — no risk warnings
// Computed Risk Rating: ${riskRating} | RR=${c.rewardRatio}:1 Risk=${c.riskPerTradePct}% Lev=${c.leverage}x
`;
  }

  const lockedNote = locked ? `//
// ⚠️  BULLETPROOF VERSION — CRITICAL PARAMETERS ARE LOCKED
// The following parameters are HARDCODED and cannot be changed:
//   • Expansion Threshold: ${c.expansionThreshold}
//   • Compression Threshold: ${c.compressionThreshold}
//   • ATR Stop Multiplier: ${c.atrStopMultiplier}
//   • Reward:Risk Ratio: ${c.rewardRatio}
//   • Range Width Bars: ${c.rangeWidthBars}
//   • Entry Window Bars: ${c.entryWindowBars}
//   • Wick Ratio: ${c.wickRatio}
//   • Midpoint Band %: ${c.midpointBandPct}
//
// Only SAFE parameters remain adjustable: Leverage, Risk%, Lot Size, Max DD, etc.
// Changing locked parameters requires full recompilation.
// ═════════════════════════════════════════════════════════════
` : "";

  const paramSection = generateParamSection(c, locked);

  return `// ═══════════════════════════════════════════════════════════════
// ${strategy.name}
// Category: ${strategy.category} | Generated: ${new Date().toISOString().substring(0, 10)}
// Gold Regime Lab v3 — XAUUSD 3-State Regime cBot
// ═══════════════════════════════════════════════════════════════
// Backtest Stats: Return ${strategy.stats.returnPct}% | WR ${strategy.stats.winRate}% | PF ${strategy.stats.profitFactor} | MaxDD ${strategy.stats.maxDrawdownPct}%
// Trades: ${strategy.stats.totalTrades} (${strategy.stats.wins}W/${strategy.stats.losses}L) | AvgR ${strategy.stats.avgR}
// ═══════════════════════════════════════════════════════════════
${lockedNote}${warningBlock}
using System;
using System.Collections.Generic;
using System.Linq;
using cAlgo.API;
using cAlgo.API.Indicators;
using cAlgo.API.Internals;
using cAlgo.Indicators;

namespace cAlgo.Robots
{
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.None)]
    public class ${className} : Robot
    {
        // ── Core Parameters ──────────────────────────────────────────
        [Parameter("Starting Balance", Group = "Account", DefaultValue = ${c.startingBalance})]
        public double StartingBalance { get; set; }

        [Parameter("Lot Size (fallback)", Group = "Account", DefaultValue = ${c.lotSize}, MinValue = 0.01, MaxValue = 100)]
        public double LotSize { get; set; }

        [Parameter("ATR Period", Group = "Indicators", DefaultValue = ${c.atrPeriod}, MinValue = 5, MaxValue = 50)]
        public int AtrPeriod { get; set; }

        [Parameter("ATR Stop Multiplier", Group = "Entry", DefaultValue = ${c.atrStopMultiplier}, MinValue = 0.5, MaxValue = 5.0, Step = 0.1)]
        public double AtrStopMultiplier { get; set; }

        [Parameter("Reward:Risk Ratio", Group = "Entry", DefaultValue = ${c.rewardRatio}, MinValue = 1.0, MaxValue = 20.0, Step = 0.1)]
        public double RewardRatio { get; set; }

        // ── Regime Detection ─────────────────────────────────────────
        [Parameter("Compression Threshold", Group = "Regime", DefaultValue = ${c.compressionThreshold}, MinValue = 0.001, MaxValue = 0.1, Step = 0.001)]
        public double CompressionThreshold { get; set; }

        [Parameter("Expansion Threshold", Group = "Regime", DefaultValue = ${c.expansionThreshold}, MinValue = 1.01, MaxValue = 3.0, Step = 0.01)]
        public double ExpansionThreshold { get; set; }

        [Parameter("Range Width Bars (H4)", Group = "Regime", DefaultValue = ${c.rangeWidthBars}, MinValue = 5, MaxValue = 50)]
        public int RangeWidthBars { get; set; }

        [Parameter("Midpoint Band %", Group = "Regime", DefaultValue = ${c.midpointBandPct}, MinValue = 0.01, MaxValue = 0.5, Step = 0.01)]
        public double MidpointBandPct { get; set; }

        [Parameter("Min Range ATR", Group = "Regime", DefaultValue = ${c.minRangeATR ?? 1.5}, MinValue = 0.5, MaxValue = 10.0, Step = 0.1)]
        public double MinRangeATR { get; set; }

        [Parameter("Max Trend ATR Ratio", Group = "Regime", DefaultValue = ${c.maxTrendATRRatio ?? 5.0}, MinValue = 1.0, MaxValue = 20.0, Step = 0.5)]
        public double MaxTrendATRRatio { get; set; }

        // ── Entry Filters ────────────────────────────────────────────
        [Parameter("Retest Buffer", Group = "Entry", DefaultValue = ${c.retestBuffer}, MinValue = 0.5, MaxValue = 50.0, Step = 0.5)]
        public double RetestBuffer { get; set; }

        [Parameter("Wick Ratio", Group = "Entry", DefaultValue = ${c.wickRatio}, MinValue = 0.3, MaxValue = 5.0, Step = 0.1)]
        public double WickRatio { get; set; }

        // ── Session Filter ───────────────────────────────────────────
        [Parameter("Execution Timeframe", Group = "Session", DefaultValue = "${c.executionTimeframe ?? '1h'}")]
        public string ExecutionTimeframe { get; set; }

        [Parameter("Session Mode", Group = "Session", DefaultValue = "${c.sessionMode}")]
        public string SessionMode { get; set; }

        [Parameter("Entry Window Bars", Group = "Session", DefaultValue = ${c.entryWindowBars}, MinValue = 0, MaxValue = 12)]
        public int EntryWindowBars { get; set; }

        [Parameter("Max Trades Per Day", Group = "Session", DefaultValue = ${c.maxTradesPerDay}, MinValue = 1, MaxValue = 10)]
        public int MaxTradesPerDay { get; set; }

        // ── News Blackout Filter ─────────────────────────────────────
        [Parameter("News Before Minutes", Group = "News", DefaultValue = ${c.newsBeforeMin}, MinValue = 0, MaxValue = 240)]
        public int NewsBeforeMin { get; set; }

        [Parameter("News After Minutes", Group = "News", DefaultValue = ${c.newsAfterMin}, MinValue = 0, MaxValue = 240)]
        public int NewsAfterMin { get; set; }

        // ── Gap Filter ───────────────────────────────────────────────
        [Parameter("Gap Filter Enabled", Group = "Filters", DefaultValue = ${c.gapFilterEnabled})]
        public bool GapFilterEnabled { get; set; }

        [Parameter("Gap Threshold ATR", Group = "Filters", DefaultValue = ${c.gapThresholdAtr}, MinValue = 0.1, MaxValue = 5.0, Step = 0.1)]
        public double GapThresholdAtr { get; set; }

        [Parameter("Gap Cooldown Bars", Group = "Filters", DefaultValue = ${c.gapCooldownBars}, MinValue = 1, MaxValue = 12)]
        public int GapCooldownBars { get; set; }

        // ── Trailing Stop ────────────────────────────────────────────
        [Parameter("Trailing Stop Enabled", Group = "StopManagement", DefaultValue = ${c.trailingStopEnabled})]
        public bool TrailingStopEnabled { get; set; }

        [Parameter("Trailing Trigger (R)", Group = "StopManagement", DefaultValue = ${c.trailingStopTriggerR}, MinValue = 0.5, MaxValue = 10.0, Step = 0.1)]
        public double TrailingStopTriggerR { get; set; }

        // ── Risk Management ──────────────────────────────────────────
        [Parameter("Risk Per Trade %", Group = "Risk", DefaultValue = ${c.riskPerTradePct}, MinValue = 0.1, MaxValue = 10.0, Step = 0.05)]
        public double RiskPerTradePct { get; set; }

        [Parameter("Leverage", Group = "Risk", DefaultValue = ${Math.min(c.leverage, 10)}, MinValue = 1, MaxValue = 10)]
        public int Leverage { get; set; }

        [Parameter("Max Drawdown %", Group = "Risk", DefaultValue = ${Math.min(c.maxDrawdownPct, 25)}, MinValue = 5, MaxValue = 25)]
        public double MaxDrawdownPct { get; set; }

        [Parameter("Max Daily Loss %", Group = "Risk", DefaultValue = ${c.maxDailyLossPct}, MinValue = 0.5, MaxValue = 20.0, Step = 0.5)]
        public double MaxDailyLossPct { get; set; }

        [Parameter("Max Consecutive Losses", Group = "Risk", DefaultValue = ${c.maxConsecutiveLosses}, MinValue = 1, MaxValue = 20)]
        public int MaxConsecutiveLosses { get; set; }

        [Parameter("Post-Loss Cooldown Bars", Group = "Risk", DefaultValue = ${c.postLossCooldownBars}, MinValue = 0, MaxValue = 20)]
        public int PostLossCooldownBars { get; set; }

        [Parameter("Reduce Size After Loss", Group = "Risk", DefaultValue = ${c.reduceSizeAfterLoss})]
        public bool ReduceSizeAfterLoss { get; set; }

        [Parameter("Reduced Risk %", Group = "Risk", DefaultValue = ${c.reducedRiskPerTradePct}, MinValue = 0.1, MaxValue = 10.0, Step = 0.05)]
        public double ReducedRiskPerTradePct { get; set; }

        // ── ATR Risk Scaling ─────────────────────────────────────────
        [Parameter("ATR Risk Scale Enabled", Group = "Risk", DefaultValue = ${c.atrRiskScaleEnabled})]
        public bool AtrRiskScaleEnabled { get; set; }

        [Parameter("ATR Risk Scale Threshold", Group = "Risk", DefaultValue = ${c.atrRiskScaleThreshold}, MinValue = 1.01, MaxValue = 5.0, Step = 0.01)]
        public double AtrRiskScaleThreshold { get; set; }

        [Parameter("ATR Risk Scale Factor", Group = "Risk", DefaultValue = ${c.atrRiskScaleFactor}, MinValue = 0.1, MaxValue = 1.0, Step = 0.05)]
        public double AtrRiskScaleFactor { get; set; }

        [Parameter("2nd Trade Risk Factor", Group = "Risk", DefaultValue = ${c.secondTradeRiskFactor}, MinValue = 0.1, MaxValue = 1.0, Step = 0.05)]
        public double SecondTradeRiskFactor { get; set; }

        // ── ORB Filter ───────────────────────────────────────────────
        [Parameter("Session ORB Enabled", Group = "Filters", DefaultValue = ${c.sessionORBEnabled})]
        public bool SessionORBEnabled { get; set; }

        // ── Indicators ───────────────────────────────────────────────
        private AverageTrueRange _atrH1;
        private AverageTrueRange _atrH4;
        private ExponentialMovingAverage _emaDaily;
        private BollingerBands _bbH4;
        private Bars _h4Bars;
        private Bars _dailyBars;

        // ── State ────────────────────────────────────────────────────
        private double _peak;
        private int _consecutiveLosses;
        private int _cooldownBarsRemaining;
        private bool _lastTradeWasLoss;
        private int _gapCooldownRemaining;
        private DateTime _lastTradeDay;
        private int _dailyTradeCount;
        private double _dailyLoss;
        private bool _orbValid;
        private bool _orbBullish;
        private DateTime _orbDay;
        private string _botLabel;
        private List<DateTime> _newsEvents;

        protected override void OnStart()
        {
            _botLabel = "${className}_" + Server.Time.Ticks;
            _peak = StartingBalance;
            _consecutiveLosses = 0;
            _cooldownBarsRemaining = 0;
            _lastTradeWasLoss = false;
            _gapCooldownRemaining = 0;
            _lastTradeDay = DateTime.MinValue;
            _dailyTradeCount = 0;
            _dailyLoss = 0;
            _orbValid = false;
            _orbDay = DateTime.MinValue;
            _newsEvents = new List<DateTime>();

            _h4Bars = MarketData.GetBars(TimeFrame.Hour4);
            _dailyBars = MarketData.GetBars(TimeFrame.Daily);

            // Wilder's smoothing period N is equivalent to EMA with period 2N-1
            // Our backtest uses Wilder's smoothing — this conversion ensures exact match
            var wilderPeriod = 2 * AtrPeriod - 1;
            _atrH1 = Indicators.AverageTrueRange(wilderPeriod, MovingAverageType.Exponential);
            _atrH4 = Indicators.AverageTrueRange(_h4Bars, wilderPeriod, MovingAverageType.Exponential);
            _emaDaily = Indicators.ExponentialMovingAverage(_dailyBars.ClosePrices, 50);
            _bbH4 = Indicators.BollingerBands(_h4Bars.ClosePrices, 20, 2, MovingAverageType.Simple);

            Positions.Closed += OnPositionClosed;

            // NOTE: Populate _newsEvents with your economic calendar dates
            // e.g. NFP, CPI, FOMC, PPI, Retail Sales
            // _newsEvents.Add(new DateTime(2024, 1, 5, 13, 30, 0)); // NFP example

            Print("${className} started — ${strategy.category} risk category");
            Print("Config: RR=" + RewardRatio + " ATR=" + AtrStopMultiplier + " Risk=" + RiskPerTradePct + "% Lev=" + Leverage + "x");
        }

        protected override void OnBar()
        {
            var currentTime = Server.Time;
            var hour = currentTime.Hour;

            // Reset daily counters
            if (currentTime.Date != _lastTradeDay.Date)
            {
                _dailyTradeCount = 0;
                _dailyLoss = 0;
                _lastTradeDay = currentTime;
                Print($"[{currentTime:yyyy-MM-dd HH:mm}] New day — counters reset. H4 bars: {_h4Bars.Count}, H1 bars: {Bars.Count}");
            }

            // ── Session filter ──
            if (!InSession(hour))
            {
                Print($"[{currentTime:yyyy-MM-dd HH:mm}] Outside session window (hour={hour})");
                return;
            }

            // ── Entry window filter ──
            if (!InEntryWindow(hour))
            {
                Print($"[{currentTime:yyyy-MM-dd HH:mm}] Outside entry window (hour={hour}, window={EntryWindowBars} bars)");
                return;
            }

            // ── News blackout filter ──
            if (IsNewsBlackout(currentTime))
            {
                Print($"[{currentTime:yyyy-MM-dd HH:mm}] In news blackout");
                return;
            }

            // ── Gap filter ──
            if (GapFilterEnabled && Bars.ClosePrices.Count >= 2)
            {
                var gap = Math.Abs(Bars.OpenPrices.LastValue - Bars.ClosePrices.Last(1));
                var atr = _atrH1.Result.LastValue;
                if (atr > 0 && gap >= atr * GapThresholdAtr)
                {
                    Print($"[{currentTime:yyyy-MM-dd HH:mm}] Gap detected: {gap} >= {atr * GapThresholdAtr}");
                    _gapCooldownRemaining = GapCooldownBars;
                }
            }

            if (_gapCooldownRemaining > 0)
            {
                _gapCooldownRemaining--;
                Print($"[{currentTime:yyyy-MM-dd HH:mm}] Gap cooldown remaining: {_gapCooldownRemaining}");
                return;
            }

            // ── ORB tracking ──
            if (SessionORBEnabled)
            {
                if (IsSessionOpenCandle(hour))
                {
                    _orbBullish = Bars.ClosePrices.LastValue > Bars.OpenPrices.LastValue;
                    _orbDay = currentTime.Date;
                    _orbValid = true;
                    Print($"[{currentTime:yyyy-MM-dd HH:mm}] SESSION OPEN CANDLE detected! ORB={(_orbBullish ? "BULLISH" : "BEARISH")}");
                }
                if (_orbDay != currentTime.Date)
                {
                    _orbValid = false;
                    Print($"[{currentTime:yyyy-MM-dd HH:mm}] ORB day mismatch — ORB invalidated");
                }
                if (!_orbValid)
                {
                    Print($"[{currentTime:yyyy-MM-dd HH:mm}] ORB not valid");
                    return;
                }
            }

            // ── Skip if already have max positions ──
            if (_dailyTradeCount >= MaxTradesPerDay)
            {
                Print($"[{currentTime:yyyy-MM-dd HH:mm}] Daily trade limit reached ({_dailyTradeCount}/{MaxTradesPerDay})");
                return;
            }

            // ── Skip if already in a position ──
            var myPositions = Positions.FindAll(_botLabel, SymbolName);
            if (myPositions.Length > 0)
            {
                Print($"[{currentTime:yyyy-MM-dd HH:mm}] Already in position");
                return;
            }

            // ── Cooldown after consecutive losses ──
            if (_cooldownBarsRemaining > 0)
            {
                _cooldownBarsRemaining--;
                Print($"[{currentTime:yyyy-MM-dd HH:mm}] Post-loss cooldown: {_cooldownBarsRemaining} bars remaining");
                return;
            }

            // ── Drawdown circuit breaker ──
            var currentDD = _peak > 0 ? ((_peak - Account.Balance) / _peak) * 100 : 0;
            if (currentDD >= MaxDrawdownPct)
            {
                Print($"[{currentTime:yyyy-MM-dd HH:mm}] MAX DRAWDOWN BREAKER: {currentDD:F2}% >= {MaxDrawdownPct}%");
                return;
            }

            // ── Daily loss limit (based on StartingBalance to match backtest) ──
            var dailyLossCap = StartingBalance * (MaxDailyLossPct / 100);
            if (_dailyLoss >= dailyLossCap)
            {
                Print($"[{currentTime:yyyy-MM-dd HH:mm}] DAILY LOSS LIMIT HIT: {_dailyLoss:F2} >= {dailyLossCap:F2}");
                return;
            }

            // ── Compute H4 range ──
            if (_h4Bars.Count < RangeWidthBars + 2)
            {
                Print($"[{currentTime:yyyy-MM-dd HH:mm}] Not enough H4 bars: {_h4Bars.Count} < {RangeWidthBars + 2}");
                return;
            }

            var rangeOffset = 2;
            var rangeEnd = Math.Max(0, _h4Bars.Count - rangeOffset);
            var rangeStart = Math.Max(0, rangeEnd - RangeWidthBars);

            if (rangeEnd - rangeStart < RangeWidthBars)
                return;

            double rangeHigh = double.MinValue;
            double rangeLow = double.MaxValue;
            for (int j = rangeStart; j < rangeEnd; j++)
            {
                if (_h4Bars.HighPrices[j] > rangeHigh) rangeHigh = _h4Bars.HighPrices[j];
                if (_h4Bars.LowPrices[j] < rangeLow) rangeLow = _h4Bars.LowPrices[j];
            }
            var rangeMid = (rangeHigh + rangeLow) / 2;
            var rangeWidth = rangeHigh - rangeLow;
            if (rangeWidth <= 0)
                return;

            // ── Compute average H4 true range (matches backtest: raw TR average) ──
            int atrLookback = 50;
            int trStart = Math.Max(1, _h4Bars.Count - atrLookback);
            double avgTrH4 = 0;
            int trCount = 0;
            for (int j = trStart; j < _h4Bars.Count; j++)
            {
                double tr = Math.Max(
                    _h4Bars.HighPrices[j] - _h4Bars.LowPrices[j],
                    Math.Max(
                        Math.Abs(_h4Bars.HighPrices[j] - _h4Bars.ClosePrices[j - 1]),
                        Math.Abs(_h4Bars.LowPrices[j] - _h4Bars.ClosePrices[j - 1])
                    )
                );
                avgTrH4 += tr;
                trCount++;
            }
            avgTrH4 = trCount > 0 ? avgTrH4 / trCount : 0;

            // ── Classify regime ──
            var price = Bars.ClosePrices.LastValue;
            var atrH4 = _atrH4.Result.LastValue;
            var bbMain = _bbH4.Main.LastValue;
            // Backtest uses bbWidth = (2*std)/mean; cTrader BB top-bottom = 4*std, so divide by 2 to match
            var bbWidth = bbMain > 0 ? (_bbH4.Top.LastValue - _bbH4.Bottom.LastValue) / (2.0 * bbMain) : double.NaN;

            if (double.IsNaN(atrH4) || double.IsNaN(avgTrH4) || avgTrH4 <= 0)
                return;

            var atrExpanding = atrH4 > avgTrH4 * ExpansionThreshold;
            var priceAboveRange = price > rangeHigh;
            var priceBelowRange = price < rangeLow;
            var priceInsideRange = price >= rangeLow && price <= rangeHigh;

            var band = rangeWidth * MidpointBandPct;
            var inMidpoint = price >= rangeMid - band && price <= rangeMid + band;

            string regime;
            if (atrExpanding && (priceAboveRange || priceBelowRange))
                regime = "trend";
            else if (inMidpoint)
                return;
            else if (!atrExpanding && priceInsideRange && (!double.IsNaN(bbWidth) && bbWidth < CompressionThreshold || atrH4 <= avgTrH4))
                regime = "range";
            else
                return;

            // ── Midpoint band block ──
            if (inMidpoint)
                return;

            // ── Compute stop distance ──
            var atrH1 = _atrH1.Result.LastValue;
            var stopDistance = atrH1 * AtrStopMultiplier;
            if (stopDistance <= 0)
                return;

            // ── Risk sizing ──
            double effectiveRiskPct = RiskPerTradePct;

            if (ReduceSizeAfterLoss && _lastTradeWasLoss)
                effectiveRiskPct = ReducedRiskPerTradePct;

            if (_dailyTradeCount >= 1)
                effectiveRiskPct *= SecondTradeRiskFactor;

            if (AtrRiskScaleEnabled && avgTrH4 > 0)
            {
                var atrRatio = atrH4 / avgTrH4;
                if (atrRatio > AtrRiskScaleThreshold)
                    effectiveRiskPct *= AtrRiskScaleFactor;
            }

            var riskDollars = Account.Balance * (effectiveRiskPct / 100);
            var stopPips = stopDistance / Symbol.PipSize;
            var pipValue = Symbol.PipValue;
            double volumeInUnits;
            if (stopPips > 0 && pipValue > 0)
                volumeInUnits = Math.Max(Symbol.VolumeInUnitsMin,
                    Symbol.NormalizeVolumeInUnits((riskDollars / (stopPips * pipValue)) * Leverage));
            else
                volumeInUnits = Symbol.NormalizeVolumeInUnits(Symbol.QuantityToVolumeInUnits(LotSize));

            // ── Daily EMA bias ──
            var dailyClose = _dailyBars.Count > 0 ? _dailyBars.ClosePrices.LastValue : price;
            var emaDaily = _emaDaily.Result.LastValue;
            var bullishBias = dailyClose > emaDaily;
            var bearishBias = dailyClose < emaDaily;

            // ── Candle anatomy ──
            var open = Bars.OpenPrices.LastValue;
            var high = Bars.HighPrices.LastValue;
            var low = Bars.LowPrices.LastValue;
            var close = Bars.ClosePrices.LastValue;
            var body = Math.Abs(close - open);
            var upperWick = high - Math.Max(open, close);
            var lowerWick = Math.Min(open, close) - low;

            var tpPips = stopPips * RewardRatio;

            // ── RANGE regime entries ──
            if (regime == "range")
            {
                // Narrow range filter — skip if range width < minRangeATR * H1 ATR
                if (MinRangeATR > 0 && atrH1 > 0 && rangeWidth < atrH1 * MinRangeATR)
                    return;

                var nearResistance = high >= rangeHigh - RetestBuffer;
                var nearSupport = low <= rangeLow + RetestBuffer;

                // Sell at resistance
                if (nearResistance && (bearishBias || !bullishBias))
                {
                    if (IsBearishRejection(body, upperWick, close, open))
                    {
                        if (OrbAligns("sell"))
                        {
                            ExecuteMarketOrder(TradeType.Sell, SymbolName, volumeInUnits, _botLabel,
                                stopPips, tpPips, "Range_Resistance_Rejection");
                            _dailyTradeCount++;
                            return;
                        }
                    }
                }

                // Buy at support
                if (nearSupport && (bullishBias || !bearishBias))
                {
                    if (IsBullishRejection(body, lowerWick, close, open))
                    {
                        if (OrbAligns("buy"))
                        {
                            ExecuteMarketOrder(TradeType.Buy, SymbolName, volumeInUnits, _botLabel,
                                stopPips, tpPips, "Range_Support_Rejection");
                            _dailyTradeCount++;
                            return;
                        }
                    }
                }
            }

            // ── TREND regime entries ──
            if (regime == "trend")
            {
                // Extreme ATR filter — skip trend trades if ATR expansion is excessive
                if (MaxTrendATRRatio > 0 && avgTrH4 > 0 && atrH4 / avgTrH4 > MaxTrendATRRatio)
                    return;

                var strongBreakout = rangeWidth > 0 && (
                    (priceAboveRange && (close - rangeHigh) > rangeWidth * 0.1) ||
                    (priceBelowRange && (rangeLow - close) > rangeWidth * 0.1)
                );

                // Long breakout
                if (priceAboveRange && (bullishBias || strongBreakout))
                {
                    var accepted = low >= rangeHigh - RetestBuffer;
                    if (accepted && OrbAligns("buy"))
                    {
                        var label = strongBreakout && !bullishBias ? "Trend_Momentum_Long" : "Trend_Breakout_Long";
                        ExecuteMarketOrder(TradeType.Buy, SymbolName, volumeInUnits, _botLabel,
                            stopPips, tpPips, label);
                        _dailyTradeCount++;
                        return;
                    }
                }

                // Short breakdown
                if (priceBelowRange && (bearishBias || strongBreakout))
                {
                    var accepted = high <= rangeLow + RetestBuffer;
                    if (accepted && OrbAligns("sell"))
                    {
                        var label = strongBreakout && !bearishBias ? "Trend_Momentum_Short" : "Trend_Breakout_Short";
                        ExecuteMarketOrder(TradeType.Sell, SymbolName, volumeInUnits, _botLabel,
                            stopPips, tpPips, label);
                        _dailyTradeCount++;
                        return;
                    }
                }
            }
        }

        private void OnPositionClosed(PositionClosedEventArgs args)
        {
            var pos = args.Position;
            if (pos.Label != _botLabel || pos.SymbolName != SymbolName)
                return;

            if (Account.Balance > _peak)
                _peak = Account.Balance;

            if (pos.NetProfit < 0)
            {
                _dailyLoss += Math.Abs(pos.NetProfit);
                _consecutiveLosses++;
                _lastTradeWasLoss = true;
                if (_consecutiveLosses >= MaxConsecutiveLosses)
                    _cooldownBarsRemaining = PostLossCooldownBars;
            }
            else
            {
                _consecutiveLosses = 0;
                _lastTradeWasLoss = false;
            }
        }

        protected override void OnTick()
        {
            if (!TrailingStopEnabled)
                return;

            foreach (var pos in Positions.FindAll(_botLabel, SymbolName))
            {
                if (pos.StopLoss == null)
                    continue;

                var riskDistance = Math.Abs(pos.EntryPrice - pos.StopLoss.Value);
                var triggerDistance = riskDistance * TrailingStopTriggerR;

                if (pos.TradeType == TradeType.Buy)
                {
                    if (Symbol.Bid >= pos.EntryPrice + triggerDistance && pos.StopLoss < pos.EntryPrice)
                        ModifyPosition(pos, pos.EntryPrice, pos.TakeProfit, ProtectionType.Absolute);
                }
                else
                {
                    if (Symbol.Ask <= pos.EntryPrice - triggerDistance && pos.StopLoss > pos.EntryPrice)
                        ModifyPosition(pos, pos.EntryPrice, pos.TakeProfit, ProtectionType.Absolute);
                }
            }
        }

        // ── Helper Methods ───────────────────────────────────────────

        private bool InSession(int utcHour)
        {
            switch (SessionMode)
            {
                case "Asian": return utcHour >= 0 && utcHour < 7;
                case "Asian+London": return utcHour >= 0 && utcHour < 16;
                case "London": return utcHour >= 7 && utcHour < 16;
                case "NewYork": return utcHour >= 12 && utcHour < 21;
                case "London+NewYork": return utcHour >= 7 && utcHour < 21;
                case "Asian+London+NewYork": return utcHour >= 0 && utcHour < 21;
                case "All": return true;
                default: return utcHour >= 7 && utcHour < 21;
            }
        }

        private bool InEntryWindow(int utcHour)
        {
            if (EntryWindowBars <= 0) return true;
            int openHour = GetSessionOpenHour();
            int windowEnd = openHour + EntryWindowBars;
            if (windowEnd <= 24)
                return utcHour >= openHour && utcHour < windowEnd;
            return utcHour >= openHour || utcHour < (windowEnd % 24);
        }

        private int GetSessionOpenHour()
        {
            switch (SessionMode)
            {
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

        private bool IsSessionOpenCandle(int utcHour)
        {
            return utcHour == GetSessionOpenHour();
        }

        private bool IsNewsBlackout(DateTime currentTime)
        {
            if (NewsBeforeMin == 0 && NewsAfterMin == 0)
                return false;
            foreach (var ev in _newsEvents)
            {
                var before = ev.AddMinutes(-NewsBeforeMin);
                var after = ev.AddMinutes(NewsAfterMin);
                if (currentTime >= before && currentTime <= after)
                    return true;
            }
            return false;
        }

        private bool OrbAligns(string side)
        {
            if (!SessionORBEnabled)
                return true;
            if (!_orbValid)
                return false;
            if (side == "buy") return _orbBullish;
            return !_orbBullish;
        }

        private bool IsBearishRejection(double body, double upperWick, double close, double open)
        {
            if (body <= 0) return false;
            if (upperWick / body < WickRatio) return false;
            return close < open;
        }

        private bool IsBullishRejection(double body, double lowerWick, double close, double open)
        {
            if (body <= 0) return false;
            if (lowerWick / body < WickRatio) return false;
            return close > open;
        }

        protected override void OnStop()
        {
            Print("${className} stopped. Final balance: " + Account.Balance);
        }
    }
}
`;
}

function sanitizeLabel(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .replace(/\s+/g, "_")
    .substring(0, 60);
}

function toPascalCase(str: string): string {
  return str
    .split(/[\s_-]+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

export function lockCriticalParameters(code: string, config: BacktestConfig): string {
  // Define locked constants block
  const lockedConstants = `        // ═══════════════════════════════════════════════════════════════
        // BULLETPROOF: Critical Regime Parameters are LOCKED and HARDCODED
        // These cannot be changed without full recompilation
        // ═══════════════════════════════════════════════════════════════
        private const double EXPANSION_THRESHOLD = ${config.expansionThreshold};
        private const double COMPRESSION_THRESHOLD = ${config.compressionThreshold};
        private const double ATR_STOP_MULTIPLIER = ${config.atrStopMultiplier};
        private const double REWARD_RATIO = ${config.rewardRatio};
        private const int RANGE_WIDTH_BARS = ${config.rangeWidthBars};
        private const int ENTRY_WINDOW_BARS = ${config.entryWindowBars};
        private const double WICK_RATIO = ${config.wickRatio};
        private const double MIDPOINT_BAND_PCT = ${config.midpointBandPct};
        private const string SESSION_MODE = "${config.sessionMode}";
        private const bool SESSION_ORB_ENABLED = ${config.sessionORBEnabled ? 'true' : 'false'};

`;

  let modified = code;

  // Remove [Parameter] decorators for locked params and their public properties
  const lockedParamNames = [
    "AtrStopMultiplier",
    "RewardRatio",
    "CompressionThreshold",
    "ExpansionThreshold",
    "RangeWidthBars",
    "MidpointBandPct",
    "EntryWindowBars",
    "WickRatio",
    "SessionMode",
    "SessionORBEnabled"
  ];

  for (const paramName of lockedParamNames) {
    // Remove the entire [Parameter(...)] line and public property block
    const pattern = new RegExp(
      `\\s*\\[Parameter\\([^)]*\\)\\]\\s*public\\s+\\w+\\s+${paramName}\\s*\\{\\s*get;\\s*set;\\s*\\}\\s*`,
      'g'
    );
    modified = modified.replace(pattern, '\n        ');
  }

  // Insert locked constants right before "// ── Indicators"
  modified = modified.replace(
    /(\s+\/\/ ── Indicators )/,
    `${lockedConstants}        $1`
  );

  return modified;
}

export function generateStrategyJSON(strategy: SavedStrategy): string {
  return JSON.stringify({
    name: strategy.name,
    category: strategy.category,
    version: "GoldRegimeLab_v3",
    exportedAt: new Date().toISOString(),
    platform: "cTrader",
    symbol: "XAUUSD",
    timeframe: "H1",
    config: strategy.config,
    stats: strategy.stats,
    diagnostics: strategy.diagnostics || null,
    notes: strategy.notes || null,
  }, null, 2);
}
