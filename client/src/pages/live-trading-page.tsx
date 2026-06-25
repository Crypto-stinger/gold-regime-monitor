import { useState, useEffect, useRef, useMemo, useCallback, memo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { PageGuide } from "@/components/page-guide";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  Wifi, WifiOff, Play, Square, RefreshCw, TrendingUp, TrendingDown,
  AlertTriangle, CheckCircle, Loader2, ArrowUpDown, Shield,
  Activity, DollarSign, BarChart3, Clock, Zap, Target,
  ChevronDown, ChevronUp, Eye, EyeOff, Calendar,
  CircleDot, Radio, Gauge, FlaskConical, Brain, BarChart2, History
} from "lucide-react";

interface TradeLog {
  timestamp: string;
  type: "signal" | "order" | "close" | "info" | "warning" | "error" | "regime";
  message: string;
  details?: any;
}

interface Position {
  positionId: number;
  symbolId: number;
  tradeSide: number;
  volume: number;
  entryPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  unrealizedPnl: number;
  openTimestamp: number;
}

interface LiveStatus {
  connected: boolean;
  connection: {
    connected: boolean;
    authenticated: boolean;
    accountAuthed: boolean;
    positions: Position[];
    lastSpot: { bid: number; ask: number; timestamp: number } | null;
    symbolId: number;
    balance: number | null;
    leverage: number | null;
  } | null;
  trader: {
    running: boolean;
    connected: boolean;
    regime: string;
    currentPrice: number;
    positions: Position[];
    dailyPnl: number;
    totalPnl: number;
    balance: number;
    tradestoday: number;
    consecutiveLosses: number;
    logs: TradeLog[];
    params: Record<string, any>;
    lastUpdate: string;
  } | null;
  tradeCounts?: { today: number; thisWeek: number; thisMonth: number; allTime: number; pnlToday: number; pnlThisWeek: number; pnlThisMonth: number; pnlAllTime: number };
  startingBalance?: number;
  accountPnl?: number;
  gvz?: { value: number; date: string; percentile: number };
  cot?: { netPosition: number; noncommLong: number; noncommShort: number; openInterest: number; date: string; percentile: number; sentiment: string };
  hmm?: { trained: boolean; currentState: string | null; confidence: number | null; trainingSamples: number; states: Record<string, number> | null };
  mrsGarch?: { trained: boolean; garchVolatility: number | null; annualizedVol: number | null; volForecast: number | null; volPercentile: number | null; regimeStability: number | null; positionSizeMultiplier: number | null; regimeCount: number };
}

const PnlValue = memo(function PnlValue({ value, size = "md", prefix = "$" }: { value: number; size?: "sm" | "md" | "lg" | "xl"; prefix?: string }) {
  const isPositive = value >= 0;
  const sizeClasses = {
    sm: "text-sm",
    md: "text-lg",
    lg: "text-2xl",
    xl: "text-3xl",
  };
  return (
    <span className={`font-mono font-bold transition-colors duration-300 ${sizeClasses[size]} ${isPositive ? "text-[#00ff88]" : "text-[#ff4466]"}`}>
      {isPositive ? "+" : ""}{prefix}{value.toFixed(2)}
    </span>
  );
});

