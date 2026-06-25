import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageGuide } from "@/components/page-guide";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  Settings, Save, RotateCcw, Shield, TrendingUp, Target, Sliders,
  Clock, Brain, History, ChevronDown, ChevronUp, AlertCircle, Check,
  Bot, User, BarChart3,
} from "lucide-react";

type ParamGroup = {
  title: string;
  icon: any;
  description: string;
  params: ParamDef[];
};

type ParamDef = {
  key: string;
  label: string;
  type: "number" | "boolean" | "select" | "text";
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  description?: string;
};

type ChangelogEntry = {
  id: number;
  timestamp: string;
  source: string;
  changedKeys: string[];
  oldValues: Record<string, any>;
  newValues: Record<string, any>;
  rationale: string;
};

const paramGroups: ParamGroup[] = [
  {
    title: "Core Strategy",
    icon: Target,
    description: "Main strategy parameters that define entry and exit logic",
    params: [
      { key: "rewardRatio", label: "Reward Ratio", type: "number", min: 1, max: 20, step: 0.5, description: "Risk:Reward ratio for take profit" },
      { key: "atrStopMultiplier", label: "ATR Stop Multiplier", type: "number", min: 0.5, max: 5, step: 0.25, description: "ATR multiplier for stop loss distance" },
      { key: "atrPeriod", label: "ATR Period", type: "number", min: 5, max: 50, step: 1 },
      { key: "wickRatio", label: "Wick Ratio", type: "number", min: 0.3, max: 5, step: 0.1, description: "Min wick-to-body ratio for rejection signals" },
      { key: "retestBuffer", label: "Retest Buffer", type: "number", min: 0.5, max: 50, step: 0.5, description: "Points buffer for S/R retest entries" },
    ],
  },
  {
    title: "Regime Detection",
    icon: Sliders,
    description: "Parameters controlling range/trend classification",
    params: [
      { key: "compressionThreshold", label: "Compression Threshold", type: "number", min: 0.001, max: 0.1, step: 0.001, description: "BB width threshold for range detection" },
      { key: "expansionThreshold", label: "Expansion Threshold", type: "number", min: 1.01, max: 3, step: 0.05, description: "ATR ratio threshold for trend detection" },
      { key: "rangeWidthBars", label: "Range Width Bars", type: "number", min: 5, max: 50, step: 1, description: "Lookback bars for range S/R" },
      { key: "midpointBandPct", label: "Midpoint Band %", type: "number", min: 0.01, max: 0.5, step: 0.01 },
      { key: "minRangeATR", label: "Min Range ATR", type: "number", min: 0, max: 10, step: 0.1, description: "Minimum ATR multiplier for valid ranges" },
      { key: "maxTrendATRRatio", label: "Max Trend ATR Ratio", type: "number", min: 1, max: 20, step: 0.5, description: "Maximum ATR ratio to filter extreme volatility" },
    ],
  },
  {
    title: "Risk Management",
    icon: Shield,
    description: "Position sizing, drawdown limits, and loss controls",
    params: [
      { key: "riskPerTradePct", label: "Risk Per Trade %", type: "number", min: 0.1, max: 10, step: 0.1, description: "Account % risked per trade" },
      { key: "leverage", label: "Leverage", type: "number", min: 1, max: 10, step: 1 },
      { key: "maxDrawdownPct", label: "Max Drawdown %", type: "number", min: 5, max: 25, step: 1 },
      { key: "maxDailyLossPct", label: "Max Daily Loss %", type: "number", min: 0.5, max: 20, step: 0.5 },
      { key: "maxConsecutiveLosses", label: "Max Consecutive Losses", type: "number", min: 1, max: 20, step: 1, description: "Pause trading after N consecutive losses" },
      { key: "maxTradesPerDay", label: "Max Trades/Day", type: "number", min: 1, max: 10, step: 1 },
      { key: "postLossCooldownBars", label: "Post-Loss Cooldown", type: "number", min: 0, max: 20, step: 1, description: "Bars to wait after a loss" },
      { key: "reduceSizeAfterLoss", label: "Reduce Size After Loss", type: "boolean", description: "Cut position size after a losing trade" },
      { key: "reducedRiskPerTradePct", label: "Reduced Risk %", type: "number", min: 0.1, max: 10, step: 0.1, description: "Reduced risk % after loss" },
      { key: "secondTradeRiskFactor", label: "2nd Trade Risk Factor", type: "number", min: 0.1, max: 1, step: 0.05, description: "Risk scaling for 2nd trade of the day" },
    ],
  },
  {
    title: "ATR Risk Scaling",
    icon: TrendingUp,
    description: "Dynamic risk adjustment based on volatility",
    params: [
      { key: "atrRiskScaleEnabled", label: "ATR Risk Scale Enabled", type: "boolean" },
      { key: "atrRiskScaleThreshold", label: "ATR Scale Threshold", type: "number", min: 1.01, max: 5, step: 0.05 },
      { key: "atrRiskScaleFactor", label: "ATR Scale Factor", type: "number", min: 0.1, max: 1, step: 0.05, description: "Risk multiplier when ATR exceeds threshold" },
    ],
  },
  {
    title: "Session & Timing",
    icon: Clock,
    description: "Trading session windows and timing controls",
    params: [
      { key: "sessionMode", label: "Session Mode", type: "select", options: [
        { value: "London+NewYork", label: "London + New York" },
        { value: "London", label: "London" },
        { value: "NewYork", label: "New York" },
        { value: "Asian", label: "Asian" },
        { value: "Asian+London", label: "Asian + London" },
        { value: "Asian+London+NewYork", label: "Asian + London + New York" },
        { value: "All", label: "All Sessions" },
      ]},
      { key: "sessionORBEnabled", label: "Session ORB Enabled", type: "boolean", description: "Opening range breakout filter" },
      { key: "entryWindowBars", label: "Entry Window Bars", type: "number", min: 0, max: 12, step: 1 },
      { key: "newsBeforeMin", label: "News Blackout Before (min)", type: "number", min: 0, max: 240, step: 5 },
      { key: "newsAfterMin", label: "News Blackout After (min)", type: "number", min: 0, max: 240, step: 5 },
      { key: "avoidHoursEnabled", label: "Avoid Hours Filter", type: "boolean", description: "Block entries during low-liquidity hours (21-00 UTC)" },
      { key: "avoidHoursUTC", label: "Avoid Hours (UTC)", type: "text", description: "Comma-separated UTC hours to avoid, e.g. 21,22,23,0" },
      { key: "peakHoursEnabled", label: "Peak Hours Filter", type: "boolean", description: "Restrict entries to best-performing hours only" },
      { key: "peakHoursUTC", label: "Peak Hours (UTC)", type: "text", description: "Comma-separated UTC hours to allow, e.g. 8,9,10,13,14" },
    ],
  },
  {
    title: "Filters & Safety",
    icon: Shield,
    description: "Gap filters, trailing stops, and execution costs",
    params: [
      { key: "gapFilterEnabled", label: "Gap Filter Enabled", type: "boolean" },
      { key: "gapThresholdAtr", label: "Gap Threshold (ATR)", type: "number", min: 0.1, max: 5, step: 0.1 },
      { key: "gapCooldownBars", label: "Gap Cooldown Bars", type: "number", min: 1, max: 12, step: 1 },
      { key: "trailingStopEnabled", label: "Trailing Stop", type: "boolean" },
      { key: "trailingStopTriggerR", label: "Trailing Stop Trigger (R)", type: "number", min: 0.5, max: 10, step: 0.5 },
      { key: "spreadPoints", label: "Spread (points)", type: "number", min: 0, max: 5, step: 0.05 },
      { key: "slippagePoints", label: "Slippage (points)", type: "number", min: 0, max: 5, step: 0.05 },
      { key: "commissionPerLot", label: "Commission/Lot", type: "number", min: 0, max: 50, step: 1 },
    ],
  },
  {
    title: "Volume Profile",
    icon: BarChart3,
    description: "Volume distribution analysis for entry confirmation",
    params: [
      { key: "volumeProfileEnabled", label: "Volume Profile Enabled", type: "boolean", description: "Use VP levels (POC/VAH/VAL) to filter entries" },
      { key: "volumeProfilePeriod", label: "VP Lookback (H4 bars)", type: "number", min: 10, max: 200, step: 5 },
      { key: "volumeProfileBins", label: "VP Price Bins", type: "number", min: 10, max: 100, step: 2 },
      { key: "volumeProfileValueAreaPct", label: "Value Area %", type: "number", min: 50, max: 90, step: 5 },
      { key: "vpPocProximityPct", label: "POC Proximity Block %", type: "number", min: 0.05, max: 0.50, step: 0.05, description: "Block entries within this % of value area range from POC" },
    ],
  },
  {
    title: "Account",
    icon: TrendingUp,
    description: "Starting balance and lot size",
    params: [
      { key: "startingBalance", label: "Starting Balance ($)", type: "number", min: 100, max: 1000000, step: 100 },
      { key: "lotSize", label: "Lot Size", type: "number", min: 0.01, max: 100, step: 0.01 },
    ],
  },
];

