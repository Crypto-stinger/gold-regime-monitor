import { useQuery } from "@tanstack/react-query";
import { PageGuide } from "@/components/page-guide";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Brain, Target, TrendingUp, TrendingDown, Shield, Activity,
  CheckCircle2, XCircle, Clock, AlertTriangle, Eye, Crosshair,
  BarChart3, ArrowUpDown, Gauge, Zap,
} from "lucide-react";
import {
  ResponsiveContainer, ComposedChart, Bar, Cell, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine,
} from "recharts";

interface ConditionCheck {
  name: string;
  met: boolean;
  detail: string;
}

interface RecommendedStrategy {
  id: string;
  name: string;
  category?: string;
  notes?: string;
  config: Record<string, any>;
  stats: {
    returnPct: number;
    maxDrawdownPct: number;
    winRate: number;
    totalTrades: number;
    profitFactor: number;
  };
  createdAt: string;
}

interface OpenPositionInfo {
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

interface StrategyAnalysis {
  activeParams: Record<string, any>;
  timestamp: string;
  running: boolean;
  regime: string;
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

function RegimeBadge({ regime }: { regime: string }) {
  const config: Record<string, { color: string; icon: typeof TrendingUp }> = {
    trend: { color: "bg-blue-500/20 text-blue-400 border-blue-500/30", icon: TrendingUp },
    range: { color: "bg-amber-500/20 text-amber-400 border-amber-500/30", icon: ArrowUpDown },
    no_trade: { color: "bg-red-500/20 text-red-400 border-red-500/30", icon: XCircle },
  };
  const c = config[regime] || config.no_trade;
  const Icon = c.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold border ${c.color}`} data-testid="badge-regime">
      <Icon className="w-4 h-4" />
      {regime.toUpperCase().replace("_", " ")}
    </span>
  );
}

function ConditionRow({ condition }: { condition: ConditionCheck }) {
  return (
    <div className="flex items-start gap-3 py-2" data-testid={`condition-${condition.name.toLowerCase().replace(/\s+/g, "-")}`}>
      {condition.met ? (
        <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
      ) : (
        <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{condition.name}</div>
        <div className="text-xs text-muted-foreground">{condition.detail}</div>
      </div>
    </div>
  );
}

function PriceRangeVisual({ analysis }: { analysis: StrategyAnalysis }) {
  const { range, currentPrice, pricePosition } = analysis;
  if (range.width === 0) return null;

  const padding = range.width * 0.25;
  const chartLow = range.low - padding;
  const chartHigh = range.high + padding;
  const chartRange = chartHigh - chartLow;

  const toPct = (price: number) => ((price - chartLow) / chartRange) * 100;
  const clamp = (pct: number) => Math.max(4, Math.min(96, pct));

  const pricePct = clamp(toPct(currentPrice));
  const rangeLowPct = toPct(range.low);
  const rangeHighPct = toPct(range.high);
  const midLowPct = toPct(range.midBandLower);
  const midHighPct = toPct(range.midBandUpper);

  const entryPrice = analysis.expectedEntry?.price;
  const entryOverlapsResistance = entryPrice != null && Math.abs(entryPrice - range.high) < range.width * 0.02;
  const entryOverlapsSupport = entryPrice != null && Math.abs(entryPrice - range.low) < range.width * 0.02;
  const showSeparateEntry = entryPrice != null && !entryOverlapsResistance && !entryOverlapsSupport;
  const entryPct = entryPrice != null ? clamp(toPct(entryPrice)) : null;

  return (
    <div className="relative rounded-lg bg-muted/30 border overflow-hidden" style={{ height: 200 }} data-testid="visual-price-range">
      <div
        className="absolute left-0 right-0 bg-blue-500/8"
        style={{ bottom: `${rangeLowPct}%`, height: `${rangeHighPct - rangeLowPct}%` }}
      />

      <div
        className="absolute left-0 right-0 bg-red-500/10"
        style={{ bottom: `${midLowPct}%`, height: `${midHighPct - midLowPct}%` }}
      >
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-red-400/50 font-medium tracking-wider">DEAD ZONE</span>
      </div>

      <div className="absolute left-0 right-0 z-10" style={{ bottom: `${rangeLowPct}%` }}>
        <div className="h-[2px] bg-amber-400/80 w-full" />
        <div className="absolute left-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5 bg-amber-950/90 border border-amber-500/40 rounded px-1.5 py-0.5">
          <span className="text-[10px] text-amber-400 font-semibold">
            {entryOverlapsSupport ? "Support / Entry" : "Support"}
          </span>
          <span className="text-[10px] text-amber-300 font-mono">${range.low.toFixed(2)}</span>
        </div>
      </div>

      <div className="absolute left-0 right-0 z-10" style={{ bottom: `${rangeHighPct}%` }}>
        <div className="h-[2px] bg-amber-400/80 w-full" />
        <div className="absolute left-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5 bg-amber-950/90 border border-amber-500/40 rounded px-1.5 py-0.5">
          <span className="text-[10px] text-amber-400 font-semibold">
            {entryOverlapsResistance ? "Resistance / Entry" : "Resistance"}
          </span>
          <span className="text-[10px] text-amber-300 font-mono">${range.high.toFixed(2)}</span>
        </div>
        {entryOverlapsResistance && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 bg-purple-950/90 border border-purple-500/40 rounded px-1.5 py-0.5">
            <span className="text-[10px] text-purple-400 font-semibold">Breakout Entry</span>
          </div>
        )}
      </div>

      {showSeparateEntry && entryPct !== null && (
        <div className="absolute left-0 right-0 z-15" style={{ bottom: `${entryPct}%` }}>
          <div className="h-[2px] w-full bg-purple-400" />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5 bg-purple-950/90 border border-purple-500/40 rounded px-1.5 py-0.5">
            <span className="text-[10px] text-purple-400 font-semibold">Entry</span>
            <span className="text-[10px] text-purple-300 font-mono">${entryPrice!.toFixed(2)}</span>
          </div>
        </div>
      )}

      <div className="absolute left-0 right-0 z-20" style={{ bottom: `${pricePct}%` }}>
        <div className="h-[3px] bg-emerald-400 w-full shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5 bg-emerald-950/90 border border-emerald-500/50 rounded px-1.5 py-0.5 shadow-lg shadow-emerald-500/20">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[10px] text-emerald-300 font-semibold">Live</span>
          <span className="text-[11px] text-emerald-200 font-mono font-bold">${currentPrice.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}

function H1ChartTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className="bg-[#1a1a2e] border border-[#333] rounded-lg p-2.5 text-xs shadow-xl">
      <div className="text-emerald-400 font-bold text-sm mb-1">High: ${d.high.toFixed(2)}</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground">
        <span>Open:</span><span className="text-right font-mono">${d.open.toFixed(2)}</span>
        <span>Close:</span><span className="text-right font-mono">${d.close.toFixed(2)}</span>
        <span>Low:</span><span className="text-right font-mono">${d.low.toFixed(2)}</span>
      </div>
      <div className="text-[10px] text-muted-foreground mt-1 border-t border-white/10 pt-1">{d.time}</div>
    </div>
  );
}

function H1CandleChart({ data, range, currentPrice, expectedEntry }: { data: StrategyAnalysis["h1Chart"]; range: StrategyAnalysis["range"]; currentPrice: number; expectedEntry?: StrategyAnalysis["expectedEntry"] }) {
  if (data.length === 0) {
    return <div className="text-sm text-muted-foreground text-center py-10">No chart data available</div>;
  }

  const chartData = data.map((bar) => {
    const bullish = bar.close >= bar.open;
    return {
      time: new Date(bar.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      open: bar.open,
      close: bar.close,
      high: bar.high,
      low: bar.low,
      color: bullish ? "#22c55e" : "#ef4444",
    };
  });

  const allPrices = data.flatMap(b => [b.high, b.low]);
  if (range.high > 0) { allPrices.push(range.high, range.low); }
  if (expectedEntry) { allPrices.push(expectedEntry.price); }
  allPrices.push(currentPrice);
  const yMin = Math.min(...allPrices) - 5;
  const yMax = Math.max(...allPrices) + 5;

  return (
    <ResponsiveContainer width="100%" height={250}>
      <ComposedChart data={chartData} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
        <XAxis dataKey="time" tick={{ fontSize: 10, fill: "#888" }} interval="preserveStartEnd" />
        <YAxis domain={[yMin, yMax]} tick={{ fontSize: 10, fill: "#888" }} tickFormatter={(v: number) => v.toFixed(0)} />
        <Tooltip content={<H1ChartTooltip />} />
        {range.high > 0 && (
          <>
            <ReferenceLine y={range.high} stroke="#f59e0b" strokeDasharray="5 5" label={{ value: `R $${range.high.toFixed(0)}`, position: "right", fill: "#f59e0b", fontSize: 10 }} />
            <ReferenceLine y={range.low} stroke="#f59e0b" strokeDasharray="5 5" label={{ value: `S $${range.low.toFixed(0)}`, position: "right", fill: "#f59e0b", fontSize: 10 }} />
          </>
        )}
        {expectedEntry && (
          <ReferenceLine y={expectedEntry.price} stroke="#a78bfa" strokeDasharray="4 4" label={{ value: `Entry $${expectedEntry.price.toFixed(0)}`, position: "left", fill: "#a78bfa", fontSize: 10 }} />
        )}
        <ReferenceLine y={currentPrice} stroke="#22c55e" strokeWidth={2} label={{ value: `$${currentPrice.toFixed(0)}`, position: "left", fill: "#22c55e", fontSize: 10 }} />
        <Bar dataKey="close" barSize={4}>
          {chartData.map((entry, index) => (
            <Cell key={index} fill={entry.color} />
          ))}
        </Bar>
      </ComposedChart>
    </ResponsiveContainer>
  );
}

type LossDecision = {
  id: number;
  timestamp: string;
  decision: string;
  side?: string;
  price?: number;
  regime?: string;
  conditions?: Record<string, any>;
  signal_details?: Record<string, any>;
  market_context?: Record<string, any>;
  outcome?: string;
  pnl?: number;
  notes?: string;
};

function TradeLossAnalysis() {
  const { data: decisions = [] } = useQuery<LossDecision[]>({
    queryKey: ["/api/ai-monitor/decisions?limit=100"],
    staleTime: 0,
    refetchOnMount: "always",
  });

  const lossEntries = decisions.filter(d => d.decision === "entry" && d.pnl != null && Number(d.pnl) < 0);

  if (lossEntries.length === 0) return null;

  return (
    <Card data-testid="card-loss-analysis">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400" />
            Trade Loss Analysis ({lossEntries.length} losses)
          </CardTitle>
          <Badge variant="outline" className="text-xs border-red-500/30 text-red-400">
            Learning from mistakes
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {lossEntries.slice(0, 10).map((loss) => {
          const reasoning = loss.signal_details?.entryReasoning as Record<string, any> | undefined;
          const expectation = reasoning?.expectation || `Entered ${loss.side || "unknown"} at $${loss.price != null ? Number(loss.price).toFixed(2) : "?"} in ${loss.regime || "unknown"} regime`;
          const slPrice = reasoning?.stopLoss || loss.signal_details?.sl;
          const tpPrice = reasoning?.takeProfit || loss.signal_details?.tp;
          const entryPrice = reasoning?.price || loss.price;

          let whatWentWrong = "";
          if (loss.pnl != null && entryPrice) {
            const lossAmt = Math.abs(Number(loss.pnl));
            const isBuy = (loss.side || "").toLowerCase() === "buy";
            if (isBuy) {
              whatWentWrong = `Price moved against the long position. Stop loss was hit${slPrice ? ` at $${Number(slPrice).toFixed(2)}` : ""}, resulting in -$${lossAmt.toFixed(2)} loss. The expected bounce from support did not materialise — selling pressure dominated.`;
            } else {
              whatWentWrong = `Price moved against the short position. Stop loss was hit${slPrice ? ` at $${Number(slPrice).toFixed(2)}` : ""}, resulting in -$${lossAmt.toFixed(2)} loss. The expected drop from resistance did not materialise — buying pressure dominated.`;
            }
          }

          const conditions = loss.conditions || {};
          let lesson = "";
          if (conditions.consecutiveLosses > 1) {
            lesson += `This was loss #${conditions.consecutiveLosses} in a row — the cooldown period will help reset. `;
          }
          if (Number(conditions.spread) > 0.5) {
            lesson += `Spread was elevated (${Number(conditions.spread).toFixed(2)}) which may have contributed to poor fill. `;
          }
          if (loss.regime === "trend") {
            lesson += "Trend regime entries carry higher risk when the trend reverses mid-trade. ";
          }
          if (loss.regime === "range") {
            lesson += "Range boundary may have been breached — range breakouts invalidate mean-reversion entries. ";
          }
          if (!lesson) {
            lesson = "Standard stop-loss exit. The risk was controlled within parameters. Losses are part of the strategy — maintaining discipline is key.";
          }

