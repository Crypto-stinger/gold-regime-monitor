import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageGuide } from "@/components/page-guide";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { Search, TrendingUp, TrendingDown, FlaskConical, ArrowRight } from "lucide-react";
import { ExportMenu } from "@/components/export-menu";
import type { BacktestResult } from "@shared/schema";

type BacktestSummary = Omit<BacktestResult, "trades" | "equityCurve"> & { tradeCount: number };

export default function TradesPage() {
  const [search, setSearch] = useState("");
  const [regimeFilter, setRegimeFilter] = useState<"all" | "trend" | "range">("all");
  const [resultFilter, setResultFilter] = useState<"all" | "win" | "loss">("all");
  const [sideFilter, setSideFilter] = useState<"all" | "buy" | "sell">("all");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");

  const { data: backtests } = useQuery<BacktestSummary[]>({ queryKey: ["/api/backtests"] });
  const { data: activeSummaryData } = useQuery<{ matchingBacktest?: { id: string } }>({
    queryKey: ["/api/active-strategy-summary"],
    staleTime: 0,
  });
  const activeMatchId = activeSummaryData?.matchingBacktest?.id;
  const latest = (activeMatchId ? backtests?.find(b => b.id === activeMatchId) : null) ?? backtests?.[0];
  const { data: fullResult, isLoading } = useQuery<BacktestResult>({
    queryKey: ["/api/backtest", latest?.id],
    enabled: !!latest?.id,
  });

  const trades = fullResult?.trades ?? [];

  const filtered = useMemo(() => {
    let result = [...trades];
    if (regimeFilter !== "all") result = result.filter((t) => t.regime === regimeFilter);
    if (resultFilter === "win") result = result.filter((t) => t.pnl > 0);
    if (resultFilter === "loss") result = result.filter((t) => t.pnl <= 0);
    if (sideFilter !== "all") result = result.filter((t) => t.side === sideFilter);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((t) =>
        t.entryTime.includes(q) || t.regime.includes(q) || t.side.includes(q) || t.entryReason.includes(q)
      );
    }
    result.sort((a, b) => {
      const at = new Date(a.exitTime).getTime();
      const bt = new Date(b.exitTime).getTime();
      return sortDir === "desc" ? bt - at : at - bt;
    });
    return result;
  }, [trades, regimeFilter, resultFilter, sideFilter, search, sortDir]);

  const hasData = trades.length > 0;

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="p-6 border-b bg-background/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold" data-testid="heading-trades">Test Log</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {hasData ? `${trades.length} trades from active strategy backtest` : "No backtest run yet"}
            </p>
            <PageGuide
              title="Test Log — Every Backtest Trade in Detail"
              summary="This page shows every individual trade from your most recent backtest. It's your audit trail — see exactly when the bot entered and exited, at what price, and whether it won or lost."
              steps={[
                { title: "Review the Table", description: "Each row is one trade showing: entry/exit time, direction (buy/sell), entry/exit price, stop loss, take profit, and the profit or loss in dollars." },
                { title: "Filter and Search", description: "Use the filters to focus on wins only, losses only, or specific date ranges." },
                { title: "Understand Patterns", description: "Look for patterns — are losses clustered at certain times? Are wins bigger during specific sessions? This helps refine your strategy." },
              ]}
              tips={[
                "Run a backtest first to populate this page with trade data.",
                "Export the data using the export button if you want to analyse trades in a spreadsheet.",
              ]}
            />
          </div>
          {fullResult && <ExportMenu result={fullResult} />}
        </div>
      </div>

      {!hasData && !isLoading && (
        <div className="flex-1 flex items-center justify-center p-12">
          <div className="text-center max-w-sm">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
              <FlaskConical className="w-8 h-8 text-primary" />
            </div>
            <h2 className="text-lg font-semibold mb-2">No Trades Yet</h2>
            <p className="text-sm text-muted-foreground mb-6">Run a backtest first to populate the trade log.</p>
            <Button asChild data-testid="button-go-to-backtest">
              <Link href="/backtest">Run Backtest <ArrowRight className="w-4 h-4 ml-1.5" /></Link>
            </Button>
          </div>
        </div>
      )}

      {(hasData || isLoading) && (
        <div className="p-6 space-y-5">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-40">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input placeholder="Search by date, regime, reason..." value={search}
                onChange={(e) => setSearch(e.target.value)} className="pl-8" data-testid="input-search-trades" />
            </div>

            <Select value={regimeFilter} onValueChange={(v: any) => setRegimeFilter(v)}>
              <SelectTrigger className="w-32" data-testid="select-regime-filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Regimes</SelectItem>
                <SelectItem value="trend">Trend</SelectItem>
                <SelectItem value="range">Range</SelectItem>
              </SelectContent>
            </Select>

            <Select value={resultFilter} onValueChange={(v: any) => setResultFilter(v)}>
              <SelectTrigger className="w-28" data-testid="select-result-filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Results</SelectItem>
                <SelectItem value="win">Wins</SelectItem>
                <SelectItem value="loss">Losses</SelectItem>
              </SelectContent>
            </Select>

            <Select value={sideFilter} onValueChange={(v: any) => setSideFilter(v)}>
              <SelectTrigger className="w-28" data-testid="select-side-filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Sides</SelectItem>
                <SelectItem value="buy">Buy</SelectItem>
                <SelectItem value="sell">Sell</SelectItem>
              </SelectContent>
            </Select>

            <Button variant="outline" size="sm"
              onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
              data-testid="button-sort-date">
              Date {sortDir === "desc" ? "Newest" : "Oldest"}
            </Button>

            <span className="text-xs text-muted-foreground ml-auto">{filtered.length} trades</span>
          </div>

          {/* Table */}
          <Card>
            <CardContent className="pt-4 px-0">
              {isLoading ? (
                <div className="space-y-2 px-5">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-xs text-muted-foreground">
                        {[
                          { key: "entry-date", label: "Entry", align: "left" },
                          { key: "exit-date", label: "Exit", align: "left" },
                          { key: "side", label: "Side", align: "left" },
                          { key: "regime", label: "Regime", align: "left" },
                          { key: "entry-reason", label: "Entry Reason", align: "left" },
                          { key: "exit-type", label: "Exit Type", align: "left" },
                          { key: "entry-price", label: "Entry $", align: "right" },
                          { key: "exit-price", label: "Exit $", align: "right" },
                          { key: "sl", label: "SL", align: "right" },
                          { key: "tp", label: "TP", align: "right" },
                          { key: "pnl", label: "P&L", align: "right" },
                          { key: "r", label: "R", align: "right" },
                          { key: "balance", label: "Balance", align: "right" },
                        ].map((h) => (
                          <th key={h.key} className={`pb-2 font-medium px-3 ${h.align === "left" ? "text-left" : "text-right"}`}>
                            {h.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((trade) => (
                        <tr key={trade.id} className="border-b last:border-0 text-xs" data-testid={`row-trade-${trade.id.slice(0, 8)}`}>
                          <td className="py-2 px-3 text-muted-foreground">{trade.entryTime.substring(0, 10)}</td>
                          <td className="py-2 px-3 text-muted-foreground">{trade.exitTime.substring(0, 10)}</td>
                          <td className="py-2 px-3">
                            <Badge variant="outline" className={`text-xs ${trade.side === "buy" ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "border-red-500/40 text-red-600 dark:text-red-400"}`}>
                              {trade.side === "buy" ? <TrendingUp className="w-2.5 h-2.5 mr-0.5 inline" /> : <TrendingDown className="w-2.5 h-2.5 mr-0.5 inline" />}
                              {trade.side}
                            </Badge>
                          </td>
                          <td className="py-2 px-3">
                            <Badge variant="outline" className={`text-xs ${trade.regime === "trend" ? "border-amber-500/40 text-amber-600 dark:text-amber-400" : "border-blue-500/40 text-blue-600 dark:text-blue-400"}`}>
                              {trade.regime}
                            </Badge>
                          </td>
                          <td className="py-2 px-3 text-muted-foreground max-w-32 truncate" title={trade.entryReason}>
                            {trade.entryReason.replace(/_/g, " ")}
                          </td>
                          <td className="py-2 px-3">
                            <Badge className={`text-xs border-0 ${trade.exitReason === "target" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"}`}>
                              {trade.exitReason}
                            </Badge>
                          </td>
                          <td className="py-2 px-3 text-right font-mono">{trade.entryPrice.toFixed(2)}</td>
                          <td className="py-2 px-3 text-right font-mono">{trade.exitPrice.toFixed(2)}</td>
                          <td className="py-2 px-3 text-right font-mono text-muted-foreground">{trade.stopLoss.toFixed(2)}</td>
                          <td className="py-2 px-3 text-right font-mono text-muted-foreground">{trade.takeProfit.toFixed(2)}</td>
                          <td className={`py-2 px-3 text-right font-mono font-semibold ${trade.pnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}`}>
                            {trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}
                          </td>
                          <td className={`py-2 px-3 text-right font-mono ${trade.resultR >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400"}`}>
                            {trade.resultR >= 0 ? "+" : ""}{trade.resultR}R
                          </td>
                          <td className="py-2 px-3 text-right font-mono">${trade.balance.toLocaleString()}</td>
                        </tr>
                      ))}
                      {filtered.length === 0 && (
                        <tr><td colSpan={13} className="py-8 text-center text-muted-foreground">No trades match your filters</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
