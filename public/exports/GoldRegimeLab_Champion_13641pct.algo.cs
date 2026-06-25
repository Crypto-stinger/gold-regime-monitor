// ═══════════════════════════════════════════════════════════════
// Hill-Climb 13641.87% ret / 18.55% DD (London+NewYork)
// Category: HIGH | Generated: 2026-03-16
// Gold Regime Lab v3 — XAUUSD 3-State Regime cBot
// ═══════════════════════════════════════════════════════════════
// Backtest Stats: Return 13641.87% | WR 66.7% | PF 3.41 | MaxDD 18.55%
// Trades: 24 (0W/0L) | AvgR 0
// ═══════════════════════════════════════════════════════════════
//
// ✓ All parameters within safe definitions — no risk warnings
// Computed Risk Rating: MED | RR=4:1 Risk=1.5% Lev=10x

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
    public class Hillclimb1364187Ret1855DdLondonnewyork : Robot
    {
        // ── Core Parameters ──────────────────────────────────────────
        [Parameter("Starting Balance", Group = "Account", DefaultValue = 1500)]
        public double StartingBalance { get; set; }

        [Parameter("Lot Size (fallback)", Group = "Account", DefaultValue = 1, MinValue = 0.01, MaxValue = 100)]
        public double LotSize { get; set; }

        [Parameter("ATR Period", Group = "Indicators", DefaultValue = 14, MinValue = 5, MaxValue = 50)]
        public int AtrPeriod { get; set; }

        [Parameter("ATR Stop Multiplier", Group = "Entry", DefaultValue = 2.75, MinValue = 0.5, MaxValue = 5.0, Step = 0.1)]
        public double AtrStopMultiplier { get; set; }

        [Parameter("Reward:Risk Ratio", Group = "Entry", DefaultValue = 4, MinValue = 1.0, MaxValue = 20.0, Step = 0.1)]
        public double RewardRatio { get; set; }

        // ── Regime Detection ─────────────────────────────────────────
        [Parameter("Compression Threshold", Group = "Regime", DefaultValue = 0.022, MinValue = 0.001, MaxValue = 0.1, Step = 0.001)]
        public double CompressionThreshold { get; set; }

        [Parameter("Expansion Threshold", Group = "Regime", DefaultValue = 1.15, MinValue = 1.01, MaxValue = 3.0, Step = 0.01)]
        public double ExpansionThreshold { get; set; }

        [Parameter("Range Width Bars (H4)", Group = "Regime", DefaultValue = 7, MinValue = 5, MaxValue = 50)]
        public int RangeWidthBars { get; set; }

        [Parameter("Midpoint Band %", Group = "Regime", DefaultValue = 0.1, MinValue = 0.01, MaxValue = 0.5, Step = 0.01)]
        public double MidpointBandPct { get; set; }

        // ── Entry Filters ────────────────────────────────────────────
        [Parameter("Retest Buffer", Group = "Entry", DefaultValue = 12, MinValue = 0.5, MaxValue = 50.0, Step = 0.5)]
        public double RetestBuffer { get; set; }

        [Parameter("Wick Ratio", Group = "Entry", DefaultValue = 0.5, MinValue = 0.3, MaxValue = 5.0, Step = 0.1)]
        public double WickRatio { get; set; }

        // ── Session Filter ───────────────────────────────────────────
        [Parameter("Execution Timeframe", Group = "Session", DefaultValue = "1h")]
        public string ExecutionTimeframe { get; set; }

        [Parameter("Session Mode", Group = "Session", DefaultValue = "London+NewYork")]
        public string SessionMode { get; set; }

        [Parameter("Entry Window Bars", Group = "Session", DefaultValue = undefined, MinValue = 0, MaxValue = 12)]
        public int EntryWindowBars { get; set; }

        [Parameter("Max Trades Per Day", Group = "Session", DefaultValue = 5, MinValue = 1, MaxValue = 10)]
        public int MaxTradesPerDay { get; set; }

        // ── News Blackout Filter ─────────────────────────────────────
        [Parameter("News Before Minutes", Group = "News", DefaultValue = 30, MinValue = 0, MaxValue = 240)]
        public int NewsBeforeMin { get; set; }

        [Parameter("News After Minutes", Group = "News", DefaultValue = 30, MinValue = 0, MaxValue = 240)]
        public int NewsAfterMin { get; set; }

        // ── Gap Filter ───────────────────────────────────────────────
        [Parameter("Gap Filter Enabled", Group = "Filters", DefaultValue = true)]
        public bool GapFilterEnabled { get; set; }

        [Parameter("Gap Threshold ATR", Group = "Filters", DefaultValue = 0.5, MinValue = 0.1, MaxValue = 5.0, Step = 0.1)]
        public double GapThresholdAtr { get; set; }

        [Parameter("Gap Cooldown Bars", Group = "Filters", DefaultValue = 2, MinValue = 1, MaxValue = 12)]
        public int GapCooldownBars { get; set; }

        // ── Trailing Stop ────────────────────────────────────────────
        [Parameter("Trailing Stop Enabled", Group = "StopManagement", DefaultValue = false)]
        public bool TrailingStopEnabled { get; set; }

        [Parameter("Trailing Trigger (R)", Group = "StopManagement", DefaultValue = 1, MinValue = 0.5, MaxValue = 10.0, Step = 0.1)]
        public double TrailingStopTriggerR { get; set; }

        // ── Risk Management ──────────────────────────────────────────
        [Parameter("Risk Per Trade %", Group = "Risk", DefaultValue = 1.5, MinValue = 0.1, MaxValue = 10.0, Step = 0.05)]
        public double RiskPerTradePct { get; set; }

        [Parameter("Leverage", Group = "Risk", DefaultValue = 10, MinValue = 1, MaxValue = 200)]
        public int Leverage { get; set; }

        [Parameter("Max Drawdown %", Group = "Risk", DefaultValue = 25, MinValue = 5, MaxValue = 100)]
        public double MaxDrawdownPct { get; set; }

        [Parameter("Max Daily Loss %", Group = "Risk", DefaultValue = 2, MinValue = 0.5, MaxValue = 20.0, Step = 0.5)]
        public double MaxDailyLossPct { get; set; }

        [Parameter("Max Consecutive Losses", Group = "Risk", DefaultValue = 2, MinValue = 1, MaxValue = 20)]
        public int MaxConsecutiveLosses { get; set; }

        [Parameter("Post-Loss Cooldown Bars", Group = "Risk", DefaultValue = 2, MinValue = 0, MaxValue = 20)]
        public int PostLossCooldownBars { get; set; }

        [Parameter("Reduce Size After Loss", Group = "Risk", DefaultValue = true)]
        public bool ReduceSizeAfterLoss { get; set; }

        [Parameter("Reduced Risk %", Group = "Risk", DefaultValue = 0.5, MinValue = 0.1, MaxValue = 10.0, Step = 0.05)]
        public double ReducedRiskPerTradePct { get; set; }

        // ── ATR Risk Scaling ─────────────────────────────────────────
        [Parameter("ATR Risk Scale Enabled", Group = "Risk", DefaultValue = true)]
        public bool AtrRiskScaleEnabled { get; set; }

        [Parameter("ATR Risk Scale Threshold", Group = "Risk", DefaultValue = 1.25, MinValue = 1.01, MaxValue = 5.0, Step = 0.01)]
        public double AtrRiskScaleThreshold { get; set; }

        [Parameter("ATR Risk Scale Factor", Group = "Risk", DefaultValue = 0.65, MinValue = 0.1, MaxValue = 1.0, Step = 0.05)]
        public double AtrRiskScaleFactor { get; set; }

        [Parameter("2nd Trade Risk Factor", Group = "Risk", DefaultValue = 0.75, MinValue = 0.1, MaxValue = 1.0, Step = 0.05)]
        public double SecondTradeRiskFactor { get; set; }

        // ── ORB Filter ───────────────────────────────────────────────
        [Parameter("Session ORB Enabled", Group = "Filters", DefaultValue = true)]
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
            _botLabel = "Hillclimb1364187Ret1855DdLondonnewyork_" + Server.Time.Ticks;
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

            _atrH1 = Indicators.AverageTrueRange(AtrPeriod, MovingAverageType.Exponential);
            _atrH4 = Indicators.AverageTrueRange(_h4Bars, AtrPeriod, MovingAverageType.Exponential);
            _emaDaily = Indicators.ExponentialMovingAverage(_dailyBars.ClosePrices, 50);
            _bbH4 = Indicators.BollingerBands(_h4Bars.ClosePrices, 20, 2, MovingAverageType.Simple);

            Positions.Closed += OnPositionClosed;

            // NOTE: Populate _newsEvents with your economic calendar dates
            // e.g. NFP, CPI, FOMC, PPI, Retail Sales
            // _newsEvents.Add(new DateTime(2024, 1, 5, 13, 30, 0)); // NFP example

            Print("Hillclimb1364187Ret1855DdLondonnewyork started — HIGH risk category");
            Print("Config: RR=4 ATR=2.75 Risk=1.5% Lev=10x");
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
            }

            // ── Session filter ──
            if (!InSession(hour))
                return;

            // ── Entry window filter ──
            if (!InEntryWindow(hour))
                return;

            // ── News blackout filter ──
            if (IsNewsBlackout(currentTime))
                return;

            // ── Gap filter ──
            if (GapFilterEnabled && Bars.ClosePrices.Count >= 2)
            {
                var gap = Math.Abs(Bars.OpenPrices.LastValue - Bars.ClosePrices.Last(1));
                var atr = _atrH1.Result.LastValue;
                if (atr > 0 && gap >= atr * GapThresholdAtr)
                    _gapCooldownRemaining = GapCooldownBars;
            }

            if (_gapCooldownRemaining > 0)
            {
                _gapCooldownRemaining--;
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
                }
                if (_orbDay != currentTime.Date)
                    _orbValid = false;
                if (!_orbValid)
                    return;
            }

            // ── Skip if already have max positions ──
            if (_dailyTradeCount >= MaxTradesPerDay)
                return;

            // ── Skip if already in a position ──
            var myPositions = Positions.FindAll(_botLabel, SymbolName);
            if (myPositions.Length > 0)
                return;

            // ── Cooldown after consecutive losses ──
            if (_cooldownBarsRemaining > 0)
            {
                _cooldownBarsRemaining--;
                return;
            }

            // ── Drawdown circuit breaker ──
            var currentDD = _peak > 0 ? ((_peak - Account.Balance) / _peak) * 100 : 0;
            if (currentDD >= MaxDrawdownPct)
                return;

            // ── Daily loss limit (based on StartingBalance to match backtest) ──
            var dailyLossCap = StartingBalance * (MaxDailyLossPct / 100);
            if (_dailyLoss >= dailyLossCap)
                return;

            // ── Compute H4 range ──
            if (_h4Bars.Count < RangeWidthBars + 2)
                return;

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
            var bbWidth = bbMain > 0 ? (_bbH4.Top.LastValue - _bbH4.Bottom.LastValue) / bbMain : double.NaN;

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
                        ModifyPosition(pos, pos.EntryPrice, pos.TakeProfit);
                }
                else
                {
                    if (Symbol.Ask <= pos.EntryPrice - triggerDistance && pos.StopLoss > pos.EntryPrice)
                        ModifyPosition(pos, pos.EntryPrice, pos.TakeProfit);
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
            Print("Hillclimb1364187Ret1855DdLondonnewyork stopped. Final balance: " + Account.Balance);
        }
    }
}
