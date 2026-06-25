import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { PageGuide } from "@/components/page-guide";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Area, AreaChart, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";
import { TrendingUp, TrendingDown, Target, Activity, BarChart3, ArrowRight, Ban, Globe, Clock, Circle, Wifi, WifiOff, RefreshCw, Newspaper, ExternalLink, Zap, DollarSign, ShieldAlert, Layers, AlertTriangle } from "lucide-react";
import { useState, useEffect, useMemo } from "react";
import { MarketAnalysisPanel } from "@/components/market-analysis-panel";
import { StrategyChart } from "@/components/strategy-chart";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type AsianMarketSnapshot = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
  timestamp: string;
};

type AccountInfo = {
  connected: boolean;
  accountId?: string;
  traderLogin?: string;
  balance?: number;
  leverage?: number;
  leverageSource?: string;
  lastSpot?: { bid: number; ask: number; timestamp: number };
};

type DiscoveredAccount = {
  ctidTraderAccountId: number;
  traderLogin: number;
  isLive: boolean;
  brokerName: string;
};

type TraderLog = { timestamp: string; type: string; message: string };

type LiveStatus = {
  connected: boolean;
  connection: any;
  trader: {
    running: boolean;
    connected: boolean;
    regime: string | null;
    currentPrice: number;
    positions: any[];
    dailyPnl: number;
    totalPnl: number;
    balance: number;
    tradestoday: number;
    consecutiveLosses: number;
    logs: TraderLog[];
    params: Record<string, any>;
    lastUpdate: string;
  } | null;
  tradeCounts: { today: number; thisWeek: number; thisMonth: number; allTime: number; pnlToday: number; pnlThisWeek: number; pnlThisMonth: number; pnlAllTime: number };
  startingBalance?: number;
  accountPnl?: number;
  gvz: { value: number; date: string; percentile: number } | null;
  cot: { netPosition: number; noncommLong: number; noncommShort: number; openInterest: number; date: string; percentile: number; sentiment: string } | null;
};

