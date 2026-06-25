import { useState, useEffect, useRef, useCallback } from "react";
import { PageGuide } from "@/components/page-guide";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { parseCSV, readFileAsText } from "@/lib/csv-parser";
import { backtestConfigSchema, type BacktestConfig, type BacktestResult, type Candle } from "@shared/schema";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { format, parse } from "date-fns";
import {
  FlaskConical, Loader2, TrendingUp, TrendingDown, Target, AlertCircle, Upload,
  FileCheck, CheckCircle2, Shield, RefreshCw, Globe, Newspaper, BarChart3,
  Wifi, WifiOff, Database, CalendarDays, HardDrive, Zap, Brain,
  Sparkles, Play, X, Activity, Trophy, Ban, Search, Trash2, Clock, Eye, Rocket, Save, ArrowRight,
  Archive, RotateCcw, BookOpen, ChevronDown, ChevronRight, Lock, Pencil,
} from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, BarChart, Bar,
} from "recharts";
import { ExportMenu } from "@/components/export-menu";

type MarketStatus = {
  keys: { twelveData: boolean; finnhub: boolean };
  data: {
    xauusd: { m1: number; m15: number; h1: number; h4: number; daily: number; lastFetched: string | null };
    events: { count: number; lastFetched: string | null };
    asian: { indices: string[]; lastFetched: string | null };
  };
};

type DbPriceStatus = {
  m1: { count: number; range: { from: string; to: string } | null };
  m15: { count: number; range: { from: string; to: string } | null };
  h1: { count: number; range: { from: string; to: string } | null };
  h4: { count: number; range: { from: string; to: string } | null };
  daily: { count: number; range: { from: string; to: string } | null };
};

type AutoTuneIteration = {
  iteration: number;
  config: BacktestConfig;
  stats: {
    totalTrades: number;
    winRate: number;
    returnPct: number;
    maxDrawdownPct: number;
    profitFactor: number;
    returnDDRatio: number;
  };
  changes: string[];
  backtestId: string;
};

type AutoTuneProgress = {
  running: boolean;
  currentIteration: number;
  maxIterations: number;
  iterations: AutoTuneIteration[];
  status: string;
};

type AutoTuneResult = {
  iterations: AutoTuneIteration[];
  bestIteration: number;
  bestReturnDDRatio: number;
  bestConfig: BacktestConfig;
  status: string;
  message: string;
};

type ActiveStrategySummary = {
  params: Record<string, any>;
  lastChange: {
    source: string;
    timestamp: string;
    changedKeys: string[];
    rationale: string;
  } | null;
  matchingBacktest: {
    id: string;
    returnPct: number;
    maxDrawdownPct: number;
    winRate: number;
    totalTrades: number;
    profitFactor: number;
    label: string | null;
  } | null;
  activeStrategy: {
    id: string;
    name: string;
    category: string;
    notes?: string;
    stats: { returnPct: number; maxDrawdownPct: number; winRate: number; totalTrades: number; profitFactor: number };
  } | null;
};

type DataMode = "auto" | "csv";

function LockedSlider({ min, max, step, value, onValueChange, "data-testid": testId }: {
  min: number; max: number; step: number; value: number[];
  onValueChange: (v: number[]) => void; "data-testid"?: string;
}) {
  const [editing, setEditing] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const startEditing = useCallback(() => {
    setEditing(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setEditing(false), 4000);
  }, []);

  const handleChange = useCallback((v: number[]) => {
    onValueChange(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setEditing(false), 4000);
  }, [onValueChange]);

  useEffect(() => { return () => { if (timerRef.current) clearTimeout(timerRef.current); }; }, []);

  if (!editing) {
    return (
      <div
        className="flex items-center gap-2 h-5 cursor-pointer group"
        onClick={startEditing}
        data-testid={testId ? `${testId}-locked` : undefined}
      >
        <div className="flex-1 h-1.5 bg-muted rounded-full relative">
          <div
            className="absolute h-1.5 bg-primary/30 rounded-full"
            style={{ width: `${((value[0] - min) / (max - min)) * 100}%` }}
          />
        </div>
        <Pencil className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
      </div>
    );
  }

  return (
    <div className="ring-1 ring-primary/30 rounded-md p-1 -m-1">
      <Slider min={min} max={max} step={step} value={value} onValueChange={handleChange} data-testid={testId} />
    </div>
  );
}

const LS = LockedSlider;

