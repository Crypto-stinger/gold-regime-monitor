import { useQuery, useMutation } from "@tanstack/react-query";
import { PageGuide } from "@/components/page-guide";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  TrendingUp, Activity, Target, BarChart3, Clock, ArrowUpRight, ArrowDownRight,
  Minus, Shield, Ban, Download, Zap, Gauge, Copy, ExternalLink, Smartphone, Rocket,
} from "lucide-react";
import { useState } from "react";
import type { SavedStrategy } from "@shared/schema";

export default function StrategyPage() {
  const { toast } = useToast();
  const { data: recommended, isLoading } = useQuery<SavedStrategy>({
    queryKey: ["/api/strategies/recommended"],
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const { data: activeParams } = useQuery<Record<string, any>>({
    queryKey: ["/api/locked-params"],
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const { data: changelog } = useQuery<any[]>({
    queryKey: ["/api/locked-params/changelog"],
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const { data: activeSummary } = useQuery<{
    params: Record<string, any>;
    activeStrategy: { id: string; name: string; category: string; notes?: string; stats: any } | null;
  }>({
    queryKey: ["/api/active-strategy-summary"],
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const activeStrat = activeSummary?.activeStrategy;
  const champion = recommended || undefined;
  const c = champion?.config as Record<string, any> | undefined;

  const lastChange = changelog && changelog.length > 0 ? changelog[0] : null;
  const sourceLabel = lastChange?.source === "ai_advisor" ? "Set by AI Advisor" :
    lastChange?.source === "backtest_apply" ? "Applied from Backtest" :
    lastChange?.source === "champion_apply" ? "Applied from Strategy Page" :
    lastChange?.source === "auto_tuner" ? "Auto-Tuned" :
    lastChange?.source === "user" ? "Manual Update" : "System Default";


  const handleDownload = async () => {
    if (!champion) return;
    try {
      const res = await apiRequest("POST", "/api/strategies/export/ctrader-from-config", {
        config: champion.config,
        stats: champion.stats,
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `GoldRegime_Recommended_${champion.stats.returnPct}pct.algo`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Export failed", variant: "destructive" });
    }
  };

  const applyToLiveMutation = useMutation({
    mutationFn: async (config: Record<string, any>) => {
      const { startDate, endDate, executionTimeframe, startingBalance, dataSource, ...params } = config;
      params.leverage = 10;
      params.maxDrawdownPct = 25;
      params._source = "champion_apply";
      params._rationale = `Applied Champion strategy from Strategy page (${champion?.stats.returnPct}% return, ${champion?.stats.maxDrawdownPct}% DD)`;
      await apiRequest("PUT", "/api/locked-params", params);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/locked-params"] });
      queryClient.invalidateQueries({ queryKey: ["/api/locked-params/changelog"] });
      queryClient.invalidateQueries({ queryKey: ["/api/active-strategy-summary"] });
      toast({ title: "Strategy applied to live trading!", description: "Parameters updated. The live trader will use these settings." });
    },
    onError: () => {
      toast({ title: "Failed to apply strategy", variant: "destructive" });
    },
  });

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="p-6 border-b bg-background/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold" data-testid="heading-strategy">Strategy Documentation</h1>
          <Badge className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 text-xs">v9</Badge>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">
          Gold Regime Playbook v9 — Champion engine with immediate entry, no ADX/BB percentile filters, exact exit pricing
        </p>
        <PageGuide
          title="Strategy — What's Active and What's Recommended"
          summary="This page shows your active live trading strategy and compares it to the top recommended strategy from the catalogue. It also documents how the strategy engine works."
          steps={[
            { title: "Currently Active (top card)", description: "The blue card at the top shows the exact parameters your live bot is trading with right now. It also shows who last changed them (you, the AI, or from a backtest) and when." },
            { title: "Match/Mismatch Badge", description: "A green 'Matches Recommended' badge means your live settings match the top-ranked strategy from the catalogue. An amber badge means they've drifted apart." },
            { title: "Recommended Strategy", description: "The green card shows the highest-ranked strategy from the catalogue (best Return/Drawdown ratio). Click 'Apply to Live Trading' to make it your active strategy." },
            { title: "Export to cTrader", description: "Download the strategy as a .algo file for cTrader, copy the source code, or use the direct install links for your phone." },
            { title: "Strategy Documentation", description: "Scroll down to understand how the 3-state regime classifier works, entry/exit rules, and what changed in v9." },
          ]}
          tips={[
            "If the badge says 'Different from Recommended', click 'Apply to Live Trading' on the Recommended card to sync them up.",
            "The AI Advisor can also change your active strategy — check the changelog in Settings to see all changes.",
          ]}
        />
      </div>

      <div className="p-6 space-y-5 max-w-4xl">

        {activeParams && (
          <Card className="border-primary/30 bg-gradient-to-r from-primary/5 to-transparent" data-testid="active-strategy-status">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Activity className="w-5 h-5 text-primary" />
                <CardTitle className="text-base">Currently Active on Live Trading</CardTitle>
                {activeStrat?.category && (
                  <Badge className="bg-primary/10 text-primary border-primary/30 text-xs ml-auto">
                    {activeStrat.category}
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {activeStrat && (
                <div>
                  <p className="text-base font-semibold" data-testid="text-active-name">{activeStrat.name}</p>
                  {activeStrat.notes && (
                    <p className="text-xs text-muted-foreground mt-0.5">{activeStrat.notes}</p>
                  )}
                </div>
              )}
              {activeStrat && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="bg-primary/5 border border-primary/20 rounded-md p-3 text-center">
                    <div className="text-xs text-muted-foreground mb-0.5">Return</div>
                    <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400" data-testid="text-active-return">{Number(activeStrat.stats.returnPct).toFixed(1)}%</div>
                  </div>
                  <div className="bg-primary/5 border border-primary/20 rounded-md p-3 text-center">
                    <div className="text-xs text-muted-foreground mb-0.5">Max DD</div>
                    <div className="text-lg font-bold text-amber-700 dark:text-amber-400" data-testid="text-active-dd">{Number(activeStrat.stats.maxDrawdownPct).toFixed(1)}%</div>
                  </div>
                  <div className="bg-primary/5 border border-primary/20 rounded-md p-3 text-center">
                    <div className="text-xs text-muted-foreground mb-0.5">Win Rate</div>
                    <div className="text-lg font-bold" data-testid="text-active-wr">{Number(activeStrat.stats.winRate).toFixed(1)}%</div>
                  </div>
                  <div className="bg-primary/5 border border-primary/20 rounded-md p-3 text-center">
                    <div className="text-xs text-muted-foreground mb-0.5">Trades</div>
                    <div className="text-lg font-bold" data-testid="text-active-trades">{activeStrat.stats.totalTrades}</div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                {[
                  { label: "Profit Factor", value: activeStrat ? Number(activeStrat.stats.profitFactor).toFixed(1) : "--" },
                  { label: "R/DD Ratio", value: activeStrat && Number(activeStrat.stats.maxDrawdownPct) > 0 ? (Number(activeStrat.stats.returnPct) / Number(activeStrat.stats.maxDrawdownPct)).toFixed(1) : "--" },
                  { label: "Risk/Trade", value: `${activeParams.riskPerTradePct}%` },
                  { label: "Reward:Risk", value: `${activeParams.rewardRatio}:1` },
                  { label: "ATR Stop", value: `${activeParams.atrStopMultiplier}x` },
                  { label: "Session", value: activeParams.sessionMode },
                  { label: "Entry Window", value: activeParams.entryWindowBars === 0 ? "Immediate" : `${activeParams.entryWindowBars} bar${activeParams.entryWindowBars > 1 ? 's' : ''}` },
                  { label: "Leverage", value: `${Math.min(activeParams.leverage || 10, 10)}x` },
                  { label: "Expansion", value: `${activeParams.expansionThreshold}x` },
                  { label: "Compression", value: activeParams.compressionThreshold },
                ].map(({ label, value }) => (
                  <div key={label} className="bg-muted/40 rounded-md p-2">
                    <div className="text-[10px] text-muted-foreground">{label}</div>
                    <div className="font-semibold text-xs">{value}</div>
                  </div>
                ))}
              </div>

              <p className="text-xs text-muted-foreground">
                These are the exact parameters your live trader and AI advisor are using right now.
                {lastChange && (
                  <span className="font-medium text-foreground"> Last changed: {sourceLabel}{lastChange.timestamp ? ` on ${new Date(lastChange.timestamp).toLocaleDateString()}` : ""}</span>
                )}
              </p>
              {lastChange?.rationale && (
                <div className="text-xs text-muted-foreground italic border-l-2 border-primary/30 pl-2">
                  "{lastChange.rationale}"
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {isLoading ? (
          <Card className="border-amber-500/30">
            <CardContent className="py-6"><Skeleton className="h-32 w-full" /></CardContent>
          </Card>
        ) : champion && c ? (
          <Card className="border-emerald-500/30 bg-gradient-to-r from-emerald-500/5 to-transparent" data-testid="champion-card">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-emerald-500" />
                <CardTitle className="text-base">Recommended Strategy</CardTitle>
                {champion?.category && (
                  <Badge className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 text-xs ml-auto">
                    {champion.category} — Best R/DD
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {champion.name && (
                <div>
                  <p className="text-base font-semibold" data-testid="text-champion-name">{champion.name}</p>
                  {champion?.notes && (
                    <p className="text-xs text-muted-foreground mt-0.5">{champion.notes}</p>
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-md p-3 text-center">
                  <div className="text-xs text-muted-foreground mb-0.5">Return</div>
                  <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400" data-testid="text-champion-return">{Number(champion.stats.returnPct).toFixed(1)}%</div>
                </div>
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-md p-3 text-center">
                  <div className="text-xs text-muted-foreground mb-0.5">Max DD</div>
                  <div className="text-lg font-bold text-amber-700 dark:text-amber-400" data-testid="text-champion-dd">{Number(champion.stats.maxDrawdownPct).toFixed(1)}%</div>
                </div>
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-md p-3 text-center">
                  <div className="text-xs text-muted-foreground mb-0.5">Win Rate</div>
                  <div className="text-lg font-bold" data-testid="text-champion-wr">{Number(champion.stats.winRate).toFixed(1)}%</div>
                </div>
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-md p-3 text-center">
                  <div className="text-xs text-muted-foreground mb-0.5">Trades</div>
                  <div className="text-lg font-bold" data-testid="text-champion-trades">{champion.stats.totalTrades}</div>
                </div>
              </div>

              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                {[
                  { label: "Profit Factor", value: Number(champion.stats.profitFactor).toFixed(1) },
                  { label: "R/DD Ratio", value: Number(champion.stats.maxDrawdownPct) > 0 ? (Number(champion.stats.returnPct) / Number(champion.stats.maxDrawdownPct)).toFixed(1) : "∞" },
                  { label: "Risk/Trade", value: `${c.riskPerTradePct}%` },
                  { label: "Reward:Risk", value: `${c.rewardRatio}:1` },
                  { label: "ATR Stop", value: `${c.atrStopMultiplier}x` },
                  { label: "Session", value: c.sessionMode },
                  { label: "Entry Window", value: c.entryWindowBars === 0 ? "Immediate" : `${c.entryWindowBars} bar${c.entryWindowBars > 1 ? 's' : ''}` },
                  { label: "Leverage", value: `${Math.min(c.leverage || 10, 10)}x` },
                  { label: "Expansion", value: `${c.expansionThreshold}x` },
                  { label: "Compression", value: c.compressionThreshold },
                ].map(({ label, value }) => (
                  <div key={label} className="bg-muted/40 rounded-md p-2">
                    <div className="text-[10px] text-muted-foreground">{label}</div>
                    <div className="font-semibold text-xs">{value}</div>
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                <Button
                  size="sm"
                  className="w-full h-9 text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
                  disabled={applyToLiveMutation.isPending}
                  onClick={() => {
                    if (c) applyToLiveMutation.mutate(c);
                  }}
                  data-testid="button-apply-live"
                >
                  <Rocket className="w-3.5 h-3.5 mr-1.5" />
                  {applyToLiveMutation.isPending ? "Applying…" : "Apply to Live Trading"}
                </Button>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1 h-8 text-xs bg-amber-600 hover:bg-amber-700 text-white"
                    onClick={handleDownload}
                    data-testid="button-download-champion"
                  >
                    <Download className="w-3.5 h-3.5 mr-1.5" />
                    Download .algo
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 h-8 text-xs border-emerald-500/30 text-emerald-700 dark:text-emerald-400"
                    onClick={async () => {
                      try {
                        const res = await fetch("/api/strategies/export/recommended-source");
                        const code = await res.text();
                        await navigator.clipboard.writeText(code);
                        toast({ title: "Source code copied to clipboard!" });
                      } catch {
                        toast({ title: "Copy failed", variant: "destructive" });
                      }
                    }}
                    data-testid="button-copy-source"
                  >
                    <Copy className="w-3.5 h-3.5 mr-1.5" />
                    Copy Source Code
                  </Button>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1 h-8 text-xs bg-red-600 hover:bg-red-700 text-white"
                    onClick={async () => {
                      try {
                        const res = await fetch("/api/strategies/export/recommended-locked.algo");
                        const blob = await res.blob();
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `GoldRegime_Locked_${champion.stats.returnPct}pct.algo`;
                        a.click();
                        URL.revokeObjectURL(url);
                        toast({ title: "Locked bot downloaded (parameters hardcoded)" });
                      } catch {
                        toast({ title: "Download failed", variant: "destructive" });
                      }
                    }}
                    data-testid="button-download-locked"
                  >
                    <Shield className="w-3.5 h-3.5 mr-1.5" />
                    Download Locked (Bulletproof)
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 h-8 text-xs border-red-500/30 text-red-700 dark:text-red-400"
                    onClick={async () => {
                      try {
                        const res = await fetch("/api/strategies/export/recommended-locked-source");
                        const code = await res.text();
                        await navigator.clipboard.writeText(code);
                        toast({ title: "Locked source code copied (parameters hardcoded)" });
                      } catch {
                        toast({ title: "Copy failed", variant: "destructive" });
                      }
                    }}
                    data-testid="button-copy-locked-source"
                  >
                    <Copy className="w-3.5 h-3.5 mr-1.5" />
                    Copy Locked Code
                  </Button>
                </div>
                <a
                  href="/api/strategies/export/recommended.algo"
                  className="flex items-center justify-center gap-1.5 w-full h-7 text-[11px] text-muted-foreground hover:text-foreground border border-dashed border-muted-foreground/30 rounded-md transition-colors"
                  data-testid="link-direct-download"
                >
                  <Smartphone className="w-3 h-3" />
                  Direct link (tap on phone, then open in cTrader)
                </a>
                <a
                  href="/api/strategies/export/recommended-locked.algo"
                  className="flex items-center justify-center gap-1.5 w-full h-7 text-[11px] text-muted-foreground hover:text-foreground border border-dashed border-muted-foreground/30 rounded-md transition-colors"
                  data-testid="link-direct-download-locked"
                >
                  <Shield className="w-3 h-3" />
                  Locked direct link (parameters cannot be changed)
                </a>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
                <TrendingUp className="w-3.5 h-3.5 text-primary" />
              </div>
              <CardTitle className="text-base">Strategy Overview — v9 Champion</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-muted-foreground leading-relaxed">
              The <strong className="text-foreground">Gold Regime Playbook v9</strong> trades XAUUSD using a strict 3-state regime classifier (Range / Trend / No-Trade). It uses H4 market structure for regime detection and H1 for execution. V9 is the champion engine — it removed ADX trend filtering, BB percentile range filtering, exit spread double-counting, and introduced immediate entry (entryWindowBars=0) with ATR risk scaling at 0.65x.
            </p>
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-md p-3">
              <div className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-2">V9 Key Changes (from V3)</div>
              <ul className="text-xs text-muted-foreground space-y-1">
                <li className="flex items-start gap-1.5"><span className="text-emerald-500 mt-0.5">+</span> Immediate entry — entryWindowBars = 0 (was 1)</li>
                <li className="flex items-start gap-1.5"><span className="text-emerald-500 mt-0.5">+</span> ATR risk scale factor = 0.65 (high-vol risk reduction)</li>
                <li className="flex items-start gap-1.5"><span className="text-red-500 mt-0.5">-</span> Removed ADX trend filter (was blocking valid trends)</li>
                <li className="flex items-start gap-1.5"><span className="text-red-500 mt-0.5">-</span> Removed BB percentile range filter (was too restrictive)</li>
                <li className="flex items-start gap-1.5"><span className="text-red-500 mt-0.5">-</span> Removed exit spread double-counting (exits use exact stop/target prices)</li>
                <li className="flex items-start gap-1.5"><span className="text-red-500 mt-0.5">-</span> EMA200 filter disabled</li>
                <li className="flex items-start gap-1.5"><span className="text-red-500 mt-0.5">-</span> Avoid hours disabled</li>
              </ul>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { label: "Symbol", value: "XAUUSD", sub: "Spot Gold / USD" },
                { label: "Regime TF", value: "H4", sub: "Structure & classification" },
                { label: "Execution TF", value: "H1", sub: "Entry & management" },
              ].map(({ label, value, sub }) => (
                <div key={label} className="bg-muted/40 rounded-md p-3">
                  <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
                  <div className="font-semibold">{value}</div>
                  <div className="text-xs text-muted-foreground">{sub}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {activeParams && c && (
          <Card data-testid="params-comparison-card">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
                  <Gauge className="w-3.5 h-3.5 text-primary" />
                </div>
                <CardTitle className="text-base">Parameter Comparison</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="text-sm">
              {(() => {
                const rows = [
                  { label: "Reward:Risk", active: `${activeParams.rewardRatio}:1`, rec: `${c.rewardRatio}:1`, desc: "Take profit ratio" },
                  { label: "ATR Stop", active: `${activeParams.atrStopMultiplier}x`, rec: `${c.atrStopMultiplier}x`, desc: "Stop loss multiplier" },
                  { label: "Risk/Trade", active: `${activeParams.riskPerTradePct}%`, rec: `${c.riskPerTradePct}%`, desc: "Position sizing" },
                  { label: "Leverage", active: `${Math.min(activeParams.leverage || 10, 10)}x`, rec: `${Math.min(c.leverage || 10, 10)}x`, desc: "Account leverage" },
                  { label: "Session", active: activeParams.sessionMode, rec: c.sessionMode, desc: "Trading session" },
                  { label: "Entry Window", active: `${activeParams.entryWindowBars ?? 0} bars`, rec: `${c.entryWindowBars ?? 0} bars`, desc: "Signal wait period" },
                  { label: "Expansion", active: `${activeParams.expansionThreshold}x`, rec: `${c.expansionThreshold}x`, desc: "ATR expansion trigger" },
                  { label: "Compression", active: `${activeParams.compressionThreshold}`, rec: `${c.compressionThreshold}`, desc: "BB width threshold" },
                  { label: "ATR Risk Scale", active: `${activeParams.atrRiskScaleFactor ?? 0.65}x`, rec: `${c.atrRiskScaleFactor ?? 0.65}x`, desc: "High-vol risk reduction" },
                  { label: "Max DD", active: `${activeParams.maxDrawdownPct}%`, rec: `${c.maxDrawdownPct ?? 25}%`, desc: "Circuit breaker" },
                  { label: "Max Trades/Day", active: `${activeParams.maxTradesPerDay}`, rec: `${c.maxTradesPerDay}`, desc: "Daily trade limit" },
                  { label: "Range Bars", active: `${activeParams.rangeWidthBars}`, rec: `${c.rangeWidthBars}`, desc: "H4 lookback bars" },
                  { label: "Midpoint Band", active: `${((activeParams.midpointBandPct || 0.08) * 100).toFixed(0)}%`, rec: `${((c.midpointBandPct || 0.08) * 100).toFixed(0)}%`, desc: "No-trade zone width" },
                  { label: "Wick Ratio", active: `${activeParams.wickRatio}`, rec: `${c.wickRatio}`, desc: "Min rejection wick" },
                ];
                return (
                  <div className="space-y-0">
                    <div className="grid grid-cols-[1fr,80px,80px] gap-2 px-2 pb-2 border-b">
                      <div className="text-[10px] font-semibold text-muted-foreground uppercase">Parameter</div>
                      <div className="text-[10px] font-semibold text-primary text-center uppercase">Active</div>
                      <div className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 text-center uppercase">Recommended</div>
                    </div>
                    {rows.map(({ label, active, rec, desc }) => {
                      const match = active === rec;
                      return (
                        <div key={label} className={`grid grid-cols-[1fr,80px,80px] gap-2 px-2 py-1.5 rounded-md ${match ? '' : 'bg-amber-500/5'}`}>
                          <div>
                            <div className="text-xs font-medium">{label}</div>
                            <div className="text-[10px] text-muted-foreground">{desc}</div>
                          </div>
                          <div className={`text-center font-mono text-xs font-semibold ${match ? 'text-foreground' : 'text-primary'}`}>{active}</div>
                          <div className={`text-center font-mono text-xs font-semibold ${match ? 'text-foreground' : 'text-emerald-600 dark:text-emerald-400'}`}>{rec}</div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
                <Activity className="w-3.5 h-3.5 text-primary" />
              </div>
              <CardTitle className="text-base">V9 Regime Classifier (3-State)</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-muted-foreground leading-relaxed">
              Each H1 bar is classified into exactly one of three states. The default is <strong className="text-foreground">no_trade</strong> when uncertain. V9 uses only ATR expansion and BB width compression — no ADX or BB percentile filters.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="border rounded-md p-3 space-y-1.5">
                <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-0 text-xs mb-1">Range</Badge>
                <ul className="text-xs text-muted-foreground space-y-1">
                  <li>ATR not expanding (flat or below avg)</li>
                  <li>BB width &lt; compression threshold</li>
                  <li>OR ATR &le; average ATR</li>
                  <li>Price inside H4 range boundaries</li>
                  <li>NOT in midpoint no-trade zone</li>
                  <li className="text-red-400 line-through">No BB percentile filter (removed v9)</li>
                </ul>
              </div>
              <div className="border rounded-md p-3 space-y-1.5">
                <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-0 text-xs mb-1">Trend</Badge>
                <ul className="text-xs text-muted-foreground space-y-1">
                  <li>ATR expanding &gt; {c?.expansionThreshold || 1.15}x avg</li>
                  <li>Price breaks above/below H4 range</li>
                  <li>Not just a wick sweep</li>
                  <li>Acceptance on retest</li>
                  <li className="text-red-400 line-through">No ADX filter (removed v9)</li>
                </ul>
              </div>
              <div className="border rounded-md p-3 space-y-1.5">
                <Badge className="bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 border-0 text-xs mb-1">No Trade</Badge>
                <ul className="text-xs text-muted-foreground space-y-1">
                  <li>Price in midpoint band</li>
                  <li>ATR data insufficient</li>
                  <li>Signal ambiguous</li>
                  <li>News blackout active</li>
                  <li>GVZ/COT/HMM filter blocks</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
                <Target className="w-3.5 h-3.5 text-primary" />
              </div>
              <CardTitle className="text-base">V9 Entry Rules (H1 Execution)</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-md p-2.5 mb-2">
              <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">V9: Immediate Entry (entryWindowBars = 0)</div>
              <div className="text-[10px] text-muted-foreground">Signals execute on the same bar — no waiting period. This increased the champion return by capturing entries that previously expired.</div>
            </div>
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-0 text-xs">Range Mode</Badge>
                <span className="text-xs text-muted-foreground">Rejection at Extremes</span>
              </div>
              <div className="space-y-2 pl-3 border-l-2 border-blue-400/40">
                <div className="flex items-start gap-2">
                  <ArrowUpRight className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-xs">Buy at Support</div>
                    <div className="text-xs text-muted-foreground">Price near H4 range low + bullish rejection candle (wick ratio &ge; {c?.wickRatio || 0.5}) + daily bias not bearish</div>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <ArrowDownRight className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-xs">Sell at Resistance</div>
                    <div className="text-xs text-muted-foreground">Price near H4 range high + bearish rejection candle (wick ratio &ge; {c?.wickRatio || 0.5}) + daily bias not bullish</div>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <div className="flex items-center gap-2 mb-2">
                <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-0 text-xs">Trend Mode</Badge>
                <span className="text-xs text-muted-foreground">Breakout Acceptance</span>
              </div>
              <div className="space-y-2 pl-3 border-l-2 border-amber-400/40">
                <div className="flex items-start gap-2">
                  <ArrowUpRight className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-xs">Long Breakout</div>
                    <div className="text-xs text-muted-foreground">Previous H1 close below range high, current closes above it, retest holds (buffer: {c?.retestBuffer || 12}), daily bullish bias</div>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <ArrowDownRight className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-xs">Short Breakout</div>
                    <div className="text-xs text-muted-foreground">Previous H1 close above range low, current closes below it, retest fails (buffer: {c?.retestBuffer || 12}), daily bearish bias</div>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
                <Shield className="w-3.5 h-3.5 text-primary" />
              </div>
              <CardTitle className="text-base">Liquidity Classification</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-sm">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { name: "Rejection", desc: "Price tests a key level but closes back away from it. Valid for range entries.", color: "text-emerald-600 dark:text-emerald-400" },
                { name: "Acceptance", desc: "Price breaks the level, closes beyond it, and retest holds. Valid for trend entries.", color: "text-amber-600 dark:text-amber-400" },
                { name: "Fake Breakout", desc: "Price breaks level but quickly closes back inside. NOT a valid trend entry.", color: "text-red-600 dark:text-red-400" },
              ].map(({ name, desc, color }) => (
                <div key={name} className="bg-muted/40 rounded-md p-3">
                  <div className={`font-semibold text-xs mb-1 ${color}`}>{name}</div>
                  <div className="text-xs text-muted-foreground">{desc}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
                <BarChart3 className="w-3.5 h-3.5 text-primary" />
              </div>
              <CardTitle className="text-base">V9 Exit Rules — Exact Pricing</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-md p-2.5 mb-2">
              <div className="text-xs font-medium text-amber-700 dark:text-amber-400">V9: No Spread Deduction on Exits</div>
              <div className="text-[10px] text-muted-foreground">Exits use the exact stop loss and take profit prices. Spread is only applied on entry. This fixed the double-counting that was reducing returns in earlier versions.</div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="bg-muted/40 rounded-md p-3 space-y-1">
                <div className="font-medium text-xs">Stop Loss (ATR-based)</div>
                <div className="font-mono text-base text-primary">SL = {c?.atrStopMultiplier || 2.75} x H1 ATR({c?.atrStopPeriod || 14})</div>
                <div className="text-xs text-muted-foreground">Dynamic, scales with volatility. Exact price — no spread adjustment.</div>
              </div>
              <div className="bg-muted/40 rounded-md p-3 space-y-1">
                <div className="font-medium text-xs">Take Profit (Fixed R:R)</div>
                <div className="font-mono text-base text-primary">TP = Entry +/- (SL x {c?.rewardRatio || 4})</div>
                <div className="text-xs text-muted-foreground">{c?.rewardRatio || 4}:1 reward-to-risk ratio. Exact price — no spread adjustment.</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
                <Ban className="w-3.5 h-3.5 text-primary" />
              </div>
              <CardTitle className="text-base">Midpoint No-Trade Filter</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="text-muted-foreground leading-relaxed mb-3">
              Compute the recent H4 range high and low. The midpoint is the center of this range, surrounded by a configurable no-trade band ({c ? `${(c.midpointBandPct * 100).toFixed(0)}%` : "10%"} of range width on each side). No entries are taken while price is inside this band.
            </p>
            <div className="bg-muted/40 rounded-md p-3 font-mono text-xs space-y-1">
              <div>mid = (range_high + range_low) / 2</div>
              <div>band = range_width * midpoint_band_pct</div>
              <div>no_trade if: mid - band &lt;= price &lt;= mid + band</div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
                <Gauge className="w-3.5 h-3.5 text-primary" />
              </div>
              <CardTitle className="text-base">V9 Risk Management</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="text-sm">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {[
                { label: "Max Drawdown", value: `${c?.maxDrawdownPct || 25}%`, desc: "Circuit breaker — stops all trading" },
                { label: "Daily Loss Cap", value: `${c?.maxDailyLossPct || 2}%`, desc: "Max daily realized loss" },
                { label: "Consecutive Loss Pause", value: `${c?.maxConsecutiveLosses || 2} losses`, desc: `Sit out ${c?.postLossCooldownBars || 2} bars after streak` },
                { label: "ATR Risk Scaling", value: `${c?.atrRiskScaleFactor || 0.65}x`, desc: `Reduce position size when ATR > ${c?.atrRiskScaleThreshold || 1.25}x avg (V9 champion value)` },
                { label: "Starting Balance", value: `$${c?.startingBalance || 3000}`, desc: "Initial account equity" },
                { label: "2nd Trade Factor", value: `${c?.secondTradeRiskFactor || 0.75}x`, desc: "Reduced risk on 2nd+ daily trade" },
              ].map(({ label, value, desc }) => (
                <div key={label} className="bg-muted/40 rounded-md p-2.5">
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs font-medium">{label}</span>
                    <span className="font-mono font-semibold text-xs text-primary">{value}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{desc}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
                <Clock className="w-3.5 h-3.5 text-primary" />
              </div>
              <CardTitle className="text-base">Trade Management Rules</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {[
                "Max 1 open position. Wait for full close before re-entering.",
                `Max ${c?.maxTradesPerDay || 8} trades per day (configurable).`,
                `Session filter: ${c?.sessionMode || "London+NewYork"} hours only.`,
                `Event blackout: No entries within ${c?.newsBeforeMin || 30}/${c?.newsAfterMin || 30} min before/after news.`,
                `No midpoint trades. Dead zone = ${c ? (c.midpointBandPct * 100).toFixed(0) : 10}% band around range center.`,
                "Exits use exact stop/target prices — NO spread deduction (V9).",
                "Immediate entry on signal — entryWindowBars = 0 (V9).",
                "Do NOT move stop loss to breakeven. Trust ATR-based placement.",
                "Do NOT take partial profits. Full target or full stop.",
                "EMA200 filter disabled — do not filter by trend direction (V9).",
                "Avoid hours disabled — trade all session hours (V9).",
                "When uncertain about regime, classify as no_trade.",
              ].map((rule, i) => (
                <li key={i} className="flex items-start gap-2">
                  <Minus className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                  <span className="text-muted-foreground leading-relaxed">{rule}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