function StatCard({ label, value, sub, positive, icon: Icon, loading }: {
  label: string; value: string; sub?: string; positive?: boolean; icon: React.ElementType; loading?: boolean;
}) {
  return (
    <Card data-testid={`card-stat-${label.toLowerCase().replace(/\s/g, "-")}`}>
      <CardContent className="pt-5 pb-4 px-5">
        {loading ? (
          <div className="space-y-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-16" /></div>
        ) : (
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-1">{label}</div>
              <div className={`text-2xl font-bold leading-tight ${positive === true ? "text-emerald-600 dark:text-emerald-400" : positive === false ? "text-red-500 dark:text-red-400" : ""}`}
                data-testid={`value-${label.toLowerCase().replace(/\s/g, "-")}`}>
                {value}
              </div>
              {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
            </div>
            <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
              <Icon className="w-4 h-4 text-primary" />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type SessionInfo = {
  name: string;
  startUtc: number;
  endUtc: number;
  color: string;
};

const SESSIONS: SessionInfo[] = [
  { name: "Sydney", startUtc: 21, endUtc: 6, color: "text-purple-400" },
  { name: "Tokyo", startUtc: 0, endUtc: 9, color: "text-pink-400" },
  { name: "London", startUtc: 7, endUtc: 16, color: "text-blue-400" },
  { name: "New York", startUtc: 13, endUtc: 22, color: "text-amber-400" },
];

function isSessionOpen(session: SessionInfo, utcHour: number): boolean {
  if (session.startUtc < session.endUtc) {
    return utcHour >= session.startUtc && utcHour < session.endUtc;
  }
  return utcHour >= session.startUtc || utcHour < session.endUtc;
}

function isForexMarketOpen(now: Date): boolean {
  const utcDay = now.getUTCDay();
  const utcHour = now.getUTCHours();
  if (utcDay === 6) return false;
  if (utcDay === 0 && utcHour < 21) return false;
  if (utcDay === 5 && utcHour >= 21) return false;
  return true;
}

function formatSessionTime(utcHour: number): string {
  const d = new Date();
  d.setUTCHours(utcHour, 0, 0, 0);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
}

function getNextOpenTime(): string {
  const now = new Date();
  const target = new Date(now);
  const utcDay = now.getUTCDay();
  if (utcDay === 6) {
    target.setUTCDate(target.getUTCDate() + (7 - utcDay));
  } else if (utcDay === 0 && now.getUTCHours() < 21) {
  } else {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  target.setUTCHours(21, 0, 0, 0);
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
  return target.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true }) + " " +
    target.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function MarketHoursIndicator() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  const utcHour = now.getUTCHours();
  const marketOpen = isForexMarketOpen(now);

  return (
    <Card data-testid="card-market-hours">
      <CardContent className="py-3 px-5">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2 shrink-0">
            <Clock className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">XAUUSD Market</span>
            {marketOpen ? (
              <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs" data-testid="badge-market-open">
                <Circle className="w-2 h-2 mr-1 fill-emerald-400" />OPEN
              </Badge>
            ) : (
              <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-xs" data-testid="badge-market-closed">
                <Circle className="w-2 h-2 mr-1 fill-red-400" />CLOSED
              </Badge>
            )}
          </div>

          {!marketOpen && (
            <span className="text-xs text-muted-foreground" data-testid="text-next-open">
              Opens {getNextOpenTime()}
            </span>
          )}

          <div className="flex items-center gap-3 ml-auto flex-wrap">
            {SESSIONS.map((session) => {
              const open = marketOpen && isSessionOpen(session, utcHour);
              return (
                <div
                  key={session.name}
                  className="flex items-center gap-1.5"
                  data-testid={`session-${session.name.toLowerCase().replace(/\s/g, "-")}`}
                >
                  <Circle className={`w-2 h-2 ${open ? "fill-emerald-400 text-emerald-400" : "fill-red-400 text-red-400"}`} />
                  <span className={`text-xs font-medium ${open ? session.color : "text-muted-foreground"}`}>
                    {session.name}
                  </span>
                  <span className="text-xs text-muted-foreground hidden sm:inline">
                    {formatSessionTime(session.startUtc)}–{formatSessionTime(session.endUtc)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AccountInfoPanel() {
  const { toast } = useToast();
  const { data: accountInfo } = useQuery<AccountInfo>({
    queryKey: ["/api/live-trading/account-info"],
    refetchInterval: 5000,
  });

  const { data: lockedParams } = useQuery<Record<string, any>>({
    queryKey: ["/api/locked-params"],
  });

  const [showSwitcher, setShowSwitcher] = useState(false);
  const [accounts, setAccounts] = useState<DiscoveredAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);

  const switchMutation = useMutation({
    mutationFn: async ({ accountId, isLive }: { accountId: number; isLive: boolean }) => {
      const res = await apiRequest("POST", "/api/live-trading/switch-account", {
        accountId,
        isLive,
      });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/live-trading/account-info"] });
      queryClient.invalidateQueries({ queryKey: ["/api/live-trading/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/live-trading/price-history"] });
      setShowSwitcher(false);
      toast({ title: "Account Switched", description: `Connected to account ${data.accountId}. Balance: $${data.balance?.toLocaleString()}` });
    },
    onError: (err: Error) => {
      toast({ title: "Switch Failed", description: err.message, variant: "destructive" });
    },
  });

  const discoverAccounts = async () => {
    setLoadingAccounts(true);
    try {
      const res = await apiRequest("POST", "/api/live-trading/discover-accounts", {});
      const data = await res.json();
      setAccounts(data.accounts || []);
    } catch (e) {}
    setLoadingAccounts(false);
  };

  const bid = accountInfo?.lastSpot?.bid;
  const ask = accountInfo?.lastSpot?.ask;
  const spread = bid && ask ? ((ask - bid) * 100).toFixed(1) : null;

  const displayLeverage = accountInfo?.leverage || lockedParams?.leverage || null;
  const leverageSource = accountInfo?.leverageSource || "config";

  return (
    <Card data-testid="card-account-info" className="h-full">
      <CardContent className="py-3 px-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {accountInfo?.connected ? (
              <Wifi className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <WifiOff className="w-3.5 h-3.5 text-red-400" />
            )}
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Account Info</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => {
              setShowSwitcher(!showSwitcher);
              if (!showSwitcher && accounts.length === 0) discoverAccounts();
            }}
            data-testid="button-switch-account"
          >
            <RefreshCw className="w-3 h-3 mr-1" />Switch
          </Button>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">cTrader ID</span>
            <span className="text-xs font-mono font-medium" data-testid="text-account-id">
              {accountInfo?.accountId || "—"}
            </span>
          </div>
          {(accountInfo?.traderLogin || (accounts.length > 0 && accounts[0]?.traderLogin)) && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Login</span>
              <span className="text-xs font-mono font-medium" data-testid="text-trader-login">
                {accountInfo?.traderLogin || accounts[0]?.traderLogin}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Balance</span>
            <span className="text-xs font-mono font-medium" data-testid="text-balance">
              ${accountInfo?.balance?.toLocaleString(undefined, { minimumFractionDigits: 2 }) || "—"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Leverage</span>
            <span className="text-xs font-mono font-medium" data-testid="text-leverage">
              {displayLeverage ? (
                <>
                  1:{displayLeverage}
                  {leverageSource === "config" && (
                    <span className="text-[9px] text-muted-foreground ml-1">(config)</span>
                  )}
                </>
              ) : "—"}
            </span>
          </div>
          {bid && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Bid / Ask</span>
              <span className="text-xs font-mono font-medium" data-testid="text-bid-ask">
                {bid.toFixed(2)} / {ask?.toFixed(2)} <span className="text-muted-foreground">({spread}c)</span>
              </span>
            </div>
          )}
        </div>

        {showSwitcher && (
          <div className="mt-3 pt-3 border-t border-border space-y-2">
            <span className="text-xs font-medium text-muted-foreground">Available Accounts</span>
            {loadingAccounts ? (
              <div className="text-xs text-muted-foreground">Loading...</div>
            ) : (
              <div className="space-y-1">
                {accounts.map((acc) => (
                  <Button
                    key={acc.ctidTraderAccountId}
                    variant={String(acc.ctidTraderAccountId) === accountInfo?.accountId ? "secondary" : "ghost"}
                    size="sm"
                    className="w-full justify-between h-7 text-xs"
                    disabled={switchMutation.isPending || String(acc.ctidTraderAccountId) === accountInfo?.accountId}
                    onClick={() => switchMutation.mutate({ accountId: acc.ctidTraderAccountId, isLive: acc.isLive })}
                    data-testid={`button-account-${acc.ctidTraderAccountId}`}
                  >
                    <span className="font-mono">{acc.traderLogin}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">{acc.brokerName}</span>
                      <Badge variant={acc.isLive ? "destructive" : "secondary"} className="text-[10px] h-4 px-1">
                        {acc.isLive ? "LIVE" : "DEMO"}
                      </Badge>
                    </div>
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type PriceTick = { time: number; price: number };

function LiveMiniChart() {
  const { data } = useQuery<{ prices: PriceTick[] }>({
    queryKey: ["/api/live-trading/price-history"],
    refetchInterval: 10000,
  });

  const prices = data?.prices || [];
  const hasData = prices.length >= 2;

  const chartData = useMemo(() => {
    if (!hasData) return [];
    return prices.map((p) => ({
      time: new Date(p.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      price: p.price,
    }));
  }, [prices, hasData]);

  const currentPrice = prices.length > 0 ? prices[prices.length - 1].price : null;
  const startPrice = prices.length > 1 ? prices[0].price : null;
  const changeAmt = currentPrice && startPrice ? currentPrice - startPrice : null;
  const changePct = changeAmt && startPrice ? (changeAmt / startPrice) * 100 : null;
  const isUp = (changeAmt ?? 0) >= 0;

  const minPrice = hasData ? Math.min(...prices.map(p => p.price)) : 0;
  const maxPrice = hasData ? Math.max(...prices.map(p => p.price)) : 0;
  const padding = (maxPrice - minPrice) * 0.1 || 1;

  return (
    <Card data-testid="card-live-mini-chart" className="h-full">
      <CardContent className="py-3 px-4 h-full flex flex-col">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Activity className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">XAUUSD Live</span>
          </div>
          {currentPrice && (
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold font-mono" data-testid="text-live-price">
                ${currentPrice.toFixed(2)}
              </span>
              {changeAmt !== null && (
                <span className={`text-xs font-mono font-semibold ${isUp ? "text-emerald-400" : "text-red-400"}`} data-testid="text-price-change">
                  {isUp ? "+" : ""}{changeAmt.toFixed(2)} ({changePct?.toFixed(3)}%)
                </span>
              )}
            </div>
          )}
        </div>
        {hasData ? (
          <div className="flex-1 min-h-[140px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: 5 }}>
                <defs>
                  <linearGradient id="miniChartGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={isUp ? "#10b981" : "#ef4444"} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={isUp ? "#10b981" : "#ef4444"} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <YAxis domain={[minPrice - padding, maxPrice + padding]} hide />
                <XAxis dataKey="time" hide />
                <Tooltip
                  contentStyle={{ background: "#1a1a2e", border: "1px solid #333", borderRadius: 8, fontSize: 11 }}
                  labelStyle={{ color: "#888" }}
                  formatter={(v: number) => [`$${v.toFixed(2)}`, "Price"]}
                />
                <Area
                  type="monotone"
                  dataKey="price"
                  stroke={isUp ? "#10b981" : "#ef4444"}
                  strokeWidth={1.5}
                  fill="url(#miniChartGrad)"
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground min-h-[140px]">
            {prices.length === 0 ? "Waiting for price data..." : "Collecting data points..."}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type AnalystIdea = {
  id: number;
  source: string;
  title: string;
  url: string;
  content: string;
  fetched_at: string;
};

function AnalystInsightsPanel() {
  const { data: ideas, isLoading } = useQuery<AnalystIdea[]>({
    queryKey: ["/api/analyst-ideas"],
    staleTime: 300000,
  });

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/analyst-ideas/refresh");
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/analyst-ideas"] });
    },
  });

  const items = ideas?.slice(0, 3) || [];

  return (
    <Card data-testid="card-analyst-insights">
      <CardContent className="py-3 px-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Newspaper className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">TradingView Analysis</span>
            <Badge variant="outline" className="text-[10px] h-4 px-1.5 border-primary/30 text-primary">Goldviewfx</Badge>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            data-testid="button-refresh-analyst-dashboard"
          >
            <RefreshCw className={`w-3 h-3 mr-1 ${refreshMutation.isPending ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
        {isLoading ? (
          <div className="text-xs text-muted-foreground">Loading analyst insights...</div>
        ) : items.length === 0 ? (
          <div className="text-xs text-muted-foreground">No analyst insights available. Click Refresh to fetch latest from TradingView.</div>
        ) : (
          <div className="space-y-2">
            {items.map((idea) => {
              const age = Math.round((Date.now() - new Date(idea.fetched_at).getTime()) / (1000 * 60 * 60));
              const ageStr = age < 1 ? "just now" : age < 24 ? `${age}h ago` : `${Math.round(age / 24)}d ago`;
              return (
                <div key={idea.id} className="bg-muted/40 rounded-md p-2.5" data-testid={`dashboard-analyst-idea-${idea.id}`}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-medium text-xs truncate">{idea.title}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] text-muted-foreground">{ageStr}</span>
                      <a href={idea.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" data-testid={`link-analyst-idea-${idea.id}`}>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground line-clamp-2">{idea.content}</p>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LiveTradingStatsPanel() {
  const { data: liveStatus, isLoading } = useQuery<LiveStatus>({
    queryKey: ["/api/live-trading/status"],
    refetchInterval: 5000,
  });

  const trader = liveStatus?.trader;
  const tradeCounts = liveStatus?.tradeCounts;
  const { data: ctraderDealData } = useQuery<{ deals: any[]; count: number }>({
    queryKey: ["/api/live-trading/ctrader-deals"],
    refetchInterval: 30000,
  });
  const ctraderDealCount = ctraderDealData?.count || 0;
  const brokerBalance = liveStatus?.connection?.balance || liveStatus?.trader?.balance || 0;
  const startBal = liveStatus?.startingBalance || 3000;
  const accountPnl = (liveStatus?.accountPnl && liveStatus.accountPnl !== 0) ? liveStatus.accountPnl : (brokerBalance > 0 ? brokerBalance - startBal : 0);
  const gvz = liveStatus?.gvz;
  const cot = liveStatus?.cot;

  const regimeLabel = trader?.regime || "Unknown";
  const regimeColor = regimeLabel === "range"
    ? "text-blue-400"
    : regimeLabel === "trend"
    ? "text-amber-400"
    : "text-muted-foreground";

  const positionCount = trader?.positions?.length ?? 0;
  const totalUnrealizedPnl = trader?.positions?.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0) ?? 0;

  return (
    <div className="space-y-4" data-testid="panel-live-trading-stats">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Daily P&L"
          value={trader ? `${trader.dailyPnl >= 0 ? "+" : ""}$${trader.dailyPnl.toFixed(2)}` : "--"}
          sub={trader ? `${trader.tradestoday} trade${trader.tradestoday !== 1 ? "s" : ""} today` : undefined}
          positive={trader ? trader.dailyPnl >= 0 : undefined}
          icon={DollarSign}
          loading={isLoading}
        />
        <StatCard
          label="Account P&L"
          value={`${accountPnl >= 0 ? "+" : ""}$${accountPnl.toFixed(2)}`}
          sub={`${Math.max(ctraderDealCount, tradeCounts?.allTime || 0)} all-time trades`}
          positive={accountPnl >= 0}
          icon={accountPnl >= 0 ? TrendingUp : TrendingDown}
          loading={isLoading}
        />
        <StatCard
          label="Current Regime"
          value={trader?.regime ? regimeLabel.charAt(0).toUpperCase() + regimeLabel.slice(1) : "--"}
          sub={trader?.regime ? `Regime: ${trader.regime.replace(/_/g, " ")}` : undefined}
          icon={Layers}
          loading={isLoading}
        />
        <StatCard
          label="Open Positions"
          value={positionCount.toString()}
          sub={positionCount > 0 ? `Unrealized: ${totalUnrealizedPnl >= 0 ? "+" : ""}$${totalUnrealizedPnl.toFixed(2)}` : "No open trades"}
          positive={positionCount > 0 ? totalUnrealizedPnl >= 0 : undefined}
          icon={Target}
          loading={isLoading}
        />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Trades Today"
          value={tradeCounts ? `${tradeCounts.today}` : "--"}
          sub={tradeCounts ? `${tradeCounts.thisWeek} this week` : undefined}
          icon={BarChart3}
          loading={isLoading}
        />
        <StatCard
          label="This Month"
          value={tradeCounts ? `${tradeCounts.thisMonth}` : "--"}
          sub={`${Math.max(ctraderDealCount, tradeCounts?.allTime || 0)} all-time`}
          icon={Activity}
          loading={isLoading}
        />
        <StatCard
          label="Consec. Losses"
          value={trader ? `${trader.consecutiveLosses}` : "--"}
          sub={trader && trader.consecutiveLosses >= 2 ? "Trading paused" : "Within limits"}
          positive={trader ? trader.consecutiveLosses < 2 : undefined}
          icon={ShieldAlert}
          loading={isLoading}
        />
        <StatCard
          label="Bot Status"
          value={trader?.running ? "Running" : "Stopped"}
          sub={liveStatus?.connected ? "cTrader connected" : "Not connected"}
          positive={trader?.running ? true : false}
          icon={trader?.running ? Activity : Ban}
          loading={isLoading}
        />
      </div>

      {(gvz || cot) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {gvz && (
            <Card data-testid="card-gvz-status">
              <CardContent className="py-3 px-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-primary" />
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">GVZ (Gold VIX)</span>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold font-mono" data-testid="text-gvz-value">{gvz.value.toFixed(2)}</div>
                    <div className="text-[10px] text-muted-foreground">
                      Percentile: {gvz.percentile.toFixed(0)}%
                      {gvz.percentile < 25 && <Badge className="ml-1 text-[9px] h-4 bg-blue-500/20 text-blue-400 border-blue-500/30">Range Confirm</Badge>}
                      {gvz.percentile > 75 && <Badge className="ml-1 text-[9px] h-4 bg-amber-500/20 text-amber-400 border-amber-500/30">Trend Confirm</Badge>}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          {cot && (
            <Card data-testid="card-cot-status">
              <CardContent className="py-3 px-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Globe className="w-3.5 h-3.5 text-primary" />
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">COT Sentiment</span>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold font-mono" data-testid="text-cot-net">
                      {cot.netPosition.toLocaleString()}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      P{cot.percentile.toFixed(0)} —{" "}
                      <Badge className={`text-[9px] h-4 ${cot.sentiment === "BULLISH" ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" : cot.sentiment === "BEARISH" ? "bg-red-500/20 text-red-400 border-red-500/30" : "bg-muted text-muted-foreground border-border"}`}>
                        {cot.sentiment}
                      </Badge>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {trader && (trader.positions ?? []).length > 0 && (
        <Card data-testid="card-open-positions">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Open Positions</CardTitle>
            <CardDescription className="text-xs">{trader.positions.length} active position{trader.positions.length > 1 ? "s" : ""}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="text-left pb-2 font-medium">Side</th>
                    <th className="text-right pb-2 font-medium">Entry</th>
                    <th className="text-right pb-2 font-medium">Current</th>
                    <th className="text-right pb-2 font-medium">Volume</th>
                    <th className="text-right pb-2 font-medium">SL</th>
                    <th className="text-right pb-2 font-medium">TP</th>
                    <th className="text-right pb-2 font-medium">Unrealized P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {trader.positions.map((pos: any, i: number) => {
                    const isBuy = pos.tradeSide === 1;
                    return (
                      <tr key={pos.positionId || i} className="border-b last:border-0" data-testid={`row-position-${pos.positionId || i}`}>
                        <td className="py-2">
                          <Badge variant="outline" className={`text-xs ${isBuy ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "border-red-500/40 text-red-600 dark:text-red-400"}`}>
                            {isBuy ? "Buy" : "Sell"}
                          </Badge>
                        </td>
                        <td className="py-2 text-right font-mono text-xs">{pos.entryPrice?.toFixed(2) || "—"}</td>
                        <td className="py-2 text-right font-mono text-xs">{trader.currentPrice?.toFixed(2) || "—"}</td>
                        <td className="py-2 text-right font-mono text-xs">{((pos.volume || 0) / 100).toFixed(2)}</td>
                        <td className="py-2 text-right font-mono text-xs">{pos.stopLoss?.toFixed(2) || "—"}</td>
                        <td className="py-2 text-right font-mono text-xs">{pos.takeProfit?.toFixed(2) || "—"}</td>
                        <td className={`py-2 text-right font-mono text-xs font-medium ${(pos.unrealizedPnl || 0) >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}`}>
                          {(pos.unrealizedPnl || 0) >= 0 ? "+" : ""}${(pos.unrealizedPnl || 0).toFixed(2)}
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

      {trader && (trader.logs ?? []).length > 0 && (
        <Card data-testid="card-recent-logs">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recent Bot Activity</CardTitle>
            <CardDescription className="text-xs">Latest trading bot log entries</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-48 overflow-y-auto space-y-1 font-mono text-[11px]">
              {trader.logs.slice(-15).reverse().map((log, i) => {
                const logText = typeof log === "string" ? log : `[${log.type}] ${log.message}`;
                const ts = typeof log === "object" && log.timestamp
                  ? new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                  : "";
                return (
                  <div key={i} className="text-muted-foreground py-0.5 border-b border-border/30 last:border-0" data-testid={`text-log-${i}`}>
                    {ts && <span className="text-[10px] text-muted-foreground/60 mr-2">{ts}</span>}
                    {logText}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const [showAnalysis, setShowAnalysis] = useState(false);

  const { data: asianMarkets } = useQuery<AsianMarketSnapshot[]>({
    queryKey: ["/api/market/asian"],
  });

  const hasAsianData = asianMarkets && asianMarkets.length > 0 && asianMarkets.some(a => a.price > 0);

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="p-6 border-b bg-background/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold" data-testid="heading-dashboard">Dashboard</h1>
            <div className="text-sm text-muted-foreground mt-0.5">
              Live trading overview — XAUUSD Gold
            </div>
            <PageGuide
              title="Dashboard — Your Trading Command Centre"
              summary="This is your at-a-glance overview of everything happening with your gold trading bot. All the key numbers, charts, and status indicators are right here."
              steps={[
                { title: "Live P&L", description: "See your profit and loss for today, this week, this month, and all time. Green is good, red means losses." },
                { title: "Market Regime", description: "The bot classifies the market as Range (sideways), Trend (strong direction), or No-Trade (too risky). This determines whether the bot will take trades." },
                { title: "Bot Status", description: "Shows whether the trading bot is connected, running, and whether any positions are currently open." },
                { title: "Trading Conditions", description: "15 safety checks the bot runs before every trade — session hours, news blackout, spread check, drawdown limits, and more. Green means the condition is met." },
                { title: "Price Charts", description: "Live gold price with key levels (support, resistance, midpoint). Switch between H1 and H4 timeframes using the buttons." },
                { title: "Market Intelligence", description: "GVZ (gold volatility index), COT (institutional positioning), Asian market sentiment, and analyst ideas — all feeding into the bot's decisions." },
              ]}
              tips={[
                "If the regime shows 'No Trade', the bot is sitting out — this is normal and protects your capital.",
                "The conditions panel tells you exactly why the bot isn't trading if all lights aren't green.",
              ]}
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" size="sm" asChild data-testid="button-go-backtest">
              <Link href="/backtest">
                <BarChart3 className="w-4 h-4 mr-1.5" />
                Run Backtest
              </Link>
            </Button>
            <Button onClick={() => setShowAnalysis(true)} data-testid="button-analyze-market">
              <Zap className="w-4 h-4 mr-1.5" />Analyze Market
            </Button>
          </div>
        </div>
      </div>

      <div className="px-6 pt-4 space-y-4">
        <MarketHoursIndicator />
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
          <AccountInfoPanel />
          <LiveMiniChart />
        </div>
      </div>

      <div className="px-6 pt-4">
        <LiveTradingStatsPanel />
      </div>

      <div className="px-6 pt-4">
        <StrategyChart />
      </div>

      {hasAsianData && (
        <div className="px-6 pt-4">
          <Card>
            <CardContent className="py-3 px-5">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-1.5 shrink-0">
                  <Globe className="w-3.5 h-3.5 text-primary" />
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Asian Markets</span>
                </div>
                <div className="flex items-center gap-4 flex-wrap">
                  {asianMarkets!.filter(a => a.price > 0).map((idx) => (
                    <div key={idx.symbol} className="flex items-center gap-2" data-testid={`asian-index-${idx.symbol}`}>
                      <span className="text-xs font-medium">{idx.name}</span>
                      <span className="text-xs font-mono">{idx.price.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
                      <span className={`text-xs font-mono font-semibold ${idx.changePct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}`}>
                        {idx.changePct >= 0 ? "+" : ""}{idx.changePct.toFixed(2)}%
                      </span>
                    </div>
                  ))}
                </div>
                <span className="text-xs text-muted-foreground ml-auto shrink-0">
                  via Twelve Data
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="px-6 pt-4 pb-6">
        <AnalystInsightsPanel />
      </div>

      {showAnalysis && <MarketAnalysisPanel onClose={() => setShowAnalysis(false)} />}
    </div>
  );
}