          return (
            <div key={loss.id} className="rounded-lg border border-red-500/20 bg-red-500/5 p-3" data-testid={`loss-entry-${loss.id}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={`text-[10px] ${loss.side === "BUY" || loss.side === "buy" ? "border-emerald-500/40 text-emerald-400" : "border-red-500/40 text-red-400"}`}>
                    {loss.side}
                  </Badge>
                  <Badge variant="outline" className="text-[10px]">{loss.regime}</Badge>
                  <span className="text-xs font-mono">${entryPrice != null ? Number(entryPrice).toFixed(2) : "?"}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono font-semibold text-red-400">
                    -${Math.abs(Number(loss.pnl) || 0).toFixed(2)}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(loss.timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              </div>

              <div className="space-y-1.5 text-xs">
                <div>
                  <span className="font-medium text-blue-400">What I expected: </span>
                  <span className="text-muted-foreground">{expectation}</span>
                </div>
                <div>
                  <span className="font-medium text-red-400">What went wrong: </span>
                  <span className="text-muted-foreground">{whatWentWrong}</span>
                </div>
                <div>
                  <span className="font-medium text-amber-400">Lesson learned: </span>
                  <span className="text-muted-foreground">{lesson}</span>
                </div>
              </div>

              {(slPrice || tpPrice) && (
                <div className="flex gap-3 mt-2 text-[10px] text-muted-foreground">
                  {slPrice && <span>SL: ${Number(slPrice).toFixed(2)}</span>}
                  {tpPrice && <span>TP: ${Number(tpPrice).toFixed(2)}</span>}
                  {reasoning?.atrH1 && <span>ATR: {reasoning.atrH1}</span>}
                  {reasoning?.riskRewardRatio && <span>R:R = {reasoning.riskRewardRatio}:1</span>}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

type JournalEntry = {
  id: string;
  createdAt: string;
  source: string;
  suggestions: Array<{ parameter: string; fromValue: string | number; toValue: string | number; rationale: string }>;
  beforeStats?: { returnPct: number; maxDrawdownPct: number; winRate: number; totalTrades: number; profitFactor: number };
  afterStats?: { returnPct: number; maxDrawdownPct: number; winRate: number; totalTrades: number; profitFactor: number };
  outcome?: string;
  learnings?: string;
};

function OptimizationJournal() {
  const { data: journalData } = useQuery<{ entries: JournalEntry[]; count: number }>({
    queryKey: ["/api/ai/journal"],
    staleTime: 0,
    refetchOnMount: "always",
  });

  if (!journalData || journalData.entries.length === 0) return null;

  const entries = journalData.entries.slice(0, 10);

  return (
    <Card data-testid="card-optimization-journal">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Brain className="w-4 h-4 text-violet-400" />
            AI Optimization Journal ({journalData.count} entries)
          </CardTitle>
          <Badge variant="outline" className="text-xs border-violet-500/50 text-violet-400" data-testid="badge-journal-count">
            Persistent Memory
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {entries.map((entry) => {
          const outcomeColor = entry.outcome === "improved" ? "text-emerald-400" :
            entry.outcome === "worsened" ? "text-red-400" :
            entry.outcome === "pending" ? "text-amber-400" : "text-blue-400";
          const outcomeBg = entry.outcome === "improved" ? "border-emerald-500/30 bg-emerald-500/5" :
            entry.outcome === "worsened" ? "border-red-500/30 bg-red-500/5" :
            entry.outcome === "pending" ? "border-amber-500/30 bg-amber-500/5" : "border-blue-500/30 bg-blue-500/5";

          return (
            <div key={entry.id} className={`rounded-lg border p-3 ${outcomeBg}`} data-testid={`journal-entry-${entry.id}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-muted-foreground">
                  {new Date(entry.createdAt).toLocaleDateString()} {new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  <span className="ml-2 uppercase">{entry.source}</span>
                </span>
                <span className={`text-xs font-semibold uppercase ${outcomeColor}`} data-testid={`journal-outcome-${entry.id}`}>
                  {entry.outcome || "pending"}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5 mb-1">
                {entry.suggestions.map((s, i) => (
                  <span key={i} className="text-xs bg-muted/50 rounded px-1.5 py-0.5">
                    {s.parameter}: {String(s.fromValue)}→{String(s.toValue)}
                  </span>
                ))}
              </div>
              {entry.beforeStats && entry.afterStats && (
                <div className="text-xs text-muted-foreground">
                  Return: {entry.beforeStats.returnPct}%→
                  <span className={entry.afterStats.returnPct > entry.beforeStats.returnPct ? "text-emerald-400" : "text-red-400"}>
                    {entry.afterStats.returnPct}%
                  </span>
                  {" | DD: "}{entry.beforeStats.maxDrawdownPct}%→
                  <span className={entry.afterStats.maxDrawdownPct <= entry.beforeStats.maxDrawdownPct ? "text-emerald-400" : "text-red-400"}>
                    {entry.afterStats.maxDrawdownPct}%
                  </span>
                  {" | WR: "}{entry.beforeStats.winRate}%→{entry.afterStats.winRate}%
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function paramLabel(key: string): string {
  const labels: Record<string, string> = {
    atrPeriod: "ATR Period", atrStopMultiplier: "ATR Stop ×", rewardRatio: "Reward Ratio",
    compressionThreshold: "BB Compression", expansionThreshold: "ATR Expansion ×",
    rangeWidthBars: "Range Width Bars", midpointBandPct: "Midpoint Band %",
    entryWindowBars: "Entry Window", wickRatio: "Wick Ratio",
    sessionMode: "Session", sessionORBEnabled: "ORB Enabled",
    riskPerTradePct: "Risk/Trade %", leverage: "Leverage",
    maxDrawdownPct: "Max DD %", maxDailyLossPct: "Daily Loss Limit %",
    maxConsecutiveLosses: "Max Consec. Losses", maxTradesPerDay: "Max Trades/Day",
    trailingStopEnabled: "Trailing Stop", trailingStopTriggerR: "Trail Trigger R",
    startingBalance: "Starting Balance", retestBuffer: "Retest Buffer $",
    reduceSizeAfterLoss: "Reduce After Loss", reducedRiskPerTradePct: "Reduced Risk %",
    gapFilterEnabled: "Gap Filter", gapThresholdAtr: "Gap ATR Threshold",
    gapCooldownBars: "Gap Cooldown", postLossCooldownBars: "Post-Loss Cooldown",
    secondTradeRiskFactor: "2nd Trade Risk ×", atrRiskScaleEnabled: "ATR Risk Scale",
    atrRiskScaleFactor: "ATR Scale Factor", atrRiskScaleThreshold: "ATR Scale Threshold",
    lotSize: "Lot Size",
  };
  return labels[key] || key;
}

function formatParamValue(value: any): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  return String(value);
}

function ActiveStrategyCard({ analysis }: { analysis: StrategyAnalysis }) {
  const { data: summary } = useQuery<{
    params: Record<string, any>;
    activeStrategy: { id: string; name: string; category: string; notes?: string; stats: any } | null;
  }>({
    queryKey: ["/api/active-strategy-summary"],
    staleTime: 0,
    refetchOnMount: "always",
  });

  const activeParams = analysis.activeParams;
  const activeStrat = summary?.activeStrategy;

  const importantParams = [
    'lotSize', 'atrPeriod', 'atrStopPeriod', 'atrStopMultiplier', 'rewardRatio',
    'compressionThreshold', 'expansionThreshold', 'rangeWidthBars', 'midpointBandPct',
    'entryWindowBars', 'wickRatio', 'sessionMode', 'riskPerTradePct', 'leverage',
    'maxDrawdownPct', 'maxDailyLossPct', 'maxConsecutiveLosses', 'reduceSizeAfterLoss',
    'atrRiskScaleEnabled', 'secondTradeRiskFactor', 'trailingStopEnabled',
  ];

  return (
    <Card className="border-amber-500/30 bg-gradient-to-r from-amber-500/5 to-transparent" data-testid="card-active-strategy">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="w-4 h-4 text-amber-500" />
            Active Strategy
          </CardTitle>
          <Badge variant="outline" className="text-xs" data-testid="badge-strategy-mode">REGIME</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {activeStrat ? (
          <div>
            <div className="flex items-center gap-2">
              <p className="text-base font-semibold" data-testid="text-strategy-name">{activeStrat.name}</p>
              <Badge variant="outline" className="text-[10px] h-5">{activeStrat.category}</Badge>
            </div>
            {activeStrat.notes && (
              <p className="text-[11px] text-muted-foreground mt-0.5">{activeStrat.notes}</p>
            )}
            <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
              <span data-testid="text-active-return">Return: <span className="text-emerald-400 font-medium">{Number(activeStrat.stats.returnPct).toFixed(1)}%</span></span>
              <span data-testid="text-active-dd">DD: <span className="text-amber-400 font-medium">{Number(activeStrat.stats.maxDrawdownPct).toFixed(1)}%</span></span>
              <span data-testid="text-active-wr">Win Rate: {Number(activeStrat.stats.winRate).toFixed(1)}%</span>
              <span data-testid="text-active-trades">Trades: {activeStrat.stats.totalTrades}</span>
              <span data-testid="text-active-pf">PF: {Number(activeStrat.stats.profitFactor).toFixed(1)}</span>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="text-no-strategy">
            Active params do not match any catalogue strategy.
          </p>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          {importantParams.filter(key => activeParams[key] !== undefined).map(key => (
            <div key={key} className="rounded-md p-1.5 text-xs bg-muted/30" data-testid={`param-${key}`}>
              <div className="text-[10px] text-muted-foreground truncate">{paramLabel(key)}</div>
              <div className="font-semibold">{formatParamValue(activeParams[key])}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function StrategyMindPage() {
  const { data: analysis, isLoading, error } = useQuery<StrategyAnalysis>({
    queryKey: ["/api/live-trading/analysis"],
    refetchInterval: 5000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full" data-testid="loading-strategy-mind">
        <div className="text-center space-y-3">
          <Brain className="w-12 h-12 text-primary mx-auto animate-pulse" />
          <p className="text-muted-foreground">Loading strategy analysis...</p>
        </div>
      </div>
    );
  }

  if (error || !analysis) {
    return (
      <div className="flex items-center justify-center h-full" data-testid="error-strategy-mind">
        <div className="text-center space-y-3 max-w-md">
          <AlertTriangle className="w-12 h-12 text-amber-400 mx-auto" />
          <p className="text-lg font-medium">Strategy Mind Unavailable</p>
          <p className="text-sm text-muted-foreground">
            The live trader needs to be running to view the strategy analysis. Go to Live Trading and start the connection.
          </p>
        </div>
      </div>
    );
  }

  const conditionsMet = analysis.conditions.filter(c => c.met).length;
  const conditionsTotal = analysis.conditions.length;
  const readinessPercent = (conditionsMet / conditionsTotal) * 100;

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-6" data-testid="page-strategy-mind">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Brain className="w-7 h-7 text-primary" />
          <div>
            <h1 className="text-xl font-bold" data-testid="text-page-title">Strategy Mind</h1>
            <p className="text-xs text-muted-foreground">
              Live analysis updated {new Date(analysis.timestamp).toLocaleTimeString()}
            </p>
            <PageGuide
              title="Strategy Mind — Live Intelligence"
              summary="This page is the brain of your trading system. It shows real-time analysis of market conditions, whether your strategy is aligned with the current market, and learns from every trade — wins and losses."
              steps={[
                { title: "Regime Status", description: "Shows the current market classification — Range, Trend, or No Trade. This updates in real time and directly controls whether the bot will trade." },
                { title: "Trading Readiness", description: "A percentage score showing how many of the 15 safety conditions are met. 100% means all systems go." },
                { title: "Active vs Recommended", description: "Compares your current live parameters against what the system recommends. If they differ, you'll see which specific settings don't match." },
                { title: "Loss Analysis", description: "When trades lose, this section breaks down what happened — what the bot expected, what actually occurred, and what it learned for next time." },
                { title: "AI Learnings", description: "Accumulated insights from the AI's continuous monitoring — patterns it has spotted, things it has learned about timing, spreads, regime transitions, and more." },
              ]}
              tips={[
                "This page auto-updates — you don't need to refresh it manually.",
                "The loss analysis is especially valuable for understanding whether losses were 'bad luck' or a strategy flaw.",
              ]}
            />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <RegimeBadge regime={analysis.regime} />
          <Badge variant={analysis.running ? "default" : "destructive"} data-testid="badge-running-status">
            {analysis.running ? "LIVE" : "OFFLINE"}
          </Badge>
        </div>
      </div>

      <ActiveStrategyCard analysis={analysis} />

      {analysis.openPositions.length > 0 && (
        <Card className="border-emerald-500/30 bg-gradient-to-r from-emerald-500/5 to-transparent" data-testid="card-open-positions">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-500" />
                Open Positions
              </CardTitle>
              <Badge variant="outline" className="text-xs border-emerald-500/50 text-emerald-400" data-testid="badge-position-count">
                {analysis.openPositions.length} active
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {analysis.openPositions.map(pos => {
              const pnlColor = pos.unrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400";
              const sideColor = pos.side === "BUY" ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40" : "bg-red-500/20 text-red-400 border-red-500/40";
              return (
                <div key={pos.positionId} className="rounded-lg border bg-muted/20 p-3 space-y-2" data-testid={`position-${pos.positionId}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={`text-xs font-bold ${sideColor}`} data-testid={`position-side-${pos.positionId}`}>
                        {pos.side}
                      </Badge>
                      <span className="text-sm font-semibold">XAUUSD</span>
                      <span className="text-xs text-muted-foreground">#{pos.positionId}</span>
                    </div>
                    <div className={`text-lg font-bold ${pnlColor}`} data-testid={`position-pnl-${pos.positionId}`}>
                      {pos.unrealizedPnl >= 0 ? "+" : ""}${pos.unrealizedPnl.toFixed(2)}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div className="bg-muted/30 rounded p-1.5">
                      <div className="text-[10px] text-muted-foreground">Entry Price</div>
                      <div className="font-semibold" data-testid={`position-entry-${pos.positionId}`}>${pos.entryPrice.toFixed(2)}</div>
                    </div>
                    <div className="bg-muted/30 rounded p-1.5">
                      <div className="text-[10px] text-muted-foreground">Current Price</div>
                      <div className="font-semibold" data-testid={`position-current-${pos.positionId}`}>${pos.currentPrice.toFixed(2)}</div>
                    </div>
                    <div className="bg-muted/30 rounded p-1.5">
                      <div className="text-[10px] text-muted-foreground">Volume</div>
                      <div className="font-semibold" data-testid={`position-vol-${pos.positionId}`}>{pos.volume}</div>
                    </div>
                    <div className="bg-muted/30 rounded p-1.5">
                      <div className="text-[10px] text-muted-foreground">Opened</div>
                      <div className="font-semibold">{new Date(pos.openTimestamp).toLocaleTimeString()}</div>
                    </div>
                  </div>
                  <div className="flex gap-2 text-xs">
                    {pos.stopLoss && (
                      <div className="flex items-center gap-1 text-red-400/80">
                        <Shield className="w-3 h-3" />
                        <span>SL: ${pos.stopLoss.toFixed(2)}</span>
                      </div>
                    )}
                    {pos.takeProfit && (
                      <div className="flex items-center gap-1 text-emerald-400/80">
                        <Target className="w-3 h-3" />
                        <span>TP: ${pos.takeProfit.toFixed(2)}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <Card className="border-primary/20 bg-gradient-to-r from-primary/5 to-transparent" data-testid="card-plan-of-action">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Eye className="w-4 h-4 text-primary" />
            Bot's Plan of Action
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-relaxed" data-testid="text-plan-of-action">{analysis.planOfAction}</p>
          <div className="mt-3">
            <p className="text-xs text-muted-foreground mb-2" data-testid="text-regime-reasoning">{analysis.regimeReasoning}</p>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card data-testid="card-price-chart">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <BarChart3 className="w-4 h-4" />
              H1 Price Action (Last 50 Bars)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <H1CandleChart data={analysis.h1Chart} range={analysis.range} currentPrice={analysis.currentPrice} expectedEntry={analysis.expectedEntry} />
          </CardContent>
        </Card>

        <Card data-testid="card-price-position">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Crosshair className="w-4 h-4" />
              Price Position in Range
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <PriceRangeVisual analysis={analysis} />
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="p-2 rounded bg-muted/30">
                <div className="text-xs text-muted-foreground">Distance to Support</div>
                <div className="font-semibold" data-testid="text-dist-support">${analysis.pricePosition.distToSupport.toFixed(2)}</div>
              </div>
              <div className="p-2 rounded bg-muted/30">
                <div className="text-xs text-muted-foreground">Distance to Resistance</div>
                <div className="font-semibold" data-testid="text-dist-resistance">${analysis.pricePosition.distToResistance.toFixed(2)}</div>
              </div>
              <div className="p-2 rounded bg-muted/30">
                <div className="text-xs text-muted-foreground">Position in Range</div>
                <div className="font-semibold" data-testid="text-pct-in-range">{analysis.pricePosition.percentInRange.toFixed(1)}%</div>
              </div>
              <div className="p-2 rounded bg-muted/30">
                <div className="text-xs text-muted-foreground">Zone</div>
                <div className="font-semibold" data-testid="text-zone">
                  {analysis.pricePosition.nearSupport ? "Near Support" :
                   analysis.pricePosition.nearResistance ? "Near Resistance" :
                   analysis.pricePosition.inMidpointBand ? "Dead Zone" : "Mid-Range"}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {analysis.expectedEntry && (
        <Card className="border-purple-500/20 bg-gradient-to-r from-purple-500/5 to-transparent" data-testid="card-expected-entry">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Target className="w-4 h-4 text-purple-400" />
              Expected Entry Setup
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
              <div className="p-3 rounded bg-purple-500/10 border border-purple-500/20">
                <div className="text-xs text-muted-foreground">Side</div>
                <div className={`font-bold text-lg ${analysis.expectedEntry.side === "BUY" ? "text-emerald-400" : "text-red-400"}`} data-testid="text-expected-side">
                  {analysis.expectedEntry.side}
                </div>
              </div>
              <div className="p-3 rounded bg-muted/30">
                <div className="text-xs text-muted-foreground">Entry Price</div>
                <div className="font-semibold" data-testid="text-expected-price">${analysis.expectedEntry.price.toFixed(2)}</div>
              </div>
              <div className="p-3 rounded bg-muted/30">
                <div className="text-xs text-muted-foreground">Distance Away</div>
                <div className="font-semibold" data-testid="text-expected-distance">${analysis.expectedEntry.distance.toFixed(2)}</div>
              </div>
              <div className="p-3 rounded bg-red-500/10 border border-red-500/20">
                <div className="text-xs text-muted-foreground">Stop Loss</div>
                <div className="font-semibold text-red-400" data-testid="text-expected-sl">${analysis.expectedEntry.sl.toFixed(2)}</div>
              </div>
              <div className="p-3 rounded bg-emerald-500/10 border border-emerald-500/20">
                <div className="text-xs text-muted-foreground">Take Profit</div>
                <div className="font-semibold text-emerald-400" data-testid="text-expected-tp">${analysis.expectedEntry.tp.toFixed(2)}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card data-testid="card-entry-conditions">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Shield className="w-4 h-4" />
              Entry Conditions Checklist
              <Badge variant={analysis.allConditionsMet ? "default" : "secondary"} className="ml-auto" data-testid="badge-conditions-summary">
                {conditionsMet}/{conditionsTotal}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-3">
              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                <span>Trade Readiness</span>
                <span>{readinessPercent.toFixed(0)}%</span>
              </div>
              <Progress value={readinessPercent} className="h-2" data-testid="progress-readiness" />
            </div>
            <div className="divide-y divide-border">
              {analysis.conditions.map((c, i) => (
                <ConditionRow key={i} condition={c} />
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card data-testid="card-indicators">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Activity className="w-4 h-4" />
                Market Indicators
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="p-2 rounded bg-muted/30">
                  <div className="text-xs text-muted-foreground">ATR H1</div>
                  <div className="font-semibold" data-testid="text-atr-h1">{analysis.indicators.atrH1.toFixed(2)}</div>
                </div>
                <div className="p-2 rounded bg-muted/30">
                  <div className="text-xs text-muted-foreground">ATR H4</div>
                  <div className="font-semibold" data-testid="text-atr-h4">{analysis.indicators.atrH4.toFixed(2)}</div>
                </div>
                <div className="p-2 rounded bg-muted/30">
                  <div className="text-xs text-muted-foreground">Avg ATR H4</div>
                  <div className="font-semibold" data-testid="text-avg-atr-h4">{analysis.indicators.avgAtrH4.toFixed(2)}</div>
                </div>
                <div className="p-2 rounded bg-muted/30">
                  <div className="text-xs text-muted-foreground">BB Width H4</div>
                  <div className="font-semibold" data-testid="text-bb-width">{analysis.indicators.bbWidthH4.toFixed(4)}</div>
                </div>
              </div>

              <Separator className="my-3" />

              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5" />
                    ATR Expanding
                  </span>
                  <Badge variant={analysis.indicators.atrExpanding ? "default" : "secondary"} data-testid="badge-atr-expanding">
                    {analysis.indicators.atrExpanding ? "YES" : "NO"}
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground flex items-center gap-1.5">
                    <Gauge className="w-3.5 h-3.5" />
                    BB Compressed
                  </span>
                  <Badge variant={analysis.indicators.bbCompressed ? "default" : "secondary"} data-testid="badge-bb-compressed">
                    {analysis.indicators.bbCompressed ? "YES" : "NO"}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-performance">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <TrendingUp className="w-4 h-4" />
                Performance
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="p-2 rounded bg-muted/30">
                  <div className="text-xs text-muted-foreground">Balance</div>
                  <div className="font-semibold" data-testid="text-balance">${analysis.performance.balance.toFixed(2)}</div>
                </div>
                <div className="p-2 rounded bg-muted/30">
                  <div className="text-xs text-muted-foreground">Daily P&L</div>
                  <div className={`font-semibold ${analysis.performance.dailyPnl >= 0 ? "text-emerald-400" : "text-red-400"}`} data-testid="text-daily-pnl">
                    {analysis.performance.dailyPnl >= 0 ? "+" : ""}${analysis.performance.dailyPnl.toFixed(2)}
                  </div>
                </div>
                <div className="p-2 rounded bg-muted/30">
                  <div className="text-xs text-muted-foreground">Total P&L</div>
                  <div className={`font-semibold ${analysis.performance.totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`} data-testid="text-total-pnl">
                    {analysis.performance.totalPnl >= 0 ? "+" : ""}${analysis.performance.totalPnl.toFixed(2)}
                  </div>
                </div>
                <div className="p-2 rounded bg-muted/30">
                  <div className="text-xs text-muted-foreground">Drawdown</div>
                  <div className="font-semibold" data-testid="text-drawdown">{analysis.performance.drawdown.toFixed(1)}%</div>
                </div>
              </div>
            </CardContent>
          </Card>

          {analysis.wickAnalysis && (
            <Card data-testid="card-candle-analysis">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Clock className="w-4 h-4" />
                  Last H1 Candle Analysis
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-2 text-sm mb-3">
                  <div className="p-2 rounded bg-muted/30 text-center">
                    <div className="text-[10px] text-muted-foreground">Body</div>
                    <div className="font-semibold">{analysis.wickAnalysis.body.toFixed(2)}</div>
                  </div>
                  <div className="p-2 rounded bg-muted/30 text-center">
                    <div className="text-[10px] text-muted-foreground">Upper Wick</div>
                    <div className="font-semibold">{analysis.wickAnalysis.upperWick.toFixed(2)}</div>
                  </div>
                  <div className="p-2 rounded bg-muted/30 text-center">
                    <div className="text-[10px] text-muted-foreground">Lower Wick</div>
                    <div className="font-semibold">{analysis.wickAnalysis.lowerWick.toFixed(2)}</div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Badge variant={analysis.wickAnalysis.bullishRejection ? "default" : "outline"} className="text-xs" data-testid="badge-bullish-rejection">
                    {analysis.wickAnalysis.bullishRejection ? <CheckCircle2 className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
                    Bullish Rejection
                  </Badge>
                  <Badge variant={analysis.wickAnalysis.bearishRejection ? "default" : "outline"} className="text-xs" data-testid="badge-bearish-rejection">
                    {analysis.wickAnalysis.bearishRejection ? <CheckCircle2 className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
                    Bearish Rejection
                  </Badge>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <TradeLossAnalysis />

      <OptimizationJournal />

      <Card data-testid="card-range-levels">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <ArrowUpDown className="w-4 h-4" />
            H4 Range Levels
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3 text-sm">
            <div className="p-2 rounded bg-muted/30">
              <div className="text-xs text-muted-foreground">Range High</div>
              <div className="font-semibold text-amber-400" data-testid="text-range-high">${analysis.range.high.toFixed(2)}</div>
            </div>
            <div className="p-2 rounded bg-muted/30">
              <div className="text-xs text-muted-foreground">Range Low</div>
              <div className="font-semibold text-amber-400" data-testid="text-range-low">${analysis.range.low.toFixed(2)}</div>
            </div>
            <div className="p-2 rounded bg-muted/30">
              <div className="text-xs text-muted-foreground">Range Width</div>
              <div className="font-semibold" data-testid="text-range-width">${analysis.range.width.toFixed(2)}</div>
            </div>
            <div className="p-2 rounded bg-muted/30">
              <div className="text-xs text-muted-foreground">Midpoint</div>
              <div className="font-semibold" data-testid="text-midpoint">${analysis.range.midpoint.toFixed(2)}</div>
            </div>
            <div className="p-2 rounded bg-muted/30">
              <div className="text-xs text-muted-foreground">Dead Zone Upper</div>
              <div className="font-semibold text-red-400" data-testid="text-dz-upper">${analysis.range.midBandUpper.toFixed(2)}</div>
            </div>
            <div className="p-2 rounded bg-muted/30">
              <div className="text-xs text-muted-foreground">Dead Zone Lower</div>
              <div className="font-semibold text-red-400" data-testid="text-dz-lower">${analysis.range.midBandLower.toFixed(2)}</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
