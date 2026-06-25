import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Shield, Zap, Flame, TrendingUp, Target, BarChart3, Activity,
  ChevronDown, ChevronUp, Check, ArrowRight, Clock, AlertTriangle,
} from "lucide-react";
import { useState } from "react";
import type { SavedStrategy } from "@shared/schema";

const riskMeta: Record<string, { icon: typeof Shield; color: string; bg: string; border: string; label: string; description: string }> = {
  "Low Risk": {
    icon: Shield,
    color: "text-emerald-400",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/20",
    label: "Low Risk",
    description: "Conservative strategies prioritizing capital preservation. Max drawdown under 3%, steady compounding with all safety nets active.",
  },
  "Medium Risk": {
    icon: Zap,
    color: "text-amber-400",
    bg: "bg-amber-500/10",
    border: "border-amber-500/20",
    label: "Medium Risk",
    description: "Balanced strategies optimizing for growth with controlled risk. Drawdown under 6%, strong R/DD ratios with selective safety nets.",
  },
  "High Risk": {
    icon: Flame,
    color: "text-red-400",
    bg: "bg-red-500/10",
    border: "border-red-500/20",
    label: "High Risk",
    description: "Aggressive strategies maximizing returns. Drawdown up to 10%, safety nets removed for maximum position sizing on high-conviction setups.",
  },
};

const categoryOrder = ["Low Risk", "Medium Risk", "High Risk"];

