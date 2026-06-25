import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { PageGuide } from "@/components/page-guide";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Brain, Sparkles, AlertTriangle, TrendingUp, Settings2,
  MessageSquare, Send, Loader2, RefreshCw, ChevronRight,
  Database, Download, CheckCircle2, XCircle, Trash2, User,
  Play, ArrowRight, Bookmark, ChevronDown, ChevronUp, X,
  Trophy, Crown, Medal, Zap, Shield, Copy, CalendarDays,
  Paperclip, FileText, Image as ImageIcon,
} from "lucide-react";
import type { BacktestResult, SavedStrategy } from "@shared/schema";

type BacktestSummary = Omit<BacktestResult, "trades" | "equityCurve"> & { tradeCount: number };

type MarketStatus = {
  keys: { twelveData: boolean; finnhub: boolean };
  data: {
    xauusd: { h1: number; h4: number; daily: number; lastFetched: string | null };
    events: { count: number; lastFetched: string | null };
    asian: { indices: string[]; lastFetched: string | null };
  };
};

type ParameterSuggestion = {
  parameter: string;
  currentValue: string | number;
  suggestedValue: string | number;
  rationale: string;
  expectedImpact: string;
};

type AdvisorResponse = {
  marketAnalysis: string;
  patternObservations: string;
  parameterSuggestions: ParameterSuggestion[];
  riskWarnings: string[];
  overallAssessment: string;
};

type BacktestAction = { type: string; params: Record<string, any>; result: string };
type ChatEntry = { role: "user" | "assistant" | "action"; content: string; actions?: BacktestAction[] };
type ChatResponse = { reply: string; actions: BacktestAction[]; history: ChatEntry[] };

type DisplayMessage = {
  role: "user" | "assistant" | "action";
  content: string;
  actions?: BacktestAction[];
};

async function fetchSSEChat(body: any, onProgress?: (msg: string) => void): Promise<ChatResponse> {
  const res = await fetch("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = "AI chat failed";
    try { msg = JSON.parse(text).error || msg; } catch {}
    throw new Error(msg);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response stream");

  const decoder = new TextDecoder();
  let buffer = "";
  let result: ChatResponse | null = null;
  let sseError: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const eventBoundary = buffer.lastIndexOf("\n\n");
    if (eventBoundary === -1) continue;

    const complete = buffer.substring(0, eventBoundary);
    buffer = buffer.substring(eventBoundary + 2);

    const events = complete.split("\n\n");
    for (const event of events) {
      const lines = event.split("\n");
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload);
          if (parsed.type === "result") {
            result = { reply: parsed.reply, actions: parsed.actions, history: parsed.history };
          } else if (parsed.type === "error") {
            sseError = parsed.error;
          } else if (parsed.type === "progress") {
            onProgress?.(parsed.message);
          }
        } catch {
        }
      }
    }
  }

  if (buffer.trim()) {
    const remaining = buffer.split("\n");
    for (const line of remaining) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        if (parsed.type === "result") {
          result = { reply: parsed.reply, actions: parsed.actions, history: parsed.history };
        } else if (parsed.type === "error") {
          sseError = parsed.error;
        }
      } catch {
      }
    }
  }

  if (sseError) throw new Error(sseError);
  if (!result) throw new Error("No response received from AI");
  return result;
}

