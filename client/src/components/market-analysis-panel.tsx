import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  TrendingUp, TrendingDown, Shield, AlertTriangle, Globe, Newspaper,
  Bot, User, ChevronRight, X, Loader2, Target, Clock, Zap, Eye,
  ArrowUpRight, ArrowDownRight, Minus, Play, ImageIcon, TriangleAlert,
  Activity, BarChart3, Volume2,
} from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

type DailyAnalysis = {
  timestamp: string;
  marketOverview: {
    currentPrice: number;
    dailyChange: string;
    regime: string;
    regimeReason: string;
    volatility: string;
    trend: string;
    keyLevels: { resistance: number; support: number; midpoint: number };
  };
  analystInsights: {
    source: string;
    summary: string;
    bias: string;
    keyPoints: string[];
  };
  asianMarkets: {
    sentiment: string;
    details: { name: string; changePct: number }[];
    goldImpact: string;
  };
  newsEvents: {
    highImpact: { event: string; time: string; hoursAway: string }[];
    tradingImplication: string;
  };
  automatedPlan: {
    status: string;
    regime: string;
    direction: string;
    entryZone: string;
    stopLoss: string;
    takeProfit: string;
    riskPerTrade: string;
    reasoning: string;
    warnings: string[];
  };
  manualPlan: {
    bias: string;
    entryIdea: string;
    keyLevelsToWatch: string[];
    bestTimeToTrade: string;
    riskManagement: string;
    alternativeScenario: string;
  };
  confidence: number;
  summary: string;
};

function BiasIcon({ bias }: { bias: string }) {
  if (bias === "BULLISH") return <ArrowUpRight className="w-4 h-4 text-emerald-500" />;
  if (bias === "BEARISH") return <ArrowDownRight className="w-4 h-4 text-red-500" />;
  return <Minus className="w-4 h-4 text-amber-500" />;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    ACTIVE: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    STANDBY: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
    CAUTION: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
    "RISK-ON": "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    "RISK-OFF": "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
    NEUTRAL: "bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30",
    BULLISH: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    BEARISH: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
    RANGE: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30",
    TREND: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30",
    NO_TRADE: "bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30",
    BUY: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    SELL: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
    WAIT: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
    LOW: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    NORMAL: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30",
    ELEVATED: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
    HIGH: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
  };
  return (
    <Badge variant="outline" className={`text-xs font-semibold ${colors[status] ?? colors.NEUTRAL}`}>
      {status}
    </Badge>
  );
}

function ConfidenceMeter({ value }: { value: number }) {
  const pct = Math.min(100, Math.max(0, value * 10));
  const color = value >= 7 ? "bg-emerald-500" : value >= 4 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm font-mono font-semibold">{value}/10</span>
    </div>
  );
}

type AnalystIdea = {
  id: number;
  source: string;
  title: string;
  url: string;
  content: string;
  chart_url: string | null;
  video_url: string | null;
  fetched_at: string;
};

