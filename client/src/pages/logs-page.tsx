import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageGuide } from "@/components/page-guide";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ScrollText, Search, Brain, Eye, BarChart3, Settings,
  TrendingUp, TrendingDown, XCircle, CheckCircle2, Clock,
  AlertTriangle, Filter, ChevronDown, ChevronUp,
} from "lucide-react";

type TradeDecision = {
  id: number;
  timestamp: string;
  decision: string;
  side?: string;
  price?: number;
  regime?: string;
  conditions?: Record<string, any>;
  block_reason?: string;
  signal_details?: Record<string, any>;
  market_context?: Record<string, any>;
  outcome?: string;
  pnl?: number;
  notes?: string;
};

type MarketObservation = {
  id: number;
  timestamp: string;
  price?: number;
  bid?: number;
  ask?: number;
  spread?: number;
  atr_h1?: number;
  atr_h4?: number;
  regime?: string;
  range_high?: number;
  range_low?: number;
  session?: string;
  conditions?: Record<string, any>;
  notes?: string;
};

type AILearning = {
  id: number;
  created_at: string;
  category: string;
  insight: string;
  confidence: number;
  source_data?: Record<string, any>;
  times_reinforced: number;
};

type ParamChange = {
  id: number;
  timestamp: string;
  source: string;
  changedKeys: string[];
  oldValues: Record<string, any>;
  newValues: Record<string, any>;
  rationale?: string;
};

