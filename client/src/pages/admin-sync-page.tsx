import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { PageGuide } from "@/components/page-guide";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Download, Upload, Database, RefreshCw, CheckCircle2, AlertCircle, Trash2, Settings, ThumbsUp, ThumbsDown, ArrowRight, Clock, Check, X, Newspaper, ExternalLink } from "lucide-react";

type DataCounts = {
  backtests: number;
  strategies: number;
  journal: number;
  candles: Record<string, number>;
};

type ImportResult = {
  success: boolean;
  imported: { backtests: number; strategies: number; journal: number };
};

type LockedParamsProposal = {
  id: string;
  createdAt: string;
  source: string;
  currentParams: Record<string, any>;
  proposedParams: Record<string, any>;
  changedKeys: string[];
  currentStats: { returnPct: number; maxDrawdownPct: number; winRate: number; totalTrades: number; profitFactor: number };
  proposedStats: { returnPct: number; maxDrawdownPct: number; winRate: number; totalTrades: number; profitFactor: number };
  rationale: string;
  status: "pending" | "approved" | "rejected";
  backtestId?: string;
};

export default function AdminSyncPage() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const countsQuery = useQuery<DataCounts>({
    queryKey: ["/api/admin/counts"],
    refetchInterval: false,
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/export?includeCandles=true");
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `gold-regime-lab-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    onSuccess: () => {
      toast({ title: "Export complete", description: "Data bundle downloaded successfully." });
    },
    onError: (err: Error) => {
      toast({ title: "Export failed", description: err.message, variant: "destructive" });
    },
  });

  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      const text = await file.text();
      const data = JSON.parse(text);
      const res = await apiRequest("POST", "/api/admin/import", {
        backtests: data.backtests,
        strategies: data.strategies,
        journal: data.journal,
      });
      return await res.json() as ImportResult;
    },
    onSuccess: (result) => {
      setImportResult(result);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/counts"] });
      toast({
        title: "Import complete",
        description: `Imported ${result.imported.backtests} backtests, ${result.imported.strategies} strategies, ${result.imported.journal} journal entries.`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    },
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      importMutation.mutate(file);
      e.target.value = "";
    }
  };

  const clearBacktestsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/admin/backtests");
      return await res.json() as { success: boolean; deleted: number };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/counts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/backtests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/backtests/leaderboard"] });
      toast({ title: "Backtests cleared", description: `Deleted ${result.deleted} backtest records.` });
    },
    onError: (err: Error) => {
      toast({ title: "Clear failed", description: err.message, variant: "destructive" });
    },
  });

  const proposalsQuery = useQuery<LockedParamsProposal[]>({
    queryKey: ["/api/locked-params/proposals"],
    refetchInterval: 15000,
  });

  const approveMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/locked-params/proposals/${id}/approve`);
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/locked-params/proposals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/locked-params"] });
      toast({ title: "Proposal approved", description: "Locked params updated. Live trader reloaded." });
    },
    onError: (err: Error) => {
      toast({ title: "Approval failed", description: err.message, variant: "destructive" });
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
    onError: (err: Error) => {
      toast({ title: "Rejection failed", description: err.message, variant: "destructive" });
    },
  });

  const counts = countsQuery.data;
  const totalCandles = counts ? Object.values(counts.candles).reduce((a, b) => a + b, 0) : 0;
  const proposals = proposalsQuery.data || [];
  const pendingProposals = proposals.filter(p => p.status === "pending");

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold" data-testid="text-admin-title">Data Sync</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Export data from this environment and import into another (e.g., dev to production).
        </p>
        <PageGuide
          title="Data Sync — Import and Export"
          summary="This is an admin page for managing your data. You can export strategies, backtest results, and settings for backup or import them into another environment."
          steps={[
            { title: "Pending Proposals", description: "If the AI has proposed parameter changes that haven't been approved yet, they appear at the top. You can approve or reject them here." },
            { title: "Export Data", description: "Export your backtest results, strategies, settings, and trading data as JSON files for backup or migration." },
            { title: "Import Data", description: "Import previously exported data into this environment. Useful for moving between development and production setups." },
          ]}
          tips={[
            "Most users won't need this page — it's primarily for administration and data management.",
            "Always export a backup before making major strategy changes.",
          ]}
        />
      </div>

      {pendingProposals.length > 0 && (
        <Card className="border-amber-500/50 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="w-5 h-5 text-amber-500" />
              Pending Param Proposals
              <Badge variant="secondary" className="ml-2 bg-amber-500/20 text-amber-700 dark:text-amber-300" data-testid="badge-pending-count">
                {pendingProposals.length} pending
              </Badge>
            </CardTitle>
            <CardDescription>AI has proposed changes to locked trading parameters. Review and approve or reject.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {pendingProposals.map(p => (
              <ProposalCard
                key={p.id}
                proposal={p}
                onApprove={() => approveMutation.mutate(p.id)}
                onReject={() => rejectMutation.mutate(p.id)}
                isApproving={approveMutation.isPending}
                isRejecting={rejectMutation.isPending}
              />
            ))}
          </CardContent>
        </Card>
      )}

      {proposals.length > 0 && pendingProposals.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="w-5 h-5" />
              Param Proposals History
            </CardTitle>
            <CardDescription>No pending proposals. Past proposals shown below.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {proposals.slice(0, 10).map(p => (
              <div key={p.id} className="flex items-center gap-3 text-sm border rounded-md p-3" data-testid={`proposal-history-${p.id}`}>
                {p.status === "approved" ? (
                  <Badge className="bg-green-500/20 text-green-700 dark:text-green-300" data-testid={`badge-status-${p.id}`}>Approved</Badge>
                ) : (
                  <Badge variant="destructive" className="bg-red-500/20 text-red-700 dark:text-red-300" data-testid={`badge-status-${p.id}`}>Rejected</Badge>
                )}
                <span className="text-muted-foreground">{new Date(p.createdAt).toLocaleDateString()}</span>
                <span className="truncate flex-1">{p.changedKeys.join(", ")}</span>
                <span className="text-xs text-muted-foreground">{p.proposedStats.returnPct.toFixed(1)}% ret / {p.proposedStats.profitFactor.toFixed(2)} PF</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <AnalystIdeasSection />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="w-5 h-5" />
            Current Data Counts
          </CardTitle>
          <CardDescription>Records in this environment's database</CardDescription>
        </CardHeader>
        <CardContent>
          {countsQuery.isLoading ? (
            <div className="text-sm text-muted-foreground" data-testid="text-counts-loading">Loading counts...</div>
          ) : counts ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4" data-testid="section-data-counts">
              <CountCard label="Backtests" value={counts.backtests} testId="text-count-backtests" />
              <CountCard label="Strategies" value={counts.strategies} testId="text-count-strategies" />
              <CountCard label="Journal Entries" value={counts.journal} testId="text-count-journal" />
              <CountCard label="Total Candles" value={totalCandles} testId="text-count-candles" />
            </div>
          ) : (
            <div className="text-sm text-destructive" data-testid="text-counts-error">Failed to load counts</div>
          )}

          {counts && Object.keys(counts.candles).length > 0 && (
            <div className="mt-4 pt-4 border-t">
              <div className="text-sm font-medium mb-2">Candle Breakdown</div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                {Object.entries(counts.candles).map(([tf, count]) => (
                  <div key={tf} className="text-xs bg-muted rounded px-2 py-1.5" data-testid={`text-candle-${tf}`}>
                    <span className="font-medium">{tf}:</span> {count.toLocaleString()}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/admin/counts"] })}
              data-testid="button-refresh-counts"
            >
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trash2 className="w-5 h-5 text-destructive" />
            Clear Old Backtests
          </CardTitle>
          <CardDescription>
            Delete all backtest results from this database. Use this to clear old runs with outdated parameters, then run a fresh backtest.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="destructive"
            onClick={() => {
              if (window.confirm(`Are you sure you want to delete all ${counts?.backtests ?? 0} backtests? This cannot be undone.`)) {
                clearBacktestsMutation.mutate();
              }
            }}
            disabled={clearBacktestsMutation.isPending || !counts?.backtests}
            data-testid="button-clear-backtests"
          >
            <Trash2 className="w-4 h-4 mr-2" />
            {clearBacktestsMutation.isPending ? "Clearing..." : `Clear All Backtests (${counts?.backtests ?? 0})`}
          </Button>
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Download className="w-5 h-5" />
              Export Data
            </CardTitle>
            <CardDescription>
              Download all backtests, strategies, and journal entries as a JSON file.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => exportMutation.mutate()}
              disabled={exportMutation.isPending}
              data-testid="button-export-data"
            >
              <Download className="w-4 h-4 mr-2" />
              {exportMutation.isPending ? "Exporting..." : "Export Data Bundle"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="w-5 h-5" />
              Import Data
            </CardTitle>
            <CardDescription>
              Upload a previously exported JSON bundle to upsert records into this database.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <input
              type="file"
              accept=".json"
              ref={fileInputRef}
              onChange={handleFileSelect}
              className="hidden"
              data-testid="input-import-file"
            />
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={importMutation.isPending}
              data-testid="button-import-data"
            >
              <Upload className="w-4 h-4 mr-2" />
              {importMutation.isPending ? "Importing..." : "Choose File & Import"}
            </Button>

            {importResult && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-green-500/10 border border-green-500/20" data-testid="section-import-result">
                <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
                <div className="text-sm">
                  <div className="font-medium text-green-700 dark:text-green-400">Import successful</div>
                  <div className="text-muted-foreground">
                    {importResult.imported.backtests} backtests, {importResult.imported.strategies} strategies, {importResult.imported.journal} journal entries
                  </div>
                </div>
              </div>
            )}

            {importMutation.isError && (
              <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20" data-testid="section-import-error">
                <AlertCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
                <div className="text-sm text-destructive">
                  Import failed: {(importMutation.error as Error).message}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function CountCard({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div className="rounded-lg border p-3 text-center">
      <div className="text-2xl font-bold" data-testid={testId}>{value.toLocaleString()}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

function StatDelta({ label, current, proposed, suffix, higherIsBetter = true }: { label: string; current: number; proposed: number; suffix?: string; higherIsBetter?: boolean }) {
  const diff = proposed - current;
  const improved = higherIsBetter ? diff > 0 : diff < 0;
  const same = Math.abs(diff) < 0.01;
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span>{current.toFixed(1)}{suffix}</span>
        <ArrowRight className="w-3 h-3 text-muted-foreground" />
        <span className={same ? "text-muted-foreground" : improved ? "text-green-600 dark:text-green-400 font-medium" : "text-red-600 dark:text-red-400 font-medium"}>
          {proposed.toFixed(1)}{suffix}
          {!same && <span className="ml-1 text-xs">({diff > 0 ? "+" : ""}{diff.toFixed(1)})</span>}
        </span>
      </div>
    </div>
  );
}

function AnalystIdeasSection() {
  const { toast } = useToast();
  const ideasQuery = useQuery<Array<{ id: number; source: string; title: string; url: string; content: string; fetched_at: string }>>({
    queryKey: ["/api/analyst-ideas"],
  });

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/analyst-ideas/refresh");
      return await res.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "Analyst ideas refreshed", description: `${data.refreshed} ideas updated` });
      queryClient.invalidateQueries({ queryKey: ["/api/analyst-ideas"] });
    },
    onError: (err: Error) => {
      toast({ title: "Refresh failed", description: err.message, variant: "destructive" });
    },
  });

  const ideas = ideasQuery.data || [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Newspaper className="w-5 h-5" />
              Goldviewfx Analyst Feed
            </CardTitle>
            <CardDescription>Latest gold analysis from Goldviewfx on TradingView — auto-fetched every 6h and injected into AI context</CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            data-testid="button-refresh-analyst"
          >
            <RefreshCw className={`w-4 h-4 mr-1 ${refreshMutation.isPending ? 'animate-spin' : ''}`} />
            Refresh Now
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {ideasQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading analyst ideas...</div>
        ) : ideas.length === 0 ? (
          <div className="text-sm text-muted-foreground">No analyst ideas stored yet. Click Refresh to fetch the latest.</div>
        ) : (
          <div className="space-y-3">
            {ideas.map((idea) => {
              const age = Math.round((Date.now() - new Date(idea.fetched_at).getTime()) / (1000 * 60 * 60));
              const ageStr = age < 1 ? "just now" : age < 24 ? `${age}h ago` : `${Math.round(age / 24)}d ago`;
              return (
                <div key={idea.id} className="border rounded-md p-3 space-y-2" data-testid={`analyst-idea-${idea.id}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">{idea.source}</Badge>
                      <span className="font-medium text-sm truncate">{idea.title}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-muted-foreground">{ageStr}</span>
                      <a href={idea.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-3">{idea.content}</p>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProposalCard({ proposal, onApprove, onReject, isApproving, isRejecting }: {
  proposal: LockedParamsProposal;
  onApprove: () => void;
  onReject: () => void;
  isApproving: boolean;
  isRejecting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border rounded-lg p-4 space-y-3" data-testid={`proposal-${proposal.id}`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-500" />
            <span className="text-sm font-medium">Proposed {new Date(proposal.createdAt).toLocaleString()}</span>
            <Badge variant="outline" className="text-xs" data-testid={`badge-source-${proposal.id}`}>{proposal.source}</Badge>
          </div>
          <div className="text-sm text-muted-foreground mt-1">
            Changed: <span className="font-mono text-xs">{proposal.changedKeys.join(", ")}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="border-green-500/50 text-green-700 dark:text-green-400 hover:bg-green-500/10"
            onClick={onApprove}
            disabled={isApproving || isRejecting}
            data-testid={`button-approve-${proposal.id}`}
          >
            <Check className="w-4 h-4 mr-1" />
            {isApproving ? "Applying..." : "Approve"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-red-500/50 text-red-700 dark:text-red-400 hover:bg-red-500/10"
            onClick={onReject}
            disabled={isApproving || isRejecting}
            data-testid={`button-reject-${proposal.id}`}
          >
            <X className="w-4 h-4 mr-1" />
            Reject
          </Button>
        </div>
      </div>

      <div className="bg-muted/50 rounded-md p-3 space-y-1">
        <div className="text-xs font-medium text-muted-foreground mb-2">Performance Comparison</div>
        <StatDelta label="Return" current={proposal.currentStats.returnPct} proposed={proposal.proposedStats.returnPct} suffix="%" />
        <StatDelta label="Win Rate" current={proposal.currentStats.winRate} proposed={proposal.proposedStats.winRate} suffix="%" />
        <StatDelta label="Profit Factor" current={proposal.currentStats.profitFactor} proposed={proposal.proposedStats.profitFactor} />
        <StatDelta label="Max Drawdown" current={proposal.currentStats.maxDrawdownPct} proposed={proposal.proposedStats.maxDrawdownPct} suffix="%" higherIsBetter={false} />
        <StatDelta label="Trades" current={proposal.currentStats.totalTrades} proposed={proposal.proposedStats.totalTrades} />
      </div>

      {proposal.rationale && (
        <div className="text-sm bg-blue-500/5 border border-blue-500/20 rounded-md p-3">
          <span className="font-medium text-blue-700 dark:text-blue-300">Rationale:</span>{" "}
          <span className="text-muted-foreground">{proposal.rationale}</span>
        </div>
      )}

      <Button
        variant="ghost"
        size="sm"
        onClick={() => setExpanded(!expanded)}
        className="text-xs"
        data-testid={`button-expand-${proposal.id}`}
      >
        {expanded ? "Hide" : "Show"} parameter changes
      </Button>

      {expanded && (
        <div className="border rounded-md overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted/50">
                <th className="text-left p-2 font-medium">Parameter</th>
                <th className="text-right p-2 font-medium">Current</th>
                <th className="text-center p-2 w-8"></th>
                <th className="text-right p-2 font-medium">Proposed</th>
              </tr>
            </thead>
            <tbody>
              {proposal.changedKeys.map(key => (
                <tr key={key} className="border-t bg-amber-500/5">
                  <td className="p-2 font-mono">{key}</td>
                  <td className="p-2 text-right text-muted-foreground">{String(proposal.currentParams[key])}</td>
                  <td className="p-2 text-center"><ArrowRight className="w-3 h-3 text-muted-foreground inline" /></td>
                  <td className="p-2 text-right font-medium">{String(proposal.proposedParams[key])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