function GlowDot({ color, pulse = false }: { color: string; pulse?: boolean }) {
  return (
    <span className="relative inline-flex h-2.5 w-2.5">
      {pulse && <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping`} style={{ backgroundColor: color }} />}
      <span className="relative inline-flex rounded-full h-2.5 w-2.5" style={{ backgroundColor: color }} />
    </span>
  );
}

const StatCard = memo(function StatCard({ label, value, icon: Icon, color = "#00e5ff", subValue, testId }: {
  label: string; value: string | number; icon: any; color?: string; subValue?: string; testId: string;
}) {
  return (
    <div className="lt-card group" data-testid={testId}>
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4" style={{ color }} />
        <span className="text-xs uppercase tracking-wider text-[#8899aa]">{label}</span>
      </div>
      <div className="font-mono font-bold text-xl text-white lt-value">{value}</div>
      {subValue && <div className="text-xs text-[#667788] mt-1 font-mono lt-value">{subValue}</div>}
    </div>
  );
});

const PnlPeriodCard = memo(function PnlPeriodCard({ label, value, trades, testId }: {
  label: string; value: number; trades: number; testId: string;
}) {
  const isPositive = value >= 0;
  return (
    <div className="lt-card" data-testid={testId}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs uppercase tracking-wider text-[#8899aa]">{label}</span>
        {value !== 0 && (
          <Badge className={`text-[10px] px-1.5 py-0 border-0 font-mono ${isPositive ? "bg-[#00ff88]/10 text-[#00ff88]" : "bg-[#ff4466]/10 text-[#ff4466]"}`}>
            {isPositive ? "PROFIT" : "LOSS"}
          </Badge>
        )}
      </div>
      <PnlValue value={value} size="lg" />
      <div className="flex items-center gap-4 mt-3 text-xs font-mono">
        <span className="text-[#8899aa]">
          <span className="text-[#00e5ff]">{trades}</span> trades
        </span>
      </div>
    </div>
  );
});

const PositionRow = memo(function PositionRow({ pos }: { pos: Position }) {
  const isBuy = pos.tradeSide === 1;
  const pnl = pos.unrealizedPnl || 0;
  return (
    <div className="flex items-center justify-between p-3 rounded-lg"
      style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}
      data-testid={`row-position-${pos.positionId}`}>
      <div className="flex items-center gap-3">
        <Badge className={`text-[10px] font-mono font-bold border-0 px-2 ${isBuy ? "bg-[#00ff88]/15 text-[#00ff88]" : "bg-[#ff4466]/15 text-[#ff4466]"}`}>
          {isBuy ? "LONG" : "SHORT"}
        </Badge>
        <div>
          <span className="font-mono text-sm text-white">XAUUSD</span>
          <span className="font-mono text-xs text-[#667788] ml-2">Vol: {(pos.volume / 100).toFixed(2)}</span>
        </div>
        <span className="font-mono text-sm text-[#8899aa]">@ {pos.entryPrice.toFixed(2)}</span>
      </div>
      <div className="flex items-center gap-4 text-xs font-mono">
        {pos.stopLoss && <span className="text-[#ff4466]">SL {pos.stopLoss.toFixed(2)}</span>}
        {pos.takeProfit && <span className="text-[#00ff88]">TP {pos.takeProfit.toFixed(2)}</span>}
        <PnlValue value={pnl} size="sm" />
      </div>
    </div>
  );
});

const LogEntry = memo(function LogEntry({ log, index, color }: { log: TradeLog; index: number; color: string }) {
  const time = new Date(log.timestamp).toLocaleTimeString("en-US", { hour12: false });
  return (
    <div className="py-0.5 hover:bg-white/[0.02] px-1 rounded" data-testid={`log-entry-${index}`}>
      <span className="text-[#334455]">{time}</span>{" "}
      <span className="inline-block w-16 text-right" style={{ color }}>[{log.type}]</span>{" "}
      <span style={{ color: color + "cc" }}>{log.message}</span>
    </div>
  );
});

const logColors: Record<string, string> = {
  error: "#ff4466",
  warning: "#ffaa00",
  signal: "#00e5ff",
  order: "#bb77ff",
  regime: "#ff66aa",
  close: "#00ff88",
  info: "#667788",
};

const regimeConfig: Record<string, { color: string; bg: string; icon: any; label: string }> = {
  trend: { color: "#00ff88", bg: "rgba(0,255,136,0.08)", icon: TrendingUp, label: "TRENDING" },
  range: { color: "#00e5ff", bg: "rgba(0,229,255,0.08)", icon: ArrowUpDown, label: "RANGING" },
  no_trade: { color: "#ff66aa", bg: "rgba(255,102,170,0.08)", icon: AlertTriangle, label: "NO TRADE" },
};

export default function LiveTradingPage() {
  const { toast } = useToast();
  const logsEndRef = useRef<HTMLDivElement>(null);
  const [showParams, setShowParams] = useState(false);
  const [showHealth, setShowHealth] = useState(false);
  const [credentials, setCredentials] = useState({
    clientId: "",
    clientSecret: "",
    accessToken: "",
    accountId: "",
    isLive: false,
  });

  const { data: credStatus } = useQuery<{
    hasClientId: boolean;
    hasClientSecret: boolean;
    hasAccessToken: boolean;
    hasAccountId: boolean;
    allConfigured: boolean;
  }>({
    queryKey: ["/api/live-trading/credentials-status"],
    staleTime: 60000,
  });

  const serverCredsReady = credStatus?.allConfigured || false;

  useEffect(() => {
    if (serverCredsReady) {
      setCredentials(prev => ({ ...prev, isLive: false }));
    }
  }, [serverCredsReady]);

  const { data: status, refetch: refetchStatus } = useQuery<LiveStatus>({
    queryKey: ["/api/live-trading/status"],
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });

  const { data: healthData } = useQuery<{
    running: boolean;
    lastCycle: string | null;
    checks: { name: string; status: "ok" | "warn" | "error"; message: string; lastChecked: string }[];
    recentEvents: { timestamp: string; source: string; severity: string; message: string }[];
    recentFixes: { timestamp: string; action: string; result: string }[];
    reconnectAttempts: number;
    dataRefreshAttempts: number;
  }>({
    queryKey: ["/api/system/health"],
    refetchInterval: 30000,
  });

  type LiveTrade = {
    id: number;
    opened_at: string;
    closed_at: string | null;
    side: string;
    entry_price: string;
    exit_price: string | null;
    volume: string;
    stop_loss: string | null;
    take_profit: string | null;
    pnl: string | null;
    status: string;
    regime: string | null;
    source: string;
    ctrader_position_id: string | null;
    notes: string | null;
  };

  type LiveTradeStats = {
    total: number;
    wins: number;
    losses: number;
    open: number;
    totalPnl: number;
    winRate: number;
  };

  const { data: liveTradeData, refetch: refetchTrades } = useQuery<{ trades: LiveTrade[]; stats: LiveTradeStats; count: number }>({
    queryKey: ["/api/live-trading/ctrader-deals"],
    refetchInterval: 30000,
  });

  const [showAddTrade, setShowAddTrade] = useState(false);
  const [newTrade, setNewTrade] = useState({
    side: "buy" as "buy" | "sell",
    entryPrice: "",
    exitPrice: "",
    pnl: "",
    openedAt: "",
    closedAt: "",
    regime: "trend",
    notes: "",
  });

  const prevLogsLen = useRef(0);
  useEffect(() => {
    const curLen = status?.trader?.logs?.length || 0;
    if (curLen > prevLogsLen.current) {
      logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevLogsLen.current = curLen;
  }, [status?.trader?.logs?.length]);

  const connectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/live-trading/connect", credentials);
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Connected to cTrader", description: `Account ${data.accountId} | Balance: $${data.balance} | XAUUSD ID: ${data.symbolId}` });
      queryClient.invalidateQueries({ queryKey: ["/api/live-trading/status"] });
    },
    onError: (err: Error) => {
      toast({ title: "Connection failed", description: err.message, variant: "destructive" });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/live-trading/disconnect");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Disconnected" });
      queryClient.invalidateQueries({ queryKey: ["/api/live-trading/status"] });
    },
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/live-trading/start");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Live trader started" });
      queryClient.invalidateQueries({ queryKey: ["/api/live-trading/status"] });
    },
    onError: (err: Error) => {
      toast({ title: "Start failed", description: err.message, variant: "destructive" });
    },
  });

  const stopMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/live-trading/stop");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Live trader stopped" });
      queryClient.invalidateQueries({ queryKey: ["/api/live-trading/status"] });
    },
  });

  const [testTradeResult, setTestTradeResult] = useState<{ success: boolean; logs: string[] } | null>(null);

  const testTradeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/live-trading/test-trade");
      return res.json();
    },
    onSuccess: (data) => {
      setTestTradeResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/live-trading/status"] });
      toast({
        title: data.success ? "Test trade pipeline verified" : "Test trade failed",
        description: data.logs?.[data.logs.length - 1] || "Check logs for details",
        variant: data.success ? "default" : "destructive",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Test trade failed", description: err.message, variant: "destructive" });
    },
  });

  const isConnected = status?.connected || false;
  const isRunning = status?.trader?.running || false;

  const derived = useMemo(() => {
    const regime = status?.trader?.regime || "no_trade";
    const currentPrice = status?.trader?.currentPrice || status?.connection?.lastSpot?.bid || 0;
    const positions = status?.trader?.positions || status?.connection?.positions || [];
    const logs = status?.trader?.logs || [];
    const params = status?.trader?.params;
    const balance = status?.connection?.balance || status?.trader?.balance || 0;
    const leverage = status?.connection?.leverage || 0;
    const dailyPnl = status?.trader?.dailyPnl || 0;
    const totalPnl = status?.trader?.totalPnl || 0;
    const liveTradeCount = liveTradeData?.stats?.total || 0;
    const tradesToday = status?.tradeCounts?.today || status?.trader?.tradestoday || 0;
    const tradesThisWeek = status?.tradeCounts?.thisWeek || tradesToday;
    const tradesThisMonth = status?.tradeCounts?.thisMonth || tradesToday;
    const tradesAllTime = Math.max(liveTradeCount, status?.tradeCounts?.allTime || 0);
    const consecutiveLosses = status?.trader?.consecutiveLosses || 0;
    const bid = status?.connection?.lastSpot?.bid || currentPrice;
    const ask = status?.connection?.lastSpot?.ask || currentPrice;
    const spread = bid > 0 && ask > 0 ? ((ask - bid) * 100).toFixed(1) : "—";
    const rc = regimeConfig[regime] || regimeConfig.no_trade;
    const maxDD = params?.maxDrawdownPct || 25;
    const currentDD = totalPnl < 0 ? Math.abs(totalPnl) : 0;
    const ddPercent = Math.min(100, (currentDD / (maxDD * 10)) * 100);
    const maxDailyLoss = params?.maxDailyLossPct || 2;
    const dailyLossPercent = dailyPnl < 0 ? Math.min(100, (Math.abs(dailyPnl) / (maxDailyLoss * 10)) * 100) : 0;
    const lastUpdate = status?.trader?.lastUpdate;
    const gvzValue = status?.gvz?.value ?? null;
    const gvzPercentile = status?.gvz?.percentile ?? null;
    const gvzDate = status?.gvz?.date ?? null;
    const cotNetPosition = status?.cot?.netPosition ?? null;
    const cotPercentile = status?.cot?.percentile ?? null;
    const cotDate = status?.cot?.date ?? null;
    const cotSentiment = status?.cot?.sentiment ?? null;
    const hmmTrained = status?.hmm?.trained ?? false;
    const hmmState = status?.hmm?.currentState ?? null;
    const hmmConfidence = status?.hmm?.confidence ?? null;
    const hmmSamples = status?.hmm?.trainingSamples ?? 0;

    const garchTrained = status?.mrsGarch?.trained ?? false;
    const garchVol = status?.mrsGarch?.annualizedVol ?? null;
    const garchForecast = status?.mrsGarch?.volForecast ?? null;
    const garchPercentile = status?.mrsGarch?.volPercentile ?? null;
    const garchMultiplier = status?.mrsGarch?.positionSizeMultiplier ?? null;
    const garchStability = status?.mrsGarch?.regimeStability ?? null;
    const pnlToday = status?.tradeCounts?.pnlToday || 0;
    const pnlThisWeek = status?.tradeCounts?.pnlThisWeek || 0;
    const pnlThisMonth = status?.tradeCounts?.pnlThisMonth || 0;
    const pnlAllTime = status?.tradeCounts?.pnlAllTime || 0;
    const startingBalance = status?.startingBalance || 3000;
    const accountPnl = (status?.accountPnl && status.accountPnl !== 0) ? status.accountPnl : (balance > 0 ? balance - startingBalance : 0);

    return {
      regime, currentPrice, positions, logs, params, dailyPnl, totalPnl,
      tradesToday, tradesThisWeek, tradesThisMonth, tradesAllTime,
      consecutiveLosses, bid, ask, spread, rc, maxDD,
      currentDD, ddPercent, maxDailyLoss, dailyLossPercent, lastUpdate,
      balance, leverage, gvzValue, gvzPercentile, gvzDate,
      cotNetPosition, cotPercentile, cotDate, cotSentiment,
      hmmTrained, hmmState, hmmConfidence, hmmSamples,
      garchTrained, garchVol, garchForecast, garchPercentile, garchMultiplier, garchStability,
      pnlToday, pnlThisWeek, pnlThisMonth, pnlAllTime,
      accountPnl, startingBalance,
    };
  }, [status, liveTradeData]);

  const {
    regime, positions, logs, params, dailyPnl, totalPnl,
    tradesToday, tradesThisWeek, tradesThisMonth, tradesAllTime,
    consecutiveLosses, bid, ask, spread, rc, maxDD,
    currentDD, ddPercent, maxDailyLoss, dailyLossPercent, lastUpdate,
    balance, leverage, gvzValue, gvzPercentile, gvzDate,
    cotNetPosition, cotPercentile, cotDate, cotSentiment,
    hmmTrained, hmmState, hmmConfidence, hmmSamples,
    garchTrained, garchVol, garchForecast, garchPercentile, garchMultiplier, garchStability,
    pnlToday, pnlThisWeek, pnlThisMonth, pnlAllTime,
    accountPnl, startingBalance,
  } = derived;

  const RegimeIcon = rc.icon;

  return (
    <div className="h-full overflow-y-auto lt-page">
      <div className="max-w-[1600px] mx-auto p-4 space-y-4">

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg, #00e5ff22, #bb77ff22)", border: "1px solid #00e5ff33" }}>
                <Activity className="w-5 h-5 text-[#00e5ff]" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-white tracking-tight" data-testid="text-page-title">
                  LIVE TRADING <span className="text-[#00e5ff]">ENGINE</span>
                </h1>
                <p className="text-xs text-[#556677] font-mono">XAUUSD • cTrader Open API • Cloud Execution</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {isRunning && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full" style={{ background: "rgba(0,255,136,0.08)", border: "1px solid rgba(0,255,136,0.2)" }}>
                <GlowDot color="#00ff88" pulse />
                <span className="text-xs font-mono font-bold text-[#00ff88]" data-testid="badge-running">TRADING LIVE</span>
              </div>
            )}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full transition-colors duration-500" style={{
              background: isConnected ? "rgba(0,229,255,0.08)" : "rgba(255,102,170,0.06)",
              border: `1px solid ${isConnected ? "rgba(0,229,255,0.2)" : "rgba(255,102,170,0.15)"}`,
            }}>
              <GlowDot color={isConnected ? "#00e5ff" : "#ff66aa"} pulse={isConnected} />
              <span className={`text-xs font-mono ${isConnected ? "text-[#00e5ff]" : "text-[#ff66aa]"}`}
                data-testid={isConnected ? "badge-connected" : "badge-disconnected"}>
                {isConnected ? "CONNECTED" : "OFFLINE"}
              </span>
            </div>
          </div>
        </div>

        <PageGuide
          title="Live Trading — Your Bot in Action"
          summary="This is the control room for your live trading bot. It connects to cTrader via API and executes trades automatically based on your active strategy."
          steps={[
            { title: "Connection Status", description: "The badges at the top show if you're connected to cTrader and whether the bot is actively trading. Blue = connected, green = trading live." },
            { title: "Account Overview", description: "See your broker account balance, current positions, and real-time bid/ask prices." },
            { title: "Open Positions", description: "Any active trades are shown here with entry price, current P&L, stop loss, and take profit levels." },
            { title: "Bot Controls", description: "Start/stop the trading bot, connect/disconnect from cTrader, and monitor the bot's decision-making in real time." },
            { title: "Trade History", description: "Recent bot activity shows every decision — entries, exits, skipped signals, and the reasoning behind each." },
          ]}
          tips={[
            "The bot only trades during your configured session (e.g., London hours). Outside session hours it will show as 'waiting'.",
            "If the bot shows 'No Trade' regime, it's protecting your capital by sitting out uncertain markets.",
            "You can manually connect/disconnect without affecting your strategy settings.",
          ]}
        />

        {!isConnected && (
          <div className="lt-card" data-testid="card-credentials" style={{ borderColor: "#00e5ff33" }}>
            <div className="flex items-center gap-2 mb-4">
              <Shield className="w-4 h-4 text-[#00e5ff]" />
              <span className="text-sm font-bold text-white uppercase tracking-wider">cTrader API Connection</span>
            </div>
            {serverCredsReady ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3 p-3 rounded-lg" style={{ background: "rgba(0,255,136,0.05)", border: "1px solid rgba(0,255,136,0.15)" }}>
                  <CheckCircle className="w-4 h-4 text-[#00ff88] shrink-0" />
                  <span className="text-sm text-[#aabbcc]">API credentials configured from server secrets. Ready to connect.</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Switch
                      id="isLive"
                      data-testid="switch-is-live"
                      checked={credentials.isLive}
                      onCheckedChange={(v) => setCredentials({ ...credentials, isLive: v })}
                    />
                    <Label htmlFor="isLive" className={`font-mono text-sm ${credentials.isLive ? "text-[#ff4466] font-bold" : "text-[#8899aa]"}`}>
                      {credentials.isLive ? "⚠ LIVE ACCOUNT (REAL MONEY)" : "Demo Account"}
                    </Label>
                  </div>
                  <Button
                    data-testid="button-connect"
                    onClick={() => connectMutation.mutate()}
                    disabled={connectMutation.isPending}
                    className="bg-[#00e5ff] hover:bg-[#00ccee] text-black font-bold font-mono tracking-wider"
                  >
                    {connectMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Wifi className="w-4 h-4 mr-2" />}
                    CONNECT
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-xs text-[#667788]">
                  Get credentials from <a href="https://openapi.ctrader.com" target="_blank" rel="noopener noreferrer" className="text-[#00e5ff] underline">openapi.ctrader.com</a>
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="clientId" className="text-xs text-[#8899aa]">Client ID</Label>
                    <Input id="clientId" data-testid="input-client-id" value={credentials.clientId}
                      onChange={(e) => setCredentials({ ...credentials, clientId: e.target.value })}
                      placeholder="Your client ID" className="lt-input" />
                  </div>
                  <div>
                    <Label htmlFor="clientSecret" className="text-xs text-[#8899aa]">Client Secret</Label>
                    <Input id="clientSecret" data-testid="input-client-secret" type="password" value={credentials.clientSecret}
                      onChange={(e) => setCredentials({ ...credentials, clientSecret: e.target.value })}
                      placeholder="Your client secret" className="lt-input" />
                  </div>
                  <div>
                    <Label htmlFor="accessToken" className="text-xs text-[#8899aa]">Access Token</Label>
                    <Input id="accessToken" data-testid="input-access-token" type="password" value={credentials.accessToken}
                      onChange={(e) => setCredentials({ ...credentials, accessToken: e.target.value })}
                      placeholder="OAuth2 access token" className="lt-input" />
                  </div>
                  <div>
                    <Label htmlFor="accountId" className="text-xs text-[#8899aa]">Account ID (ctid)</Label>
                    <Input id="accountId" data-testid="input-account-id" value={credentials.accountId}
                      onChange={(e) => setCredentials({ ...credentials, accountId: e.target.value })}
                      placeholder="e.g. 44442153" className="lt-input" />
                  </div>
                </div>
                <div className="flex items-center justify-between pt-1">
                  <div className="flex items-center gap-3">
                    <Switch id="isLive" data-testid="switch-is-live"
                      checked={credentials.isLive}
                      onCheckedChange={(v) => setCredentials({ ...credentials, isLive: v })} />
                    <Label htmlFor="isLive" className={`font-mono text-sm ${credentials.isLive ? "text-[#ff4466] font-bold" : "text-[#8899aa]"}`}>
                      {credentials.isLive ? "⚠ LIVE ACCOUNT" : "Demo Account"}
                    </Label>
                  </div>
                  <Button data-testid="button-connect" onClick={() => connectMutation.mutate()}
                    disabled={connectMutation.isPending || !credentials.clientId || !credentials.accessToken}
                    className="bg-[#00e5ff] hover:bg-[#00ccee] text-black font-bold font-mono">
                    {connectMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Wifi className="w-4 h-4 mr-2" />}
                    CONNECT
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className={isConnected ? "space-y-4" : "hidden"}>

          <div className="flex items-center gap-2 flex-wrap">
            {!isRunning ? (
              <Button data-testid="button-start-trading" onClick={() => startMutation.mutate()}
                disabled={startMutation.isPending}
                className="bg-[#00ff88] hover:bg-[#00dd77] text-black font-bold font-mono tracking-wider">
                {startMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                START TRADING
              </Button>
            ) : (
              <Button data-testid="button-stop-trading" onClick={() => stopMutation.mutate()}
                disabled={stopMutation.isPending}
                className="bg-[#ff4466] hover:bg-[#ee3355] text-white font-bold font-mono tracking-wider">
                {stopMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Square className="w-4 h-4 mr-2" />}
                STOP ENGINE
              </Button>
            )}
            <Button data-testid="button-refresh" variant="outline" size="icon" onClick={() => refetchStatus()}
              className="lt-btn-outline" aria-label="Refresh status">
              <RefreshCw className="w-4 h-4" />
            </Button>
            <Button data-testid="button-disconnect" variant="outline" onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending} className="lt-btn-outline">
              <WifiOff className="w-4 h-4 mr-2" /> Disconnect
            </Button>
            {isRunning && (
              <Button
                data-testid="button-test-trade"
                variant="outline"
                onClick={() => testTradeMutation.mutate()}
                disabled={testTradeMutation.isPending}
                className="lt-btn-outline border-amber-500/50 hover:border-amber-500 text-amber-400 hover:text-amber-300"
              >
                {testTradeMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FlaskConical className="w-4 h-4 mr-2" />}
                Test Trade
              </Button>
            )}
          </div>

          {testTradeResult && (
            <div className={`rounded-lg border p-3 text-xs font-mono space-y-1 ${testTradeResult.success ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className={`font-bold ${testTradeResult.success ? 'text-green-400' : 'text-red-400'}`}>
                  {testTradeResult.success ? '✓ Pipeline Verified' : '✗ Pipeline Failed'}
                </span>
                <Button variant="ghost" size="sm" className="h-5 text-[10px] px-1.5" onClick={() => setTestTradeResult(null)}>
                  Dismiss
                </Button>
              </div>
              {testTradeResult.logs.map((log, i) => (
                <div key={i} className="text-muted-foreground">{log}</div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
            <div className="lt-card col-span-2 flex items-center gap-5 transition-all duration-500" data-testid="card-regime"
              style={{ background: rc.bg, borderColor: rc.color + "33" }}>
              <div className="w-14 h-14 rounded-xl flex items-center justify-center transition-all duration-500" style={{ background: rc.color + "15", border: `2px solid ${rc.color}44` }}>
                <RegimeIcon className="w-7 h-7" style={{ color: rc.color }} />
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-[#8899aa] mb-0.5">Regime State</div>
                <div className="text-2xl font-black font-mono tracking-wider lt-value" style={{ color: rc.color }} data-testid="text-regime">
                  {rc.label}
                </div>
              </div>
            </div>

            <div className="lt-card" data-testid="card-balance" style={{ borderColor: "rgba(255,170,0,0.15)" }}>
              <div className="flex items-center gap-2 mb-2">
                <DollarSign className="w-4 h-4 text-[#ffaa00]" />
                <span className="text-xs uppercase tracking-wider text-[#8899aa]">Account Balance</span>
              </div>
              <div className="font-mono font-bold text-xl text-white lt-value" data-testid="text-balance">
                {balance > 0 ? `$${balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
              </div>
              <div className="text-xs text-[#667788] mt-1 font-mono lt-value" data-testid="text-leverage">Leverage: 1:{leverage > 0 ? leverage : (params?.leverage || 10)}{leverage <= 0 && " (config)"}</div>
            </div>

            <StatCard label="XAUUSD Bid" value={bid > 0 ? `$${bid.toFixed(2)}` : "—"} icon={DollarSign}
              color="#00e5ff" subValue={`Spread: ${spread} pts`} testId="card-price" />

            <StatCard label="Trades Today" value={tradesToday} icon={BarChart3}
              color="#bb77ff" subValue={`Consec. losses: ${consecutiveLosses}`} testId="card-trades" />

            <div className="lt-card" data-testid="card-daily-pnl">
              <div className="flex items-center gap-2 mb-2">
                <DollarSign className="w-4 h-4 text-[#00ff88]" />
                <span className="text-xs uppercase tracking-wider text-[#8899aa]">Daily P&L</span>
              </div>
              <PnlValue value={dailyPnl} size="lg" />
              {pnlToday !== 0 && <div className="text-[10px] text-[#8899aa] mt-1">Closed trades: {pnlToday >= 0 ? "+" : ""}${pnlToday.toFixed(2)}</div>}
            </div>

            <div className="lt-card" data-testid="card-total-pnl">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="w-4 h-4 text-[#bb77ff]" />
                <span className="text-xs uppercase tracking-wider text-[#8899aa]">Account P&L</span>
              </div>
              <PnlValue value={accountPnl} size="lg" />
              <div className="text-[10px] text-[#8899aa] mt-1">${startingBalance.toLocaleString()} → ${balance > 0 ? balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}</div>
            </div>
          </div>

          {gvzValue !== null && (
            <div className="lt-card mt-3 flex items-center gap-4" data-testid="card-gvz">
              <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: "rgba(255,170,0,0.1)", border: "1px solid rgba(255,170,0,0.25)" }}>
                <Activity className="w-5 h-5 text-[#ffaa00]" />
              </div>
              <div className="flex-1">
                <div className="text-[10px] uppercase tracking-widest text-[#8899aa] mb-0.5">GVZ (Gold Volatility)</div>
                <div className="flex items-center gap-3">
                  <span className="text-lg font-bold font-mono text-white" data-testid="text-gvz-value">{gvzValue.toFixed(1)}</span>
                  <span className="text-xs font-mono px-2 py-0.5 rounded" data-testid="text-gvz-percentile"
                    style={{
                      background: gvzPercentile !== null && gvzPercentile > 75 ? "rgba(255,68,68,0.15)" : gvzPercentile !== null && gvzPercentile < 25 ? "rgba(0,229,136,0.15)" : "rgba(136,153,170,0.15)",
                      color: gvzPercentile !== null && gvzPercentile > 75 ? "#ff4444" : gvzPercentile !== null && gvzPercentile < 25 ? "#00e588" : "#8899aa",
                    }}>
                    P{gvzPercentile}
                  </span>
                  <span className="text-[10px] text-[#667788] font-mono">{gvzDate}</span>
                </div>
              </div>
              <div className="text-[10px] text-[#667788] text-right">
                {gvzPercentile !== null && gvzPercentile > 75 ? "High Vol → Trend" : gvzPercentile !== null && gvzPercentile < 25 ? "Low Vol → Range" : "Neutral"}
              </div>
            </div>
          )}

          {cotNetPosition !== null && (
            <div className="lt-card mt-3 flex items-center gap-4" data-testid="card-cot">
              <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: "rgba(100,149,237,0.1)", border: "1px solid rgba(100,149,237,0.25)" }}>
                <BarChart3 className="w-5 h-5 text-[#6495ed]" />
              </div>
              <div className="flex-1">
                <div className="text-[10px] uppercase tracking-widest text-[#8899aa] mb-0.5">COT (Commitment of Traders)</div>
                <div className="flex items-center gap-3">
                  <span className="text-lg font-bold font-mono text-white" data-testid="text-cot-net">{cotNetPosition.toLocaleString()}</span>
                  <span className="text-xs font-mono px-2 py-0.5 rounded" data-testid="text-cot-percentile"
                    style={{
                      background: cotPercentile !== null && cotPercentile > 75 ? "rgba(0,229,136,0.15)" : cotPercentile !== null && cotPercentile < 25 ? "rgba(255,68,68,0.15)" : "rgba(136,153,170,0.15)",
                      color: cotPercentile !== null && cotPercentile > 75 ? "#00e588" : cotPercentile !== null && cotPercentile < 25 ? "#ff4444" : "#8899aa",
                    }}>
                    P{cotPercentile}
                  </span>
                  <span className="text-[10px] text-[#667788] font-mono">{cotDate}</span>
                </div>
              </div>
              <div className="text-[10px] text-[#667788] text-right" data-testid="text-cot-sentiment">
                {cotSentiment || "N/A"}
              </div>
            </div>
          )}

          <div className="lt-card mt-3 flex items-center gap-4" data-testid="card-hmm">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: "rgba(187,119,255,0.1)", border: "1px solid rgba(187,119,255,0.25)" }}>
              <Brain className="w-5 h-5 text-[#bb77ff]" />
            </div>
            <div className="flex-1">
              <div className="text-[10px] uppercase tracking-widest text-[#8899aa] mb-0.5">HMM (Hidden Markov Model)</div>
              <div className="flex items-center gap-3">
                {hmmTrained ? (
                  <>
                    <span className="text-lg font-bold font-mono text-white" data-testid="text-hmm-state">
                      {hmmState === "low_vol" ? "LOW VOL" : hmmState === "medium_vol" ? "MED VOL" : hmmState === "high_vol" ? "HIGH VOL" : "N/A"}
                    </span>
                    {hmmConfidence !== null && (
                      <span className="text-xs font-mono px-2 py-0.5 rounded" data-testid="text-hmm-confidence"
                        style={{
                          background: hmmConfidence > 0.8 ? "rgba(0,229,136,0.15)" : hmmConfidence > 0.6 ? "rgba(255,170,0,0.15)" : "rgba(136,153,170,0.15)",
                          color: hmmConfidence > 0.8 ? "#00e588" : hmmConfidence > 0.6 ? "#ffaa00" : "#8899aa",
                        }}>
                        {(hmmConfidence * 100).toFixed(0)}%
                      </span>
                    )}
                    <span className="text-[10px] text-[#667788] font-mono">{hmmSamples} samples</span>
                  </>
                ) : (
                  <span className="text-sm font-mono text-[#667788]" data-testid="text-hmm-untrained">Awaiting training data...</span>
                )}
              </div>
            </div>
            <div className="text-[10px] text-[#667788] text-right" data-testid="text-hmm-regime-hint">
              {hmmTrained && hmmState === "low_vol" ? "Confirms Range" : hmmTrained && hmmState === "high_vol" ? "Confirms Trend" : hmmTrained ? "Transitional" : "Tier 3"}
            </div>
          </div>

          <div className="lt-card mt-3 flex items-center gap-4" data-testid="card-mrs-garch">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: "rgba(255,136,68,0.1)", border: "1px solid rgba(255,136,68,0.25)" }}>
              <BarChart2 className="w-5 h-5 text-[#ff8844]" />
            </div>
            <div className="flex-1">
              <div className="text-[10px] uppercase tracking-widest text-[#8899aa] mb-0.5">MRS-GARCH Volatility</div>
              <div className="flex items-center gap-3">
                {garchTrained ? (
                  <>
                    <span className="text-lg font-bold font-mono text-white" data-testid="text-garch-vol">
                      {garchVol !== null ? `${garchVol.toFixed(1)}%` : "N/A"}
                    </span>
                    {garchPercentile !== null && (
                      <span className="text-xs font-mono px-2 py-0.5 rounded" data-testid="text-garch-percentile"
                        style={{
                          background: garchPercentile > 75 ? "rgba(255,68,68,0.15)" : garchPercentile < 25 ? "rgba(0,229,136,0.15)" : "rgba(255,170,0,0.15)",
                          color: garchPercentile > 75 ? "#ff4444" : garchPercentile < 25 ? "#00e588" : "#ffaa00",
                        }}>
                        P{garchPercentile.toFixed(0)}
                      </span>
                    )}
                    {garchMultiplier !== null && (
                      <span className="text-xs font-mono text-[#8899aa]" data-testid="text-garch-multiplier">
                        {garchMultiplier.toFixed(2)}x size
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-sm font-mono text-[#667788]" data-testid="text-garch-untrained">Awaiting training data...</span>
                )}
              </div>
            </div>
            <div className="text-[10px] text-[#667788] text-right" data-testid="text-garch-hint">
              {garchTrained && garchPercentile !== null ? (garchPercentile > 75 ? "High Vol → Reduce" : garchPercentile < 25 ? "Low Vol → Increase" : "Normal Vol") : "Tier 4"}
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <PnlPeriodCard label="Today" value={pnlToday + dailyPnl} trades={tradesToday} testId="card-pnl-daily" />
            <PnlPeriodCard label="This Week" value={pnlThisWeek} trades={tradesThisWeek} testId="card-pnl-weekly" />
            <PnlPeriodCard label="This Month" value={pnlThisMonth} trades={tradesThisMonth} testId="card-pnl-monthly" />
            <PnlPeriodCard label="All Time (Account)" value={accountPnl} trades={tradesAllTime} testId="card-pnl-yearly" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-8 space-y-4">

              <div className="lt-card" data-testid="card-positions">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Target className="w-4 h-4 text-[#bb77ff]" />
                    <span className="text-sm font-bold text-white uppercase tracking-wider">Open Positions</span>
                    <Badge className="bg-[#bb77ff]/10 text-[#bb77ff] border-0 text-[10px] font-mono">{positions.length}</Badge>
                  </div>
                </div>
                {positions.length === 0 ? (
                  <div className="py-8 text-center">
                    <CircleDot className="w-8 h-8 text-[#334455] mx-auto mb-2" />
                    <p className="text-sm text-[#556677] font-mono">No open positions</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {positions.map((pos) => (
                      <PositionRow key={pos.positionId} pos={pos} />
                    ))}
                  </div>
                )}
              </div>

              <div className="lt-card" data-testid="card-trade-history">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <History className="w-4 h-4 text-[#ffaa00]" />
                    <span className="text-sm font-bold text-white uppercase tracking-wider">Trade History</span>
                    <Badge className="bg-[#ffaa00]/10 text-[#ffaa00] border-0 text-[10px] font-mono">{liveTradeData?.count || 0}</Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    {liveTradeData?.stats && (
                      <span className="text-[10px] text-[#556677] font-mono">
                        {liveTradeData.stats.wins}W {liveTradeData.stats.losses}L · {liveTradeData.stats.winRate}% WR
                      </span>
                    )}
                    <button
                      className="px-2 py-1 text-[10px] font-mono rounded bg-[#ffaa00]/10 text-[#ffaa00] hover:bg-[#ffaa00]/20 transition-colors"
                      onClick={() => setShowAddTrade(!showAddTrade)}
                      data-testid="button-add-trade"
                    >
                      + Add Trade
                    </button>
                  </div>
                </div>
                {showAddTrade && (
                  <div className="mb-3 p-3 rounded-lg bg-[#0a1520] border border-[#1a2535] space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] text-[#667788] block mb-1">Side</label>
                        <select className="w-full bg-[#0d1a28] border border-[#1a2535] rounded px-2 py-1.5 text-xs text-white" value={newTrade.side} onChange={e => setNewTrade(p => ({ ...p, side: e.target.value as "buy" | "sell" }))} data-testid="select-side">
                          <option value="buy">BUY</option>
                          <option value="sell">SELL</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] text-[#667788] block mb-1">Regime</label>
                        <select className="w-full bg-[#0d1a28] border border-[#1a2535] rounded px-2 py-1.5 text-xs text-white" value={newTrade.regime} onChange={e => setNewTrade(p => ({ ...p, regime: e.target.value }))} data-testid="select-regime">
                          <option value="trend">Trend</option>
                          <option value="range">Range</option>
                        </select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] text-[#667788] block mb-1">Entry Price</label>
                        <input className="w-full bg-[#0d1a28] border border-[#1a2535] rounded px-2 py-1.5 text-xs text-white font-mono" type="number" step="0.01" placeholder="e.g. 4720.05" value={newTrade.entryPrice} onChange={e => setNewTrade(p => ({ ...p, entryPrice: e.target.value }))} data-testid="input-entry-price" />
                      </div>
                      <div>
                        <label className="text-[10px] text-[#667788] block mb-1">Exit Price</label>
                        <input className="w-full bg-[#0d1a28] border border-[#1a2535] rounded px-2 py-1.5 text-xs text-white font-mono" type="number" step="0.01" placeholder="e.g. 4750.00" value={newTrade.exitPrice} onChange={e => setNewTrade(p => ({ ...p, exitPrice: e.target.value }))} data-testid="input-exit-price" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] text-[#667788] block mb-1">P&L ($)</label>
                        <input className="w-full bg-[#0d1a28] border border-[#1a2535] rounded px-2 py-1.5 text-xs text-white font-mono" type="number" step="0.01" placeholder="e.g. 96.89 or -50.00" value={newTrade.pnl} onChange={e => setNewTrade(p => ({ ...p, pnl: e.target.value }))} data-testid="input-pnl" />
                      </div>
                      <div>
                        <label className="text-[10px] text-[#667788] block mb-1">Notes</label>
                        <input className="w-full bg-[#0d1a28] border border-[#1a2535] rounded px-2 py-1.5 text-xs text-white" placeholder="Optional" value={newTrade.notes} onChange={e => setNewTrade(p => ({ ...p, notes: e.target.value }))} data-testid="input-notes" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] text-[#667788] block mb-1">Opened At</label>
                        <input className="w-full bg-[#0d1a28] border border-[#1a2535] rounded px-2 py-1.5 text-xs text-white" type="datetime-local" value={newTrade.openedAt} onChange={e => setNewTrade(p => ({ ...p, openedAt: e.target.value }))} data-testid="input-opened-at" />
                      </div>
                      <div>
                        <label className="text-[10px] text-[#667788] block mb-1">Closed At</label>
                        <input className="w-full bg-[#0d1a28] border border-[#1a2535] rounded px-2 py-1.5 text-xs text-white" type="datetime-local" value={newTrade.closedAt} onChange={e => setNewTrade(p => ({ ...p, closedAt: e.target.value }))} data-testid="input-closed-at" />
                      </div>
                    </div>
                    <button
                      className="w-full py-2 rounded bg-[#ffaa00] text-black text-xs font-bold hover:bg-[#ffbb33] transition-colors"
                      data-testid="button-save-trade"
                      onClick={async () => {
                        if (!newTrade.entryPrice || !newTrade.pnl) return;
                        try {
                          await apiRequest("POST", "/api/live-trades", {
                            side: newTrade.side,
                            entryPrice: newTrade.entryPrice,
                            exitPrice: newTrade.exitPrice || null,
                            pnl: newTrade.pnl,
                            openedAt: newTrade.openedAt ? new Date(newTrade.openedAt).toISOString() : new Date().toISOString(),
                            closedAt: newTrade.closedAt ? new Date(newTrade.closedAt).toISOString() : new Date().toISOString(),
                            status: "closed",
                            regime: newTrade.regime,
                            source: "manual",
                            notes: newTrade.notes || null,
                          });
                          setNewTrade({ side: "buy", entryPrice: "", exitPrice: "", pnl: "", openedAt: "", closedAt: "", regime: "trend", notes: "" });
                          setShowAddTrade(false);
                          refetchTrades();
                          queryClient.invalidateQueries({ queryKey: ["/api/live-trading/ctrader-deals"] });
                        } catch (err) {
                          console.error("Failed to save trade:", err);
                        }
                      }}
                    >
                      Save Trade
                    </button>
                  </div>
                )}
                {!liveTradeData || liveTradeData.trades.length === 0 ? (
                  <div className="py-6 text-center">
                    <History className="w-8 h-8 text-[#334455] mx-auto mb-2" />
                    <p className="text-sm text-[#556677] font-mono">No trades recorded yet</p>
                    <p className="text-[10px] text-[#334455] font-mono mt-1">Use "+ Add Trade" to enter your existing cTrader trades</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs font-mono">
                      <thead>
                        <tr className="text-[#667788] border-b border-[#1a2535]">
                          <th className="text-left pb-2 pr-3">Date</th>
                          <th className="text-left pb-2 pr-3">Side</th>
                          <th className="text-left pb-2 pr-3">Regime</th>
                          <th className="text-right pb-2 pr-3">Entry</th>
                          <th className="text-right pb-2 pr-3">Exit</th>
                          <th className="text-right pb-2 pr-3">P&L</th>
                          <th className="text-left pb-2">Src</th>
                        </tr>
                      </thead>
                      <tbody>
                        {liveTradeData.trades.map((trade) => {
                          const pnl = trade.pnl !== null ? Number(trade.pnl) : 0;
                          const isClosed = trade.status === "closed";
                          return (
                            <tr key={trade.id} className="border-b border-[#111a25] hover:bg-[#0d1520]" data-testid={`row-trade-${trade.id}`}>
                              <td className="py-2 pr-3 text-[#8899aa]">{new Date(trade.opened_at).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                              <td className="py-2 pr-3">
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${trade.side === "buy" ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                                  {trade.side.toUpperCase()}
                                </span>
                              </td>
                              <td className="py-2 pr-3 text-[#8899aa] capitalize">{trade.regime || "—"}</td>
                              <td className="py-2 pr-3 text-right text-white">${Number(trade.entry_price).toFixed(2)}</td>
                              <td className="py-2 pr-3 text-right text-white">{trade.exit_price ? `$${Number(trade.exit_price).toFixed(2)}` : "—"}</td>
                              <td className={`py-2 pr-3 text-right font-bold ${isClosed ? (pnl >= 0 ? "text-emerald-400" : "text-red-400") : "text-[#667788]"}`}>
                                {isClosed ? `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` : "Open"}
                              </td>
                              <td className="py-2 text-[10px] text-[#556677]">{trade.source === "manual" ? "Manual" : "Bot"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-[#1a2535]">
                          <td colSpan={5} className="py-2 text-right text-[#8899aa] font-bold">Total P&L:</td>
                          <td className={`py-2 text-right font-bold ${(liveTradeData.stats?.totalPnl || 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {(() => { const t = liveTradeData.stats?.totalPnl || 0; return `${t >= 0 ? "+" : ""}$${t.toFixed(2)}`; })()}
                          </td>
                          <td></td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>

              <div className="lt-card" data-testid="card-trade-log">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Radio className="w-4 h-4 text-[#00e5ff]" />
                    <span className="text-sm font-bold text-white uppercase tracking-wider">Activity Feed</span>
                    <Badge className="bg-[#00e5ff]/10 text-[#00e5ff] border-0 text-[10px] font-mono">{logs.length}</Badge>
                  </div>
                  <Clock className="w-4 h-4 text-[#334455]" />
                </div>
                <div className="h-72 overflow-y-auto font-mono text-xs rounded-lg p-3 lt-terminal" data-testid="container-logs">
                  {logs.length === 0 ? (
                    <div className="flex items-center gap-2 text-[#334455]">
                      <span className="animate-pulse">█</span>
                      <span>Awaiting activity... Start trading to see live feed.</span>
                    </div>
                  ) : (
                    logs.map((log, i) => (
                      <LogEntry key={i} log={log} index={i} color={logColors[log.type] || "#667788"} />
                    ))
                  )}
                  <div ref={logsEndRef} />
                </div>
              </div>
            </div>

            <div className="lg:col-span-4 space-y-4">

              <div className="lt-card" data-testid="card-risk-gauges">
                <div className="flex items-center gap-2 mb-4">
                  <Gauge className="w-4 h-4 text-[#ff66aa]" />
                  <span className="text-sm font-bold text-white uppercase tracking-wider">Risk Monitor</span>
                </div>
                <div className="space-y-4">
                  <div>
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="text-[#8899aa] font-mono">Drawdown</span>
                      <span className="font-mono lt-value" style={{ color: ddPercent > 60 ? "#ff4466" : ddPercent > 30 ? "#ffaa00" : "#00ff88" }}>
                        {currentDD.toFixed(2)} / {maxDD}%
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-[#111822] overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-700 ease-out"
                        style={{ width: `${ddPercent}%`, background: ddPercent > 60 ? "#ff4466" : ddPercent > 30 ? "#ffaa00" : "#00ff88" }} />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="text-[#8899aa] font-mono">Daily Loss</span>
                      <span className="font-mono lt-value" style={{ color: dailyLossPercent > 60 ? "#ff4466" : dailyLossPercent > 30 ? "#ffaa00" : "#00ff88" }}>
                        {dailyPnl < 0 ? Math.abs(dailyPnl).toFixed(2) : "0.00"} / {maxDailyLoss}%
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-[#111822] overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-700 ease-out"
                        style={{ width: `${dailyLossPercent}%`, background: dailyLossPercent > 60 ? "#ff4466" : dailyLossPercent > 30 ? "#ffaa00" : "#00ff88" }} />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="text-[#8899aa] font-mono">Consec. Losses</span>
                      <span className="font-mono lt-value" style={{ color: consecutiveLosses >= 3 ? "#ff4466" : consecutiveLosses >= 2 ? "#ffaa00" : "#00ff88" }}>
                        {consecutiveLosses} / {params?.maxConsecutiveLosses || 3}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-[#111822] overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-700 ease-out"
                        style={{ width: `${(consecutiveLosses / (params?.maxConsecutiveLosses || 3)) * 100}%`,
                          background: consecutiveLosses >= 3 ? "#ff4466" : consecutiveLosses >= 2 ? "#ffaa00" : "#00ff88" }} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="lt-card" data-testid="card-session-info">
                <div className="flex items-center gap-2 mb-3">
                  <Zap className="w-4 h-4 text-[#00e5ff]" />
                  <span className="text-sm font-bold text-white uppercase tracking-wider">Session</span>
                </div>
                <div className="space-y-2.5">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-[#667788] font-mono">Symbol</span>
                    <span className="text-xs text-white font-mono font-bold">XAUUSD</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-[#667788] font-mono">Bid / Ask</span>
                    <span className="text-xs text-[#00e5ff] font-mono lt-value">{bid > 0 ? `${bid.toFixed(2)} / ${ask.toFixed(2)}` : "—"}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-[#667788] font-mono">Spread</span>
                    <span className="text-xs text-[#8899aa] font-mono lt-value">{spread} pts</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-[#667788] font-mono">Session</span>
                    <span className="text-xs text-[#bb77ff] font-mono">{params?.sessionMode || "London+NY"}</span>
                  </div>
                  {lastUpdate && (
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-[#667788] font-mono">Last Update</span>
                      <span className="text-xs text-[#556677] font-mono">{new Date(lastUpdate).toLocaleTimeString("en-US", { hour12: false })}</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="lt-card" data-testid="card-locked-params">
                <button className="w-full flex items-center justify-between" onClick={() => setShowParams(!showParams)} data-testid="button-toggle-params">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-[#ffaa00]" />
                    <span className="text-sm font-bold text-white uppercase tracking-wider">Locked Params</span>
                  </div>
                  {showParams ? <ChevronUp className="w-4 h-4 text-[#556677]" /> : <ChevronDown className="w-4 h-4 text-[#556677]" />}
                </button>
                {showParams && params && (
                  <div className="mt-3 pt-3 space-y-2" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                    {[
                      ["Expansion", params.expansionThreshold, "#00e5ff"],
                      ["Compression", params.compressionThreshold, "#00e5ff"],
                      ["ATR Stop", `${params.atrStopMultiplier}x`, "#ff66aa"],
                      ["Reward", `${params.rewardRatio}:1`, "#00ff88"],
                      ["Risk/Trade", `${params.riskPerTradePct}%`, "#ffaa00"],
                      ["Max DD", `${params.maxDrawdownPct}%`, "#ff4466"],
                      ["Max Daily", `${params.maxDailyLossPct}%`, "#ff4466"],
                      ["Session", params.sessionMode, "#bb77ff"],
                      ["Entry Window", `${params.entryWindowBars} bars`, "#bb77ff"],
                      ["Wick Ratio", params.wickRatio, "#00e5ff"],
                    ].map(([label, val, color]) => (
                      <div key={label as string} className="flex justify-between items-center">
                        <span className="text-xs text-[#667788] font-mono">{label}</span>
                        <span className="text-xs font-mono font-bold" style={{ color: color as string }}>{val}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="lt-card" data-testid="card-system-health">
                <button className="w-full flex items-center justify-between" onClick={() => setShowHealth(!showHealth)} data-testid="button-toggle-health">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-[#00e5ff]" />
                    <span className="text-sm font-bold text-white uppercase tracking-wider">System Health</span>
                    {healthData && (() => {
                      const errCount = healthData.checks?.filter(c => c.status === "error").length || 0;
                      const warnCount = healthData.checks?.filter(c => c.status === "warn").length || 0;
                      if (errCount > 0) return <GlowDot color="#ff4466" pulse />;
                      if (warnCount > 0) return <GlowDot color="#ffaa00" pulse />;
                      return <GlowDot color="#00ff88" />;
                    })()}
                  </div>
                  {showHealth ? <ChevronUp className="w-4 h-4 text-[#556677]" /> : <ChevronDown className="w-4 h-4 text-[#556677]" />}
                </button>
                {showHealth && healthData && (
                  <div className="mt-3 pt-3 space-y-3" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                    {healthData.checks?.map((check) => (
                      <div key={check.name} className="flex items-start gap-2" data-testid={`health-check-${check.name.toLowerCase().replace(/\s+/g, "-")}`}>
                        <span className="mt-0.5">
                          {check.status === "ok" && <CheckCircle className="w-3.5 h-3.5 text-[#00ff88]" />}
                          {check.status === "warn" && <AlertTriangle className="w-3.5 h-3.5 text-[#ffaa00]" />}
                          {check.status === "error" && <AlertTriangle className="w-3.5 h-3.5 text-[#ff4466]" />}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-mono text-[#8899aa]">{check.name}</div>
                          <div className="text-[10px] font-mono text-[#556677] truncate">{check.message}</div>
                        </div>
                      </div>
                    ))}

                    {healthData.recentEvents && healthData.recentEvents.length > 0 && (
                      <div className="mt-2 pt-2" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                        <div className="text-[10px] uppercase tracking-wider text-[#556677] mb-2">Recent Events</div>
                        <div className="space-y-1 max-h-32 overflow-y-auto">
                          {healthData.recentEvents.slice(-5).reverse().map((ev, i) => (
                            <div key={i} className="text-[10px] font-mono flex items-start gap-1.5">
                              <span className={ev.severity === "error" ? "text-[#ff4466]" : ev.severity === "warn" ? "text-[#ffaa00]" : "text-[#334455]"}>
                                {ev.severity === "error" ? "ERR" : ev.severity === "warn" ? "WRN" : "INF"}
                              </span>
                              <span className="text-[#556677] shrink-0">{new Date(ev.timestamp).toLocaleTimeString("en-US", { hour12: false })}</span>
                              <span className="text-[#778899] truncate">{ev.source}: {ev.message}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {healthData.recentFixes && healthData.recentFixes.length > 0 && (
                      <div className="mt-2 pt-2" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                        <div className="text-[10px] uppercase tracking-wider text-[#556677] mb-2">Auto-Fixes</div>
                        <div className="space-y-1 max-h-24 overflow-y-auto">
                          {healthData.recentFixes.slice(-3).reverse().map((fix, i) => (
                            <div key={i} className="text-[10px] font-mono flex items-start gap-1.5">
                              <Zap className="w-2.5 h-2.5 text-[#00e5ff] mt-0.5 shrink-0" />
                              <span className="text-[#778899] truncate">{fix.action}: {fix.result}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="text-[10px] text-[#334455] font-mono text-right">
                      {healthData.lastCycle ? `Updated ${new Date(healthData.lastCycle).toLocaleTimeString("en-US", { hour12: false })}` : "—"}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {!isConnected && (
          <div className="space-y-4">
            <div className="text-center py-16">
              <div className="w-20 h-20 rounded-2xl mx-auto mb-4 flex items-center justify-center" style={{ background: "rgba(0,229,255,0.05)", border: "1px solid rgba(0,229,255,0.1)" }}>
                <Activity className="w-10 h-10 text-[#223344]" />
              </div>
              <p className="text-[#445566] font-mono text-sm">Connect to cTrader to begin live monitoring</p>
            </div>

            <div className="lt-card" data-testid="card-system-health-disconnected">
              <button className="w-full flex items-center justify-between" onClick={() => setShowHealth(!showHealth)} data-testid="button-toggle-health-disconnected">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-[#00e5ff]" />
                  <span className="text-sm font-bold text-white uppercase tracking-wider">System Health</span>
                  {healthData && (() => {
                    const errCount = healthData.checks?.filter(c => c.status === "error").length || 0;
                    const warnCount = healthData.checks?.filter(c => c.status === "warn").length || 0;
                    if (errCount > 0) return <GlowDot color="#ff4466" pulse />;
                    if (warnCount > 0) return <GlowDot color="#ffaa00" pulse />;
                    return <GlowDot color="#00ff88" />;
                  })()}
                </div>
                {showHealth ? <ChevronUp className="w-4 h-4 text-[#556677]" /> : <ChevronDown className="w-4 h-4 text-[#556677]" />}
              </button>
              {showHealth && healthData && (
                <div className="mt-3 pt-3 space-y-3" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                  {healthData.checks?.map((check) => (
                    <div key={check.name} className="flex items-start gap-2">
                      <span className="mt-0.5">
                        {check.status === "ok" && <CheckCircle className="w-3.5 h-3.5 text-[#00ff88]" />}
                        {check.status === "warn" && <AlertTriangle className="w-3.5 h-3.5 text-[#ffaa00]" />}
                        {check.status === "error" && <AlertTriangle className="w-3.5 h-3.5 text-[#ff4466]" />}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-mono text-[#8899aa]">{check.name}</div>
                        <div className="text-[10px] font-mono text-[#556677] truncate">{check.message}</div>
                      </div>
                    </div>
                  ))}
                  {healthData.recentEvents && healthData.recentEvents.length > 0 && (
                    <div className="mt-2 pt-2" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                      <div className="text-[10px] uppercase tracking-wider text-[#556677] mb-2">Recent Events</div>
                      <div className="space-y-1 max-h-32 overflow-y-auto">
                        {healthData.recentEvents.slice(-5).reverse().map((ev, i) => (
                          <div key={i} className="text-[10px] font-mono flex items-start gap-1.5">
                            <span className={ev.severity === "error" ? "text-[#ff4466]" : ev.severity === "warn" ? "text-[#ffaa00]" : "text-[#334455]"}>
                              {ev.severity === "error" ? "ERR" : ev.severity === "warn" ? "WRN" : "INF"}
                            </span>
                            <span className="text-[#556677] shrink-0">{new Date(ev.timestamp).toLocaleTimeString("en-US", { hour12: false })}</span>
                            <span className="text-[#778899] truncate">{ev.source}: {ev.message}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