function DecisionRow({ d, expanded, onToggle }: { d: TradeDecision; expanded: boolean; onToggle: () => void }) {
  const isEntry = d.decision === "entry";
  const isLoss = d.pnl != null && Number(d.pnl) < 0;
  return (
    <div className="border-b last:border-0" data-testid={`log-decision-${d.id}`}>
      <div
        className="flex items-center gap-3 py-2.5 px-3 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={onToggle}
      >
        <div className="shrink-0">
          {isEntry ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          ) : (
            <XCircle className="w-4 h-4 text-muted-foreground" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={isEntry ? "default" : "secondary"} className="text-[10px] uppercase">
              {d.decision}
            </Badge>
            {d.side && (
              <Badge variant="outline" className={`text-[10px] ${d.side === "BUY" || d.side === "buy" ? "border-emerald-500/40 text-emerald-400" : "border-red-500/40 text-red-400"}`}>
                {d.side}
              </Badge>
            )}
            {d.regime && (
              <Badge variant="outline" className="text-[10px]">{d.regime}</Badge>
            )}
            {d.block_reason && (
              <span className="text-xs text-muted-foreground">{d.block_reason.replace(/_/g, " ")}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {d.price != null && (
            <span className="text-xs font-mono">${Number(d.price).toFixed(2)}</span>
          )}
          {d.pnl != null && (
            <span className={`text-xs font-mono font-medium ${isLoss ? "text-red-400" : "text-emerald-400"}`}>
              {Number(d.pnl) >= 0 ? "+" : ""}${Number(d.pnl).toFixed(2)}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
            {new Date(d.timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </span>
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </div>
      </div>
      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-2 bg-muted/10">
          {d.conditions && (
            <div>
              <div className="text-[10px] text-muted-foreground uppercase font-medium mb-1">Conditions</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5 text-xs">
                {Object.entries(d.conditions).map(([k, v]) => (
                  <div key={k} className="p-1.5 rounded bg-muted/30">
                    <span className="text-muted-foreground">{k}: </span>
                    <span className="font-mono">{typeof v === "number" ? Number(v).toFixed(2) : String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {d.signal_details && (
            <div>
              <div className="text-[10px] text-muted-foreground uppercase font-medium mb-1">Signal Details</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5 text-xs">
                {Object.entries(d.signal_details).flatMap(([k, v]) => {
                  if (v && typeof v === "object" && !Array.isArray(v)) {
                    return Object.entries(v as Record<string, unknown>).flatMap(([sk, sv]) => {
                      if (sv && typeof sv === "object" && !Array.isArray(sv)) {
                        return Object.entries(sv as Record<string, unknown>).map(([dk, dv]) => (
                          <div key={`${k}.${sk}.${dk}`} className="p-1.5 rounded bg-muted/30">
                            <span className="text-muted-foreground">{dk}: </span>
                            <span className="font-mono">{typeof dv === "number" ? Number(dv).toFixed(2) : String(dv ?? "")}</span>
                          </div>
                        ));
                      }
                      if (Array.isArray(sv)) {
                        return [(
                          <div key={`${k}.${sk}`} className="p-1.5 rounded bg-muted/30">
                            <span className="text-muted-foreground">{sk}: </span>
                            <span className="font-mono">{sv.map(item => typeof item === "object" ? JSON.stringify(item) : String(item)).join(", ")}</span>
                          </div>
                        )];
                      }
                      return [(
                        <div key={`${k}.${sk}`} className="p-1.5 rounded bg-muted/30">
                          <span className="text-muted-foreground">{sk}: </span>
                          <span className="font-mono">{typeof sv === "number" ? Number(sv).toFixed(2) : String(sv ?? "")}</span>
                        </div>
                      )];
                    });
                  }
                  if (Array.isArray(v)) {
                    return [(
                      <div key={k} className="p-1.5 rounded bg-muted/30">
                        <span className="text-muted-foreground">{k}: </span>
                        <span className="font-mono">{(v as any[]).map(item => typeof item === "object" ? JSON.stringify(item) : String(item)).join(", ")}</span>
                      </div>
                    )];
                  }
                  return [(
                    <div key={k} className="p-1.5 rounded bg-muted/30">
                      <span className="text-muted-foreground">{k}: </span>
                      <span className="font-mono">{typeof v === "number" ? Number(v).toFixed(2) : String(v ?? "")}</span>
                    </div>
                  )];
                })}
              </div>
            </div>
          )}
          {d.market_context && (
            <div>
              <div className="text-[10px] text-muted-foreground uppercase font-medium mb-1">Market Context</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5 text-xs">
                {Object.entries(d.market_context).flatMap(([k, v]) => {
                  if (v && typeof v === "object" && !Array.isArray(v)) {
                    return Object.entries(v as Record<string, unknown>).map(([sk, sv]) => (
                      <div key={`${k}.${sk}`} className="p-1.5 rounded bg-muted/30">
                        <span className="text-muted-foreground">{sk}: </span>
                        <span className="font-mono">{typeof sv === "number" ? Number(sv).toFixed(2) : String(sv ?? "")}</span>
                      </div>
                    ));
                  }
                  return [(
                    <div key={k} className="p-1.5 rounded bg-muted/30">
                      <span className="text-muted-foreground">{k}: </span>
                      <span className="font-mono">{typeof v === "number" ? Number(v).toFixed(2) : String(v ?? "")}</span>
                    </div>
                  )];
                })}
              </div>
            </div>
          )}
          {d.notes && (
            <div className="text-xs text-muted-foreground italic">{d.notes}</div>
          )}
        </div>
      )}
    </div>
  );
}

function ObservationRow({ o }: { o: MarketObservation }) {
  return (
    <div className="flex items-center gap-3 py-2 px-3 border-b last:border-0" data-testid={`log-observation-${o.id}`}>
      <Eye className="w-4 h-4 text-blue-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          {o.regime && <Badge variant="outline" className="text-[10px]">{o.regime}</Badge>}
          {o.session && <Badge variant="secondary" className="text-[10px]">{o.session}</Badge>}
          {o.price != null && <span className="font-mono">${Number(o.price).toFixed(2)}</span>}
          {o.spread != null && <span className="text-muted-foreground">spread: {Number(o.spread).toFixed(2)}</span>}
        </div>
        <div className="flex gap-3 mt-0.5 text-[10px] text-muted-foreground">
          {o.atr_h1 != null && <span>ATR H1: {Number(o.atr_h1).toFixed(2)}</span>}
          {o.atr_h4 != null && <span>ATR H4: {Number(o.atr_h4).toFixed(2)}</span>}
          {o.range_high != null && o.range_low != null && (
            <span>Range: ${Number(o.range_low).toFixed(2)}-${Number(o.range_high).toFixed(2)}</span>
          )}
        </div>
      </div>
      <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
        {new Date(o.timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
      </span>
    </div>
  );
}

function LearningRow({ l }: { l: AILearning }) {
  const catColors: Record<string, string> = {
    regime_behavior: "border-blue-500/40 text-blue-400",
    entry_timing: "border-emerald-500/40 text-emerald-400",
    risk_management: "border-red-500/40 text-red-400",
    market_structure: "border-amber-500/40 text-amber-400",
    spread_patterns: "border-purple-500/40 text-purple-400",
    news_impact: "border-orange-500/40 text-orange-400",
    session_patterns: "border-pink-500/40 text-pink-400",
    price_action: "border-cyan-500/40 text-cyan-400",
  };
  return (
    <div className="py-2.5 px-3 border-b last:border-0" data-testid={`log-learning-${l.id}`}>
      <div className="flex items-start gap-3">
        <Brain className="w-4 h-4 text-purple-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Badge variant="outline" className={`text-[10px] ${catColors[l.category] || ""}`}>
              {l.category.replace(/_/g, " ")}
            </Badge>
            <span className="text-[10px] text-muted-foreground">
              confidence: {(l.confidence * 100).toFixed(0)}%
            </span>
            {l.times_reinforced > 0 && (
              <span className="text-[10px] text-emerald-400">+{l.times_reinforced} reinforced</span>
            )}
          </div>
          <p className="text-sm leading-relaxed">{l.insight}</p>
        </div>
        <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
          {new Date(l.created_at).toLocaleString(undefined, { month: "short", day: "numeric" })}
        </span>
      </div>
    </div>
  );
}

function ParamChangeRow({ p }: { p: ParamChange }) {
  const keys = p.changedKeys || [];
  const oldVals = p.oldValues || {};
  const newVals = p.newValues || {};
  return (
    <div className="py-2.5 px-3 border-b last:border-0" data-testid={`log-param-${p.id}`}>
      <div className="flex items-start gap-3">
        <Settings className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Badge
              variant={p.source === "ai" ? "default" : p.source === "user" ? "secondary" : "outline"}
              className="text-[10px]"
            >
              {p.source.toUpperCase()}
            </Badge>
            <span className="text-xs">{keys.join(", ")}</span>
          </div>
          <div className="flex flex-wrap gap-2 text-[10px]">
            {keys.map((key) => (
              <span key={key} className="p-1 rounded bg-muted/30 font-mono">
                {key}: {JSON.stringify(oldVals[key])} → {JSON.stringify(newVals[key])}
              </span>
            ))}
          </div>
          {p.rationale && (
            <p className="text-xs text-muted-foreground mt-1 italic">{p.rationale}</p>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
          {new Date(p.timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
    </div>
  );
}

export default function LogsPage() {
  const [tab, setTab] = useState("decisions");
  const [search, setSearch] = useState("");
  const [decisionFilter, setDecisionFilter] = useState<"all" | "entry" | "skip">("all");
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  const { data: counts } = useQuery<{ decisions: number; observations: number; learnings: number }>({
    queryKey: ["/api/ai-monitor/counts"],
    refetchInterval: 30000,
  });

  const { data: decisions = [], isLoading: loadingDecisions } = useQuery<TradeDecision[]>({
    queryKey: ["/api/ai-monitor/decisions?limit=200"],
    enabled: tab === "decisions",
    staleTime: 0,
    refetchOnMount: "always",
  });

  const { data: observations = [], isLoading: loadingObs } = useQuery<MarketObservation[]>({
    queryKey: ["/api/ai-monitor/observations?limit=200"],
    enabled: tab === "observations",
    staleTime: 0,
    refetchOnMount: "always",
  });

  const { data: learnings = [], isLoading: loadingLearn } = useQuery<AILearning[]>({
    queryKey: ["/api/ai-monitor/learnings"],
    enabled: tab === "learnings",
    staleTime: 0,
    refetchOnMount: "always",
  });

  const { data: paramChanges = [], isLoading: loadingParams } = useQuery<ParamChange[]>({
    queryKey: ["/api/locked-params/changelog"],
    enabled: tab === "params",
    staleTime: 0,
    refetchOnMount: "always",
  });

  const toggleExpand = (id: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const filteredDecisions = decisions.filter(d => {
    if (decisionFilter === "entry" && d.decision !== "entry") return false;
    if (decisionFilter === "skip" && d.decision !== "skip") return false;
    if (search) {
      const s = search.toLowerCase();
      return (
        d.decision.toLowerCase().includes(s) ||
        d.block_reason?.toLowerCase().includes(s) ||
        d.side?.toLowerCase().includes(s) ||
        d.regime?.toLowerCase().includes(s) ||
        d.notes?.toLowerCase().includes(s)
      );
    }
    return true;
  });

  const filteredObservations = observations.filter(o => {
    if (!search) return true;
    const s = search.toLowerCase();
    return o.regime?.toLowerCase().includes(s) || o.session?.toLowerCase().includes(s) || o.notes?.toLowerCase().includes(s);
  });

  const filteredLearnings = learnings.filter(l => {
    if (!search) return true;
    const s = search.toLowerCase();
    return l.category.toLowerCase().includes(s) || l.insight.toLowerCase().includes(s);
  });

  const filteredParams = paramChanges.filter(p => {
    if (!search) return true;
    const s = search.toLowerCase();
    return p.source.toLowerCase().includes(s) || (p.changedKeys || []).some(k => k.toLowerCase().includes(s)) || p.rationale?.toLowerCase().includes(s);
  });

  const entryCount = decisions.filter(d => d.decision === "entry").length;
  const skipCount = decisions.filter(d => d.decision === "skip").length;

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="p-6 border-b bg-background/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2" data-testid="heading-logs">
              <ScrollText className="w-5 h-5" />
              Activity Log
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Complete record of trade decisions, market observations, AI learnings, and parameter changes
            </p>
            <PageGuide
              title="Activity Log — Complete Audit Trail"
              summary="Everything the bot does is recorded here. Four tabs give you full transparency into trade decisions, market observations, AI insights, and every parameter change."
              steps={[
                { title: "Trade Decisions", description: "Every time the bot considers a trade — whether it enters or skips — is logged here with the exact reasoning. Expand any entry to see the full context." },
                { title: "Market Observations", description: "Hourly snapshots of what the market looked like — price, ATR, regime, spread, volume. Useful for understanding why the bot behaved a certain way." },
                { title: "AI Learnings", description: "Insights the AI has accumulated over time — patterns about timing, regime behaviour, spread anomalies, and more. Each learning has a confidence score that increases when the pattern is reinforced." },
                { title: "Parameter Changes", description: "Full changelog of every setting that was modified, by whom (you, AI, auto-tuner), and why. This is your audit trail for strategy evolution." },
              ]}
              tips={[
                "Use the search box to find specific events, like 'skip' to see all skipped trades or 'loss' to find losing trades.",
                "The AI Learnings tab is a goldmine for understanding what the system has figured out over time.",
              ]}
            />
          </div>
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              placeholder="Search logs..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-8 h-8 text-sm"
              data-testid="input-log-search"
            />
          </div>
        </div>
      </div>

      <div className="p-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-4" data-testid="tabs-log-type">
            <TabsTrigger value="decisions" className="gap-1.5" data-testid="tab-decisions">
              <BarChart3 className="w-3.5 h-3.5" />
              Decisions
              <Badge variant="secondary" className="text-[10px] ml-1">{tab === "decisions" ? decisions.length : (counts?.decisions ?? "…")}</Badge>
            </TabsTrigger>
            <TabsTrigger value="observations" className="gap-1.5" data-testid="tab-observations">
              <Eye className="w-3.5 h-3.5" />
              Observations
              <Badge variant="secondary" className="text-[10px] ml-1">{tab === "observations" ? observations.length : (counts?.observations ?? "…")}</Badge>
            </TabsTrigger>
            <TabsTrigger value="learnings" className="gap-1.5" data-testid="tab-learnings">
              <Brain className="w-3.5 h-3.5" />
              AI Learnings
              <Badge variant="secondary" className="text-[10px] ml-1">{tab === "learnings" ? learnings.length : (counts?.learnings ?? "…")}</Badge>
            </TabsTrigger>
            <TabsTrigger value="params" className="gap-1.5" data-testid="tab-params">
              <Settings className="w-3.5 h-3.5" />
              Param Changes
              <Badge variant="secondary" className="text-[10px] ml-1">{paramChanges.length}</Badge>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="decisions">
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Trade Decisions</CardTitle>
                  <div className="flex gap-1">
                    <Button
                      variant={decisionFilter === "all" ? "secondary" : "ghost"}
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setDecisionFilter("all")}
                      data-testid="filter-all"
                    >
                      All ({decisions.length})
                    </Button>
                    <Button
                      variant={decisionFilter === "entry" ? "secondary" : "ghost"}
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setDecisionFilter("entry")}
                      data-testid="filter-entries"
                    >
                      Entries ({entryCount})
                    </Button>
                    <Button
                      variant={decisionFilter === "skip" ? "secondary" : "ghost"}
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setDecisionFilter("skip")}
                      data-testid="filter-skips"
                    >
                      Skips ({skipCount})
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {loadingDecisions ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">Loading decisions...</div>
                ) : filteredDecisions.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">No decisions found</div>
                ) : (
                  <div className="max-h-[600px] overflow-auto">
                    {filteredDecisions.map(d => (
                      <DecisionRow
                        key={d.id}
                        d={d}
                        expanded={expandedIds.has(d.id)}
                        onToggle={() => toggleExpand(d.id)}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="observations">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Market Observations</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {loadingObs ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">Loading observations...</div>
                ) : filteredObservations.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">No observations found</div>
                ) : (
                  <div className="max-h-[600px] overflow-auto">
                    {filteredObservations.map(o => (
                      <ObservationRow key={o.id} o={o} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="learnings">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">AI Learnings</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {loadingLearn ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">Loading learnings...</div>
                ) : filteredLearnings.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">No learnings found</div>
                ) : (
                  <div className="max-h-[600px] overflow-auto">
                    {filteredLearnings.map(l => (
                      <LearningRow key={l.id} l={l} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="params">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Parameter Changes</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {loadingParams ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">Loading changelog...</div>
                ) : filteredParams.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">No parameter changes found</div>
                ) : (
                  <div className="max-h-[600px] overflow-auto">
                    {filteredParams.map(p => (
                      <ParamChangeRow key={p.id} p={p} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