function StatPill({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center px-3 py-2 rounded-lg bg-card/50 border border-border/50 min-w-[80px]">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{label}</span>
      <span className="text-sm font-bold text-foreground">{value}</span>
      {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

function StrategyCard({
  strategy,
  isActive,
  onApply,
  isApplying,
}: {
  strategy: SavedStrategy;
  isActive: boolean;
  onApply: () => void;
  isApplying: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const s = strategy.stats;
  const c = strategy.config as Record<string, any>;
  const meta = riskMeta[strategy.category] || riskMeta["Low Risk"];
  const rdd = Number(s.maxDrawdownPct) > 0 ? (Number(s.returnPct) / Number(s.maxDrawdownPct)).toFixed(1) : "∞";

  return (
    <Card
      className={`transition-all duration-200 ${isActive ? "ring-2 ring-primary shadow-lg shadow-primary/10" : "hover:border-border"}`}
      data-testid={`card-strategy-${strategy.id}`}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <CardTitle className="text-base" data-testid={`text-strategy-name-${strategy.id}`}>
                {strategy.name}
              </CardTitle>
              {isActive && (
                <Badge variant="default" className="text-[10px] gap-1 shrink-0" data-testid="badge-active-strategy">
                  <Check className="w-3 h-3" /> Active
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">{strategy.notes}</p>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <StatPill label="Return" value={`${Number(s.returnPct).toFixed(0)}%`} />
          <StatPill label="Max DD" value={`${Number(s.maxDrawdownPct).toFixed(1)}%`} />
          <StatPill label="R/DD" value={rdd} />
          <StatPill label="Win Rate" value={`${Number(s.winRate).toFixed(0)}%`} />
          <StatPill label="PF" value={Number(s.profitFactor).toFixed(1)} />
          <StatPill label="Trades" value={String(s.totalTrades)} />
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground h-7 px-2"
            onClick={() => setExpanded(!expanded)}
            data-testid={`button-expand-${strategy.id}`}
          >
            {expanded ? <ChevronUp className="w-3 h-3 mr-1" /> : <ChevronDown className="w-3 h-3 mr-1" />}
            {expanded ? "Hide" : "Show"} Parameters
          </Button>
          <div className="flex-1" />
          {!isActive && (
            <Button
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={onApply}
              disabled={isApplying}
              data-testid={`button-apply-${strategy.id}`}
            >
              <ArrowRight className="w-3 h-3" />
              {isApplying ? "Applying..." : "Apply to Live"}
            </Button>
          )}
        </div>

        {expanded && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1.5 pt-2 border-t border-border/50 text-xs">
            <ParamRow label="Risk/Trade" value={`${c.riskPerTradePct}%`} />
            <ParamRow label="Reward Ratio" value={`${c.rewardRatio}:1`} />
            <ParamRow label="ATR Stop" value={`${c.atrStopMultiplier}x`} />
            <ParamRow label="Entry Window" value={c.entryWindowBars === 0 ? "None" : `${c.entryWindowBars}h`} />
            <ParamRow label="Session" value={c.sessionMode} />
            <ParamRow label="Max Trades/Day" value={c.maxTradesPerDay} />
            <ParamRow label="Max Daily Loss" value={`${c.maxDailyLossPct}%`} />
            <ParamRow label="Max Consec. Loss" value={c.maxConsecutiveLosses} />
            <ParamRow label="Reduce After Loss" value={c.reduceSizeAfterLoss ? "Yes" : "No"} />
            <ParamRow label="ATR Risk Scale" value={c.atrRiskScaleEnabled ? "Yes" : "No"} />
            <ParamRow label="2nd Trade Factor" value={`${c.secondTradeRiskFactor}x`} />
            <ParamRow label="Trailing Stop" value={c.trailingStopEnabled ? `${c.trailingStopTriggerR}R` : "Off"} />
            <ParamRow label="Compression" value={c.compressionThreshold} />
            <ParamRow label="Expansion" value={c.expansionThreshold} />
            <ParamRow label="Wick Ratio" value={c.wickRatio} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ParamRow({ label, value }: { label: string; value: any }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{String(value)}</span>
    </div>
  );
}

export default function StrategyCataloguePage() {
  const { toast } = useToast();
  const { data: strategies, isLoading } = useQuery<SavedStrategy[]>({
    queryKey: ["/api/strategies"],
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const { data: activeParams } = useQuery<Record<string, any>>({
    queryKey: ["/api/locked-params"],
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const [applyingId, setApplyingId] = useState<string | null>(null);

  const applyMutation = useMutation({
    mutationFn: async (strategy: SavedStrategy) => {
      const c = strategy.config as Record<string, any>;
      await apiRequest("PUT", "/api/locked-params", {
        riskPerTradePct: c.riskPerTradePct,
        rewardRatio: c.rewardRatio,
        atrStopMultiplier: c.atrStopMultiplier,
        entryWindowBars: c.entryWindowBars,
        sessionMode: c.sessionMode,
        maxTradesPerDay: c.maxTradesPerDay,
        maxDailyLossPct: c.maxDailyLossPct,
        maxConsecutiveLosses: c.maxConsecutiveLosses,
        reduceSizeAfterLoss: c.reduceSizeAfterLoss,
        reducedRiskPerTradePct: c.reducedRiskPerTradePct,
        atrRiskScaleEnabled: c.atrRiskScaleEnabled,
        atrRiskScaleFactor: c.atrRiskScaleFactor,
        atrRiskScaleThreshold: c.atrRiskScaleThreshold,
        secondTradeRiskFactor: c.secondTradeRiskFactor,
        trailingStopEnabled: c.trailingStopEnabled,
        trailingStopTriggerR: c.trailingStopTriggerR,
        compressionThreshold: c.compressionThreshold,
        expansionThreshold: c.expansionThreshold,
        wickRatio: c.wickRatio,
        minRangeATR: c.minRangeATR,
        postLossCooldownBars: c.postLossCooldownBars,
        _source: "champion_apply",
        _rationale: `Applied catalogue strategy: ${strategy.name} (${strategy.category})`,
      });
    },
    onSuccess: (_data, strategy) => {
      queryClient.invalidateQueries({ queryKey: ["/api/locked-params"] });
      queryClient.invalidateQueries({ queryKey: ["/api/locked-params/changelog"] });
      queryClient.invalidateQueries({ queryKey: ["/api/active-strategy-summary"] });
      toast({
        title: "Strategy Applied",
        description: `"${strategy.name}" is now active on live trading.`,
      });
      setApplyingId(null);
    },
    onError: (err: any) => {
      toast({ title: "Failed to apply", description: err.message, variant: "destructive" });
      setApplyingId(null);
    },
  });

  const isStrategyActive = (strategy: SavedStrategy): boolean => {
    if (!activeParams) return false;
    const c = strategy.config as Record<string, any>;
    const keys = ["riskPerTradePct", "rewardRatio", "atrStopMultiplier", "entryWindowBars", "sessionMode",
      "reduceSizeAfterLoss", "atrRiskScaleEnabled", "secondTradeRiskFactor", "trailingStopEnabled"];
    return keys.every(k => String(activeParams[k]) === String(c[k]));
  };

  const grouped = categoryOrder.map(cat => ({
    category: cat,
    meta: riskMeta[cat],
    strategies: (strategies || []).filter(s => s.category === cat),
  })).filter(g => g.strategies.length > 0);

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-10 w-64" />
        {[1, 2, 3].map(i => (
          <div key={i} className="space-y-3">
            <Skeleton className="h-8 w-48" />
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3].map(j => <Skeleton key={j} className="h-48" />)}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="p-6 space-y-8 max-w-7xl mx-auto h-full overflow-y-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">Strategy Catalogue</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Backtested strategies organized by risk profile. Apply any strategy to live trading with one click.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {categoryOrder.map(cat => {
          const meta = riskMeta[cat];
          const Icon = meta.icon;
          const strats = (strategies || []).filter(s => s.category === cat);
          const bestReturn = strats.length > 0
            ? Math.max(...strats.map(s => Number(s.stats.returnPct))).toFixed(0)
            : "0";
          const worstDD = strats.length > 0
            ? Math.max(...strats.map(s => Number(s.stats.maxDrawdownPct))).toFixed(1)
            : "0";
          return (
            <Card key={cat} className={`${meta.bg} ${meta.border} border`} data-testid={`card-risk-summary-${cat.toLowerCase().replace(' ', '-')}`}>
              <CardContent className="pt-4 pb-3 px-4">
                <div className="flex items-center gap-2 mb-2">
                  <Icon className={`w-4 h-4 ${meta.color}`} />
                  <span className={`text-sm font-semibold ${meta.color}`}>{meta.label}</span>
                </div>
                <div className="flex gap-4 text-xs text-muted-foreground">
                  <span>Best: <span className="font-medium text-foreground">{bestReturn}%</span></span>
                  <span>Max DD: <span className="font-medium text-foreground">{worstDD}%</span></span>
                  <span>{strats.length} strategies</span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {grouped.map(({ category, meta, strategies: strats }) => {
        const Icon = meta.icon;
        return (
          <div key={category} className="space-y-4">
            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-lg ${meta.bg} flex items-center justify-center`}>
                <Icon className={`w-4 h-4 ${meta.color}`} />
              </div>
              <div>
                <h2 className="text-lg font-semibold" data-testid={`text-category-${category.toLowerCase().replace(' ', '-')}`}>
                  {meta.label}
                </h2>
                <p className="text-xs text-muted-foreground">{meta.description}</p>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {strats.map(strategy => (
                <StrategyCard
                  key={strategy.id}
                  strategy={strategy}
                  isActive={isStrategyActive(strategy)}
                  onApply={() => {
                    setApplyingId(strategy.id);
                    applyMutation.mutate(strategy);
                  }}
                  isApplying={applyingId === strategy.id}
                />
              ))}
            </div>
          </div>
        );
      })}

      <Card className="border-dashed">
        <CardContent className="py-6 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-muted-foreground shrink-0" />
          <div className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Disclaimer:</span> All results are from backtesting over Jan–Apr 2026 with corrected position sizing.
            Past performance does not guarantee future results. Higher risk strategies may experience larger drawdowns in different market conditions.
            Always monitor live performance and be prepared to switch strategies if market regime changes significantly.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