export default function SettingsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editedParams, setEditedParams] = useState<Record<string, any>>({});
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(paramGroups.map(g => g.title)));
  const [showChangelog, setShowChangelog] = useState(true);

  const paramsQuery = useQuery<Record<string, any>>({
    queryKey: ["/api/locked-params"],
  });

  const changelogQuery = useQuery<ChangelogEntry[]>({
    queryKey: ["/api/locked-params/changelog"],
    refetchInterval: 15000,
  });

  const proposalsQuery = useQuery<any[]>({
    queryKey: ["/api/locked-params/proposals"],
    refetchInterval: 15000,
  });

  useEffect(() => {
    if (paramsQuery.data) {
      setEditedParams({ ...paramsQuery.data });
    }
  }, [paramsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async (params: Record<string, any>) => {
      const res = await apiRequest("PUT", "/api/locked-params", params);
      return await res.json();
    },
    onSuccess: (data) => {
      setEditedParams(data);
      queryClient.invalidateQueries({ queryKey: ["/api/locked-params"] });
      queryClient.invalidateQueries({ queryKey: ["/api/locked-params/changelog"] });
      toast({ title: "Settings saved", description: "Parameters updated and live trader reloaded." });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const approveMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/locked-params/proposals/${id}/approve`);
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/locked-params/proposals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/locked-params"] });
      queryClient.invalidateQueries({ queryKey: ["/api/locked-params/changelog"] });
      toast({ title: "Proposal approved", description: "Parameters updated and live trader reloaded." });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/locked-params/proposals/${id}/reject`);
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/locked-params/proposals"] });
      toast({ title: "Proposal rejected" });
    },
  });

  const currentParams = paramsQuery.data || {};
  const hasChanges = Object.keys(editedParams).some(
    k => JSON.stringify(editedParams[k]) !== JSON.stringify(currentParams[k])
  );
  const changedKeys = Object.keys(editedParams).filter(
    k => JSON.stringify(editedParams[k]) !== JSON.stringify(currentParams[k])
  );

  const changelog = changelogQuery.data || [];
  const proposals = proposalsQuery.data || [];
  const pendingProposals = proposals.filter((p: any) => p.status === "pending");

  const handleParamChange = (key: string, value: any) => {
    setEditedParams(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    saveMutation.mutate(editedParams);
  };

  const handleReset = () => {
    if (paramsQuery.data) {
      setEditedParams({ ...paramsQuery.data });
    }
  };

  const toggleGroup = (title: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  };

  if (paramsQuery.isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-muted-foreground">Loading settings...</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-settings-title">
              <Settings className="w-6 h-6" />
              Settings
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              All trading parameters — editable by you and the AI advisor. Changes apply to live trading immediately.
            </p>
            <PageGuide
              title="Settings — Fine-Tune Every Parameter"
              summary="This is where you can manually adjust any trading parameter. Changes here are applied to your live bot immediately — use with care. Most users won't need to touch these directly; the AI Advisor and backtesting handle optimisation for you."
              steps={[
                { title: "Browse Parameter Groups", description: "Parameters are organised into collapsible groups — Entry Rules, Risk Management, Session Filters, Trading Costs, etc. Click any group to expand it." },
                { title: "Edit Values", description: "Change any parameter by typing a new value or using the slider. Changed parameters are highlighted until you save." },
                { title: "Save Changes", description: "Click the Save button to apply your changes. They take effect on the live bot immediately — no restart needed." },
                { title: "Review Changelog", description: "Every change is logged at the bottom of the page with who changed it, what was changed, and why. This creates a full audit trail." },
              ]}
              tips={[
                "Leverage (10x) and Max Drawdown (25%) are locked and cannot be changed — these are safety limits.",
                "If you're unsure about a parameter, ask the AI Advisor to explain what it does and suggest a good value.",
                "The AI Advisor can also change these settings autonomously when it finds evidence-backed improvements.",
              ]}
            />
          </div>
          <div className="flex items-center gap-2">
            {hasChanges && (
              <Badge variant="secondary" className="bg-amber-500/20 text-amber-700 dark:text-amber-300" data-testid="badge-unsaved-changes">
                {changedKeys.length} unsaved change{changedKeys.length > 1 ? 's' : ''}
              </Badge>
            )}
            <Button type="button" variant="outline" size="sm" onClick={handleReset} disabled={!hasChanges} data-testid="button-reset-params">
              <RotateCcw className="w-4 h-4 mr-1.5" />
              Reset
            </Button>
            <Button type="button" size="sm" onClick={handleSave} disabled={!hasChanges || saveMutation.isPending} data-testid="button-save-params">
              <Save className="w-4 h-4 mr-1.5" />
              {saveMutation.isPending ? "Saving..." : "Save & Apply"}
            </Button>
          </div>
        </div>

        {pendingProposals.length > 0 && (
          <Card className="border-amber-500/50 bg-amber-500/5">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Brain className="w-5 h-5 text-amber-500" />
                AI Proposals Pending Review
                <Badge variant="secondary" className="ml-2 bg-amber-500/20 text-amber-700 dark:text-amber-300">
                  {pendingProposals.length}
                </Badge>
              </CardTitle>
              <CardDescription>The AI has proposed parameter changes. Review and approve or reject.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {pendingProposals.map((p: any) => (
                <div key={p.id} className="border rounded-lg p-4 space-y-3 bg-background" data-testid={`proposal-${p.id}`}>
                  <div className="text-sm">{p.rationale}</div>
                  <div className="flex flex-wrap gap-2">
                    {p.changedKeys.map((k: string) => (
                      <Badge key={k} variant="outline" className="text-xs">
                        {k}: {JSON.stringify(p.currentParams[k])} → {JSON.stringify(p.proposedParams[k])}
                      </Badge>
                    ))}
                  </div>
                  {p.proposedStats && (
                    <div className="flex gap-4 text-xs text-muted-foreground">
                      <span>Return: {p.currentStats?.returnPct?.toFixed(1)}% → {p.proposedStats.returnPct?.toFixed(1)}%</span>
                      <span>PF: {p.currentStats?.profitFactor?.toFixed(2)} → {p.proposedStats.profitFactor?.toFixed(2)}</span>
                      <span>Win: {p.currentStats?.winRate?.toFixed(1)}% → {p.proposedStats.winRate?.toFixed(1)}%</span>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button type="button" size="sm" onClick={() => approveMutation.mutate(p.id)} disabled={approveMutation.isPending} data-testid={`button-approve-${p.id}`}>
                      <Check className="w-3.5 h-3.5 mr-1" /> Approve
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => rejectMutation.mutate(p.id)} disabled={rejectMutation.isPending} data-testid={`button-reject-${p.id}`}>
                      Reject
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            {paramGroups.map(group => {
              const isExpanded = expandedGroups.has(group.title);
              const GroupIcon = group.icon;
              const groupChangedCount = group.params.filter(p =>
                JSON.stringify(editedParams[p.key]) !== JSON.stringify(currentParams[p.key])
              ).length;

              return (
                <Card key={group.title}>
                  <CardHeader
                    className="pb-3 cursor-pointer select-none"
                    onClick={() => toggleGroup(group.title)}
                    data-testid={`section-${group.title.toLowerCase().replace(/\s+/g, '-')}`}
                  >
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <GroupIcon className="w-4 h-4 text-primary" />
                      {group.title}
                      {groupChangedCount > 0 && (
                        <Badge variant="secondary" className="ml-auto mr-2 bg-amber-500/20 text-amber-700 dark:text-amber-300 text-[10px]">
                          {groupChangedCount} changed
                        </Badge>
                      )}
                      {isExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground ml-auto" /> : <ChevronDown className="w-4 h-4 text-muted-foreground ml-auto" />}
                    </CardTitle>
                    <CardDescription className="text-xs">{group.description}</CardDescription>
                  </CardHeader>
                  {isExpanded && (
                    <CardContent>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {group.params.map(param => {
                          const value = editedParams[param.key];
                          const originalValue = currentParams[param.key];
                          const isChanged = JSON.stringify(value) !== JSON.stringify(originalValue);

                          return (
                            <div key={param.key} className={`space-y-1.5 p-2.5 rounded-md ${isChanged ? 'bg-amber-500/5 ring-1 ring-amber-500/30' : ''}`}>
                              <div className="flex items-center justify-between">
                                <label className="text-xs font-medium" data-testid={`label-${param.key}`}>
                                  {param.label}
                                </label>
                                {isChanged && (
                                  <span className="text-[10px] text-amber-600 dark:text-amber-400">
                                    was: {String(originalValue)}
                                  </span>
                                )}
                              </div>
                              {param.type === "boolean" ? (
                                <div className="flex items-center gap-2">
                                  <Switch
                                    checked={!!value}
                                    onCheckedChange={(checked) => handleParamChange(param.key, checked)}
                                    data-testid={`switch-${param.key}`}
                                  />
                                  <span className="text-xs text-muted-foreground">{value ? "Enabled" : "Disabled"}</span>
                                </div>
                              ) : param.type === "text" ? (
                                <Input
                                  type="text"
                                  value={Array.isArray(value) ? value.join(",") : String(value ?? "")}
                                  onChange={(e) => {
                                    const raw = e.target.value;
                                    const arr = raw.split(",").map(s => s.trim()).filter(s => s !== "").map(Number).filter(n => !isNaN(n));
                                    handleParamChange(param.key, arr);
                                  }}
                                  className="h-8 text-xs"
                                  data-testid={`input-${param.key}`}
                                />
                              ) : param.type === "select" ? (
                                <Select
                                  value={String(value || "")}
                                  onValueChange={(v) => handleParamChange(param.key, v)}
                                >
                                  <SelectTrigger className="h-8 text-xs" data-testid={`select-${param.key}`}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {param.options?.map(opt => (
                                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              ) : (
                                <Input
                                  type="number"
                                  value={value ?? ""}
                                  min={param.min}
                                  max={param.max}
                                  step={param.step}
                                  onChange={(e) => handleParamChange(param.key, e.target.value === "" ? undefined : Number(e.target.value))}
                                  className="h-8 text-xs"
                                  data-testid={`input-${param.key}`}
                                />
                              )}
                              {param.description && (
                                <p className="text-[10px] text-muted-foreground">{param.description}</p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  )}
                </Card>
              );
            })}
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Brain className="w-4 h-4 text-primary" />
                  AI Authority
                </CardTitle>
                <CardDescription className="text-xs">
                  The AI advisor can directly apply parameter changes when it has backtest evidence supporting the change. All AI changes are logged below.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3 p-3 rounded-md bg-green-500/10 border border-green-500/30">
                  <Check className="w-5 h-5 text-green-500 shrink-0" />
                  <div>
                    <div className="text-xs font-medium text-green-700 dark:text-green-300">AI Has Full Access</div>
                    <div className="text-[10px] text-muted-foreground">The AI can modify any parameter and apply changes directly when evidence-backed.</div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3 cursor-pointer select-none" onClick={() => setShowChangelog(!showChangelog)}>
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <History className="w-4 h-4 text-primary" />
                  Change Log
                  <Badge variant="secondary" className="ml-auto mr-2 text-[10px]">{changelog.length}</Badge>
                  {showChangelog ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                </CardTitle>
                <CardDescription className="text-xs">History of all parameter changes by you and the AI</CardDescription>
              </CardHeader>
              {showChangelog && (
                <CardContent>
                  {changelog.length === 0 ? (
                    <div className="text-xs text-muted-foreground text-center py-4">No changes recorded yet</div>
                  ) : (
                    <div className="space-y-3 max-h-[600px] overflow-y-auto">
                      {changelog.map((entry) => (
                        <div key={entry.id} className="border rounded-md p-3 space-y-2" data-testid={`changelog-${entry.id}`}>
                          <div className="flex items-center gap-2">
                            {entry.source === "ai" ? (
                              <Badge className="bg-violet-500/20 text-violet-700 dark:text-violet-300 text-[10px]">
                                <Bot className="w-3 h-3 mr-1" /> AI
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-[10px]">
                                <User className="w-3 h-3 mr-1" /> User
                              </Badge>
                            )}
                            <span className="text-[10px] text-muted-foreground">
                              {new Date(entry.timestamp).toLocaleString()}
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {entry.changedKeys.map((k: string) => (
                              <span key={k} className="text-[10px] bg-muted rounded px-1.5 py-0.5">
                                {k}: <span className="text-red-500 line-through">{JSON.stringify(entry.oldValues[k])}</span> → <span className="text-green-500 font-medium">{JSON.stringify(entry.newValues[k])}</span>
                              </span>
                            ))}
                          </div>
                          {entry.rationale && (
                            <p className="text-[10px] text-muted-foreground italic">{entry.rationale}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