export default function BacktestPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [dataMode, setDataMode] = useState<DataMode>("auto");
  const [h1Data, setH1Data] = useState<Candle[] | null>(null);
  const [h4Data, setH4Data] = useState<Candle[] | null>(null);
  const [dailyData, setDailyData] = useState<Candle[] | null>(null);
  const [autoTuneMaxIter, setAutoTuneMaxIter] = useState(10);
  const [autoTuneTargetReturn, setAutoTuneTargetReturn] = useState(100);
  const [autoTuneMaxDD, setAutoTuneMaxDD] = useState(25);
  const [autoTunePolling, setAutoTunePolling] = useState(false);
  const [autoTuneResult, setAutoTuneResult] = useState<AutoTuneResult | null>(null);
  const [aiOptRounds, setAiOptRounds] = useState(5);
  const [aiOptPolling, setAiOptPolling] = useState(false);
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null);
  const [userManuallySelected, setUserManuallySelected] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);

  type BacktestSummary = Omit<BacktestResult, "trades" | "equityCurve"> & { tradeCount: number };

  const { data: backtests } = useQuery<BacktestSummary[]>({
    queryKey: ["/api/backtests"],
    staleTime: 0,
    refetchOnMount: "always",
  });

  const { data: activeSummaryData } = useQuery<{ matchingBacktest?: { id: string } }>({
    queryKey: ["/api/active-strategy-summary"],
    staleTime: 0,
  });

  useEffect(() => {
    if (userManuallySelected) return;
    if (!backtests || backtests.length === 0) return;
    const activeId = activeSummaryData?.matchingBacktest?.id;
    const matchInList = activeId ? backtests.find(b => b.id === activeId) : null;
    if (matchInList) {
      setSelectedResultId(matchInList.id);
    } else if (!selectedResultId) {
      setSelectedResultId(backtests[0].id);
    }
  }, [backtests, selectedResultId, activeSummaryData, userManuallySelected]);

  const activeResultId = selectedResultId;

  const { data: fullResult, isLoading: loadingResult } = useQuery<BacktestResult>({
    queryKey: ["/api/backtest", activeResultId],
    enabled: !!activeResultId,
    staleTime: 0,
    refetchOnMount: "always",
    retry: 2,
  });

  const activeSummary = backtests?.find(b => b.id === activeResultId);
  const displayStats = fullResult?.stats ?? activeSummary?.stats ?? null;

  const { data: archivedBacktests } = useQuery<BacktestSummary[]>({
    queryKey: ["/api/backtests/archived"],
    enabled: showArchive,
  });

  const { data: changelog } = useQuery<any[]>({
    queryKey: ["/api/strategy-changelog"],
    enabled: showChangelog,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/backtest/${id}`);
    },
    onSuccess: (_data, deletedId) => {
      if (selectedResultId === deletedId) { setSelectedResultId(null); setUserManuallySelected(false); }
      queryClient.invalidateQueries({ queryKey: ["/api/backtests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/backtests/archived"] });
      toast({ title: "Backtest archived", description: "Preserved in archive for future reference" });
    },
    onError: (err: any) => {
      toast({ title: "Archive failed", description: err.message, variant: "destructive" });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("POST", `/api/backtest/${id}/restore`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/backtests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/backtests/archived"] });
      toast({ title: "Backtest restored", description: "Moved back to active results" });
    },
    onError: (err: any) => {
      toast({ title: "Restore failed", description: err.message, variant: "destructive" });
    },
  });

  const saveStrategyMutation = useMutation({
    mutationFn: async (bt: BacktestSummary) => {
      const name = prompt("Name this strategy:", `Strategy ${new Date(bt.createdAt).toLocaleDateString()} (${bt.stats.returnPct}% return)`);
      if (!name) throw new Error("cancelled");
      await apiRequest("POST", "/api/strategies", {
        name,
        category: Number(bt.stats.returnPct) >= 100 ? "HIGH" : Number(bt.stats.returnPct) >= 30 ? "MED" : "LOW",
        config: bt.config,
        stats: bt.stats,
        diagnostics: (bt as any).diagnostics ?? null,
        notes: `Saved from backtest ${bt.id.slice(0, 8)} — ${bt.stats.totalTrades} trades, ${bt.stats.winRate}% win, ${bt.stats.profitFactor} PF`,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      toast({ title: "Strategy saved", description: "You can view and export it from the Advisor page." });
    },
    onError: (err: Error) => {
      if (err.message !== "cancelled") {
        toast({ title: "Failed to save strategy", description: err.message, variant: "destructive" });
      }
    },
  });

  const handleImplement = (config: Record<string, any>) => {
    const currentValues = form.getValues();
    const merged = { ...currentValues, ...config };
    merged.leverage = 10;
    merged.maxDrawdownPct = 25;
    merged.startingBalance = merged.startingBalance || 3000;
    if (config.startDate) merged.startDate = config.startDate;
    if (config.endDate) merged.endDate = config.endDate;
    form.reset(merged);
    const dateInfo = config.startDate || config.endDate
      ? ` Date range: ${config.startDate || "—"} to ${config.endDate || "now"}.`
      : " Using current date range.";
    toast({ title: "Config applied", description: `All parameters loaded from selected backtest.${dateInfo}` });
  };

  const applyToLiveMutation = useMutation({
    mutationFn: async (config: Record<string, any>) => {
      const { startDate, endDate, executionTimeframe, startingBalance, dataSource, ...tradingParams } = config;
      const res = await apiRequest("PUT", "/api/locked-params", {
        ...tradingParams,
        _source: "backtest_apply",
        _rationale: `Applied from backtest results`,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/locked-params"] });
      queryClient.invalidateQueries({ queryKey: ["/api/active-strategy-summary"] });
      toast({ title: "Strategy applied to live trading", description: "Locked parameters updated. The live trader will use these settings." });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to apply", description: err.message, variant: "destructive" });
    },
  });

  const { data: activeStrategy } = useQuery<ActiveStrategySummary>({
    queryKey: ["/api/active-strategy-summary"],
  });

  const { data: marketStatus, refetch: refetchStatus } = useQuery<MarketStatus>({
    queryKey: ["/api/market/status"],
  });

  const { data: dbPriceStatus, refetch: refetchDbStatus } = useQuery<DbPriceStatus>({
    queryKey: ["/api/market/db-status"],
  });

  const { data: autoTuneStatus, refetch: refetchAutoTuneStatus } = useQuery<AutoTuneProgress>({
    queryKey: ["/api/ai/auto-tune/status"],
    refetchInterval: autoTunePolling ? 1500 : false,
  });

  useEffect(() => {
    if (autoTuneStatus?.running && !autoTunePolling) {
      setAutoTunePolling(true);
    }
    if (autoTunePolling && autoTuneStatus && !autoTuneStatus.running && autoTuneStatus.iterations && autoTuneStatus.iterations.length > 0) {
      setAutoTunePolling(false);
      queryClient.invalidateQueries({ queryKey: ["/api/backtests"] });
      toast({ title: "Auto-Tune complete", description: `${autoTuneStatus.iterations.length} iterations finished. Best Return/DD: ${Math.max(...autoTuneStatus.iterations.map(i => i.stats.returnDDRatio))}` });
    }
  }, [autoTunePolling, autoTuneStatus, queryClient, toast]);

  const { data: aiOptStatus, refetch: refetchAiOptStatus } = useQuery<any>({
    queryKey: ["/api/ai-optimize/progress"],
    refetchInterval: aiOptPolling ? 2000 : false,
  });
  const aiOptRunning = aiOptStatus?.running ?? false;

  useEffect(() => {
    if (aiOptRunning && !aiOptPolling) {
      setAiOptPolling(true);
    }
    if (aiOptPolling && aiOptStatus && !aiOptStatus.running && aiOptStatus.done) {
      setAiOptPolling(false);
      queryClient.invalidateQueries({ queryKey: ["/api/backtests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/backtests/leaderboard"] });
      const r = aiOptStatus.result;
      toast({
        title: "AI Deep Optimize complete",
        description: r?.improved ? `Improved: ${r.startBest}% → ${r.endBest}% (${r.improvements} improvements, ${r.learningsSaved} learnings)` : `No improvement (best: ${r?.endBest}%)`,
      });
    }
  }, [aiOptPolling, aiOptStatus, queryClient, toast]);

  const aiOptMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/ai-optimize", { rounds: aiOptRounds });
      return res.json();
    },
    onSuccess: () => {
      setAiOptPolling(true);
      refetchAiOptStatus();
    },
    onError: (e: Error) => {
      toast({ title: "AI Optimize failed", description: e.message, variant: "destructive" });
    },
  });

  const approvePromotionMutation = useMutation({
    mutationFn: async (proposalId: string) => {
      const res = await apiRequest("POST", `/api/locked-params/proposals/${proposalId}/approve`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "New Champion is live", description: "Locked parameters updated. Live trader reloaded." });
      queryClient.invalidateQueries({ queryKey: ["/api/locked-params"] });
      queryClient.invalidateQueries({ queryKey: ["/api/locked-params/proposals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      refetchAiOptStatus();
    },
    onError: (e: Error) => {
      toast({ title: "Approval failed", description: e.message, variant: "destructive" });
    },
  });

  const rejectPromotionMutation = useMutation({
    mutationFn: async (proposalId: string) => {
      const res = await apiRequest("POST", `/api/locked-params/proposals/${proposalId}/reject`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Proposal rejected", description: "Strategy stays in catalogue but will not go live." });
      queryClient.invalidateQueries({ queryKey: ["/api/locked-params/proposals"] });
      refetchAiOptStatus();
    },
    onError: (e: Error) => {
      toast({ title: "Reject failed", description: e.message, variant: "destructive" });
    },
  });

  const form = useForm<BacktestConfig>({
    resolver: zodResolver(backtestConfigSchema),
    defaultValues: {
      strategyMode: "regime",
      startingBalance: 3000,
      lotSize: 1,
      atrPeriod: 14,
      atrStopMultiplier: 2.75,
      rewardRatio: 4,
      rsiPeriod: 14,
      rsiOverbought: 70,
      rsiOversold: 30,
      rsiRewardRatio: 0,
      maxDailyLossUSD: 500,
      compressionThreshold: 0.022,
      expansionThreshold: 1.15,
      rangeWidthBars: 7,
      midpointBandPct: 0.10,
      retestBuffer: 12.0,
      minRangeATR: 1.5,
      maxTrendATRRatio: 5.0,
      wickRatio: 0.5,
      executionTimeframe: "1h" as const,
      sessionMode: "London+NewYork",
      entryWindowBars: 0,
      maxTradesPerDay: 5,
      newsBeforeMin: 30,
      newsAfterMin: 30,
      startDate: localStorage.getItem("backtestStartDate") || "2025-08-01",
      endDate: localStorage.getItem("backtestEndDate") || new Date().toISOString().slice(0, 10),
      gapFilterEnabled: true,
      gapThresholdAtr: 0.5,
      gapCooldownBars: 2,
      sessionORBEnabled: true,
      trailingStopEnabled: false,
      trailingStopTriggerR: 1.0,
      riskPerTradePct: 1.5,
      leverage: 10,
      maxDrawdownPct: 25,
      maxDailyLossPct: 2.0,
      maxConsecutiveLosses: 2,
      postLossCooldownBars: 2,
      reduceSizeAfterLoss: true,
      reducedRiskPerTradePct: 0.50,
      atrRiskScaleEnabled: true,
      atrRiskScaleThreshold: 1.25,
      atrRiskScaleFactor: 0.65,
      secondTradeRiskFactor: 0.75,
      spreadPoints: 0.30,
      slippagePoints: 0.10,
      commissionPerLot: 0,
    },
  });

  const [aiSettingsApplied, setAiSettingsApplied] = useState(false);

  const { data: lockedParamsData } = useQuery<Record<string, any>>({
    queryKey: ["/api/locked-params"],
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const lockedParamsSyncRef = useRef<string | null>(null);
  useEffect(() => {
    if (!lockedParamsData) return;
    const paramsKey = JSON.stringify(lockedParamsData);
    if (lockedParamsSyncRef.current === paramsKey) return;
    lockedParamsSyncRef.current = paramsKey;
    const mapped: Partial<BacktestConfig> = {};
    const keys = [
      'startingBalance', 'lotSize', 'atrPeriod', 'atrStopMultiplier', 'rewardRatio',
      'compressionThreshold', 'expansionThreshold', 'rangeWidthBars', 'midpointBandPct',
      'retestBuffer', 'minRangeATR', 'maxTrendATRRatio', 'wickRatio', 'sessionMode', 'entryWindowBars', 'maxTradesPerDay',
      'newsBeforeMin', 'newsAfterMin', 'gapFilterEnabled', 'gapThresholdAtr', 'gapCooldownBars',
      'sessionORBEnabled', 'trailingStopEnabled', 'trailingStopTriggerR', 'riskPerTradePct',
      'leverage', 'maxDrawdownPct', 'maxDailyLossPct', 'maxConsecutiveLosses', 'postLossCooldownBars',
      'reduceSizeAfterLoss', 'reducedRiskPerTradePct', 'atrRiskScaleEnabled', 'atrRiskScaleThreshold',
      'atrRiskScaleFactor', 'secondTradeRiskFactor', 'spreadPoints', 'slippagePoints', 'commissionPerLot',
    ];
    for (const k of keys) {
      if (lockedParamsData[k] !== undefined) (mapped as any)[k] = lockedParamsData[k];
    }
    form.reset({ ...form.getValues(), ...mapped });
  }, [lockedParamsData]);

  useEffect(() => {
    const stored = localStorage.getItem("advisorSuggestedConfig");
    if (stored) {
      try {
        const suggested = JSON.parse(stored);
        const currentValues = form.getValues();
        const merged = { ...currentValues };
        const hasDates = suggested.startDate && suggested.endDate;
        const skipKeys = hasDates ? new Set<string>() : new Set(["startDate", "endDate"]);
        for (const [key, value] of Object.entries(suggested)) {
          if (key in merged && value !== undefined && value !== null && !skipKeys.has(key)) {
            (merged as any)[key] = value;
          }
        }
        form.reset(merged);
        setAiSettingsApplied(true);
      } catch {}
      localStorage.removeItem("advisorSuggestedConfig");
    }
  }, []);

  const fetchAllMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/market/fetch-all-timeframes");
      return res.json();
    },
    onSuccess: (data) => {
      refetchStatus();
      refetchDbStatus();
      if (data.success) {
        const r = data.results ?? {};
        const skippedMsg = data.skipped?.length ? ` (${data.skipped.join(", ")} already fresh)` : "";
        toast({ title: "Data updated", description: `M1: ${r.m1??0} | M15: ${r.m15??0} | H1: ${r.h1??0} | H4: ${r.h4??0} | Daily: ${r.daily??0} candles${skippedMsg}` });
      } else {
        const errMsg = data.errors?.join("; ") ?? "Partial failure";
        toast({ title: "Partial data fetch", description: `Some timeframes loaded. Errors: ${errMsg}`, variant: "destructive" });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Fetch failed", description: err.message, variant: "destructive" });
    },
  });

  const loadFromDbMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/market/load-from-db");
      return res.json();
    },
    onSuccess: (data) => {
      refetchStatus();
      refetchDbStatus();
      toast({ title: "Data loaded from database", description: `M1: ${data.m1??0} | M15: ${data.m15??0} | H1: ${data.h1} | H4: ${data.h4} | Daily: ${data.daily} candles loaded` });
    },
    onError: (err: Error) => {
      toast({ title: "Load from DB failed", description: err.message, variant: "destructive" });
    },
  });

  const autoTuneMutation = useMutation({
    mutationFn: async () => {
      const config = form.getValues();
      setAutoTuneResult(null);
      setAutoTunePolling(true);
      const res = await apiRequest("POST", "/api/ai/auto-tune", {
        config,
        maxIterations: autoTuneMaxIter,
        targetReturnPct: autoTuneTargetReturn,
        maxAllowedDD: autoTuneMaxDD,
      });
      return res.json() as Promise<AutoTuneResult>;
    },
    onSuccess: (data: AutoTuneResult) => {
      setAutoTunePolling(false);
      setAutoTuneResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/backtests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ai/auto-tune/status"] });
      if (data.status === "error") {
        toast({ title: "Auto-Tune error", description: data.message, variant: "destructive" });
      } else if (data.iterations.length > 0) {
        const bestRDR = Math.max(...data.iterations.map(i => i.stats.returnDDRatio));
        toast({ title: "Auto-Tune complete", description: `${data.iterations.length} iterations. Best Return/DD: ${bestRDR.toFixed(2)}` });
      } else {
        toast({ title: "Auto-Tune finished", description: data.message });
      }
    },
    onError: (err: Error) => {
      setAutoTunePolling(false);
      toast({ title: "Auto-Tune failed", description: err.message, variant: "destructive" });
    },
  });

  const fetchAsianMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/market/fetch-asian");
      return res.json();
    },
    onSuccess: (data) => {
      refetchStatus();
      if (data.success) {
        const count = data.indices?.length ?? 0;
        toast({ title: "Asian markets fetched", description: `${count} indices loaded` });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Asian fetch failed", description: err.message, variant: "destructive" });
    },
  });

  const handleFileUpload = async (
    file: File,
    setter: (data: Candle[]) => void,
    label: string
  ) => {
    try {
      const text = await readFileAsText(file);
      const candles = parseCSV(text);
      if (candles.length === 0) {
        toast({ title: `Invalid ${label}`, description: "No valid candles parsed", variant: "destructive" });
        return;
      }
      setter(candles);
      toast({ title: `${label} loaded`, description: `${candles.length} candles parsed` });
    } catch (err: any) {
      toast({ title: `Error loading ${label}`, description: err.message, variant: "destructive" });
    }
  };

  const backtestMutation = useMutation<BacktestResult, Error, BacktestConfig>({
    mutationFn: async (config) => {
      const payload: any = { config };

      if (dataMode === "auto") {
        payload.useAutoData = true;
      } else if (dataMode === "csv" && h1Data && h4Data && dailyData) {
        payload.data = { h1: h1Data, h4: h4Data, daily: dailyData };
      }

      const res = await apiRequest("POST", "/api/backtest", payload);
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/backtests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/backtests/leaderboard"] });
      queryClient.setQueryData(["/api/backtest", result.id], result);
      setSelectedResultId(result.id);
      setUserManuallySelected(false);
      toast({
        title: "Backtest complete",
        description: `${result.stats.totalTrades} trades (${result.stats.rangeTrades} range, ${result.stats.trendTrades} trend) — ${result.stats.winRate}% win rate`,
      });
      setTimeout(() => {
        document.getElementById("backtest-results")?.scrollIntoView({ behavior: "smooth" });
      }, 100);
    },
    onError: (err) => {
      toast({ title: "Backtest failed", description: err.message, variant: "destructive" });
    },
  });

  const onSubmit = (config: BacktestConfig) => {
    if (dataMode === "csv" && (!h1Data || !h4Data || !dailyData)) {
      toast({ title: "Missing data", description: "Upload H1, H4, and Daily CSV files", variant: "destructive" });
      return;
    }
    if (config.startDate) localStorage.setItem("backtestStartDate", config.startDate);
    else localStorage.removeItem("backtestStartDate");
    if (config.endDate) localStorage.setItem("backtestEndDate", config.endDate);
    else localStorage.removeItem("backtestEndDate");
    config.leverage = 10;
    config.maxDrawdownPct = 25;
    config.startingBalance = config.startingBalance || 3000;
    backtestMutation.mutate(config);
  };

  const values = form.watch();
  const hasKeys = marketStatus?.keys;
  const hasCachedData = (marketStatus?.data.xauusd.h1 ?? 0) > 0;
  const csvReady = h1Data && h4Data && dailyData;

  const canRunBacktest =
    dataMode === "auto" ||
    (dataMode === "csv" && csvReady);

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="p-6 border-b bg-background/80 backdrop-blur-sm sticky top-0 z-10">
        <h1 className="text-xl font-semibold" data-testid="heading-backtest">Configure Backtest v9</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          XAUUSD backtesting lab — regime classifier or RSI bot strategy with live data, risk controls, and AI optimization
        </p>
        <PageGuide
          title="Run Backtest — Test Your Strategy on Historical Data"
          summary="This page lets you test trading strategies against real past gold price data before risking real money. Think of it as a flight simulator for trading."
          steps={[
            { title: "Review Active Strategy", description: "The green banner at the top shows which strategy is currently loaded. These are the same settings your live bot uses." },
            { title: "Adjust Parameters (Optional)", description: "The form is pre-filled with your active strategy. You can tweak any parameter to test 'what if' scenarios — change the risk level, stop loss distance, session hours, etc." },
            { title: "Click Run Backtest", description: "Hit the yellow button at the bottom. The system will simulate every trade the bot would have taken using historical data." },
            { title: "Review Results", description: "Results appear below: total return, maximum drawdown, win rate, profit factor, and an equity curve showing how your balance would have grown (or shrunk) over time." },
            { title: "Apply to Live (Optional)", description: "If the results look good, click 'Apply to Live Trading' on any result to make those parameters your active strategy." },
          ]}
          tips={[
            "The AI Advisor can also suggest optimised parameters — check the AI Advisor page.",
            "Return/DD ratio above 4.0 is considered strong. Below 2.0 means the risk outweighs the reward.",
            "Always compare new strategies against your current one before applying them live.",
            "Leverage is locked at 10x and max drawdown at 25% — these safety limits cannot be changed.",
          ]}
        />
      </div>

      {activeStrategy && (() => {
        const strat = activeStrategy.activeStrategy;
        const stats = strat?.stats;
        const params = activeStrategy.params;
        const lc = activeStrategy.lastChange;
        const sourceLabel = lc ? (
          lc.source === "ai_advisor" ? "Set by AI" :
          lc.source === "backtest_apply" ? "Applied from Backtest" :
          lc.source === "champion_apply" ? "Applied from Champion" :
          lc.source === "auto_tuner" ? "Auto-Tuned" : "Manual Update"
        ) : null;

        return (
          <div className="mx-6 mt-4">
            <Card className="border-primary/30 bg-gradient-to-r from-primary/5 to-transparent" data-testid="active-strategy-banner">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <Activity className="w-5 h-5 text-primary" />
                  <CardTitle className="text-base">Currently Active on Live Trading</CardTitle>
                  {strat?.category && (
                    <Badge className="bg-primary/10 text-primary border-primary/30 text-xs ml-auto">
                      {strat.category}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                {strat && (
                  <div>
                    <p className="text-base font-semibold" data-testid="text-active-name">{strat.name}</p>
                    {strat.notes && <p className="text-xs text-muted-foreground mt-0.5">{strat.notes}</p>}
                  </div>
                )}
                {stats && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="bg-primary/5 border border-primary/20 rounded-md p-3 text-center">
                      <div className="text-xs text-muted-foreground mb-0.5">Return</div>
                      <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400">{Number(stats.returnPct).toFixed(1)}%</div>
                    </div>
                    <div className="bg-primary/5 border border-primary/20 rounded-md p-3 text-center">
                      <div className="text-xs text-muted-foreground mb-0.5">Max DD</div>
                      <div className="text-lg font-bold text-amber-700 dark:text-amber-400">{Number(stats.maxDrawdownPct).toFixed(1)}%</div>
                    </div>
                    <div className="bg-primary/5 border border-primary/20 rounded-md p-3 text-center">
                      <div className="text-xs text-muted-foreground mb-0.5">Win Rate</div>
                      <div className="text-lg font-bold">{Number(stats.winRate).toFixed(1)}%</div>
                    </div>
                    <div className="bg-primary/5 border border-primary/20 rounded-md p-3 text-center">
                      <div className="text-xs text-muted-foreground mb-0.5">Trades</div>
                      <div className="text-lg font-bold">{stats.totalTrades}</div>
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                  {[
                    { label: "Profit Factor", value: stats ? Number(stats.profitFactor).toFixed(1) : "--" },
                    { label: "R/DD Ratio", value: stats && Number(stats.maxDrawdownPct) > 0 ? (Number(stats.returnPct) / Number(stats.maxDrawdownPct)).toFixed(1) : "--" },
                    { label: "Risk/Trade", value: `${params?.riskPerTradePct ?? "--"}%` },
                    { label: "Reward:Risk", value: `${params?.rewardRatio ?? "--"}:1` },
                    { label: "ATR Stop", value: `${params?.atrStopMultiplier ?? "--"}x` },
                    { label: "Session", value: params?.sessionMode ?? "--" },
                    { label: "Entry Window", value: params?.entryWindowBars === 0 ? "Immediate" : `${params?.entryWindowBars ?? "--"} bar${(params?.entryWindowBars ?? 0) > 1 ? 's' : ''}` },
                    { label: "Leverage", value: `${Math.min(params?.leverage || 10, 10)}x` },
                    { label: "Expansion", value: `${params?.expansionThreshold ?? "--"}x` },
                    { label: "Compression", value: params?.compressionThreshold ?? "--" },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-muted/40 rounded-md p-2">
                      <div className="text-[10px] text-muted-foreground">{label}</div>
                      <div className="font-semibold text-xs">{value}</div>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  These are the exact parameters your live trader and AI advisor are using right now.
                  {lc && sourceLabel && (
                    <span className="font-medium text-foreground"> Last changed: {sourceLabel}{lc.timestamp ? ` on ${new Date(lc.timestamp).toLocaleDateString()}` : ""}</span>
                  )}
                </p>
                {lc?.rationale && (
                  <div className="text-xs text-muted-foreground italic border-l-2 border-primary/30 pl-2">
                    "{lc.rationale}"
                  </div>
                )}
                <div className="text-[10px] text-muted-foreground">
                  The form below is pre-filled with these active parameters. Any backtest you run will use these unless you change them.
                </div>
              </CardContent>
            </Card>
          </div>
        );
      })()}

      {aiSettingsApplied && (
        <div className="mx-6 mt-4 p-4 rounded-lg border-2 border-primary bg-primary/5 flex items-center gap-4" data-testid="ai-settings-banner">
          <div className="flex items-center gap-2 flex-1">
            <Sparkles className="w-5 h-5 text-primary shrink-0" />
            <div>
              <p className="text-sm font-semibold text-primary">AI-Optimized Settings Applied</p>
              <p className="text-xs text-muted-foreground">Parameters pre-filled from AI advisor. Review and click Run Backtest below.</p>
            </div>
          </div>
          <Button
            size="sm"
            className="h-9 px-4 font-semibold"
            onClick={() => { form.handleSubmit(onSubmit)(); setAiSettingsApplied(false); }}
            disabled={backtestMutation.isPending}
            data-testid="button-run-ai-backtest"
          >
            {backtestMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Play className="w-4 h-4 mr-1" />}
            Run Backtest Now
          </Button>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setAiSettingsApplied(false)} data-testid="button-dismiss-ai-banner">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit, (errors) => {
              console.error("[Backtest] Form validation errors:", errors);
              const fields = Object.keys(errors);
              toast({ title: "Form validation error", description: `Invalid fields: ${fields.join(", ")}. Check parameter values.`, variant: "destructive" });
            })} className="space-y-5">

              {/* Data Source */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Database className="w-4 h-4 text-primary" />
                    Data Source
                  </CardTitle>
                  <CardDescription className="text-xs">Choose how to load XAUUSD market data</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Mode Selector */}
                  <div className="grid grid-cols-2 gap-2">
                    {([
                      { mode: "auto" as DataMode, label: "Live Fetch", icon: Globe, desc: "Twelve Data API" },
                      { mode: "csv" as DataMode, label: "CSV Upload", icon: Upload, desc: "Manual files" },
                    ]).map(({ mode, label, icon: Icon, desc }) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setDataMode(mode)}
                        className={`rounded-md border p-3 text-left transition-colors ${
                          dataMode === mode
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/40"
                        }`}
                        data-testid={`button-mode-${mode}`}
                      >
                        <Icon className={`w-4 h-4 mb-1.5 ${dataMode === mode ? "text-primary" : "text-muted-foreground"}`} />
                        <div className="text-xs font-medium">{label}</div>
                        <div className="text-xs text-muted-foreground">{desc}</div>
                      </button>
                    ))}
                  </div>

                  {/* Auto Fetch Mode */}
                  {dataMode === "auto" && (
                    <div className="space-y-3">
                      {/* API Key Status */}
                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="flex items-center gap-1.5">
                          {hasKeys?.twelveData ? (
                            <Wifi className="w-3.5 h-3.5 text-emerald-500" />
                          ) : (
                            <WifiOff className="w-3.5 h-3.5 text-red-500" />
                          )}
                          <span className="text-xs">Twelve Data</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {hasKeys?.finnhub ? (
                            <Wifi className="w-3.5 h-3.5 text-emerald-500" />
                          ) : (
                            <WifiOff className="w-3.5 h-3.5 text-red-500" />
                          )}
                          <span className="text-xs">Finnhub</span>
                        </div>
                        <Badge variant="outline" className={`text-xs ml-auto ${hasCachedData ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "border-amber-500/40 text-amber-600 dark:text-amber-400"}`}>
                          {hasCachedData ? (
                            <><CheckCircle2 className="w-3 h-3 mr-1" />Data Ready</>
                          ) : (
                            <><Loader2 className="w-3 h-3 mr-1 animate-spin" />Auto-loading...</>
                          )}
                        </Badge>
                      </div>

                      <div className="flex items-start gap-2 p-2.5 rounded-md bg-muted/40">
                        <CheckCircle2 className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                        <p className="text-xs text-muted-foreground">Data loads automatically from the database and refreshes stale timeframes before each backtest. Only new candles are fetched from the API.</p>
                      </div>

                      {/* Manual refresh button */}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => fetchAllMutation.mutate()}
                        disabled={fetchAllMutation.isPending || !hasKeys?.twelveData}
                        data-testid="button-fetch-data"
                      >
                        {fetchAllMutation.isPending ? (
                          <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />Updating...</>
                        ) : (
                          <><RefreshCw className="w-3.5 h-3.5 mr-2" />Manual Refresh</>
                        )}
                      </Button>

                      {/* Data Status — In Memory */}
                      {hasCachedData && (
                        <div className="grid grid-cols-5 gap-1.5 text-xs">
                          {[
                            { key: "m1", label: "1min", val: marketStatus?.data.xauusd.m1 },
                            { key: "m15", label: "15min", val: marketStatus?.data.xauusd.m15 },
                            { key: "h1", label: "H1", val: marketStatus?.data.xauusd.h1 },
                            { key: "h4", label: "H4", val: marketStatus?.data.xauusd.h4 },
                            { key: "daily", label: "Daily", val: marketStatus?.data.xauusd.daily },
                          ].map(({ key, label, val }) => (
                            <div key={key} className="bg-muted/40 rounded-md p-1.5">
                              <div className="text-muted-foreground text-[10px]">{label}</div>
                              <div className="font-semibold text-sm" data-testid={`text-${key}-count`}>{(val ?? 0).toLocaleString()}</div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Price Database Status */}
                      {(dbPriceStatus?.h1.count || dbPriceStatus?.h4.count || dbPriceStatus?.daily.count || dbPriceStatus?.m15.count || dbPriceStatus?.m1.count) ? (
                        <div className="border rounded-md p-3 space-y-2">
                          <div className="flex items-center gap-2 text-xs font-medium">
                            <HardDrive className="w-3.5 h-3.5 text-primary" />
                            Price Database (persisted — survives restarts)
                          </div>
                          <div className="grid grid-cols-5 gap-1.5 text-xs">
                            {(["m1", "m15", "h1", "h4", "daily"] as const).map((tf) => {
                              const d = dbPriceStatus?.[tf];
                              const label = tf === "m1" ? "1min" : tf === "m15" ? "15min" : tf;
                              return (
                                <div key={tf} className="bg-primary/5 rounded-md p-1.5" data-testid={`text-db-${tf}`}>
                                  <div className="text-muted-foreground uppercase text-[10px]">{label}</div>
                                  <div className="font-semibold text-sm">{(d?.count ?? 0).toLocaleString()}</div>
                                  {d?.range && (
                                    <div className="text-[10px] text-muted-foreground mt-0.5 leading-tight">
                                      {d.range.from.substring(0, 10)}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          {!hasCachedData && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="w-full"
                              onClick={() => loadFromDbMutation.mutate()}
                              disabled={loadFromDbMutation.isPending}
                              data-testid="button-load-from-db"
                            >
                              {loadFromDbMutation.isPending ? (
                                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Loading...</>
                              ) : (
                                <><HardDrive className="w-4 h-4 mr-2" />Load from Database</>
                              )}
                            </Button>
                          )}
                        </div>
                      ) : !hasCachedData ? (
                        <div className="flex items-center gap-2 p-2 rounded-md bg-muted/30 text-xs text-muted-foreground">
                          <HardDrive className="w-3.5 h-3.5" />
                          No price data stored yet. Fetch data to start building your database.
                        </div>
                      ) : null}

                      {(marketStatus?.data.events.count ?? 0) > 0 && (
                        <div className="flex items-center gap-2 text-xs">
                          <Newspaper className="w-3.5 h-3.5 text-primary" />
                          <span>{marketStatus?.data.events.count} economic events loaded for blackout filter</span>
                        </div>
                      )}

                      {!hasKeys?.twelveData && !hasKeys?.finnhub && (
                        <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50/40 dark:bg-amber-900/10 border border-amber-500/20">
                          <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                          <div className="text-xs text-amber-700 dark:text-amber-300">
                            <div className="font-medium mb-0.5">API keys required</div>
                            Add TWELVE_DATA_API_KEY and FINNHUB_API_KEY in your Secrets tab to enable live data fetching.
                            Sign up free at <span className="font-mono">twelvedata.com</span> and <span className="font-mono">finnhub.io</span>.
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* CSV Upload Mode */}
                  {dataMode === "csv" && (
                    <div className="space-y-3">
                      <p className="text-xs text-muted-foreground">
                        CSV format: timestamp, open, high, low, close
                      </p>
                      {[
                        { label: "H1 Data", data: h1Data, setter: setH1Data },
                        { label: "H4 Data", data: h4Data, setter: setH4Data },
                        { label: "Daily Data", data: dailyData, setter: setDailyData },
                      ].map(({ label, data, setter }) => (
                        <div key={label} className="flex items-center gap-3">
                          <Label className="text-xs w-20 shrink-0">{label} *</Label>
                          <Input
                            type="file"
                            accept=".csv"
                            className="text-xs"
                            data-testid={`input-upload-${label.toLowerCase().replace(/\s/g, "-")}`}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) handleFileUpload(f, setter, label);
                            }}
                          />
                          {data && (
                            <Badge variant="outline" className="text-xs shrink-0 border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
                              <FileCheck className="w-3 h-3 mr-1" />
                              {data.length}
                            </Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                </CardContent>
              </Card>

              {/* Date Range */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <CalendarDays className="w-4 h-4 text-primary" />
                    Date Range
                  </CardTitle>
                  <CardDescription className="text-xs">Optional — leave blank to use all available data</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="startDate" render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel>Start Date</FormLabel>
                        <Popover>
                          <PopoverTrigger asChild>
                            <FormControl>
                              <Button
                                variant="outline"
                                className={`w-full justify-start text-left font-normal ${!field.value ? "text-muted-foreground" : ""}`}
                                data-testid="input-start-date"
                              >
                                <CalendarDays className="mr-2 h-4 w-4" />
                                {field.value ? (() => { try { const d = parse(field.value, "yyyy-MM-dd", new Date()); return isNaN(d.getTime()) ? "Pick start date" : format(d, "MMM d, yyyy"); } catch { return "Pick start date"; } })() : "Pick start date"}
                              </Button>
                            </FormControl>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-0" align="start">
                            <Calendar
                              mode="single"
                              captionLayout="dropdown-buttons"
                              fromYear={2020}
                              toYear={new Date().getFullYear()}
                              selected={field.value ? (() => { try { const d = parse(field.value, "yyyy-MM-dd", new Date()); return isNaN(d.getTime()) ? undefined : d; } catch { return undefined; } })() : undefined}
                              onSelect={(date) => field.onChange(date ? format(date, "yyyy-MM-dd") : undefined)}
                              initialFocus
                            />
                            {field.value && (
                              <div className="p-2 pt-0 border-t">
                                <Button type="button" variant="ghost" size="sm" className="w-full" onClick={() => field.onChange(undefined)}>
                                  Clear date
                                </Button>
                              </div>
                            )}
                          </PopoverContent>
                        </Popover>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={form.control} name="endDate" render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel>End Date</FormLabel>
                        <Popover>
                          <PopoverTrigger asChild>
                            <FormControl>
                              <Button
                                variant="outline"
                                className={`w-full justify-start text-left font-normal ${!field.value ? "text-muted-foreground" : ""}`}
                                data-testid="input-end-date"
                              >
                                <CalendarDays className="mr-2 h-4 w-4" />
                                {field.value ? (() => { try { const d = parse(field.value, "yyyy-MM-dd", new Date()); return isNaN(d.getTime()) ? "Pick end date" : format(d, "MMM d, yyyy"); } catch { return "Pick end date"; } })() : "Pick end date"}
                              </Button>
                            </FormControl>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-0" align="start">
                            <Calendar
                              mode="single"
                              captionLayout="dropdown-buttons"
                              fromYear={2020}
                              toYear={new Date().getFullYear()}
                              selected={field.value ? (() => { try { const d = parse(field.value, "yyyy-MM-dd", new Date()); return isNaN(d.getTime()) ? undefined : d; } catch { return undefined; } })() : undefined}
                              onSelect={(date) => field.onChange(date ? format(date, "yyyy-MM-dd") : undefined)}
                              initialFocus
                            />
                            {field.value && (
                              <div className="p-2 pt-0 border-t">
                                <Button type="button" variant="ghost" size="sm" className="w-full" onClick={() => field.onChange(undefined)}>
                                  Clear date
                                </Button>
                              </div>
                            )}
                          </PopoverContent>
                        </Popover>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                </CardContent>
              </Card>

              {/* Strategy Mode */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Brain className="w-4 h-4 text-primary" />
                    Strategy Mode
                  </CardTitle>
                  <CardDescription className="text-xs">Select which trading strategy engine to backtest</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField control={form.control} name="strategyMode" render={({ field }) => (
                    <FormItem>
                      <div className="grid grid-cols-2 gap-3">
                        {([
                          { value: "regime" as const, label: "Regime Classifier", desc: "3-state range/trend/no-trade with S/R rejection signals" },
                          { value: "rsi_bot" as const, label: "RSI cTrader Bot", desc: "RSI oversold/overbought entries with ATR stop loss" },
                        ]).map(({ value, label, desc }) => (
                          <div
                            key={value}
                            role="button"
                            tabIndex={0}
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); form.setValue("strategyMode", value, { shouldValidate: true, shouldDirty: true, shouldTouch: true }); }}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); form.setValue("strategyMode", value, { shouldValidate: true, shouldDirty: true, shouldTouch: true }); }}}
                            className={`rounded-md border p-3 text-left transition-colors cursor-pointer select-none ${
                              field.value === value
                                ? "border-primary bg-primary/5 ring-1 ring-primary"
                                : "border-border hover:border-primary/40"
                            }`}
                            data-testid={`button-strategy-${value}`}
                          >
                            <div className="text-xs font-medium">{label}</div>
                            <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
                          </div>
                        ))}
                      </div>
                      <FormMessage />
                    </FormItem>
                  )} />

                  {values.strategyMode === "rsi_bot" && (
                    <div className="space-y-4 pt-2 border-t">
                      <div className="grid grid-cols-3 gap-4">
                        <FormField control={form.control} name="rsiPeriod" render={({ field }) => (
                          <FormItem>
                            <div className="flex items-center justify-between">
                              <FormLabel className="text-xs">RSI Period</FormLabel>
                              <span className="text-xs font-semibold text-primary">{values.rsiPeriod}</span>
                            </div>
                            <FormControl>
                              <LS min={5} max={50} step={1} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-rsi-period" />
                            </FormControl>
                          </FormItem>
                        )} />
                        <FormField control={form.control} name="rsiOversold" render={({ field }) => (
                          <FormItem>
                            <div className="flex items-center justify-between">
                              <FormLabel className="text-xs">Oversold</FormLabel>
                              <span className="text-xs font-semibold text-green-500">&lt;{values.rsiOversold}</span>
                            </div>
                            <FormControl>
                              <LS min={10} max={45} step={1} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-rsi-oversold" />
                            </FormControl>
                          </FormItem>
                        )} />
                        <FormField control={form.control} name="rsiOverbought" render={({ field }) => (
                          <FormItem>
                            <div className="flex items-center justify-between">
                              <FormLabel className="text-xs">Overbought</FormLabel>
                              <span className="text-xs font-semibold text-red-500">&gt;{values.rsiOverbought}</span>
                            </div>
                            <FormControl>
                              <LS min={55} max={90} step={1} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-rsi-overbought" />
                            </FormControl>
                          </FormItem>
                        )} />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <FormField control={form.control} name="rsiRewardRatio" render={({ field }) => (
                          <FormItem>
                            <div className="flex items-center justify-between">
                              <FormLabel className="text-xs">Take Profit R:R</FormLabel>
                              <span className="text-xs font-semibold text-primary">{values.rsiRewardRatio === 0 ? "RSI exit" : `${values.rsiRewardRatio}:1`}</span>
                            </div>
                            <FormControl>
                              <LS min={0} max={10} step={0.5} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-rsi-reward-ratio" />
                            </FormControl>
                            <FormDescription className="text-xs">0 = close on opposite RSI signal (matches cTrader bot)</FormDescription>
                          </FormItem>
                        )} />
                        <FormField control={form.control} name="maxDailyLossUSD" render={({ field }) => (
                          <FormItem>
                            <div className="flex items-center justify-between">
                              <FormLabel className="text-xs">Max Daily Loss (USD)</FormLabel>
                              <span className="text-xs font-semibold text-red-500">${values.maxDailyLossUSD}</span>
                            </div>
                            <FormControl>
                              <LS min={50} max={5000} step={50} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-max-daily-loss-usd" />
                            </FormControl>
                          </FormItem>
                        )} />
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Capital & Risk */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-primary" />
                    Capital & Risk
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  <FormField control={form.control} name="startingBalance" render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>Starting Balance</FormLabel>
                        <span className="text-sm font-semibold text-primary">${values.startingBalance?.toLocaleString()}</span>
                      </div>
                      <FormControl>
                        <LS min={500} max={100000} step={500} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-starting-balance" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <FormField control={form.control} name="lotSize" render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>Lot Size / Oz-equivalent</FormLabel>
                        <span className="text-sm font-semibold text-primary">{values.lotSize}</span>
                      </div>
                      <FormControl>
                        <LS min={0.01} max={10} step={0.01} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-lot-size" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />

                  {values.strategyMode !== "rsi_bot" && (
                    <FormField control={form.control} name="rewardRatio" render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center justify-between">
                          <FormLabel>Reward : Risk Ratio</FormLabel>
                          <span className="text-sm font-semibold text-primary">{values.rewardRatio}:1</span>
                        </div>
                        <FormControl>
                          <LS min={1} max={10} step={0.5} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-reward-ratio" />
                        </FormControl>
                        <FormDescription className="text-xs">Playbook default is 4:1</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )} />
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="maxTradesPerDay" render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center justify-between">
                          <FormLabel>Max Trades/Day</FormLabel>
                          <span className="text-sm font-semibold text-primary">{values.maxTradesPerDay}</span>
                        </div>
                        <FormControl>
                          <LS min={1} max={5} step={1} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-max-trades" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="executionTimeframe" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Execution Timeframe</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger data-testid="select-execution-timeframe">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="1h">H1 — Hourly (default)</SelectItem>
                            <SelectItem value="15min">M15 — 15 Minute</SelectItem>
                            <SelectItem value="1min">M1 — 1 Minute</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">Lower TF = more precise entries. H4 always used for regime detection.</p>
                        <FormMessage />
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="sessionMode" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Session Filter</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger data-testid="select-session-mode">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="Asian">Asian Only (00-07 UTC)</SelectItem>
                            <SelectItem value="Asian+London">Asian + London (00-16 UTC)</SelectItem>
                            <SelectItem value="London">London Only (07-16 UTC)</SelectItem>
                            <SelectItem value="NewYork">New York Only (12-21 UTC)</SelectItem>
                            <SelectItem value="London+NewYork">London + New York (07-21 UTC)</SelectItem>
                            <SelectItem value="Asian+London+NewYork">All Major Sessions (00-21 UTC)</SelectItem>
                            <SelectItem value="All">All Sessions (24h)</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="entryWindowBars" render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center justify-between">
                          <FormLabel>Entry Window (hours after open)</FormLabel>
                          <span className="text-sm font-semibold text-primary">{values.entryWindowBars === 0 ? 'Off' : `${values.entryWindowBars}h`}</span>
                        </div>
                        <FormControl>
                          <LS min={0} max={6} step={1} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-entry-window" />
                        </FormControl>
                        <p className="text-xs text-muted-foreground">Only trade in the first N hours after session opens (0 = no limit)</p>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>
                </CardContent>
              </Card>

              {/* ATR & Regime — regime mode only */}
              {values.strategyMode !== "rsi_bot" && <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Target className="w-4 h-4 text-primary" />
                    ATR & Regime Detection
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  <FormField control={form.control} name="atrPeriod" render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>ATR Period</FormLabel>
                        <span className="text-sm font-semibold text-primary">{values.atrPeriod}</span>
                      </div>
                      <FormControl>
                        <LS min={5} max={50} step={1} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-atr-period" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <FormField control={form.control} name="atrStopMultiplier" render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>ATR Stop Multiplier</FormLabel>
                        <span className="text-sm font-semibold text-primary">{values.atrStopMultiplier}x</span>
                      </div>
                      <FormControl>
                        <LS min={0.5} max={4} step={0.1} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-atr-multiplier" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <FormField control={form.control} name="expansionThreshold" render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>ATR Expansion Threshold</FormLabel>
                        <span className="text-sm font-semibold text-primary">{values.expansionThreshold}x</span>
                      </div>
                      <FormControl>
                        <LS min={1.05} max={2} step={0.05} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-expansion-threshold" />
                      </FormControl>
                      <FormDescription className="text-xs">ATR vs avg — above this = trend regime</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <FormField control={form.control} name="compressionThreshold" render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>BB Compression Threshold</FormLabel>
                        <span className="text-sm font-semibold text-primary">{(values.compressionThreshold * 100).toFixed(1)}%</span>
                      </div>
                      <FormControl>
                        <LS min={0.005} max={0.05} step={0.001} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-compression" />
                      </FormControl>
                      <FormDescription className="text-xs">Normalized BB width below this = compressed</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )} />
                </CardContent>
              </Card>}

              {/* Midpoint & Entry Validation — regime mode only */}
              {values.strategyMode !== "rsi_bot" && <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Shield className="w-4 h-4 text-primary" />
                    Midpoint & Entry Filters
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  <FormField control={form.control} name="midpointBandPct" render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>Midpoint No-Trade Band</FormLabel>
                        <span className="text-sm font-semibold text-primary">{(values.midpointBandPct * 100).toFixed(0)}%</span>
                      </div>
                      <FormControl>
                        <LS min={0.05} max={0.40} step={0.01} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-midpoint-band" />
                      </FormControl>
                      <FormDescription className="text-xs">% of range around midpoint where no trades taken</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <FormField control={form.control} name="wickRatio" render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>Wick/Body Rejection Ratio</FormLabel>
                        <span className="text-sm font-semibold text-primary">{values.wickRatio}x</span>
                      </div>
                      <FormControl>
                        <LS min={0.3} max={5} step={0.1} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-wick-ratio" />
                      </FormControl>
                      <FormDescription className="text-xs">Min wick-to-body ratio for valid rejection candle</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <FormField control={form.control} name="retestBuffer" render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>Retest Buffer (points)</FormLabel>
                        <span className="text-sm font-semibold text-primary">{values.retestBuffer}</span>
                      </div>
                      <FormControl>
                        <LS min={0.5} max={50} step={0.5} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-retest-buffer" />
                      </FormControl>
                      <FormDescription className="text-xs">Buffer for near-level detection and acceptance</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <FormField control={form.control} name="minRangeATR" render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>Min Range Width (x ATR)</FormLabel>
                        <span className="text-sm font-semibold text-primary">{values.minRangeATR}x</span>
                      </div>
                      <FormControl>
                        <LS min={0} max={10} step={0.5} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-min-range-atr" />
                      </FormControl>
                      <FormDescription className="text-xs">Skip ranges narrower than this multiple of H1 ATR</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <FormField control={form.control} name="maxTrendATRRatio" render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>Max Trend ATR Ratio</FormLabel>
                        <span className="text-sm font-semibold text-primary">{values.maxTrendATRRatio}x</span>
                      </div>
                      <FormControl>
                        <LS min={1} max={20} step={0.5} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-max-trend-atr" />
                      </FormControl>
                      <FormDescription className="text-xs">Block trend entries when H4 ATR exceeds this multiple of average</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <FormField control={form.control} name="rangeWidthBars" render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>H4 Range Lookback Bars</FormLabel>
                        <span className="text-sm font-semibold text-primary">{values.rangeWidthBars}</span>
                      </div>
                      <FormControl>
                        <LS min={5} max={30} step={1} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-range-width" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </CardContent>
              </Card>}

              {/* News Blackout — regime mode only */}
              {values.strategyMode !== "rsi_bot" && <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-primary" />
                    News Event Blackout
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="newsBeforeMin" render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>Before Event (min)</FormLabel>
                        <span className="text-sm font-semibold text-primary">{values.newsBeforeMin}</span>
                      </div>
                      <FormControl>
                        <LS min={0} max={180} step={15} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-news-before" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="newsAfterMin" render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel>After Event (min)</FormLabel>
                        <span className="text-sm font-semibold text-primary">{values.newsAfterMin}</span>
                      </div>
                      <FormControl>
                        <LS min={0} max={180} step={15} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-news-after" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </CardContent>
              </Card>}

              {/* Open Candle Analysis — regime mode only */}
              {values.strategyMode !== "rsi_bot" && <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-primary" />
                    Open Candle Analysis
                  </CardTitle>
                  <CardDescription className="text-xs">Gap detection and session opening range filters</CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <FormField control={form.control} name="gapFilterEnabled" render={({ field }) => (
                    <FormItem className="flex items-center justify-between rounded-md border p-3">
                      <div>
                        <FormLabel className="text-sm font-medium">Gap Filter</FormLabel>
                        <FormDescription className="text-xs">Skip entries after large open-vs-previous-close gaps</FormDescription>
                      </div>
                      <FormControl>
                        <input
                          type="checkbox"
                          checked={field.value}
                          onChange={(e) => field.onChange(e.target.checked)}
                          className="h-4 w-4 rounded border-gray-300 accent-primary"
                          data-testid="checkbox-gap-filter"
                        />
                      </FormControl>
                    </FormItem>
                  )} />

                  {values.gapFilterEnabled && (
                    <div className="grid grid-cols-2 gap-4 pl-2 border-l-2 border-primary/20">
                      <FormField control={form.control} name="gapThresholdAtr" render={({ field }) => (
                        <FormItem>
                          <div className="flex items-center justify-between">
                            <FormLabel>Gap Threshold (ATR x)</FormLabel>
                            <span className="text-sm font-semibold text-primary">{values.gapThresholdAtr}x</span>
                          </div>
                          <FormControl>
                            <LS min={0.1} max={2} step={0.1} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-gap-threshold" />
                          </FormControl>
                          <FormDescription className="text-xs">Gap size relative to ATR to trigger filter</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="gapCooldownBars" render={({ field }) => (
                        <FormItem>
                          <div className="flex items-center justify-between">
                            <FormLabel>Cooldown Bars</FormLabel>
                            <span className="text-sm font-semibold text-primary">{values.gapCooldownBars}</span>
                          </div>
                          <FormControl>
                            <LS min={1} max={8} step={1} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-gap-cooldown" />
                          </FormControl>
                          <FormDescription className="text-xs">H1 bars to wait after a gap before trading</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                  )}

                  <FormField control={form.control} name="sessionORBEnabled" render={({ field }) => (
                    <FormItem className="flex items-center justify-between rounded-md border p-3">
                      <div>
                        <FormLabel className="text-sm font-medium">Session Opening Range Bias</FormLabel>
                        <FormDescription className="text-xs">Only take trades aligned with the first candle direction of the session</FormDescription>
                      </div>
                      <FormControl>
                        <input
                          type="checkbox"
                          checked={field.value}
                          onChange={(e) => field.onChange(e.target.checked)}
                          className="h-4 w-4 rounded border-gray-300 accent-primary"
                          data-testid="checkbox-session-orb"
                        />
                      </FormControl>
                    </FormItem>
                  )} />
                </CardContent>
              </Card>}

              {/* Risk Controls */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Shield className="w-4 h-4 text-primary" />
                    Risk Controls
                  </CardTitle>
                  <CardDescription className="text-xs">Position sizing, drawdown limits, and loss management</CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">

                  <FormField control={form.control} name="trailingStopEnabled" render={({ field }) => (
                    <FormItem className="flex items-center justify-between rounded-md border p-3">
                      <div>
                        <FormLabel className="text-sm font-medium">Trailing Stop to Breakeven</FormLabel>
                        <FormDescription className="text-xs">Move stop to entry when trade reaches trigger R in profit</FormDescription>
                      </div>
                      <FormControl>
                        <input
                          type="checkbox"
                          checked={field.value}
                          onChange={(e) => field.onChange(e.target.checked)}
                          className="h-4 w-4 rounded border-gray-300 accent-primary"
                          data-testid="checkbox-trailing-stop"
                        />
                      </FormControl>
                    </FormItem>
                  )} />

                  {values.trailingStopEnabled && (
                    <FormField control={form.control} name="trailingStopTriggerR" render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center justify-between">
                          <FormLabel className="text-sm">Trailing Trigger (R)</FormLabel>
                          <span className="text-sm font-semibold text-primary">{values.trailingStopTriggerR}R</span>
                        </div>
                        <FormControl>
                          <LS min={0.5} max={5} step={0.25} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-trailing-trigger" />
                        </FormControl>
                        <FormDescription className="text-xs">Move stop to breakeven when unrealized profit reaches this R-multiple</FormDescription>
                      </FormItem>
                    )} />
                  )}

                  <FormField control={form.control} name="riskPerTradePct" render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel className="text-sm">Risk Per Trade</FormLabel>
                        <span className="text-sm font-semibold text-primary">{values.riskPerTradePct}%</span>
                      </div>
                      <FormControl>
                        <LS min={0.5} max={5} step={0.25} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-risk-per-trade" />
                      </FormControl>
                      <FormDescription className="text-xs">% of current balance risked per trade (position sizing)</FormDescription>
                    </FormItem>
                  )} />

                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm">Leverage</Label>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-xs border-primary/30 text-primary">Locked</Badge>
                        <span className="text-sm font-semibold text-primary" data-testid="value-leverage-locked">10x</span>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">Fixed at 1:10 — cannot be changed for safety</p>
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm">Max Drawdown Circuit Breaker</Label>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-xs border-destructive/30 text-destructive">Locked</Badge>
                        <span className="text-sm font-semibold text-destructive" data-testid="value-maxdd-locked">25%</span>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">Fixed at 25% — stops trading when drawdown exceeds this</p>
                  </div>

                  <FormField control={form.control} name="maxDailyLossPct" render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel className="text-sm">Max Daily Loss</FormLabel>
                        <span className="text-sm font-semibold text-destructive">{values.maxDailyLossPct}%</span>
                      </div>
                      <FormControl>
                        <LS min={0.5} max={10} step={0.5} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-max-daily-loss" />
                      </FormControl>
                      <FormDescription className="text-xs">Stop trading for the day when realized loss reaches this % of starting balance</FormDescription>
                    </FormItem>
                  )} />

                  <div className="grid grid-cols-2 gap-3">
                    <FormField control={form.control} name="maxConsecutiveLosses" render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center justify-between">
                          <FormLabel className="text-sm">Max Consec Losses</FormLabel>
                          <span className="text-sm font-semibold text-destructive">{values.maxConsecutiveLosses}</span>
                        </div>
                        <FormControl>
                          <LS min={1} max={10} step={1} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-max-consec-losses" />
                        </FormControl>
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="postLossCooldownBars" render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center justify-between">
                          <FormLabel className="text-sm">Cooldown Bars</FormLabel>
                          <span className="text-sm font-semibold text-primary">{values.postLossCooldownBars}</span>
                        </div>
                        <FormControl>
                          <LS min={0} max={10} step={1} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-cooldown-bars" />
                        </FormControl>
                      </FormItem>
                    )} />
                  </div>
                  <FormDescription className="text-xs -mt-2">Pause entries for N bars after hitting consecutive loss limit</FormDescription>

                  <FormField control={form.control} name="reduceSizeAfterLoss" render={({ field }) => (
                    <FormItem className="flex items-center justify-between rounded-md border p-3">
                      <div>
                        <FormLabel className="text-sm font-medium">Reduce Size After Loss</FormLabel>
                        <FormDescription className="text-xs">Use reduced risk % on the trade following a loss</FormDescription>
                      </div>
                      <FormControl>
                        <input type="checkbox" checked={field.value} onChange={(e) => field.onChange(e.target.checked)} className="h-4 w-4 rounded border-gray-300 accent-primary" data-testid="checkbox-reduce-size" />
                      </FormControl>
                    </FormItem>
                  )} />

                  {values.reduceSizeAfterLoss && (
                    <FormField control={form.control} name="reducedRiskPerTradePct" render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center justify-between">
                          <FormLabel className="text-sm">Reduced Risk %</FormLabel>
                          <span className="text-sm font-semibold text-amber-600">{values.reducedRiskPerTradePct}%</span>
                        </div>
                        <FormControl>
                          <LS min={0.1} max={5} step={0.1} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-reduced-risk" />
                        </FormControl>
                        <FormDescription className="text-xs">Risk % used on the first trade after a loss</FormDescription>
                      </FormItem>
                    )} />
                  )}

                  <FormField control={form.control} name="secondTradeRiskFactor" render={({ field }) => (
                    <FormItem>
                      <div className="flex items-center justify-between">
                        <FormLabel className="text-sm">2nd Trade Risk Factor</FormLabel>
                        <span className="text-sm font-semibold text-primary">{values.secondTradeRiskFactor}x</span>
                      </div>
                      <FormControl>
                        <LS min={0.1} max={1} step={0.05} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-second-trade-factor" />
                      </FormControl>
                      <FormDescription className="text-xs">Multiply risk by this on 2nd+ trade of the day</FormDescription>
                    </FormItem>
                  )} />

                  <FormField control={form.control} name="atrRiskScaleEnabled" render={({ field }) => (
                    <FormItem className="flex items-center justify-between rounded-md border p-3">
                      <div>
                        <FormLabel className="text-sm font-medium">ATR Risk Scaling</FormLabel>
                        <FormDescription className="text-xs">Reduce risk when ATR is elevated above threshold</FormDescription>
                      </div>
                      <FormControl>
                        <input type="checkbox" checked={field.value} onChange={(e) => field.onChange(e.target.checked)} className="h-4 w-4 rounded border-gray-300 accent-primary" data-testid="checkbox-atr-risk-scale" />
                      </FormControl>
                    </FormItem>
                  )} />

                  {values.atrRiskScaleEnabled && (
                    <div className="grid grid-cols-2 gap-3">
                      <FormField control={form.control} name="atrRiskScaleThreshold" render={({ field }) => (
                        <FormItem>
                          <div className="flex items-center justify-between">
                            <FormLabel className="text-sm">ATR Threshold</FormLabel>
                            <span className="text-sm font-semibold text-primary">{values.atrRiskScaleThreshold}x</span>
                          </div>
                          <FormControl>
                            <LS min={1.05} max={3} step={0.05} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-atr-threshold" />
                          </FormControl>
                        </FormItem>
                      )} />

                      <FormField control={form.control} name="atrRiskScaleFactor" render={({ field }) => (
                        <FormItem>
                          <div className="flex items-center justify-between">
                            <FormLabel className="text-sm">Scale Factor</FormLabel>
                            <span className="text-sm font-semibold text-primary">{values.atrRiskScaleFactor}x</span>
                          </div>
                          <FormControl>
                            <LS min={0.1} max={1} step={0.05} value={[field.value]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-atr-scale-factor" />
                          </FormControl>
                        </FormItem>
                      )} />
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Target className="w-4 h-4" />
                    Trading Costs (cTrader Realism)
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-3 gap-3">
                    <FormField control={form.control} name="spreadPoints" render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center justify-between">
                          <FormLabel className="text-sm">Spread</FormLabel>
                          <span className="text-sm font-semibold text-primary">${values.spreadPoints?.toFixed(2) ?? '0.30'}</span>
                        </div>
                        <FormControl>
                          <LS min={0} max={5} step={0.05} value={[field.value ?? 0.3]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-spread" />
                        </FormControl>
                        <FormDescription className="text-xs">Bid/Ask spread in points</FormDescription>
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="slippagePoints" render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center justify-between">
                          <FormLabel className="text-sm">Slippage</FormLabel>
                          <span className="text-sm font-semibold text-primary">${values.slippagePoints?.toFixed(2) ?? '0.10'}</span>
                        </div>
                        <FormControl>
                          <LS min={0} max={5} step={0.05} value={[field.value ?? 0.1]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-slippage" />
                        </FormControl>
                        <FormDescription className="text-xs">Execution slippage in points</FormDescription>
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="commissionPerLot" render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center justify-between">
                          <FormLabel className="text-sm">Commission</FormLabel>
                          <span className="text-sm font-semibold text-primary">${values.commissionPerLot?.toFixed(0) ?? '0'}</span>
                        </div>
                        <FormControl>
                          <LS min={0} max={50} step={1} value={[field.value ?? 0]} onValueChange={([v]) => field.onChange(v)} data-testid="slider-commission" />
                        </FormControl>
                        <FormDescription className="text-xs">Per-lot commission ($)</FormDescription>
                      </FormItem>
                    )} />
                  </div>
                </CardContent>
              </Card>

              <Button
                type="submit"
                className="w-full"
                disabled={backtestMutation.isPending || !canRunBacktest}
                data-testid="button-submit-backtest"
                size="lg"
              >
                {backtestMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Running Simulation...</>
                ) : (
                  <><FlaskConical className="w-4 h-4 mr-2" />Run Backtest{dataMode === "auto" ? " (Live Data)" : " (CSV Data)"}</>
                )}
              </Button>
            </form>
          </Form>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">
                {values.strategyMode === "rsi_bot" ? "RSI Bot Strategy Rules" : "v9 Regime Strategy Rules"}
              </CardTitle>
              <CardDescription className="text-xs">
                {values.strategyMode === "rsi_bot" ? "cTrader RSI Bot" : "Gold Regime Playbook"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {(values.strategyMode === "rsi_bot" ? [
                { icon: CheckCircle2, title: "RSI Oversold BUY", desc: `Enter long when RSI(${values.rsiPeriod}) < ${values.rsiOversold}` },
                { icon: CheckCircle2, title: "RSI Overbought SELL", desc: `Enter short when RSI(${values.rsiPeriod}) > ${values.rsiOverbought}` },
                { icon: Target, title: "ATR Stop Loss", desc: `Previous bar low/high ± ${values.atrStopMultiplier}x ATR` },
                { icon: Shield, title: "Take Profit", desc: values.rsiRewardRatio === 0 ? "Close on opposite RSI signal" : `${values.rsiRewardRatio}:1 reward ratio` },
                { icon: CheckCircle2, title: "Daily Loss Limit", desc: `$${values.maxDailyLossUSD} max daily loss` },
                { icon: Globe, title: "Session Filter", desc: "Configurable session hours" },
                { icon: CheckCircle2, title: "One Position", desc: "Only one open trade at a time" },
              ] : [
                { icon: CheckCircle2, title: "3-State Regime", desc: "Range / Trend / No-Trade classification" },
                { icon: Shield, title: "Midpoint Filter", desc: "No trades in H4 midpoint dead zone" },
                { icon: CheckCircle2, title: "Rejection Validation", desc: "Wick/body ratio required for range entries" },
                { icon: CheckCircle2, title: "Acceptance Confirmation", desc: "Breakout must hold on retest for trend" },
                { icon: Globe, title: "Session Filter", desc: "London + New York hours only" },
                { icon: Newspaper, title: "Event Blackout", desc: "Live economic calendar from Finnhub" },
                { icon: CheckCircle2, title: "Max 2 Trades/Day", desc: "Prevents overtrading" },
              ]).map(({ icon: Icon, title, desc }) => (
                <div key={title} className="flex items-start gap-2">
                  <Icon className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <div>
                    <div className="font-medium text-xs">{title}</div>
                    <div className="text-muted-foreground text-xs">{desc}</div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Brain className="w-4 h-4 text-primary" />
                AI Auto-Tune
              </CardTitle>
              <CardDescription className="text-xs">Let AI optimize parameters automatically</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Max Iterations</span>
                  <Input
                    type="number"
                    min={2}
                    max={25}
                    value={autoTuneMaxIter}
                    onChange={(e) => setAutoTuneMaxIter(parseInt(e.target.value) || 10)}
                    className="w-16 h-7 text-xs text-right"
                    data-testid="input-autotune-iterations"
                  />
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Target Return %</span>
                  <Input
                    type="number"
                    min={10}
                    max={500}
                    value={autoTuneTargetReturn}
                    onChange={(e) => setAutoTuneTargetReturn(parseInt(e.target.value) || 100)}
                    className="w-16 h-7 text-xs text-right"
                    data-testid="input-autotune-target"
                  />
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Max Drawdown %</span>
                  <Input
                    type="number"
                    min={5}
                    max={50}
                    value={autoTuneMaxDD}
                    onChange={(e) => setAutoTuneMaxDD(parseInt(e.target.value) || 25)}
                    className="w-16 h-7 text-xs text-right"
                    data-testid="input-autotune-maxdd"
                  />
                </div>
              </div>

              <Button
                type="button"
                className="w-full"
                onClick={() => autoTuneMutation.mutate()}
                disabled={autoTuneMutation.isPending || !hasCachedData}
                data-testid="button-autotune-start"
              >
                {autoTuneMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Running ({autoTuneMaxIter} iterations)...</>
                ) : (
                  <><Zap className="w-4 h-4 mr-2" />Start Auto-Tune</>
                )}
              </Button>

              {!hasCachedData && (
                <p className="text-[10px] text-muted-foreground">Fetch or load market data first</p>
              )}

              {autoTuneMutation.isPending && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground pt-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>AI is optimizing... this may take 30-60 seconds</span>
                </div>
              )}

              {(() => {
                const displayIterations = autoTuneResult?.iterations ?? autoTuneStatus?.iterations ?? [];
                const displayStatus = autoTuneResult?.message ?? autoTuneStatus?.status ?? "";
                const isRunning = autoTuneStatus?.running ?? false;
                if (displayIterations.length === 0) return null;
                return (
                  <div className="space-y-2 pt-2 border-t">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium">{displayStatus}</span>
                      {isRunning && autoTuneStatus && (
                        <Badge variant="outline" className="text-[10px]">
                          {autoTuneStatus.currentIteration}/{autoTuneStatus.maxIterations}
                        </Badge>
                      )}
                    </div>
                    {isRunning && autoTuneStatus && (
                      <Progress
                        value={(autoTuneStatus.currentIteration / autoTuneStatus.maxIterations) * 100}
                        className="h-1.5"
                        data-testid="progress-autotune"
                      />
                    )}
                    <div className="max-h-48 overflow-y-auto space-y-1">
                      {displayIterations.map((iter) => {
                        const bestRDR = Math.max(...displayIterations.map(i => i.stats.returnDDRatio));
                        const isBest = iter.stats.returnDDRatio === bestRDR;
                        return (
                          <div
                            key={iter.iteration}
                            className={`text-[10px] p-1.5 rounded ${isBest ? "bg-emerald-500/10 border border-emerald-500/30" : "bg-muted/30"}`}
                            data-testid={`text-autotune-iter-${iter.iteration}`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-medium">
                                #{iter.iteration} {isBest && "★"}
                              </span>
                              <span className="font-mono">
                                {iter.stats.returnPct}% / {iter.stats.maxDrawdownPct}% DD
                              </span>
                            </div>
                            <div className="text-muted-foreground">
                              {iter.stats.totalTrades}t {iter.stats.winRate}%WR PF{iter.stats.profitFactor} R/DD:{iter.stats.returnDDRatio}
                            </div>
                            {iter.changes.length > 0 && iter.iteration > 0 && (
                              <div className="text-muted-foreground mt-0.5 truncate" title={iter.changes.join("; ")}>
                                {iter.changes[0]}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {!isRunning && !autoTuneMutation.isPending && displayIterations.length > 1 && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => {
                          const best = displayIterations.reduce((a, b) =>
                            a.stats.returnDDRatio > b.stats.returnDDRatio ? a : b
                          );
                          const { startDate, endDate, ...bestParams } = best.config as any;
                          form.reset({ ...form.getValues(), ...bestParams });
                          toast({ title: "Best config applied", description: `Iteration #${best.iteration} — ${best.stats.returnPct}% return, ${best.stats.maxDrawdownPct}% DD` });
                        }}
                        data-testid="button-apply-best-config"
                      >
                        <Target className="w-4 h-4 mr-2" />
                        Apply Best Config
                      </Button>
                    )}
                  </div>
                );
              })()}
            </CardContent>
          </Card>

          <Card className="border-amber-500/30">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Zap className="w-4 h-4 text-amber-500" />
                AI Deep Optimize
              </CardTitle>
              <CardDescription className="text-xs">Multi-round AI-driven optimization with learning</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Rounds (8 tests each)</span>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={aiOptRounds}
                  onChange={(e) => setAiOptRounds(parseInt(e.target.value) || 5)}
                  className="w-16 h-7 text-xs text-right"
                  data-testid="input-ai-opt-rounds"
                />
              </div>
              <Button
                type="button"
                className="w-full bg-amber-600 hover:bg-amber-700 text-white"
                onClick={() => aiOptMutation.mutate()}
                disabled={aiOptMutation.isPending || aiOptRunning}
                data-testid="button-ai-optimize-start"
              >
                {aiOptMutation.isPending || aiOptRunning ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />AI Optimizing (Round {aiOptStatus?.round || 0}/{aiOptStatus?.totalRounds || aiOptRounds})...</>
                ) : (
                  <><Brain className="w-4 h-4 mr-2" />Start AI Deep Optimize</>
                )}
              </Button>

              {aiOptRunning && aiOptStatus && (
                <div className="space-y-2 pt-2">
                  <Progress
                    value={aiOptStatus.totalRounds > 0 ? ((aiOptStatus.round - 1 + (aiOptStatus.testsThisRound / Math.max(aiOptStatus.totalTestsThisRound, 1))) / aiOptStatus.totalRounds) * 100 : 0}
                    className="h-1.5"
                    data-testid="progress-ai-opt"
                  />
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>Round {aiOptStatus.round}/{aiOptStatus.totalRounds} — Test {aiOptStatus.testsThisRound}/{aiOptStatus.totalTestsThisRound}</span>
                    <span className="font-mono text-emerald-600 dark:text-emerald-400">Best: {aiOptStatus.globalBest}%</span>
                  </div>
                </div>
              )}

              {aiOptStatus?.log && aiOptStatus.log.length > 0 && (
                <div className="max-h-64 overflow-y-auto space-y-0.5 pt-2 border-t">
                  {aiOptStatus.log.map((line: string, i: number) => (
                    <div key={i} className={`text-[10px] font-mono ${line.includes('★ NEW BEST') ? 'text-emerald-600 dark:text-emerald-400 font-bold' : line.startsWith('──') ? 'text-primary font-semibold mt-1' : 'text-muted-foreground'}`}>
                      {line}
                    </div>
                  ))}
                </div>
              )}

              {aiOptStatus?.done && aiOptStatus.result && (
                <div className="pt-2 border-t text-xs space-y-1">
                  <div className="font-semibold text-primary">
                    {aiOptStatus.result.improved
                      ? `Improved: ${aiOptStatus.result.startBest}% → ${aiOptStatus.result.endBest}%`
                      : `No improvement found (best: ${aiOptStatus.result.endBest}%)`}
                  </div>
                  <div className="text-muted-foreground">
                    {aiOptStatus.result.improvements} improvements, {aiOptStatus.result.learningsSaved} learnings saved
                  </div>
                </div>
              )}

              {aiOptStatus?.done && aiOptStatus.result?.promotion && (
                <div className="mt-2 p-3 rounded-md border border-emerald-500/40 bg-emerald-500/5 space-y-2" data-testid="panel-promotion">
                  <div className="flex items-center gap-2">
                    <Trophy className="w-4 h-4 text-emerald-500" />
                    <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">New Champion candidate</span>
                    <Badge variant="outline" className="text-[9px] h-4 px-1.5">{aiOptStatus.result.promotion.category}</Badge>
                  </div>
                  <div className="text-xs font-mono break-words" data-testid="text-promotion-name">
                    {aiOptStatus.result.promotion.name}
                  </div>
                  {aiOptStatus.result.promotion.proposalId ? (
                    <>
                      <div className="text-[10px] text-muted-foreground">
                        Saved to catalogue. Authorization required to apply to live trading.
                        {aiOptStatus.result.promotion.changedKeys?.length > 0 && (
                          <> Changes: {aiOptStatus.result.promotion.changedKeys.join(", ")}</>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 px-2 text-[10px] bg-emerald-600 hover:bg-emerald-700 text-white flex-1"
                          onClick={() => approvePromotionMutation.mutate(aiOptStatus.result.promotion.proposalId)}
                          disabled={approvePromotionMutation.isPending || rejectPromotionMutation.isPending}
                          data-testid="button-approve-promotion"
                        >
                          {approvePromotionMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
                          Approve & Go Live
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-[10px]"
                          onClick={() => rejectPromotionMutation.mutate(aiOptStatus.result.promotion.proposalId)}
                          disabled={approvePromotionMutation.isPending || rejectPromotionMutation.isPending}
                          data-testid="button-reject-promotion"
                        >
                          Reject
                        </Button>
                      </div>
                    </>
                  ) : (
                    <div className="text-[10px] text-muted-foreground">
                      Saved to catalogue. {aiOptStatus.result.promotion.note || "No live param changes needed."}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Current Config</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-xs">
                {[
                  ["Balance", `$${values.startingBalance?.toLocaleString()}`],
                  ["Lot Size", `${values.lotSize}`],
                  ["R:R ratio", `${values.rewardRatio}:1`],
                  ["ATR period", `${values.atrPeriod}`],
                  ["ATR SL mult", `${values.atrStopMultiplier}x`],
                  ["Expansion", `${values.expansionThreshold}x`],
                  ["Midpoint band", `${(values.midpointBandPct * 100).toFixed(0)}%`],
                  ["Wick ratio", `${values.wickRatio}x`],
                  ["Exec TF", `${values.executionTimeframe ?? "1h"}`],
                  ["Session", `${values.sessionMode}`],
                  ["Max/day", `${values.maxTradesPerDay}`],
                  ["Risk/trade", `${values.riskPerTradePct}%`],
                  ["Leverage", `${values.leverage}x`],
                  ["Max DD", `${values.maxDrawdownPct}%`],
                  ["Daily loss cap", `${values.maxDailyLossPct}%`],
                  ["Consec loss limit", `${values.maxConsecutiveLosses}`],
                  ["2nd trade factor", `${values.secondTradeRiskFactor}x`],
                  ["Spread", `$${values.spreadPoints?.toFixed(2) ?? '0.30'}`],
                  ["Slippage", `$${values.slippagePoints?.toFixed(2) ?? '0.10'}`],
                  ["Commission/lot", `$${values.commissionPerLot ?? 0}`],
                  ["Data source", dataMode === "auto" ? "Live API" : "CSV Upload"],
                ].map(([label, val]) => (
                  <div key={label} className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-mono font-medium">{val}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Backtest Results Section */}
      <div id="backtest-results" className="px-6 pb-6">
        {(fullResult || loadingResult || displayStats) && (
          <div className="space-y-6 mt-6 pt-6 border-t">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <h2 className="text-lg font-semibold flex items-center gap-2" data-testid="heading-results">
                  <FlaskConical className="w-5 h-5 text-primary" />
                  Backtest Results
                </h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {selectedResultId ? "Viewing saved backtest" : "Latest backtest"}
                  {fullResult?.dataSource === "synthetic" && " — Synthetic Data"}
                  {fullResult?.dataSource === "real" && " — Real Data"}
                  {fullResult?.config?.startDate && fullResult?.config?.endDate && (
                    <span className="ml-2 text-xs">({fullResult.config.startDate} — {fullResult.config.endDate})</span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {fullResult && (
                  <Button
                    size="sm"
                    variant="default"
                    className="h-8 text-xs"
                    onClick={() => {
                      if (confirm("Apply this strategy's parameters to live trading? This will update the locked params used by the live trader.")) {
                        applyToLiveMutation.mutate(fullResult.config as any);
                      }
                    }}
                    disabled={applyToLiveMutation.isPending}
                    data-testid="button-apply-live-result"
                  >
                    <Zap className="w-3.5 h-3.5 mr-1" />
                    {applyToLiveMutation.isPending ? "Applying..." : "Apply to Live Trading"}
                  </Button>
                )}
                {fullResult && <ExportMenu result={fullResult} />}
              </div>
            </div>

            {(() => {
              const stats = displayStats;
              const recentTrades = fullResult?.trades.slice(-10).reverse() ?? [];
              const regimePie = fullResult ? [
                { name: "Range", value: fullResult.regimeCounts.range, fill: "hsl(200,70%,45%)" },
                { name: "Trend", value: fullResult.regimeCounts.trend, fill: "hsl(43,84%,45%)" },
                { name: "No Trade", value: fullResult.regimeCounts.no_trade, fill: "hsl(0,0%,55%)" },
              ] : [];
              const regimeTradePie = stats ? [
                { name: "Range", value: stats.rangeTrades, fill: "hsl(200,70%,45%)" },
                { name: "Trend", value: stats.trendTrades, fill: "hsl(43,84%,45%)" },
              ] : [];

              return (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                    <Card data-testid="card-stat-final-balance">
                      <CardContent className="pt-5 pb-4 px-5">
                        {loadingResult ? <div className="space-y-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-16" /></div> : (
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-1">Final Balance</div>
                              <div className={`text-2xl font-bold leading-tight ${stats && stats.netPnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}`} data-testid="value-final-balance">
                                {stats ? `$${stats.finalBalance.toLocaleString()}` : "--"}
                              </div>
                              {stats && <div className="text-xs text-muted-foreground mt-0.5">Started ${Math.max(fullResult?.config?.startingBalance ?? activeSummary?.config?.startingBalance ?? 3000, 3000).toLocaleString()}</div>}
                            </div>
                            <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                              {stats && stats.netPnl >= 0 ? <TrendingUp className="w-4 h-4 text-primary" /> : <TrendingDown className="w-4 h-4 text-primary" />}
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                    <Card data-testid="card-stat-net-return">
                      <CardContent className="pt-5 pb-4 px-5">
                        {loadingResult ? <div className="space-y-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-16" /></div> : (
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-1">Net Return</div>
                              <div className={`text-2xl font-bold leading-tight ${stats && stats.netPnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}`} data-testid="value-net-return">
                                {stats ? `${stats.returnPct > 0 ? "+" : ""}${stats.returnPct}%` : "--"}
                              </div>
                              {stats && <div className="text-xs text-muted-foreground mt-0.5">${Number(stats.netPnl) >= 0 ? "+" : ""}{Number(stats.netPnl).toFixed(2)} P&L</div>}
                            </div>
                            <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5"><Activity className="w-4 h-4 text-primary" /></div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                    <Card data-testid="card-stat-win-rate">
                      <CardContent className="pt-5 pb-4 px-5">
                        {loadingResult ? <div className="space-y-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-16" /></div> : (
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-1">Win Rate</div>
                              <div className={`text-2xl font-bold leading-tight ${stats && stats.winRate >= 40 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}`} data-testid="value-win-rate">
                                {stats ? `${stats.winRate}%` : "--"}
                              </div>
                              {stats && <div className="text-xs text-muted-foreground mt-0.5">{stats.wins}W / {stats.losses}L</div>}
                            </div>
                            <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5"><Target className="w-4 h-4 text-primary" /></div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                    <Card data-testid="card-stat-max-drawdown">
                      <CardContent className="pt-5 pb-4 px-5">
                        {loadingResult ? <div className="space-y-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-16" /></div> : (
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-1">Max Drawdown</div>
                              <div className={`text-2xl font-bold leading-tight ${stats && Number(stats.maxDrawdownPct) <= 20 ? "text-emerald-600 dark:text-emerald-400" : stats && Number(stats.maxDrawdownPct) <= 40 ? "text-amber-600 dark:text-amber-400" : "text-red-500 dark:text-red-400"}`} data-testid="value-max-drawdown">
                                {stats ? `${Number(stats.maxDrawdownPct).toFixed(1)}%` : "--"}
                              </div>
                              {stats && <div className="text-xs text-muted-foreground mt-0.5">R/DD: {stats.returnDDRatio}</div>}
                            </div>
                            <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5"><TrendingDown className="w-4 h-4 text-primary" /></div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                    <Card data-testid="card-stat-profit-factor">
                      <CardContent className="pt-5 pb-4 px-5">
                        {loadingResult ? <div className="space-y-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-16" /></div> : (
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-1">Profit Factor</div>
                              <div className={`text-2xl font-bold leading-tight ${stats && stats.profitFactor >= 1.5 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}`} data-testid="value-profit-factor">
                                {stats ? `${stats.profitFactor}x` : "--"}
                              </div>
                              {stats && <div className="text-xs text-muted-foreground mt-0.5">Avg R: {stats.avgR}R</div>}
                            </div>
                            <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5"><Trophy className="w-4 h-4 text-primary" /></div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>

                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <Card><CardContent className="pt-5 pb-4 px-5">
                      {loadingResult ? <div className="space-y-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-16" /></div> : (
                        <div className="flex items-start justify-between gap-2"><div>
                          <div className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-1">Total Trades</div>
                          <div className="text-2xl font-bold leading-tight" data-testid="value-total-trades">{stats ? `${stats.totalTrades}` : "--"}</div>
                          {stats && <div className="text-xs text-muted-foreground mt-0.5">Avg R: {stats.avgR}R</div>}
                        </div><div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5"><BarChart3 className="w-4 h-4 text-primary" /></div></div>
                      )}
                    </CardContent></Card>
                    <Card><CardContent className="pt-5 pb-4 px-5">
                      {loadingResult ? <div className="space-y-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-16" /></div> : (
                        <div className="flex items-start justify-between gap-2"><div>
                          <div className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-1">Range Trades</div>
                          <div className={`text-2xl font-bold leading-tight ${stats && stats.rangePnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}`} data-testid="value-range-trades">{stats ? `${stats.rangeTrades}` : "--"}</div>
                          {stats && <div className="text-xs text-muted-foreground mt-0.5">Win {stats.rangeWinRate}% · ${stats.rangePnl.toFixed(0)}</div>}
                        </div><div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5"><Activity className="w-4 h-4 text-primary" /></div></div>
                      )}
                    </CardContent></Card>
                    <Card><CardContent className="pt-5 pb-4 px-5">
                      {loadingResult ? <div className="space-y-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-16" /></div> : (
                        <div className="flex items-start justify-between gap-2"><div>
                          <div className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-1">Trend Trades</div>
                          <div className={`text-2xl font-bold leading-tight ${stats && stats.trendPnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}`} data-testid="value-trend-trades">{stats ? `${stats.trendTrades}` : "--"}</div>
                          {stats && <div className="text-xs text-muted-foreground mt-0.5">Win {stats.trendWinRate}% · ${stats.trendPnl.toFixed(0)}</div>}
                        </div><div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5"><TrendingUp className="w-4 h-4 text-primary" /></div></div>
                      )}
                    </CardContent></Card>
                    <Card><CardContent className="pt-5 pb-4 px-5">
                      {loadingResult ? <div className="space-y-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-16" /></div> : (
                        <div className="flex items-start justify-between gap-2"><div>
                          <div className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-1">No-Trade Bars</div>
                          <div className="text-2xl font-bold leading-tight" data-testid="value-no-trade-bars">{stats ? `${stats.noTradeBarCount.toLocaleString()}` : "--"}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">Bars filtered out</div>
                        </div><div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5"><Ban className="w-4 h-4 text-primary" /></div></div>
                      )}
                    </CardContent></Card>
                  </div>

                  {fullResult?.diagnostics && (
                    <Card>
                      <CardHeader className="pb-2 flex flex-row items-center gap-2">
                        <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                          <Search className="w-3.5 h-3.5 text-primary" />
                        </div>
                        <div>
                          <CardTitle className="text-base">Filter Diagnostics</CardTitle>
                          <CardDescription className="text-xs">Where bars are being blocked in the decision chain</CardDescription>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                          {[
                            { label: "Session Block", value: fullResult.diagnostics.blockedBySession, color: "text-muted-foreground" },
                            { label: "News Block", value: fullResult.diagnostics.blockedByNews, color: "text-muted-foreground" },
                            { label: "Gap Block", value: fullResult.diagnostics.blockedByGap, color: "text-muted-foreground" },
                            { label: "Midpoint Block", value: fullResult.diagnostics.blockedByMidpointBand, color: "text-amber-600 dark:text-amber-400" },
                            { label: "Retest Dist Block", value: fullResult.diagnostics.blockedByRetestDistance, color: "text-amber-600 dark:text-amber-400" },
                            { label: "Narrow Range Block", value: fullResult.diagnostics.blockedByNarrowRange, color: "text-amber-600 dark:text-amber-400" },
                            { label: "Extreme ATR Block", value: fullResult.diagnostics.blockedByExtremeATR, color: "text-amber-600 dark:text-amber-400" },
                            { label: "Wick Ratio Block", value: fullResult.diagnostics.blockedByWickRatio, color: "text-amber-600 dark:text-amber-400" },
                            { label: "Compression Block", value: fullResult.diagnostics.blockedByCompression, color: "text-amber-600 dark:text-amber-400" },
                            { label: "Expansion Block", value: fullResult.diagnostics.blockedByExpansion, color: "text-amber-600 dark:text-amber-400" },
                            { label: "Peak Hours Block", value: fullResult.diagnostics.blockedByPeakHours || 0, color: "text-muted-foreground" },
                            { label: "Avoid Hours Block", value: fullResult.diagnostics.blockedByAvoidHours || 0, color: "text-muted-foreground" },
                            { label: "Volume Profile Block", value: fullResult.diagnostics.blockedByVolumeProfile || 0, color: "text-purple-600 dark:text-purple-400" },
                            { label: "Max Trades/Day", value: fullResult.diagnostics.blockedByMaxTradesPerDay, color: "text-muted-foreground" },
                            { label: "Max Drawdown", value: fullResult.diagnostics.blockedByMaxDrawdown, color: "text-destructive" },
                            { label: "Daily Loss Limit", value: fullResult.diagnostics.blockedByDailyLossLimit, color: "text-destructive" },
                            { label: "Consec Loss Pause", value: fullResult.diagnostics.blockedByConsecutiveLossLimit, color: "text-destructive" },
                            { label: "Reduced Size (Loss)", value: fullResult.diagnostics.reducedSizeAfterLossCount, color: "text-amber-600 dark:text-amber-400" },
                            { label: "ATR Risk Scaled", value: fullResult.diagnostics.atrScaledRiskCount, color: "text-amber-600 dark:text-amber-400" },
                            { label: "2nd Trade Reduced", value: fullResult.diagnostics.secondTradeReducedRiskCount, color: "text-amber-600 dark:text-amber-400" },
                            { label: "Buy Candidates", value: fullResult.diagnostics.buyCandidates, color: "text-emerald-600 dark:text-emerald-400" },
                            { label: "Sell Candidates", value: fullResult.diagnostics.sellCandidates, color: "text-red-500 dark:text-red-400" },
                            { label: "Accepted Buys", value: fullResult.diagnostics.acceptedBuyTrades, color: "text-emerald-600 dark:text-emerald-400" },
                            { label: "Accepted Sells", value: fullResult.diagnostics.acceptedSellTrades, color: "text-red-500 dark:text-red-400" },
                          ].map(({ label, value, color }) => (
                            <div key={label} className="bg-muted/40 rounded-md p-2.5" data-testid={`diag-${label.toLowerCase().replace(/[\s\/]/g, "-")}`}>
                              <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
                              <div className={`text-lg font-bold font-mono ${color}`}>{(value ?? 0).toLocaleString()}</div>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    <Card className="lg:col-span-2">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-base">Equity Curve</CardTitle>
                        <CardDescription className="text-xs">Balance over time</CardDescription>
                      </CardHeader>
                      <CardContent>
                        {loadingResult ? <Skeleton className="h-52 w-full" /> : (
                          <ResponsiveContainer width="100%" height={208}>
                            <AreaChart data={fullResult?.equityCurve} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                              <defs>
                                <linearGradient id="balGrad" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%" stopColor="hsl(43,84%,45%)" stopOpacity={0.25} />
                                  <stop offset="95%" stopColor="hsl(43,84%,45%)" stopOpacity={0} />
                                </linearGradient>
                              </defs>
                              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                              <XAxis dataKey="time" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                                tickFormatter={(v) => v?.substring(5, 10) ?? ""} interval="preserveStartEnd" />
                              <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                                tickFormatter={(v) => `$${v}`} width={52} />
                              <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: "6px", fontSize: 12 }}
                                formatter={(val: number) => [`$${val.toLocaleString()}`, "Balance"]} />
                              <Area type="monotone" dataKey="balance" stroke="hsl(43,84%,45%)" strokeWidth={2} fill="url(#balGrad)" dot={false} />
                            </AreaChart>
                          </ResponsiveContainer>
                        )}
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-base">Regime Classification</CardTitle>
                        <CardDescription className="text-xs">H1 bars by regime</CardDescription>
                      </CardHeader>
                      <CardContent>
                        {loadingResult ? <Skeleton className="h-52 w-full" /> : (
                          <ResponsiveContainer width="100%" height={208}>
                            <PieChart>
                              <Pie data={regimePie} cx="50%" cy="45%" outerRadius={68} dataKey="value"
                                label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                                labelLine={false} fontSize={10}>
                                {regimePie.map((e, i) => <Cell key={i} fill={e.fill} />)}
                              </Pie>
                              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                            </PieChart>
                          </ResponsiveContainer>
                        )}
                      </CardContent>
                    </Card>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-base">Trades by Regime</CardTitle>
                      </CardHeader>
                      <CardContent>
                        {loadingResult ? <Skeleton className="h-36 w-full" /> : (
                          <ResponsiveContainer width="100%" height={140}>
                            <PieChart>
                              <Pie data={regimeTradePie} cx="50%" cy="50%" outerRadius={55} dataKey="value"
                                label={({ name, value }) => `${name}: ${value}`} labelLine={false} fontSize={11}>
                                {regimeTradePie.map((e, i) => <Cell key={i} fill={e.fill} />)}
                              </Pie>
                            </PieChart>
                          </ResponsiveContainer>
                        )}
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-base">Monthly P&L</CardTitle>
                      </CardHeader>
                      <CardContent>
                        {loadingResult ? <Skeleton className="h-36 w-full" /> : (
                          <ResponsiveContainer width="100%" height={140}>
                            <BarChart data={fullResult?.monthlyReturns} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                              <XAxis dataKey="month" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                                tickFormatter={(v) => v?.substring(5) ?? ""} />
                              <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(v) => `${v}%`} width={32} />
                              <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: "6px", fontSize: 12 }}
                                formatter={(val: number) => [`${val.toFixed(2)}%`, "Return"]} />
                              <Bar dataKey="return" radius={[3, 3, 0, 0]}>
                                {(fullResult?.monthlyReturns ?? []).map((m, i) => (
                                  <Cell key={i} fill={m.return >= 0 ? "hsl(43,84%,45%)" : "hsl(0,62%,50%)"} />
                                ))}
                              </Bar>
                            </BarChart>
                          </ResponsiveContainer>
                        )}
                      </CardContent>
                    </Card>
                  </div>

                  {recentTrades.length > 0 && (
                    <Card>
                      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2">
                        <div>
                          <CardTitle className="text-base">Recent Trades</CardTitle>
                          <CardDescription className="text-xs">Last 10 closed positions</CardDescription>
                        </div>
                        <Button variant="outline" size="sm" asChild data-testid="button-view-all-trades">
                          <Link href="/trades">View All <ArrowRight className="w-3 h-3 ml-1" /></Link>
                        </Button>
                      </CardHeader>
                      <CardContent>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b text-xs text-muted-foreground">
                                <th className="text-left pb-2 font-medium">Date</th>
                                <th className="text-left pb-2 font-medium">Side</th>
                                <th className="text-left pb-2 font-medium">Regime</th>
                                <th className="text-left pb-2 font-medium">Reason</th>
                                <th className="text-right pb-2 font-medium">Entry</th>
                                <th className="text-right pb-2 font-medium">Exit</th>
                                <th className="text-right pb-2 font-medium">P&L</th>
                                <th className="text-right pb-2 font-medium">R</th>
                              </tr>
                            </thead>
                            <tbody>
                              {recentTrades.map((trade) => (
                                <tr key={trade.id} className="border-b last:border-0" data-testid={`row-trade-${trade.id.slice(0, 8)}`}>
                                  <td className="py-2 text-muted-foreground text-xs">{trade.exitTime.substring(0, 10)}</td>
                                  <td className="py-2">
                                    <Badge variant="outline" className={`text-xs ${trade.side === "buy" ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "border-red-500/40 text-red-600 dark:text-red-400"}`}>
                                      {trade.side === "buy" ? "Buy" : "Sell"}
                                    </Badge>
                                  </td>
                                  <td className="py-2">
                                    <Badge variant="outline" className={`text-xs ${trade.regime === "trend" ? "border-amber-500/40 text-amber-600 dark:text-amber-400" : "border-blue-500/40 text-blue-600 dark:text-blue-400"}`}>
                                      {trade.regime}
                                    </Badge>
                                  </td>
                                  <td className="py-2 text-xs text-muted-foreground">{trade.entryReason.replace(/_/g, " ")}</td>
                                  <td className="py-2 text-right font-mono text-xs">{trade.entryPrice.toFixed(2)}</td>
                                  <td className="py-2 text-right font-mono text-xs">{trade.exitPrice.toFixed(2)}</td>
                                  <td className={`py-2 text-right font-mono text-xs font-medium ${trade.pnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}`}>
                                    {trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}
                                  </td>
                                  <td className={`py-2 text-right font-mono text-xs ${trade.resultR >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}`}>
                                    {trade.resultR >= 0 ? "+" : ""}{trade.resultR}R
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {backtests && backtests.length > 0 && (
          <Card className="mt-6">
            <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Clock className="w-4 h-4" />
                  Backtest History
                </CardTitle>
                <CardDescription className="text-xs">{backtests.length} saved results — click to view, compare, or delete</CardDescription>
              </div>
              {selectedResultId && (
                <Button variant="outline" size="sm" onClick={() => { setSelectedResultId(null); setUserManuallySelected(false); }} data-testid="button-view-latest">
                  View Latest
                </Button>
              )}
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="text-left pb-2 font-medium">Run Date</th>
                      <th className="text-left pb-2 font-medium">Test Period</th>
                      <th className="text-left pb-2 font-medium">Source</th>
                      <th className="text-right pb-2 font-medium">Trades</th>
                      <th className="text-right pb-2 font-medium">Win%</th>
                      <th className="text-right pb-2 font-medium">PF</th>
                      <th className="text-right pb-2 font-medium">Return</th>
                      <th className="text-right pb-2 font-medium">Max DD</th>
                      <th className="text-right pb-2 font-medium">RR</th>
                      <th className="text-right pb-2 font-medium">Risk%</th>
                      <th className="text-center pb-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backtests.map((bt) => {
                      const isActive = bt.id === activeResultId;
                      return (
                        <tr
                          key={bt.id}
                          className={`border-b last:border-0 cursor-pointer transition-colors ${isActive ? "bg-primary/5 border-primary/20" : "hover:bg-muted/50"}`}
                          onClick={() => { setSelectedResultId(bt.id); setUserManuallySelected(true); }}
                          data-testid={`row-backtest-${bt.id.slice(0, 8)}`}
                        >
                          <td className="py-2 text-muted-foreground text-xs font-mono">
                            {new Date(bt.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </td>
                          <td className="py-2 text-muted-foreground text-xs" data-testid={`text-period-${bt.id.slice(0, 8)}`}>
                            {(() => {
                              const s = bt.config.startDate;
                              const e = bt.config.endDate;
                              const fmt = (d: string) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
                              if (s && e) {
                                const diffD = Math.round((new Date(e).getTime() - new Date(s).getTime()) / 86400000);
                                const months = Math.round(diffD / 30);
                                return <span className="whitespace-nowrap">{fmt(s)} — {fmt(e)} <span className="text-muted-foreground/60">({months}mo)</span></span>;
                              }
                              if (s) return <span className="whitespace-nowrap">{fmt(s)} — now</span>;
                              if (e) return <span className="whitespace-nowrap">start — {fmt(e)}</span>;
                              return "Full range";
                            })()}
                          </td>
                          <td className="py-2">
                            <Badge variant="outline" className={`text-xs ${bt.dataSource === "real" ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "border-amber-500/40 text-amber-600 dark:text-amber-400"}`}>
                              {bt.dataSource === "real" ? "Real" : "Synth"}
                            </Badge>
                          </td>
                          <td className="py-2 text-right font-mono text-xs">{bt.tradeCount}</td>
                          <td className="py-2 text-right font-mono text-xs">{bt.stats.winRate}%</td>
                          <td className="py-2 text-right font-mono text-xs">{bt.stats.profitFactor}</td>
                          <td className={`py-2 text-right font-mono text-xs font-medium ${bt.stats.returnPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}`}>
                            {bt.stats.returnPct >= 0 ? "+" : ""}{bt.stats.returnPct}%
                          </td>
                          <td className={`py-2 text-right font-mono text-xs ${bt.stats.maxDrawdownPct <= 20 ? "text-emerald-600 dark:text-emerald-400" : bt.stats.maxDrawdownPct <= 40 ? "text-amber-600 dark:text-amber-400" : "text-red-500 dark:text-red-400"}`}>
                            {bt.stats.maxDrawdownPct}%
                          </td>
                          <td className="py-2 text-right font-mono text-xs">{bt.config.rewardRatio}:1</td>
                          <td className="py-2 text-right font-mono text-xs">{bt.config.riskPerTradePct ?? "-"}%</td>
                          <td className="py-2 text-center">
                            <div className="flex items-center justify-center gap-1">
                              {isActive && <Eye className="w-3.5 h-3.5 text-primary" />}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0 text-muted-foreground hover:text-emerald-600"
                                title="Load into backtest form"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleImplement(bt.config as any);
                                }}
                                data-testid={`button-implement-${bt.id.slice(0, 8)}`}
                              >
                                <Rocket className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0 text-muted-foreground hover:text-orange-500"
                                title="Apply to live trading"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (confirm("Apply this strategy's parameters to live trading? This will update the locked params used by the live trader.")) {
                                    applyToLiveMutation.mutate(bt.config as any);
                                  }
                                }}
                                data-testid={`button-apply-live-${bt.id.slice(0, 8)}`}
                              >
                                <Zap className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0 text-muted-foreground hover:text-blue-600"
                                title="Save as strategy"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  saveStrategyMutation.mutate(bt);
                                }}
                                data-testid={`button-save-strategy-${bt.id.slice(0, 8)}`}
                              >
                                <Save className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                                title="Archive backtest"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (confirm("Archive this backtest? It will be preserved in the archive for future reference.")) {
                                    deleteMutation.mutate(bt.id);
                                  }
                                }}
                                data-testid={`button-archive-${bt.id.slice(0, 8)}`}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Archive & Changelog Section */}
        <div className="flex gap-2 mt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowArchive(!showArchive)}
            data-testid="button-toggle-archive"
          >
            {showArchive ? <ChevronDown className="w-4 h-4 mr-1" /> : <ChevronRight className="w-4 h-4 mr-1" />}
            <Archive className="w-4 h-4 mr-1" />
            Archive ({archivedBacktests?.length ?? "..."})
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowChangelog(!showChangelog)}
            data-testid="button-toggle-changelog"
          >
            {showChangelog ? <ChevronDown className="w-4 h-4 mr-1" /> : <ChevronRight className="w-4 h-4 mr-1" />}
            <BookOpen className="w-4 h-4 mr-1" />
            Strategy Changelog
          </Button>
        </div>

        {showArchive && (
          <Card className="mt-2">
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <Archive className="w-4 h-4" />
                Archived Backtests
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {!archivedBacktests?.length ? (
                <p className="text-xs text-muted-foreground">No archived backtests yet. Backtests you remove are preserved here.</p>
              ) : (
                <div className="overflow-auto max-h-60">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-muted-foreground">
                        <th className="text-left py-1 px-2">Date</th>
                        <th className="text-right py-1 px-2">Return</th>
                        <th className="text-right py-1 px-2">DD</th>
                        <th className="text-right py-1 px-2">Trades</th>
                        <th className="text-right py-1 px-2">WR</th>
                        <th className="text-left py-1 px-2">Reason</th>
                        <th className="text-right py-1 px-2">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {archivedBacktests.map((bt: any) => (
                        <tr key={bt.id} className="border-b border-muted/30 hover:bg-muted/20">
                          <td className="py-1 px-2">{new Date(bt.createdAt).toLocaleDateString()}</td>
                          <td className="py-1 px-2 text-right font-mono">{Number(bt.stats?.returnPct ?? 0).toFixed(1)}%</td>
                          <td className="py-1 px-2 text-right font-mono">{Number(bt.stats?.maxDrawdownPct ?? 0).toFixed(1)}%</td>
                          <td className="py-1 px-2 text-right">{bt.stats?.totalTrades ?? 0}</td>
                          <td className="py-1 px-2 text-right">{Number(bt.stats?.winRate ?? 0).toFixed(0)}%</td>
                          <td className="py-1 px-2 text-muted-foreground">{bt.archiveReason || "—"}</td>
                          <td className="py-1 px-2 text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-xs"
                              onClick={() => restoreMutation.mutate(bt.id)}
                              data-testid={`button-restore-${bt.id?.slice(0, 8)}`}
                            >
                              <RotateCcw className="w-3 h-3 mr-1" /> Restore
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {showChangelog && (
          <Card className="mt-2">
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <BookOpen className="w-4 h-4" />
                Strategy Evolution Log
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {!changelog?.length ? (
                <p className="text-xs text-muted-foreground">No changelog entries yet. Every backtest you run will be recorded here.</p>
              ) : (
                <div className="overflow-auto max-h-80 space-y-2">
                  {changelog.map((entry: any, i: number) => (
                    <div key={entry.id || i} className="border rounded p-2 text-xs bg-muted/10">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-foreground">
                          {entry.action === "backtest_saved" ? "Backtest Saved" :
                           entry.action === "params_changed" ? "Params Changed" :
                           entry.action}
                        </span>
                        <span className="text-muted-foreground">
                          {new Date(entry.created_at || entry.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <p className="text-muted-foreground mt-1">{entry.description}</p>
                      {entry.previous_best_stats && (() => {
                        const pbs = typeof entry.previous_best_stats === 'string' ? JSON.parse(entry.previous_best_stats) : entry.previous_best_stats;
                        return (
                          <p className="text-muted-foreground mt-1 italic">
                            Previous best: {Number(pbs?.returnPct ?? 0).toFixed(1)}% return, {Number(pbs?.maxDrawdownPct ?? 0).toFixed(1)}% DD
                          </p>
                        );
                      })()}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