export function MarketAnalysisPanel({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<"automated" | "manual">("automated");
  const [expandedIdea, setExpandedIdea] = useState<number | null>(null);

  const analysisMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/ai/daily-analysis");
      return (await res.json()) as DailyAnalysis;
    },
  });

  const { data: analystIdeas } = useQuery<AnalystIdea[]>({
    queryKey: ["/api/analyst-ideas"],
  });

  const { data: techIndicators } = useQuery<{
    indicators: {
      price: number;
      timestamp: string;
      sma: { sma50: number | null; sma200: number | null; priceAboveSMA50: boolean; priceAboveSMA200: boolean; goldenCross: boolean };
      macd: { line: number | null; signal: number | null; histogram: number | null; bullish: boolean; increasing: boolean };
      dmi: { adx: number | null; plusDI: number | null; minusDI: number | null; trendStrength: string; bullish: boolean };
      atr: number | null;
      rsi: number | null;
      volume: {
        current: number;
        sma20: number | null;
        ratio: number | null;
        status: string;
        obv: number;
        obvTrend: string;
        vwap: number | null;
        priceAboveVWAP: boolean;
      } | null;
    } | null;
  }>({
    queryKey: ["/api/technical-indicators"],
    refetchInterval: 60000,
  });

  const analysis = analysisMutation.data;
  const isLoading = analysisMutation.isPending;

  useEffect(() => {
    analysisMutation.mutate();
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" data-testid="market-analysis-overlay">
      <div className="fixed inset-4 md:inset-8 lg:inset-12 bg-background border rounded-xl shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b bg-muted/30">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Target className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="text-lg font-bold" data-testid="text-analysis-title">Daily Market Analysis</h2>
              <p className="text-xs text-muted-foreground">
                {analysis ? `Generated ${new Date(analysis.timestamp).toLocaleTimeString()}` : "AI-powered comprehensive analysis"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!analysis && !isLoading && (
              <Button onClick={() => analysisMutation.mutate()} size="sm" data-testid="button-generate-analysis">
                <Zap className="w-4 h-4 mr-1.5" />
                Generate Analysis
              </Button>
            )}
            {analysis && (
              <Button onClick={() => analysisMutation.mutate()} variant="outline" size="sm" disabled={isLoading} data-testid="button-refresh-analysis">
                <Zap className="w-4 h-4 mr-1.5" />
                Refresh
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onClose} data-testid="button-close-analysis">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {isLoading && (
            <div className="flex flex-col items-center justify-center h-full gap-6" data-testid="analysis-loading">
              <Loader2 className="w-10 h-10 animate-spin text-primary" />
              <div className="text-center">
                <p className="font-medium">Doing its Magic...</p>
                <p className="text-sm text-muted-foreground mt-1">Gathering data from all sources — AI, Mr Gold, Asian markets, news events...</p>
              </div>
              <div className="max-w-lg mt-4 bg-muted/30 rounded-lg px-4 py-3" data-testid="risk-disclaimer">
                <div className="flex items-start gap-2">
                  <TriangleAlert className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs font-semibold text-amber-600 dark:text-amber-400 mb-1">Risk Disclaimer</p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Trading gold (XAUUSD) and other financial instruments involves substantial risk of loss and is not suitable for all investors. 
                      Past performance, whether actual or indicated by backtests and simulations, is not indicative of future results. 
                      The analysis, trading plans, and AI-generated insights provided here are for informational and educational purposes only and 
                      do not constitute financial advice, investment recommendations, or solicitation to trade. GoldViewFX analyst content is 
                      third-party material reproduced for educational reference and does not represent the views of this platform. 
                      You should not trade with money you cannot afford to lose. Always conduct your own research and consult with a licensed 
                      financial advisor before making any trading decisions. The developers of this platform accept no liability for any losses 
                      incurred from the use of this software or its analysis.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {analysisMutation.isError && (
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <AlertTriangle className="w-10 h-10 text-destructive" />
              <p className="text-sm text-destructive">{analysisMutation.error?.message ?? "Analysis failed"}</p>
              <Button onClick={() => analysisMutation.mutate()} size="sm">Try Again</Button>
            </div>
          )}

          {!analysis && !isLoading && !analysisMutation.isError && (
            <div className="flex flex-col items-center justify-center h-full gap-6">
              <div className="w-20 h-20 rounded-full bg-primary/5 flex items-center justify-center">
                <Target className="w-10 h-10 text-primary/50" />
              </div>
              <div className="text-center max-w-md">
                <h3 className="font-semibold text-lg mb-2">Ready to Analyze</h3>
                <p className="text-sm text-muted-foreground">
                  Click "Generate Analysis" to get a comprehensive breakdown of today's gold market — 
                  including AI insights, Mr Gold's analysis, Asian market sentiment, news events, 
                  and both automated and manual trading plans.
                </p>
              </div>
              <Button onClick={() => analysisMutation.mutate()} size="lg" data-testid="button-generate-analysis-center">
                <Zap className="w-5 h-5 mr-2" />
                Generate Daily Analysis
              </Button>
            </div>
          )}

          {analysis && (
            <div className="space-y-6 max-w-6xl mx-auto">
              <Card className="border-primary/20 bg-primary/5">
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start gap-3">
                    <Eye className="w-5 h-5 text-primary mt-0.5 shrink-0" />
                    <div className="flex-1">
                      <p className="text-sm leading-relaxed" data-testid="text-analysis-summary">{analysis.summary}</p>
                      <div className="mt-3">
                        <p className="text-xs text-muted-foreground mb-1 font-medium">Analysis Confidence</p>
                        <ConfidenceMeter value={analysis.confidence} />
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <Card>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-muted-foreground font-medium">XAUUSD</span>
                      <StatusBadge status={analysis.marketOverview.regime} />
                    </div>
                    <p className="text-2xl font-bold font-mono" data-testid="text-current-price">
                      ${analysis.marketOverview.currentPrice.toFixed(2)}
                    </p>
                    <p className={`text-sm font-mono ${analysis.marketOverview.dailyChange.startsWith('+') ? 'text-emerald-600 dark:text-emerald-400' : analysis.marketOverview.dailyChange.startsWith('-') ? 'text-red-500' : 'text-muted-foreground'}`}>
                      {analysis.marketOverview.dailyChange}
                    </p>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-muted-foreground font-medium">Trend</span>
                      <StatusBadge status={analysis.marketOverview.trend} />
                    </div>
                    <p className="text-sm mt-1">{analysis.marketOverview.regimeReason}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-xs text-muted-foreground">Volatility:</span>
                      <StatusBadge status={analysis.marketOverview.volatility} />
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-muted-foreground font-medium">Asian Markets</span>
                      <StatusBadge status={analysis.asianMarkets.sentiment} />
                    </div>
                    <div className="space-y-1">
                      {analysis.asianMarkets.details.map((d) => (
                        <div key={d.name} className="flex items-center justify-between text-xs">
                          <span>{d.name}</span>
                          <span className={`font-mono ${d.changePct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
                            {d.changePct >= 0 ? '+' : ''}{d.changePct.toFixed(2)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-muted-foreground font-medium">Key Levels</span>
                      <Target className="w-3.5 h-3.5 text-muted-foreground" />
                    </div>
                    <div className="space-y-1.5 text-xs font-mono">
                      <div className="flex justify-between">
                        <span className="text-red-500">Resistance</span>
                        <span>${analysis.marketOverview.keyLevels.resistance.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Midpoint</span>
                        <span>${analysis.marketOverview.keyLevels.midpoint.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-emerald-500">Support</span>
                        <span>${analysis.marketOverview.keyLevels.support.toFixed(2)}</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {techIndicators?.indicators && (
                <Card data-testid="technical-indicators-card">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Activity className="w-4 h-4 text-blue-500" />
                      Technical Indicators (H1)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                      <div className="space-y-2" data-testid="indicator-sma">
                        <div className="flex items-center gap-2 mb-1">
                          <BarChart3 className="w-3.5 h-3.5 text-blue-500" />
                          <span className="text-xs font-semibold text-muted-foreground">MOVING AVERAGES</span>
                        </div>
                        <div className="space-y-1.5 text-xs">
                          {techIndicators.indicators.sma.sma50 !== null && (
                            <div className="flex justify-between items-center">
                              <span>SMA 50</span>
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono">${techIndicators.indicators.sma.sma50.toFixed(2)}</span>
                                <span className={techIndicators.indicators.sma.priceAboveSMA50 ? "text-emerald-500" : "text-red-500"}>
                                  {techIndicators.indicators.sma.priceAboveSMA50 ? "▲" : "▼"}
                                </span>
                              </div>
                            </div>
                          )}
                          {techIndicators.indicators.sma.sma200 !== null && (
                            <div className="flex justify-between items-center">
                              <span>SMA 200</span>
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono">${techIndicators.indicators.sma.sma200.toFixed(2)}</span>
                                <span className={techIndicators.indicators.sma.priceAboveSMA200 ? "text-emerald-500" : "text-red-500"}>
                                  {techIndicators.indicators.sma.priceAboveSMA200 ? "▲" : "▼"}
                                </span>
                              </div>
                            </div>
                          )}
                          {techIndicators.indicators.sma.sma50 !== null && techIndicators.indicators.sma.sma200 !== null && (
                            <div className="flex justify-between items-center pt-1 border-t border-dashed">
                              <span>Cross</span>
                              <Badge variant="outline" className={`text-[10px] ${techIndicators.indicators.sma.goldenCross ? "text-emerald-600 border-emerald-500/30" : "text-red-500 border-red-500/30"}`}>
                                {techIndicators.indicators.sma.goldenCross ? "Golden Cross" : "Death Cross"}
                              </Badge>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="space-y-2" data-testid="indicator-macd">
                        <div className="flex items-center gap-2 mb-1">
                          <Activity className="w-3.5 h-3.5 text-purple-500" />
                          <span className="text-xs font-semibold text-muted-foreground">MACD (12, 26, 9)</span>
                        </div>
                        <div className="space-y-1.5 text-xs">
                          {techIndicators.indicators.macd.line !== null && (
                            <div className="flex justify-between">
                              <span>MACD Line</span>
                              <span className="font-mono">{techIndicators.indicators.macd.line.toFixed(2)}</span>
                            </div>
                          )}
                          {techIndicators.indicators.macd.signal !== null && (
                            <div className="flex justify-between">
                              <span>Signal</span>
                              <span className="font-mono">{techIndicators.indicators.macd.signal.toFixed(2)}</span>
                            </div>
                          )}
                          {techIndicators.indicators.macd.histogram !== null && (
                            <div className="flex justify-between items-center">
                              <span>Histogram</span>
                              <div className="flex items-center gap-1.5">
                                <span className={`font-mono font-semibold ${techIndicators.indicators.macd.bullish ? "text-emerald-600" : "text-red-500"}`}>
                                  {techIndicators.indicators.macd.histogram.toFixed(2)}
                                </span>
                                <span className="text-[10px] text-muted-foreground">
                                  {techIndicators.indicators.macd.increasing ? "▲" : "▼"}
                                </span>
                              </div>
                            </div>
                          )}
                          <div className="flex justify-between items-center pt-1 border-t border-dashed">
                            <span>Signal</span>
                            <Badge variant="outline" className={`text-[10px] ${techIndicators.indicators.macd.bullish ? "text-emerald-600 border-emerald-500/30" : "text-red-500 border-red-500/30"}`}>
                              {techIndicators.indicators.macd.bullish ? "Bullish" : "Bearish"}
                            </Badge>
                          </div>
                        </div>
                      </div>

                      <div className="space-y-2" data-testid="indicator-dmi">
                        <div className="flex items-center gap-2 mb-1">
                          <TrendingUp className="w-3.5 h-3.5 text-amber-500" />
                          <span className="text-xs font-semibold text-muted-foreground">DMI / ADX (14)</span>
                        </div>
                        <div className="space-y-1.5 text-xs">
                          {techIndicators.indicators.dmi.adx !== null && (
                            <div className="flex justify-between items-center">
                              <span>ADX</span>
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono font-semibold">{techIndicators.indicators.dmi.adx.toFixed(1)}</span>
                                <Badge variant="outline" className="text-[10px]">{techIndicators.indicators.dmi.trendStrength}</Badge>
                              </div>
                            </div>
                          )}
                          {techIndicators.indicators.dmi.plusDI !== null && (
                            <div className="flex justify-between">
                              <span className="text-emerald-600">+DI</span>
                              <span className="font-mono">{techIndicators.indicators.dmi.plusDI.toFixed(1)}</span>
                            </div>
                          )}
                          {techIndicators.indicators.dmi.minusDI !== null && (
                            <div className="flex justify-between">
                              <span className="text-red-500">-DI</span>
                              <span className="font-mono">{techIndicators.indicators.dmi.minusDI.toFixed(1)}</span>
                            </div>
                          )}
                          <div className="flex justify-between items-center pt-1 border-t border-dashed">
                            <span>Direction</span>
                            <Badge variant="outline" className={`text-[10px] ${techIndicators.indicators.dmi.bullish ? "text-emerald-600 border-emerald-500/30" : "text-red-500 border-red-500/30"}`}>
                              {techIndicators.indicators.dmi.bullish ? "Bullish (+DI > -DI)" : "Bearish (-DI > +DI)"}
                            </Badge>
                          </div>
                        </div>
                      </div>

                      <div className="space-y-2" data-testid="indicator-volume">
                        <div className="flex items-center gap-2 mb-1">
                          <Volume2 className="w-3.5 h-3.5 text-cyan-500" />
                          <span className="text-xs font-semibold text-muted-foreground">VOLUME</span>
                        </div>
                        {techIndicators.indicators.volume ? (
                          <div className="space-y-1.5 text-xs">
                            <div className="flex justify-between items-center">
                              <span>Current</span>
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono">{techIndicators.indicators.volume.current.toLocaleString()}</span>
                                <Badge variant="outline" className={`text-[10px] ${
                                  techIndicators.indicators.volume.status === 'High' ? "text-emerald-600 border-emerald-500/30" :
                                  techIndicators.indicators.volume.status === 'Above Avg' ? "text-blue-500 border-blue-500/30" :
                                  techIndicators.indicators.volume.status === 'Low' ? "text-red-500 border-red-500/30" :
                                  "border-muted-foreground/30"
                                }`}>
                                  {techIndicators.indicators.volume.status}
                                </Badge>
                              </div>
                            </div>
                            {techIndicators.indicators.volume.sma20 !== null && (
                              <div className="flex justify-between">
                                <span>SMA(20)</span>
                                <span className="font-mono">{techIndicators.indicators.volume.sma20.toLocaleString()}</span>
                              </div>
                            )}
                            <div className="flex justify-between items-center">
                              <span>OBV</span>
                              <div className="flex items-center gap-1.5">
                                <span className={`font-mono text-[10px] ${techIndicators.indicators.volume.obvTrend === 'Rising' ? "text-emerald-600" : techIndicators.indicators.volume.obvTrend === 'Falling' ? "text-red-500" : ""}`}>
                                  {techIndicators.indicators.volume.obvTrend === 'Rising' ? '▲' : techIndicators.indicators.volume.obvTrend === 'Falling' ? '▼' : '—'}
                                </span>
                                <span className="font-mono text-[10px]">{techIndicators.indicators.volume.obvTrend}</span>
                              </div>
                            </div>
                            {techIndicators.indicators.volume.vwap !== null && (
                              <div className="flex justify-between items-center pt-1 border-t border-dashed">
                                <span>VWAP</span>
                                <div className="flex items-center gap-1.5">
                                  <span className="font-mono">${techIndicators.indicators.volume.vwap.toFixed(2)}</span>
                                  <span className={techIndicators.indicators.volume.priceAboveVWAP ? "text-emerald-500" : "text-red-500"}>
                                    {techIndicators.indicators.volume.priceAboveVWAP ? "▲" : "▼"}
                                  </span>
                                </div>
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="text-[10px] text-muted-foreground italic">Volume data not yet available. Will populate on next data refresh.</p>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4 mt-4 pt-3 border-t">
                      <div className="flex items-center justify-between text-xs" data-testid="indicator-atr">
                        <span className="text-muted-foreground">ATR (14)</span>
                        <span className="font-mono font-semibold">{techIndicators.indicators.atr !== null ? `$${techIndicators.indicators.atr.toFixed(2)}` : "N/A"}</span>
                      </div>
                      <div className="flex items-center justify-between text-xs" data-testid="indicator-rsi">
                        <span className="text-muted-foreground">RSI (14)</span>
                        <span className={`font-mono font-semibold ${
                          techIndicators.indicators.rsi !== null
                            ? techIndicators.indicators.rsi > 70 ? "text-red-500"
                            : techIndicators.indicators.rsi < 30 ? "text-emerald-600"
                            : ""
                            : ""
                        }`}>
                          {techIndicators.indicators.rsi !== null ? techIndicators.indicators.rsi.toFixed(1) : "N/A"}
                          {techIndicators.indicators.rsi !== null && techIndicators.indicators.rsi > 70 ? " (Overbought)" : ""}
                          {techIndicators.indicators.rsi !== null && techIndicators.indicators.rsi < 30 ? " (Oversold)" : ""}
                        </span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Globe className="w-4 h-4 text-amber-500" />
                    Mr Gold (GoldViewFX) Daily Review
                    <BiasIcon bias={analysis.analystInsights.bias} />
                    <StatusBadge status={analysis.analystInsights.bias} />
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm text-muted-foreground" data-testid="text-analyst-summary">{analysis.analystInsights.summary}</p>
                  <div className="space-y-1.5">
                    {analysis.analystInsights.keyPoints.map((point, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <ChevronRight className="w-3 h-3 text-primary mt-0.5 shrink-0" />
                        <span>{point}</span>
                      </div>
                    ))}
                  </div>

                  {analystIdeas && analystIdeas.length > 0 && (
                    <div className="space-y-3 pt-2 border-t">
                      {analystIdeas.slice(0, 3).map((idea) => (
                        <div key={idea.id} className="space-y-2">
                          <div
                            className="flex items-start gap-2 cursor-pointer group"
                            onClick={() => setExpandedIdea(expandedIdea === idea.id ? null : idea.id)}
                            data-testid={`analyst-idea-${idea.id}`}
                          >
                            <ImageIcon className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium group-hover:text-primary transition-colors truncate">
                                {idea.title.replace(/^[A-Za-z0-9]{8}\s+/, '')}
                              </p>
                              <p className="text-[10px] text-muted-foreground">
                                {new Date(idea.fetched_at).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                              </p>
                            </div>
                            {idea.video_url && (
                              <Badge variant="outline" className="text-[10px] border-purple-500/30 text-purple-500 shrink-0">
                                <Play className="w-2.5 h-2.5 mr-0.5" /> Video
                              </Badge>
                            )}
                            <ChevronRight className={`w-3.5 h-3.5 text-muted-foreground transition-transform shrink-0 ${expandedIdea === idea.id ? 'rotate-90' : ''}`} />
                          </div>

                          {expandedIdea === idea.id && (
                            <div className="ml-5 space-y-3">
                              {idea.chart_url && (
                                <div className="rounded-lg overflow-hidden border bg-muted/30">
                                  <img
                                    src={idea.chart_url}
                                    alt={`GoldViewFX chart: ${idea.title}`}
                                    className="w-full h-auto max-h-[300px] object-contain"
                                    loading="lazy"
                                    data-testid={`chart-image-${idea.id}`}
                                  />
                                </div>
                              )}

                              {idea.video_url && (
                                <div className="rounded-lg overflow-hidden border bg-black aspect-video">
                                  {(() => {
                                    const url = idea.video_url!;
                                    let ytId: string | null = null;
                                    try {
                                      const parsed = new URL(url);
                                      if (parsed.hostname.includes("youtube.com") && parsed.searchParams.get("v")) {
                                        ytId = parsed.searchParams.get("v");
                                      } else if (parsed.hostname.includes("youtu.be")) {
                                        ytId = parsed.pathname.slice(1).split("/")[0];
                                      }
                                    } catch {}
                                    if (ytId) {
                                      return (
                                        <iframe
                                          src={`https://www.youtube.com/embed/${ytId}`}
                                          className="w-full h-full"
                                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                          allowFullScreen
                                          title={`GoldViewFX video: ${idea.title}`}
                                          data-testid={`video-embed-${idea.id}`}
                                        />
                                      );
                                    }
                                    return (
                                      <a href={url} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center h-full text-white gap-2 hover:text-primary transition-colors">
                                        <Play className="w-8 h-8" />
                                        <span className="text-sm">Watch Video</span>
                                      </a>
                                    );
                                  })()}
                                </div>
                              )}

                              <div className="text-xs text-muted-foreground leading-relaxed space-y-2">
                                {idea.content.split(/\n\n+/).map((paragraph, pi) => (
                                  <p key={pi}>{paragraph}</p>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Newspaper className="w-4 h-4 text-blue-500" />
                      News Events
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {analysis.newsEvents.highImpact.length > 0 ? (
                      <div className="space-y-2 mb-3">
                        {analysis.newsEvents.highImpact.map((ev, i) => (
                          <div key={i} className="flex items-center justify-between text-xs border rounded-lg px-3 py-2 bg-muted/30">
                            <div className="flex items-center gap-2">
                              <AlertTriangle className="w-3 h-3 text-amber-500" />
                              <span className="font-medium">{ev.event}</span>
                            </div>
                            <div className="flex items-center gap-2 text-muted-foreground">
                              <Clock className="w-3 h-3" />
                              <span>{ev.time}</span>
                              <Badge variant="outline" className="text-[10px]">{ev.hoursAway}</Badge>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground mb-3">No high-impact events today.</p>
                    )}
                    <p className="text-xs text-muted-foreground" data-testid="text-news-implication">{analysis.newsEvents.tradingImplication}</p>
                  </CardContent>
                </Card>
              </div>

              <div className="flex gap-2 mb-2">
                <Button
                  variant={activeTab === "automated" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setActiveTab("automated")}
                  data-testid="tab-automated-plan"
                >
                  <Bot className="w-4 h-4 mr-1.5" />
                  Automated Plan
                </Button>
                <Button
                  variant={activeTab === "manual" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setActiveTab("manual")}
                  data-testid="tab-manual-plan"
                >
                  <User className="w-4 h-4 mr-1.5" />
                  Manual Plan
                </Button>
              </div>

              {activeTab === "automated" && (
                <Card className="border-blue-500/20">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Bot className="w-4 h-4 text-blue-500" />
                        Automated Trading Plan
                      </CardTitle>
                      <div className="flex items-center gap-2">
                        <StatusBadge status={analysis.automatedPlan.status} />
                        <StatusBadge status={analysis.automatedPlan.direction} />
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                      <div className="bg-muted/30 rounded-lg p-3 text-center">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Regime</p>
                        <p className="text-sm font-semibold">{analysis.automatedPlan.regime}</p>
                      </div>
                      <div className="bg-muted/30 rounded-lg p-3 text-center">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Entry Zone</p>
                        <p className="text-sm font-semibold font-mono">{analysis.automatedPlan.entryZone}</p>
                      </div>
                      <div className="bg-muted/30 rounded-lg p-3 text-center">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Stop Loss</p>
                        <p className="text-sm font-semibold font-mono text-red-500">{analysis.automatedPlan.stopLoss}</p>
                      </div>
                      <div className="bg-muted/30 rounded-lg p-3 text-center">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Take Profit</p>
                        <p className="text-sm font-semibold font-mono text-emerald-500">{analysis.automatedPlan.takeProfit}</p>
                      </div>
                    </div>
                    <div className="space-y-3">
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">Reasoning</p>
                        <p className="text-sm" data-testid="text-auto-reasoning">{analysis.automatedPlan.reasoning}</p>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <Shield className="w-3.5 h-3.5 text-blue-500" />
                        <span className="text-muted-foreground">Risk per trade:</span>
                        <span className="font-semibold">{analysis.automatedPlan.riskPerTrade}</span>
                      </div>
                      {analysis.automatedPlan.warnings.length > 0 && (
                        <div className="space-y-1.5 mt-2">
                          {analysis.automatedPlan.warnings.map((w, i) => (
                            <div key={i} className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-500/5 rounded-md px-3 py-2">
                              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                              <span>{w}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}

              {activeTab === "manual" && (
                <Card className="border-purple-500/20">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <User className="w-4 h-4 text-purple-500" />
                        Manual Trading Plan
                      </CardTitle>
                      <div className="flex items-center gap-2">
                        <BiasIcon bias={analysis.manualPlan.bias} />
                        <StatusBadge status={analysis.manualPlan.bias} />
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">Trade Idea</p>
                        <p className="text-sm" data-testid="text-manual-entry">{analysis.manualPlan.entryIdea}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">Key Levels to Watch</p>
                        <div className="space-y-1">
                          {analysis.manualPlan.keyLevelsToWatch.map((level, i) => (
                            <div key={i} className="flex items-start gap-2 text-xs bg-muted/30 rounded-md px-3 py-2">
                              <Target className="w-3 h-3 text-purple-500 mt-0.5 shrink-0" />
                              <span>{level}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <p className="text-xs font-medium text-muted-foreground mb-1">Best Time to Trade</p>
                          <div className="flex items-center gap-2 text-sm">
                            <Clock className="w-3.5 h-3.5 text-muted-foreground" />
                            <span>{analysis.manualPlan.bestTimeToTrade}</span>
                          </div>
                        </div>
                        <div>
                          <p className="text-xs font-medium text-muted-foreground mb-1">Risk Management</p>
                          <div className="flex items-center gap-2 text-sm">
                            <Shield className="w-3.5 h-3.5 text-muted-foreground" />
                            <span>{analysis.manualPlan.riskManagement}</span>
                          </div>
                        </div>
                      </div>
                      <div className="bg-muted/30 rounded-lg p-3">
                        <p className="text-xs font-medium text-muted-foreground mb-1">Alternative Scenario</p>
                        <p className="text-sm" data-testid="text-manual-alternative">{analysis.manualPlan.alternativeScenario}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

            </div>
          )}
        </div>
      </div>
    </div>
  );
}