export default function AdvisorPage() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [chatInput, setChatInput] = useState("");
  const [analysis, setAnalysis] = useState<AdvisorResponse | null>(null);
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
  const [chatProgress, setChatProgress] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"chat" | "analysis">("chat");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachedFiles, setAttachedFiles] = useState<Array<{ type: "text" | "csv" | "image"; name: string; content: string; preview?: string }>>([]);

  type Attachment = { type: "text" | "csv" | "image"; name: string; content: string };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const fileList = Array.from(files).slice(0, 5 - attachedFiles.length);
    if (fileList.length === 0) {
      toast({ title: "Max 5 files", description: "Remove a file before adding more.", variant: "destructive" });
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    fileList.forEach(file => {
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      const isImage = file.type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
      const isCsv = ext === 'csv' || file.type === 'text/csv';

      if (isImage) {
        if (file.size > 4 * 1024 * 1024) {
          toast({ title: "Image too large", description: "Max 4MB per image.", variant: "destructive" });
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          setAttachedFiles(prev => {
            if (prev.length >= 5) return prev;
            return [...prev, { type: "image", name: file.name, content: dataUrl, preview: dataUrl }];
          });
        };
        reader.readAsDataURL(file);
      } else {
        if (file.size > 500 * 1024) {
          toast({ title: "File too large", description: "Max 500KB for text/CSV files.", variant: "destructive" });
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const text = reader.result as string;
          setAttachedFiles(prev => {
            if (prev.length >= 5) return prev;
            return [...prev, { type: isCsv ? "csv" : "text", name: file.name, content: text }];
          });
        };
        reader.readAsText(file);
      }
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const { data: marketStatus } = useQuery<MarketStatus>({
    queryKey: ["/api/market/status"],
  });

  const { data: backtests } = useQuery<BacktestSummary[]>({ queryKey: ["/api/backtests"] });
  const { data: activeSummaryData } = useQuery<{ matchingBacktest?: { id: string } }>({
    queryKey: ["/api/active-strategy-summary"],
    staleTime: 0,
  });
  const activeMatchId = activeSummaryData?.matchingBacktest?.id;
  const latestBacktest = (activeMatchId ? backtests?.find(b => b.id === activeMatchId) : null) ?? backtests?.[0];

  const hasCachedData = (marketStatus?.data.xauusd.h1 ?? 0) > 0;
  const hasBacktests = (backtests?.length ?? 0) > 0;

  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [strategiesOpen, setStrategiesOpen] = useState(false);
  const [leaderboardOpen, setLeaderboardOpen] = useState(true);
  const [leaderboardSort, setLeaderboardSort] = useState<"performance" | "risk">("performance");

  type LeaderboardEntry = BacktestSummary & { returnDD: number; label?: string; category?: string; notes?: string };

  const { data: leaderboard } = useQuery<LeaderboardEntry[]>({
    queryKey: ["/api/backtests/leaderboard", leaderboardSort],
    queryFn: async () => {
      const res = await fetch(`/api/backtests/leaderboard?sort=${leaderboardSort}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch leaderboard");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const { data: savedStrategies, refetch: refetchStrategies } = useQuery<SavedStrategy[]>({
    queryKey: ["/api/strategies"],
  });

  const deleteStrategyMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/strategies/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
      toast({ title: "Strategy deleted" });
    },
  });

  const [sweepRunning, setSweepRunning] = useState(false);
  const [sweepStatus, setSweepStatus] = useState("");
  const sweepPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startSweepPolling = useCallback(() => {
    if (sweepPollRef.current) return;
    setSweepRunning(true);
    let errorCount = 0;
    sweepPollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/batch-sweep/progress");
        const prog = await res.json();
        errorCount = 0;
        if (prog.running) {
          setSweepStatus(`${prog.current}/${prog.total} tested | ${prog.validResults} valid | Best: ${prog.bestReturnPct}%`);
        } else if (prog.done) {
          if (sweepPollRef.current) clearInterval(sweepPollRef.current);
          sweepPollRef.current = null;
          setSweepRunning(false);
          queryClient.invalidateQueries({ queryKey: ["/api/backtests"] });
          queryClient.invalidateQueries({ queryKey: ["/api/backtests/leaderboard"] });
          queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
          if (prog.error) {
            toast({ title: "Hill-climb failed", description: prog.error, variant: "destructive" });
            setSweepStatus("");
          } else {
            const r = prog.result;
            const improved = r.improved ? `NEW BEST ${r.newBest}% (was ${r.previousBest}%)` : `No improvement over ${r.previousBest}%`;
            toast({ title: r.improved ? "New record found!" : "Hill-climb complete", description: `${r.totalTested} mutations tested. ${improved}. ${r.newBestsFound || 0} improvements, ${r.strategiesCreated?.length || 0} strategies saved.` });
            setSweepStatus(r.improved ? `NEW BEST: ${r.newBest}% ret (was ${r.previousBest}%)` : `Best stays at ${r.previousBest}%. ${r.nearBestResults || 0} near-best found.`);
          }
        } else {
          if (sweepPollRef.current) clearInterval(sweepPollRef.current);
          sweepPollRef.current = null;
          setSweepRunning(false);
        }
      } catch {
        errorCount++;
        if (errorCount > 5) {
          if (sweepPollRef.current) clearInterval(sweepPollRef.current);
          sweepPollRef.current = null;
          setSweepRunning(false);
          setSweepStatus("Connection lost during sweep");
        }
      }
    }, 2000);
  }, [toast]);

  useEffect(() => {
    fetch("/api/batch-sweep/progress").then(r => r.json()).then(prog => {
      if (prog.running) startSweepPolling();
    }).catch(() => {});
    return () => { if (sweepPollRef.current) clearInterval(sweepPollRef.current); };
  }, [startSweepPolling]);

  const batchSweepMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/batch-sweep", {});
      return res.json();
    },
    onSuccess: () => {
      setSweepStatus("Starting sweep...");
      startSweepPolling();
    },
    onError: (err: any) => {
      if (err.message?.includes("already running")) {
        startSweepPolling();
      } else {
        toast({ title: "Batch sweep failed", description: err.message, variant: "destructive" });
      }
    },
  });

  const { data: chatHistoryData } = useQuery<{ history: ChatEntry[] }>({
    queryKey: ["/api/ai/chat/history"],
    enabled: hasCachedData,
    staleTime: 0,
    refetchOnMount: "always",
  });

  useEffect(() => {
    if (!historyLoaded && chatHistoryData?.history && chatHistoryData.history.length > 0) {
      setDisplayMessages(prev => {
        if (prev.length > 0) return prev;
        return chatHistoryData.history.map(m => ({
          role: m.role,
          content: m.content,
          ...(m.actions ? { actions: m.actions } : {}),
        }));
      });
      setHistoryLoaded(true);
    }
  }, [chatHistoryData, historyLoaded]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [displayMessages]);

  const fetchAllMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/market/fetch-all");
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/market/status"] });
      if (data.success) {
        toast({ title: "Market data fetched", description: "Price data is now available for analysis." });
      } else {
        toast({ title: "Partial fetch", description: data.errors?.join("; ") || "Some data could not be fetched.", variant: "destructive" });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Fetch failed", description: err.message, variant: "destructive" });
    },
  });

  const analyzeMutation = useMutation({
    mutationFn: async (userQuestion?: string) => {
      const res = await apiRequest("POST", "/api/ai/analyze", {
        backtestId: latestBacktest?.id,
        userQuestion,
      });
      return res.json() as Promise<AdvisorResponse>;
    },
    onSuccess: (data) => {
      setAnalysis(data);
      setActiveTab("analysis");
    },
    onError: (err: Error) => {
      toast({ title: "Analysis Failed", description: err.message, variant: "destructive" });
    },
  });

  const chatMutation = useMutation({
    mutationFn: async ({ message, files, _msgId }: { message: string; files?: Attachment[]; _msgId?: string }) => {
      setChatProgress("Connecting...");
      const body: any = { message, context: { backtestId: latestBacktest?.id } };
      if (files && files.length > 0) {
        body.attachments = files.map(f => ({ type: f.type, name: f.name, content: f.content }));
      }
      return fetchSSEChat(body, (progressMsg) => setChatProgress(progressMsg));
    },
    onSuccess: (data) => {
      setChatProgress(null);
      setDisplayMessages(prev => {
        const updated = [...prev];
        if (data.actions && data.actions.length > 0) {
          const btCount = data.actions.filter((a: any) => a.type === "run_backtest").length;
          const snapCount = data.actions.filter((a: any) => a.type === "get_market_snapshot").length;
          const parts: string[] = [];
          if (btCount > 0) parts.push(`Ran ${btCount} backtest${btCount > 1 ? 's' : ''}`);
          if (snapCount > 0) parts.push(`Analyzed live market`);
          updated.push({
            role: "action",
            content: parts.join(' + ') || `${data.actions.length} action${data.actions.length > 1 ? 's' : ''}`,
            actions: data.actions,
          });
        }
        updated.push({ role: "assistant", content: data.reply });
        return updated;
      });
      queryClient.invalidateQueries({ queryKey: ["/api/backtests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
    },
    onError: (err: Error, vars: { message: string; files?: Attachment[]; _msgId?: string }) => {
      setChatProgress(null);
      setDisplayMessages(prev => prev.filter((m: any) => m._id !== vars._msgId));
      setChatInput(vars.message);
      if (vars.files) setAttachedFiles(vars.files.map(f => ({ ...f })));
      toast({ title: "Chat Failed", description: err.message, variant: "destructive" });
    },
  });

  const clearChatMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/ai/chat/clear");
      return res.json();
    },
    onSuccess: () => {
      setDisplayMessages([]);
      setHistoryLoaded(false);
      queryClient.invalidateQueries({ queryKey: ["/api/ai/chat/history"] });
      toast({ title: "Chat cleared", description: "Conversation history has been reset." });
    },
  });

  const reRunMutation = useMutation({
    mutationFn: async (params: Record<string, any>) => {
      setChatProgress("Running backtest...");
      return fetchSSEChat(
        {
          message: `Run a single backtest with exactly these parameters and report the results: ${JSON.stringify(params)}`,
          context: { backtestId: latestBacktest?.id },
        },
        (progressMsg) => setChatProgress(progressMsg)
      );
    },
    onSuccess: (data) => {
      setChatProgress(null);
      setDisplayMessages(prev => {
        const updated = [...prev];
        if (data.actions && data.actions.length > 0) {
          updated.push({
            role: "action",
            content: `Re-ran: ${data.actions.length} backtest${data.actions.length > 1 ? 's' : ''}`,
            actions: data.actions,
          });
        }
        updated.push({ role: "assistant", content: data.reply });
        return updated;
      });
      queryClient.invalidateQueries({ queryKey: ["/api/backtests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategies"] });
    },
    onError: (err: Error) => {
      setChatProgress(null);
      toast({ title: "Re-run failed", description: err.message, variant: "destructive" });
    },
  });

  const handleImplementConfig = (params: Record<string, any>, preserveDates = false) => {
    if (preserveDates && params.startDate && params.endDate) {
      localStorage.setItem("advisorSuggestedConfig", JSON.stringify(params));
    } else {
      const { startDate, endDate, ...safeParams } = params;
      localStorage.setItem("advisorSuggestedConfig", JSON.stringify(safeParams));
    }
    navigate("/backtest");
    toast({ title: "Settings applied", description: preserveDates ? "Backtest form pre-filled with original settings and date range." : "Backtest form has been pre-filled with the AI's suggested settings." });
  };

  const handleAnalyze = () => {
    if (!hasCachedData) {
      toast({ title: "No data available", description: "Fetch market data first before running analysis.", variant: "destructive" });
      return;
    }
    analyzeMutation.mutate(undefined);
  };

  const handleChat = () => {
    if (!chatInput.trim() && attachedFiles.length === 0) return;
    if (!hasCachedData) {
      toast({ title: "No data available", description: "Fetch market data first.", variant: "destructive" });
      return;
    }
    const userMsg = chatInput.trim() || (attachedFiles.length > 0 ? `Analyze the attached file${attachedFiles.length > 1 ? 's' : ''}` : '');
    const fileNames = attachedFiles.map(f => f.name);
    const displayContent = fileNames.length > 0
      ? `${userMsg}\n\n📎 ${fileNames.join(', ')}`
      : userMsg;
    const msgId = `msg_${Date.now()}`;
    setDisplayMessages(prev => [...prev, { role: "user", content: displayContent, _id: msgId }]);
    const filesToSend = attachedFiles.length > 0 ? [...attachedFiles] : undefined;
    setChatInput("");
    setAttachedFiles([]);
    chatMutation.mutate({ message: userMsg, files: filesToSend, _msgId: msgId });
  };

  const isLoading = analyzeMutation.isPending || chatMutation.isPending || reRunMutation.isPending;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="p-6 border-b bg-background/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2" data-testid="heading-advisor">
              <Brain className="w-5 h-5 text-primary" />
              AI Strategy Advisor
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Chat with the AI about your strategy, or run a full structured analysis
            </p>
            <PageGuide
              title="AI Advisor — Your Personal Trading Analyst"
              summary="Chat with an AI that knows your strategy, market conditions, and trading history. It can run backtests, suggest parameter changes, and explain what's happening in the gold market."
              steps={[
                { title: "Ask Questions", description: "Type naturally — 'Is my strategy working?', 'What's happening in gold right now?', 'Can you optimise my parameters?'. The AI has full context of your active strategy and recent performance." },
                { title: "Let It Optimise", description: "Ask the AI to find better parameters. It will run multiple backtests automatically, comparing results until it finds an improvement. Say something like 'optimise my strategy' or 'find better settings'." },
                { title: "Review Proposals", description: "When the AI finds better settings, it will either propose them (you approve/reject) or apply them directly if the improvement is clear." },
                { title: "Upload Files", description: "You can paste or attach images, CSV data, or text files. The AI can analyse charts, review exported trade data, or process any document you share." },
              ]}
              tips={[
                "The AI knows your current active strategy, recent backtest history, and live trading performance.",
                "Ask 'what strategy am I running?' to confirm exactly what's active.",
                "The Structured Analysis tab runs a comprehensive automated review with specific recommendations.",
                "You can attach screenshots of charts for the AI to analyse.",
              ]}
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant={activeTab === "chat" ? "default" : "outline"}
              size="sm"
              onClick={() => setActiveTab("chat")}
              data-testid="button-tab-chat"
            >
              <MessageSquare className="w-4 h-4 mr-1.5" />
              Chat
            </Button>
            <Button
              variant={activeTab === "analysis" ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setActiveTab("analysis");
                if (!analysis) handleAnalyze();
              }}
              disabled={!hasCachedData}
              data-testid="button-tab-analysis"
            >
              <Sparkles className="w-4 h-4 mr-1.5" />
              Full Analysis
            </Button>
            <Button
              variant={strategiesOpen ? "default" : "outline"}
              size="sm"
              onClick={() => setStrategiesOpen(!strategiesOpen)}
              className="relative"
              data-testid="button-saved-strategies"
            >
              <Bookmark className="w-4 h-4 mr-1.5" />
              Saved Strategies
              {(savedStrategies?.length ?? 0) > 0 && (
                <Badge variant="secondary" className="ml-1.5 text-[10px] h-4 px-1.5">
                  {savedStrategies!.length}
                </Badge>
              )}
              {strategiesOpen ? <ChevronUp className="w-3.5 h-3.5 ml-1" /> : <ChevronDown className="w-3.5 h-3.5 ml-1" />}
            </Button>
          </div>
        </div>
      </div>

      {strategiesOpen && (
        <div className="border-b bg-muted/30 px-6 py-4 max-h-[50vh] overflow-auto" data-testid="panel-saved-strategies">
          {(!savedStrategies || savedStrategies.length === 0) ? (
            <div className="text-center py-6 text-muted-foreground">
              <Bookmark className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm font-medium">No saved strategies yet</p>
              <p className="text-xs mt-1">Ask the AI to save strategies by risk category (e.g., "Save this as HIGH risk")</p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold">Saved Strategies ({savedStrategies.length})</h3>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setStrategiesOpen(false)} data-testid="button-close-strategies">
                  <X className="w-4 h-4" />
                </Button>
              </div>
              {(() => {
                const categories = [...new Set(savedStrategies.map(s => s.category || 'Uncategorized'))];
                return categories.map(cat => (
                  <div key={cat}>
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="outline" className="text-xs">{cat}</Badge>
                      <div className="h-px flex-1 bg-border" />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {savedStrategies.filter(s => (s.category || 'Uncategorized') === cat).map(strat => {
                        const rdr = strat.stats.maxDrawdownPct > 0 ? (strat.stats.returnPct / strat.stats.maxDrawdownPct).toFixed(1) : 'N/A';
                        return (
                          <div key={strat.id} className="border rounded-lg p-3 bg-background/80 text-xs space-y-2" data-testid={`strategy-card-${strat.id}`}>
                            <div className="flex items-center justify-between">
                              <div className="flex-1 min-w-0">
                                <span className="font-semibold text-sm block truncate">{strat.name}</span>
                                <span className="text-[10px] text-muted-foreground">{strat.createdAt ? new Date(strat.createdAt).toLocaleDateString() : ''} · XAUUSD H1</span>
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-5 w-5 p-0 text-muted-foreground hover:text-red-500 shrink-0"
                                onClick={() => deleteStrategyMutation.mutate(strat.id)}
                                data-testid={`button-delete-strategy-${strat.id}`}
                              >
                                <Trash2 className="w-3 h-3" />
                              </Button>
                            </div>
                            <div className="grid grid-cols-3 gap-1 font-mono text-muted-foreground">
                              <div>{strat.stats.totalTrades}t</div>
                              <div>{strat.stats.winRate}% WR</div>
                              <div className={strat.stats.returnPct >= 0 ? 'text-green-600' : 'text-red-500'}>{strat.stats.returnPct}% ret</div>
                              <div>PF {strat.stats.profitFactor}</div>
                              <div className={strat.stats.maxDrawdownPct <= 25 ? 'text-green-600' : 'text-amber-500'}>{strat.stats.maxDrawdownPct}% DD</div>
                              <div className="font-semibold">R/DD {rdr}</div>
                            </div>
                            <div className="text-[10px] text-muted-foreground font-mono">
                              RR={strat.config.rewardRatio} ATR={strat.config.atrStopMultiplier} Risk={strat.config.riskPerTradePct}% Lev={strat.config.leverage}x · {strat.config.sessionMode}
                            </div>
                            {strat.notes && (
                              <p className="text-[10px] text-muted-foreground italic">{strat.notes}</p>
                            )}
                            <div className="flex gap-2 pt-1 border-t">
                              <Button
                                size="sm"
                                className="h-7 text-xs px-2.5 flex-1"
                                onClick={() => handleImplementConfig(strat.config as any)}
                                data-testid={`button-implement-strategy-${strat.id}`}
                              >
                                <ArrowRight className="w-3 h-3 mr-1" />
                                Implement
                              </Button>
                              {strat.config.startDate && strat.config.endDate && (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  className="h-7 text-xs px-2"
                                  onClick={() => handleImplementConfig(strat.config as any, true)}
                                  data-testid={`button-implement-with-dates-${strat.id}`}
                                  title={`Use original dates: ${strat.config.startDate} → ${strat.config.endDate}`}
                                >
                                  <CalendarDays className="w-3 h-3" />
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs px-2.5 flex-1"
                                onClick={() => {
                                  reRunMutation.mutate(strat.config as any);
                                  setStrategiesOpen(false);
                                  setActiveTab("chat");
                                }}
                                disabled={reRunMutation.isPending}
                                data-testid={`button-rerun-strategy-${strat.id}`}
                              >
                                <Play className="w-3 h-3 mr-1" />
                                Re-Run
                              </Button>
                            </div>
                            <div className="flex gap-2 pt-1 border-t">
                              <Button
                                size="sm"
                                variant="secondary"
                                className="h-7 text-xs px-2 flex-1"
                                onClick={() => {
                                  window.open(`/api/strategies/${strat.id}/export/ctrader`, '_blank');
                                }}
                                data-testid={`button-export-ctrader-${strat.id}`}
                              >
                                <Download className="w-3 h-3 mr-1" />
                                cTrader
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                className="h-7 text-xs px-2 flex-1"
                                onClick={() => {
                                  window.open(`/api/strategies/${strat.id}/export/pdf`, '_blank');
                                }}
                                data-testid={`button-export-pdf-${strat.id}`}
                              >
                                <Download className="w-3 h-3 mr-1" />
                                PDF
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                className="h-7 text-xs px-2 flex-1"
                                onClick={() => {
                                  window.open(`/api/strategies/${strat.id}/export/json`, '_blank');
                                }}
                                data-testid={`button-export-json-${strat.id}`}
                              >
                                <Download className="w-3 h-3 mr-1" />
                                JSON
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ));
              })()}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto p-6 space-y-5">
        {/* Data Readiness Banner */}
        <Card className={!hasCachedData ? "border-amber-500/50 bg-amber-500/5" : ""}>
          <CardContent className="py-3 px-5">
            <div className="space-y-2">
              <div className="flex items-center gap-3 flex-wrap text-sm">
                <div className="flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium">Data Status:</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {hasCachedData ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-amber-500" />
                  )}
                  <span className="text-xs">
                    {hasCachedData
                      ? `${marketStatus!.data.xauusd.h1} H1 / ${marketStatus!.data.xauusd.h4} H4 / ${marketStatus!.data.xauusd.daily} Daily candles`
                      : "No market data loaded"}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  {hasBacktests ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-amber-500" />
                  )}
                  <span className="text-xs">
                    {hasBacktests ? `${backtests!.length} backtest(s)` : "No backtests run yet"}
                  </span>
                </div>
              </div>
              {!hasCachedData && (
                <div className="flex items-center gap-2 pt-1">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  <span className="text-xs text-amber-600 dark:text-amber-400">
                    Market data is required before the AI can provide meaningful analysis.
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs h-7 ml-auto"
                    onClick={() => fetchAllMutation.mutate()}
                    disabled={fetchAllMutation.isPending}
                    data-testid="button-fetch-data-advisor"
                  >
                    {fetchAllMutation.isPending ? (
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    ) : (
                      <Download className="w-3 h-3 mr-1" />
                    )}
                    Fetch Data Now
                  </Button>
                </div>
              )}
              {hasCachedData && !hasBacktests && (
                <div className="flex items-center gap-2 pt-1">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  <span className="text-xs text-amber-600 dark:text-amber-400">
                    Run a backtest first so the AI can analyze your strategy performance.
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs h-7 ml-auto"
                    onClick={() => navigate("/backtest")}
                    data-testid="button-go-backtest"
                  >
                    Go to Backtest
                  </Button>
                </div>
              )}
            </div>
            {hasCachedData && hasBacktests && latestBacktest && (
              <div className="flex items-center gap-3 flex-wrap text-sm mt-2 pt-2 border-t">
                <div className="flex items-center gap-1.5">
                  <Settings2 className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Latest Backtest:</span>
                </div>
                <Badge variant="outline" className="text-xs">
                  {latestBacktest.stats.totalTrades} trades
                </Badge>
                <Badge
                  variant="outline"
                  className={`text-xs ${latestBacktest.stats.netPnl >= 0 ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "border-red-500/40 text-red-600 dark:text-red-400"}`}
                >
                  {latestBacktest.stats.netPnl >= 0 ? "+" : ""}${latestBacktest.stats.netPnl.toFixed(2)} P&L
                </Badge>
                <Badge variant="outline" className="text-xs">
                  {latestBacktest.stats.winRate}% win rate
                </Badge>
              </div>
            )}
          </CardContent>
        </Card>

        {leaderboard && leaderboard.length > 0 && (
          <Card className="border-amber-500/30 bg-gradient-to-r from-amber-500/5 to-transparent" data-testid="leaderboard-card">
            <CardContent className="py-3 px-5">
              <button
                type="button"
                className="flex items-center gap-2 w-full text-left"
                onClick={() => setLeaderboardOpen(!leaderboardOpen)}
                data-testid="button-toggle-leaderboard"
              >
                <Trophy className="w-4 h-4 text-amber-500" />
                <span className="text-sm font-semibold text-amber-700 dark:text-amber-400">Strategy Leaderboard</span>
                <span className="text-xs text-muted-foreground ml-1">— {leaderboard.length} strategies</span>
                {leaderboardOpen ? <ChevronUp className="w-3.5 h-3.5 ml-auto text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 ml-auto text-muted-foreground" />}
              </button>
              {leaderboardOpen && (
                <div className="mt-3 space-y-2">
                  <div className="flex gap-1.5 mb-2">
                    <Button
                      size="sm"
                      variant={leaderboardSort === "performance" ? "default" : "outline"}
                      className={`h-6 text-[10px] px-3 ${leaderboardSort === "performance" ? "bg-amber-600 hover:bg-amber-700" : "border-amber-500/30 text-amber-700 dark:text-amber-400"}`}
                      onClick={() => setLeaderboardSort("performance")}
                      data-testid="button-sort-performance"
                    >
                      <TrendingUp className="w-3 h-3 mr-1" />
                      By Performance
                    </Button>
                    <Button
                      size="sm"
                      variant={leaderboardSort === "risk" ? "default" : "outline"}
                      className={`h-6 text-[10px] px-3 ${leaderboardSort === "risk" ? "bg-emerald-600 hover:bg-emerald-700" : "border-emerald-500/30 text-emerald-700 dark:text-emerald-400"}`}
                      onClick={() => setLeaderboardSort("risk")}
                      data-testid="button-sort-risk"
                    >
                      <Shield className="w-3 h-3 mr-1" />
                      By Safety
                    </Button>
                  </div>

                  <div className="grid grid-cols-[24px,1fr,70px,50px,55px,50px,50px] gap-x-2 px-2 pb-1.5 border-b text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">
                    <div>#</div>
                    <div>Strategy</div>
                    <div className="text-right">Return</div>
                    <div className="text-right">Max DD</div>
                    <div className="text-right">R/DD</div>
                    <div className="text-right">WR</div>
                    <div className="text-right">Trades</div>
                  </div>

                  {leaderboard.map((entry, i) => {
                    const isTop = i === 0;
                    const riskColor = Number(entry.stats.maxDrawdownPct) <= 5 ? "text-emerald-500" : Number(entry.stats.maxDrawdownPct) <= 10 ? "text-amber-500" : "text-red-500";
                    const riskBg = Number(entry.stats.maxDrawdownPct) <= 5 ? "bg-emerald-500/8" : Number(entry.stats.maxDrawdownPct) <= 10 ? "bg-amber-500/8" : "bg-red-500/5";
                    return (
                      <div
                        key={entry.id}
                        className={`rounded-lg text-xs transition-colors ${isTop ? 'bg-amber-500/10 border border-amber-500/30' : `${riskBg} border border-transparent hover:border-muted-foreground/20`}`}
                        data-testid={`leaderboard-entry-${i}`}
                      >
                        <div className="grid grid-cols-[24px,1fr,70px,50px,55px,50px,50px] gap-x-2 items-center px-2 py-2">
                          <div className="flex items-center justify-center">
                            {isTop ? <Crown className="w-4 h-4 text-amber-500" /> : i <= 2 ? <Medal className="w-3.5 h-3.5 text-amber-400/70" /> : <span className="text-[10px] font-bold text-muted-foreground">#{i+1}</span>}
                          </div>
                          <div className="min-w-0">
                            <div className="font-semibold text-xs truncate">{entry.label || `Strategy ${i+1}`}</div>
                            <div className="text-[9px] text-muted-foreground">
                              {entry.category && <span className="bg-muted/50 px-1 py-0.5 rounded mr-1">{entry.category}</span>}
                              PF {entry.stats.profitFactor}
                            </div>
                          </div>
                          <div className={`text-right font-mono font-bold ${Number(entry.stats.returnPct) >= 500 ? 'text-emerald-500' : Number(entry.stats.returnPct) >= 100 ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground'}`}>
                            {Number(entry.stats.returnPct).toFixed(1)}%
                          </div>
                          <div className={`text-right font-mono font-semibold ${riskColor}`}>
                            {Number(entry.stats.maxDrawdownPct).toFixed(1)}%
                          </div>
                          <div className="text-right font-mono text-muted-foreground">{entry.returnDD}</div>
                          <div className="text-right font-mono">{Number(entry.stats.winRate).toFixed(0)}%</div>
                          <div className="text-right font-mono text-muted-foreground">{entry.stats.totalTrades}</div>
                        </div>
                        <div className="flex gap-1.5 px-2 pb-2">
                          <Button
                            size="sm"
                            variant={isTop ? "default" : "outline"}
                            className={`h-5 text-[9px] px-2 ${isTop ? 'bg-amber-600 hover:bg-amber-700' : ''}`}
                            onClick={() => handleImplementConfig(entry.config as any)}
                            data-testid={`button-implement-leaderboard-${i}`}
                          >
                            <ArrowRight className="w-2.5 h-2.5 mr-0.5" />
                            Apply
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-5 text-[9px] px-2"
                            onClick={() => { reRunMutation.mutate(entry.config as any); setActiveTab("chat"); }}
                            disabled={reRunMutation.isPending}
                            data-testid={`button-rerun-leaderboard-${i}`}
                          >
                            <Play className="w-2.5 h-2.5 mr-0.5" />
                            Re-test
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-5 text-[9px] px-1.5 border-amber-500/20 text-amber-700 dark:text-amber-400"
                            onClick={async () => {
                              try {
                                const res = await apiRequest("POST", "/api/strategies/export/ctrader-from-config", { config: entry.config, stats: entry.stats });
                                const blob = await res.blob();
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement("a");
                                a.href = url;
                                a.download = `GoldRegime_${entry.label || 'Strategy'}_${entry.stats.returnPct}pct.algo`;
                                a.click();
                                URL.revokeObjectURL(url);
                              } catch {
                                toast({ title: "Export failed", variant: "destructive" });
                              }
                            }}
                            data-testid={`button-export-leaderboard-${i}`}
                          >
                            <Download className="w-2.5 h-2.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-5 text-[9px] px-1.5 border-emerald-500/20 text-emerald-700 dark:text-emerald-400"
                            onClick={async () => {
                              try {
                                const res = await apiRequest("POST", "/api/strategies/export/ctrader-from-config", { config: entry.config, stats: entry.stats, format: "source" });
                                const code = await res.text();
                                await navigator.clipboard.writeText(code);
                                toast({ title: "Source code copied!" });
                              } catch {
                                toast({ title: "Copy failed", variant: "destructive" });
                              }
                            }}
                            data-testid={`button-copy-leaderboard-${i}`}
                          >
                            <Copy className="w-2.5 h-2.5" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                  <div className="flex gap-2 mt-3 pt-2 border-t border-amber-500/20">
                    <div className="flex-1 flex flex-col gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs w-full border-amber-500/30 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10"
                        onClick={() => batchSweepMutation.mutate()}
                        disabled={batchSweepMutation.isPending || sweepRunning || !hasCachedData}
                        data-testid="button-batch-sweep"
                      >
                        {sweepRunning ? (
                          <><Loader2 className="w-3 h-3 mr-1 animate-spin" />Sweep running...</>
                        ) : batchSweepMutation.isPending ? (
                          <><Loader2 className="w-3 h-3 mr-1 animate-spin" />Starting...</>
                        ) : (
                          <><Zap className="w-3 h-3 mr-1" />Hill-Climb (beat current best)</>
                        )}
                      </Button>
                      {sweepStatus && (
                        <span className="text-[10px] text-amber-600/80 dark:text-amber-400/60 px-1" data-testid="text-sweep-status">{sweepStatus}</span>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs border-amber-500/30 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10"
                      onClick={() => window.open("/api/strategies/export/ctrader-all", "_blank")}
                      data-testid="button-download-all-ctrader"
                    >
                      <Download className="w-3 h-3 mr-1" />
                      Download All cTrader .cs
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Chat Tab */}
        {activeTab === "chat" && (
          <div className="space-y-4">
            {/* Chat Thread */}
            <Card className="flex flex-col">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="w-4 h-4 text-primary" />
                    <CardTitle className="text-base">Strategy Chat</CardTitle>
                    {displayMessages.length > 0 && (
                      <Badge variant="outline" className="text-[10px]">
                        {displayMessages.filter(m => m.role === "user").length} messages
                      </Badge>
                    )}
                  </div>
                  {displayMessages.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-muted-foreground"
                      onClick={() => clearChatMutation.mutate()}
                      disabled={clearChatMutation.isPending}
                      data-testid="button-clear-chat"
                    >
                      <Trash2 className="w-3 h-3 mr-1" />
                      Clear
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex-1 pt-0">
                {/* Messages */}
                <div className="max-h-[500px] overflow-y-auto space-y-3 mb-3" data-testid="chat-messages">
                  {displayMessages.length === 0 && !isLoading && (
                    <div className="text-center py-8 text-muted-foreground">
                      <Brain className="w-8 h-8 mx-auto mb-2 opacity-30" />
                      <p className="text-sm">
                        {hasCachedData
                          ? "Ask the AI to analyze, optimize, or run backtests — it can execute them directly."
                          : "Load market data first to start chatting."}
                      </p>
                      {hasCachedData && (
                        <p className="text-xs mt-2 opacity-60">
                          Try: "Optimize my strategy" or "Run a backtest with RR=3 and find the best settings"
                        </p>
                      )}
                    </div>
                  )}
                  {displayMessages.map((msg, i) => {
                    if (msg.role === "action" && msg.actions) {
                      const snapshotActions = msg.actions.filter(a => a.type === "get_market_snapshot");
                      const backtestActions = msg.actions.filter(a => a.type !== "get_market_snapshot");
                      const validActions = backtestActions.filter(a => a.params && Object.keys(a.params).length > 0 && !a.result.startsWith('ERROR:'));
                      const bestAction = validActions.length > 0 ? validActions.reduce((best, cur) => {
                        const getReturnDD = (r: string) => {
                          const m = r.match(/Return\/DD(?:\s+Ratio)?:\s*([\d.]+)/);
                          return m ? parseFloat(m[1]) : 0;
                        };
                        return getReturnDD(cur.result) > getReturnDD(best.result) ? cur : best;
                      }, validActions[0]) : null;
                      return (
                        <div key={i} className="flex justify-center flex-col gap-3" data-testid={`chat-action-${i}`}>
                          {snapshotActions.length > 0 && (
                            <div className="w-full max-w-[95%] mx-auto border-2 border-blue-500/40 bg-blue-500/5 rounded-xl p-4 space-y-2">
                              <div className="flex items-center gap-2 text-sm font-semibold text-blue-600 dark:text-blue-400">
                                <TrendingUp className="w-4 h-4" />
                                Live Market Analysis
                              </div>
                              {snapshotActions.map((sa, si) => {
                                const lines = sa.result.split('\n');
                                const sections: { title: string; lines: string[] }[] = [];
                                let currentSection = { title: "Overview", lines: [] as string[] };
                                for (const line of lines) {
                                  if (line.startsWith('===') && line.endsWith('===')) {
                                    if (currentSection.lines.length > 0) sections.push(currentSection);
                                    currentSection = { title: line.replace(/===/g, '').trim(), lines: [] };
                                  } else if (line.trim()) {
                                    currentSection.lines.push(line);
                                  }
                                }
                                if (currentSection.lines.length > 0) sections.push(currentSection);
                                return (
                                  <div key={si} className="space-y-2 text-xs font-mono">
                                    {sections.map((sec, si2) => (
                                      <div key={si2}>
                                        <div className="font-semibold text-blue-700 dark:text-blue-300 text-[11px] uppercase tracking-wider">{sec.title}</div>
                                        {sec.lines.map((l, li) => (
                                          <div key={li} className={`text-muted-foreground ${l.includes('ELEVATED') || l.includes('CRITICAL') || l.includes('HIGH') ? 'text-amber-600 dark:text-amber-400' : ''} ${l.includes('BUY') ? 'text-green-600 dark:text-green-400' : ''} ${l.includes('SELL') ? 'text-red-500 dark:text-red-400' : ''} ${l.includes('BULLISH') ? 'text-green-600 dark:text-green-400' : ''} ${l.includes('BEARISH') ? 'text-red-500 dark:text-red-400' : ''}`}>{l}</div>
                                        ))}
                                      </div>
                                    ))}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {backtestActions.length > 0 && (
                          <div className="w-full max-w-[95%] mx-auto border-2 border-amber-500/40 bg-amber-500/5 rounded-xl p-4 space-y-3">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2 text-sm font-semibold text-amber-600 dark:text-amber-400">
                                <Settings2 className="w-4 h-4" />
                                {msg.content}
                              </div>
                              {bestAction && validActions.length > 1 && (
                                <Badge className="bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-500/30 text-xs">
                                  Best: Run {backtestActions.indexOf(bestAction) + 1}
                                </Badge>
                              )}
                            </div>
                            {backtestActions.map((action, j) => {
                              const isError = action.result.startsWith('ERROR:');
                              if (isError) {
                                return (
                                  <div key={j} className="border border-red-500/30 rounded-lg p-3 bg-red-500/5 text-xs font-mono" data-testid={`action-result-${j}`}>
                                    <span className="text-red-600 dark:text-red-400">{action.result}</span>
                                  </div>
                                );
                              }
                              const lines = action.result.split('\n');
                              const statsLine = lines.find(l => l.startsWith('Trades:')) || '';
                              const pnlLine = lines.find(l => l.startsWith('P&L:')) || '';
                              const ddLine = lines.find(l => l.startsWith('Drawdown:')) || '';
                              const rddLine = lines.find(l => l.includes('Return/DD')) || '';
                              const configLine = lines.find(l => l.startsWith('Config:')) || '';
                              const hasParams = action.params && Object.keys(action.params).length > 0;
                              const isBest = bestAction === action && validActions.length > 1;
                              return (
                                <div key={j} className={`border rounded-lg p-3 text-xs space-y-2 ${isBest ? 'border-amber-500/50 bg-amber-500/10 ring-1 ring-amber-500/20' : 'bg-background/50'}`} data-testid={`action-result-${j}`}>
                                  <div className="flex items-center justify-between">
                                    <div className="text-xs text-muted-foreground font-mono">Run {j + 1}: {configLine}</div>
                                    {isBest && <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-600 dark:text-amber-400">Best</Badge>}
                                  </div>
                                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono">
                                    <div>{statsLine}</div>
                                    <div>{pnlLine}</div>
                                    <div>{ddLine}</div>
                                    <div>{rddLine}</div>
                                  </div>
                                  {hasParams && (
                                    <div className="flex gap-2 pt-2 border-t">
                                      <Button
                                        size="sm"
                                        variant={isBest ? "default" : "outline"}
                                        className="h-8 text-xs px-3"
                                        onClick={() => handleImplementConfig(action.params)}
                                        data-testid={`button-implement-${j}`}
                                      >
                                        <ArrowRight className="w-3.5 h-3.5 mr-1.5" />
                                        Implement
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-8 text-xs px-3"
                                        onClick={() => reRunMutation.mutate(action.params)}
                                        disabled={reRunMutation.isPending}
                                        data-testid={`button-rerun-${j}`}
                                      >
                                        {reRunMutation.isPending ? (
                                          <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                                        ) : (
                                          <Play className="w-3.5 h-3.5 mr-1.5" />
                                        )}
                                        Re-Run
                                      </Button>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          )}
                        </div>
                      );
                    }
                    const prevMsg = i > 0 ? displayMessages[i - 1] : null;
                    const hasActionsAbove = prevMsg?.role === "action" && prevMsg.actions && prevMsg.actions.length > 0;
                    const actionsAbove = hasActionsAbove ? prevMsg!.actions! : [];
                    const bestActionAbove = actionsAbove.length > 0
                      ? actionsAbove.filter(a => a.params && Object.keys(a.params).length > 0 && !a.result.startsWith('ERROR:')).reduce((best, cur) => {
                          if (!best) return cur;
                          const getReturnDD = (r: string) => { const m = r.match(/Return\/DD(?:\s+Ratio)?:\s*([\d.]+)/); return m ? parseFloat(m[1]) : 0; };
                          return getReturnDD(cur.result) > getReturnDD(best.result) ? cur : best;
                        }, null as (typeof actionsAbove[0] | null))
                      : null;
                    return (
                      <div
                        key={i}
                        className={`flex gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                        data-testid={`chat-message-${msg.role}-${i}`}
                      >
                        {msg.role === "assistant" && (
                          <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-1">
                            <Brain className="w-3.5 h-3.5 text-primary" />
                          </div>
                        )}
                        <div
                          className={`rounded-lg px-3 py-2 max-w-[85%] text-sm leading-relaxed ${
                            msg.role === "user"
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted"
                          }`}
                        >
                          {msg.role === "assistant" ? (
                            <div className="whitespace-pre-wrap">{msg.content}</div>
                          ) : (
                            msg.content
                          )}
                          {msg.role === "assistant" && bestActionAbove && (
                            <div className="flex gap-2 pt-3 mt-3 border-t border-border/50">
                              <Button
                                size="sm"
                                className="h-8 text-xs px-3"
                                onClick={() => handleImplementConfig(bestActionAbove.params)}
                                data-testid={`button-implement-best-${i}`}
                              >
                                <ArrowRight className="w-3.5 h-3.5 mr-1.5" />
                                Implement Best Config
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 text-xs px-3"
                                onClick={() => reRunMutation.mutate(bestActionAbove.params)}
                                disabled={reRunMutation.isPending}
                                data-testid={`button-rerun-best-${i}`}
                              >
                                {reRunMutation.isPending ? (
                                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                                ) : (
                                  <Play className="w-3.5 h-3.5 mr-1.5" />
                                )}
                                Re-Run Best
                              </Button>
                            </div>
                          )}
                        </div>
                        {msg.role === "user" && (
                          <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center shrink-0 mt-1">
                            <User className="w-3.5 h-3.5" />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {(chatMutation.isPending || reRunMutation.isPending) && (
                    <div className="flex gap-2 justify-start">
                      <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-1">
                        <Brain className="w-3.5 h-3.5 text-primary" />
                      </div>
                      <div className="bg-muted rounded-lg px-3 py-2 text-sm flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span className="text-xs text-muted-foreground">
                          {chatProgress || (reRunMutation.isPending ? "Re-running backtest..." : "Running backtests and analyzing...")}
                        </span>
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* Attached files preview */}
                {attachedFiles.length > 0 && (
                  <div className="flex gap-2 flex-wrap mb-2" data-testid="attached-files-preview">
                    {attachedFiles.map((f, i) => (
                      <div key={i} className="flex items-center gap-1.5 bg-muted rounded-md px-2 py-1 text-xs">
                        {f.type === "image" ? <ImageIcon className="w-3 h-3 text-blue-500" /> : <FileText className="w-3 h-3 text-green-500" />}
                        <span className="max-w-[120px] truncate">{f.name}</span>
                        <button
                          onClick={() => setAttachedFiles(prev => prev.filter((_, idx) => idx !== i))}
                          className="text-muted-foreground hover:text-destructive ml-0.5"
                          data-testid={`button-remove-file-${i}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Input */}
                <div className="flex gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    multiple
                    accept="image/*,.csv,.txt,.json,.md,.log,.py,.js,.ts"
                    onChange={handleFileSelect}
                    data-testid="input-file-upload"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 self-end"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isLoading || !hasCachedData || attachedFiles.length >= 5}
                    title="Attach files (images, CSV, text)"
                    data-testid="button-attach-file"
                  >
                    <Paperclip className="w-4 h-4" />
                  </Button>
                  <Textarea
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder={hasCachedData ? "Ask to optimize, run backtests, or attach files..." : "Load market data first"}
                    className="min-h-[44px] max-h-[100px] resize-none text-sm"
                    disabled={!hasCachedData}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleChat();
                      }
                    }}
                    onPaste={(e) => {
                      const items = e.clipboardData?.items;
                      if (!items) return;
                      for (const item of Array.from(items)) {
                        if (item.type.startsWith('image/')) {
                          e.preventDefault();
                          const file = item.getAsFile();
                          if (!file) continue;
                          if (file.size > 4 * 1024 * 1024) {
                            toast({ title: "Image too large", description: "Max 4MB", variant: "destructive" });
                            return;
                          }
                          const reader = new FileReader();
                          reader.onload = () => {
                            const dataUrl = reader.result as string;
                            setAttachedFiles(prev => {
                              if (prev.length >= 5) return prev;
                              return [...prev, { type: "image", name: `pasted-image-${Date.now()}.png`, content: dataUrl, preview: dataUrl }];
                            });
                          };
                          reader.readAsDataURL(file);
                        }
                      }
                    }}
                    data-testid="input-advisor-chat"
                  />
                  <Button
                    onClick={handleChat}
                    disabled={isLoading || (!chatInput.trim() && attachedFiles.length === 0) || !hasCachedData}
                    size="icon"
                    className="shrink-0 self-end"
                    data-testid="button-send-chat"
                  >
                    {chatMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  </Button>
                </div>

                {/* Quick questions */}
                <div className="flex gap-2 mt-3 flex-wrap">
                  {[
                    "Analyze the current gold market — what regime are we in, what's the plan?",
                    "Would my strategy work right now? Check the live market and suggest entries",
                    "Optimize my strategy — run backtests and find better settings",
                    "What's wrong with my strategy? Analyze the diagnostics",
                    "Try to get Return/DD ratio above 10",
                  ].map((q) => (
                    <button
                      key={q}
                      onClick={() => {
                        if (!hasCachedData) return;
                        setDisplayMessages(prev => [...prev, { role: "user", content: q }]);
                        chatMutation.mutate({ message: q });
                      }}
                      disabled={isLoading || !hasCachedData}
                      className="text-xs px-2.5 py-1 rounded-full border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
                      data-testid={`button-quick-${q.slice(0, 15).replace(/\s/g, "-").toLowerCase()}`}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Analysis Tab */}
        {activeTab === "analysis" && (
          <div className="space-y-4">
            {/* Loading State */}
            {analyzeMutation.isPending && (
              <div className="space-y-4">
                <Card>
                  <CardContent className="py-6">
                    <div className="flex items-center gap-3">
                      <Loader2 className="w-5 h-5 animate-spin text-primary" />
                      <div>
                        <div className="text-sm font-medium">Running full analysis...</div>
                        <div className="text-xs text-muted-foreground">The AI is reviewing your backtest results, market context, and trade patterns</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <Skeleton className="h-48" />
                  <Skeleton className="h-48" />
                </div>
              </div>
            )}

            {/* Analysis Results */}
            {analysis && !analyzeMutation.isPending && (
              <div className="space-y-4">
                <Card data-testid="card-overall-assessment">
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
                        <Brain className="w-3.5 h-3.5 text-primary" />
                      </div>
                      <CardTitle className="text-base">Overall Assessment</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground leading-relaxed" data-testid="text-overall-assessment">
                      {analysis.overallAssessment}
                    </p>
                  </CardContent>
                </Card>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <Card data-testid="card-market-analysis">
                    <CardHeader className="pb-3">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-md bg-emerald-500/10 flex items-center justify-center">
                          <TrendingUp className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                        </div>
                        <CardTitle className="text-base">Market Analysis</CardTitle>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground leading-relaxed" data-testid="text-market-analysis">
                        {analysis.marketAnalysis}
                      </p>
                    </CardContent>
                  </Card>

                  <Card data-testid="card-pattern-observations">
                    <CardHeader className="pb-3">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-md bg-blue-500/10 flex items-center justify-center">
                          <Sparkles className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                        </div>
                        <CardTitle className="text-base">Pattern Observations</CardTitle>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground leading-relaxed" data-testid="text-pattern-observations">
                        {analysis.patternObservations}
                      </p>
                    </CardContent>
                  </Card>
                </div>

                {analysis.parameterSuggestions.length > 0 && (
                  <Card data-testid="card-parameter-suggestions">
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-md bg-amber-500/10 flex items-center justify-center">
                            <Settings2 className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                          </div>
                          <CardTitle className="text-base">Suggested Parameter Tweaks</CardTitle>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs"
                            onClick={() => {
                              const params: Record<string, any> = {};
                              for (const sug of analysis.parameterSuggestions) {
                                const val = sug.suggestedValue;
                                params[sug.parameter] = typeof val === "string" && !isNaN(Number(val)) ? Number(val) : val;
                              }
                              handleImplementConfig(params);
                            }}
                            data-testid="button-implement-all-suggestions"
                          >
                            <ArrowRight className="w-3.5 h-3.5 mr-1" />
                            Implement All
                          </Button>
                          <Button
                            size="sm"
                            className="h-8 text-xs"
                            onClick={() => {
                              const params: Record<string, any> = {};
                              for (const sug of analysis.parameterSuggestions) {
                                const val = sug.suggestedValue;
                                params[sug.parameter] = typeof val === "string" && !isNaN(Number(val)) ? Number(val) : val;
                              }
                              reRunMutation.mutate(params);
                              setActiveTab("chat");
                            }}
                            disabled={reRunMutation.isPending}
                            data-testid="button-run-all-suggestions"
                          >
                            {reRunMutation.isPending ? (
                              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                            ) : (
                              <Play className="w-3.5 h-3.5 mr-1" />
                            )}
                            Run Backtest
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-3">
                        {analysis.parameterSuggestions.map((sug, i) => (
                          <div
                            key={i}
                            className="border rounded-lg p-3 space-y-2"
                            data-testid={`suggestion-${sug.parameter}`}
                          >
                            <div className="flex items-center justify-between gap-2 flex-wrap">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium">{sug.parameter}</span>
                                <div className="flex items-center gap-1.5 text-xs">
                                  <Badge variant="outline" className="font-mono">
                                    {String(sug.currentValue)}
                                  </Badge>
                                  <ChevronRight className="w-3 h-3 text-muted-foreground" />
                                  <Badge className="font-mono bg-primary/10 text-primary border-primary/20">
                                    {String(sug.suggestedValue)}
                                  </Badge>
                                </div>
                              </div>
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              <strong className="text-foreground/80">Why:</strong> {sug.rationale}
                            </p>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              <strong className="text-foreground/80">Expected:</strong> {sug.expectedImpact}
                            </p>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {analysis.riskWarnings.length > 0 && (
                  <Card data-testid="card-risk-warnings">
                    <CardHeader className="pb-3">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-md bg-red-500/10 flex items-center justify-center">
                          <AlertTriangle className="w-3.5 h-3.5 text-red-600 dark:text-red-400" />
                        </div>
                        <CardTitle className="text-base">Risk Warnings</CardTitle>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <ul className="space-y-2">
                        {analysis.riskWarnings.map((warning, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm" data-testid={`warning-${i}`}>
                            <AlertTriangle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
                            <span className="text-muted-foreground leading-relaxed">{warning}</span>
                          </li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                )}

                <div className="flex justify-center pt-2">
                  <Button
                    variant="outline"
                    onClick={handleAnalyze}
                    disabled={analyzeMutation.isPending}
                    data-testid="button-reanalyze"
                  >
                    <RefreshCw className="w-4 h-4 mr-1.5" />
                    Re-analyze with Latest Data
                  </Button>
                </div>
              </div>
            )}

            {/* Empty state for analysis */}
            {!analysis && !analyzeMutation.isPending && (
              <div className="flex items-center justify-center py-16">
                <div className="text-center max-w-sm">
                  <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                    <Sparkles className="w-8 h-8 text-primary" />
                  </div>
                  {!hasCachedData ? (
                    <>
                      <h2 className="text-lg font-semibold mb-2">Data Required</h2>
                      <p className="text-sm text-muted-foreground mb-4">
                        Fetch market data first for a structured analysis.
                      </p>
                      <Button
                        onClick={() => fetchAllMutation.mutate()}
                        disabled={fetchAllMutation.isPending}
                        data-testid="button-fetch-data-empty"
                      >
                        {fetchAllMutation.isPending ? (
                          <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                        ) : (
                          <Download className="w-4 h-4 mr-1.5" />
                        )}
                        Fetch Market Data
                      </Button>
                    </>
                  ) : (
                    <>
                      <h2 className="text-lg font-semibold mb-2">Run Full Analysis</h2>
                      <p className="text-sm text-muted-foreground mb-6">
                        Get a structured breakdown of market context, patterns, parameter suggestions, and risk warnings.
                      </p>
                      <Button onClick={handleAnalyze} data-testid="button-start-analysis">
                        <Sparkles className="w-4 h-4 mr-1.5" />
                        Run Full Analysis
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
