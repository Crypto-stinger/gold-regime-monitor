import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, BarChart3, RefreshCw } from "lucide-react";
import { createChart, ColorType, CrosshairMode, LineStyle } from "lightweight-charts";
import type { IChartApi, ISeriesApi, CandlestickData, LineData, Time } from "lightweight-charts";

type ChartData = {
  candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
  levels: {
    rangeHigh: number;
    rangeLow: number;
    midpoint: number;
    midBandUpper: number;
    midBandLower: number;
    currentPrice: number;
    atrH1: number;
    slDistance: number;
    tpDistance: number;
    ema50Daily: number | null;
    sma50: { time: number; value: number }[];
    sma200: { time: number; value: number }[];
    regime?: string;
  } | null;
};

export function StrategyChart() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [timeframe, setTimeframe] = useState<"h1" | "h4">("h1");
  const [barCount, setBarCount] = useState(200);
  const [data, setData] = useState<ChartData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSMA, setShowSMA] = useState(true);
  const [showLevels, setShowLevels] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/chart-data?timeframe=${timeframe}&count=${barCount}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error("Failed to fetch chart data:", err);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [timeframe, barCount]);

  useEffect(() => {
    if (!chartContainerRef.current || !data || data.candles.length === 0) return;

    if (chartRef.current) {
      try { chartRef.current.remove(); } catch {}
      chartRef.current = null;
    }

    const container = chartContainerRef.current;
    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9ca3af",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(255,255,255,0.15)", labelBackgroundColor: "#1f2937" },
        horzLine: { color: "rgba(255,255,255,0.15)", labelBackgroundColor: "#1f2937" },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.1)",
        scaleMargins: { top: 0.1, bottom: 0.15 },
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.1)",
        timeVisible: true,
        secondsVisible: false,
      },
    });

    chartRef.current = chart;

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderDownColor: "#ef4444",
      borderUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      wickUpColor: "#22c55e",
    });

    const sorted = [...data.candles].sort((a, b) => a.time - b.time);
    const deduped: typeof sorted = [];
    for (const c of sorted) {
      if (deduped.length === 0 || c.time > deduped[deduped.length - 1].time) {
        deduped.push(c);
      }
    }

    const candleData: CandlestickData<Time>[] = deduped.map((c) => ({
      time: c.time as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    candleSeries.setData(candleData);

    const hasVolume = deduped.some(c => c.volume > 0);
    if (hasVolume) {
      const volumeSeries = chart.addHistogramSeries({
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
      });
      chart.priceScale("volume").applyOptions({
        scaleMargins: { top: 0.85, bottom: 0 },
      });
      volumeSeries.setData(
        deduped.map((c) => ({
          time: c.time as Time,
          value: c.volume,
          color: c.close >= c.open ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)",
        }))
      );
    }

    if (data.levels && showLevels) {
      const levels = data.levels;

      candleSeries.createPriceLine({
        price: levels.rangeHigh,
        color: "#ef4444",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: "Resistance",
      });

      candleSeries.createPriceLine({
        price: levels.rangeLow,
        color: "#22c55e",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: "Support",
      });

      candleSeries.createPriceLine({
        price: levels.midpoint,
        color: "#f59e0b",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "Mid",
      });

      candleSeries.createPriceLine({
        price: levels.midBandUpper,
        color: "rgba(245,158,11,0.3)",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
        title: "",
      });
      candleSeries.createPriceLine({
        price: levels.midBandLower,
        color: "rgba(245,158,11,0.3)",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
        title: "",
      });

      if (levels.ema50Daily) {
        candleSeries.createPriceLine({
          price: levels.ema50Daily,
          color: "#a855f7",
          lineWidth: 1,
          lineStyle: LineStyle.LargeDashed,
          axisLabelVisible: true,
          title: "D EMA50",
        });
      }
    }

    if (data.levels && showSMA) {
      if (data.levels.sma50 && data.levels.sma50.length > 0) {
        const sma50Series = chart.addLineSeries({
          color: "#3b82f6",
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        sma50Series.setData(
          data.levels.sma50.map((d) => ({ time: d.time as Time, value: d.value }))
        );
      }

      if (data.levels.sma200 && data.levels.sma200.length > 0) {
        const sma200Series = chart.addLineSeries({
          color: "#f97316",
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        sma200Series.setData(
          data.levels.sma200.map((d) => ({ time: d.time as Time, value: d.value }))
        );
      }
    }

    chart.timeScale().fitContent();

    let disposed = false;
    const resizeObserver = new ResizeObserver((entries) => {
      if (disposed || entries.length === 0) return;
      try {
        const { width, height } = entries[0].contentRect;
        if (width > 0 && height > 0) {
          chart.applyOptions({ width, height });
        }
      } catch {}
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      try { chart.remove(); } catch {}
      chartRef.current = null;
    };
  }, [data, showSMA, showLevels]);

  const levels = data?.levels;

  return (
    <Card className="overflow-hidden" data-testid="strategy-chart-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-primary" />
            XAUUSD Strategy Chart
            {levels?.regime && (
              <Badge variant="outline" className={`text-[10px] ml-1 ${
                levels.regime === "trend" ? "text-purple-400 border-purple-500/30" :
                levels.regime === "range" ? "text-blue-400 border-blue-500/30" :
                "text-gray-400 border-gray-500/30"
              }`}>
                {levels.regime.toUpperCase()}
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-1.5" data-testid="chart-controls">
            <div className="flex rounded-md border border-border overflow-hidden">
              {(["h1", "h4"] as const).map((tf) => (
                <button
                  key={tf}
                  onClick={() => setTimeframe(tf)}
                  className={`px-2.5 py-1 text-[10px] font-semibold transition-colors ${
                    timeframe === tf
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/30 text-muted-foreground hover:bg-muted/60"
                  }`}
                  data-testid={`button-tf-${tf}`}
                >
                  {tf.toUpperCase()}
                </button>
              ))}
            </div>
            <div className="flex rounded-md border border-border overflow-hidden">
              {[100, 200, 300, 500].map((n) => (
                <button
                  key={n}
                  onClick={() => setBarCount(n)}
                  className={`px-2 py-1 text-[10px] font-semibold transition-colors ${
                    barCount === n
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/30 text-muted-foreground hover:bg-muted/60"
                  }`}
                  data-testid={`button-bars-${n}`}
                >
                  {n}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowLevels(!showLevels)}
              className={`px-2 py-1 text-[10px] font-semibold rounded border transition-colors ${
                showLevels ? "bg-amber-500/20 text-amber-400 border-amber-500/30" : "bg-muted/30 text-muted-foreground border-border"
              }`}
              data-testid="button-toggle-levels"
            >
              Levels
            </button>
            <button
              onClick={() => setShowSMA(!showSMA)}
              className={`px-2 py-1 text-[10px] font-semibold rounded border transition-colors ${
                showSMA ? "bg-blue-500/20 text-blue-400 border-blue-500/30" : "bg-muted/30 text-muted-foreground border-border"
              }`}
              data-testid="button-toggle-sma"
            >
              SMA
            </button>
            <Button variant="ghost" size="sm" onClick={fetchData} className="h-6 w-6 p-0" data-testid="button-refresh-chart">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0 relative">
        {loading && !data && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        )}
        <div ref={chartContainerRef} className="w-full h-[450px]" data-testid="chart-container" />
        {levels && (
          <div className="px-4 pb-3 pt-1 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground border-t border-border/50">
            <span>
              <span className="text-red-400">■</span> Resistance: ${levels.rangeHigh}
            </span>
            <span>
              <span className="text-emerald-400">■</span> Support: ${levels.rangeLow}
            </span>
            <span>
              <span className="text-amber-400">■</span> Mid: ${levels.midpoint}
            </span>
            {levels.ema50Daily && (
              <span>
                <span className="text-purple-400">■</span> D.EMA50: ${levels.ema50Daily}
              </span>
            )}
            {showSMA && (
              <>
                <span><span className="text-blue-400">—</span> SMA50</span>
                <span><span className="text-orange-400">—</span> SMA200</span>
              </>
            )}
            <span className="ml-auto">ATR: ${levels.atrH1} | SL: ${levels.slDistance} | TP: ${levels.tpDistance}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
