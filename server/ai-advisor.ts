import { openai as replit_openai } from "./replit_integrations/audio/client";
import { z } from "zod";
import type { BacktestResult, BacktestConfig, BacktestStats, Trade } from "../shared/schema";
import { backtestConfigSchema } from "../shared/schema";
import type { AsianMarketSnapshot, EconomicEvent } from "./data-fetcher";
import { runBacktest } from "./backtest";
import { getCachedData, getDataFreshness, fetchLivePrice, ensureDataReady, getLatestGVZ, getGVZPercentileForValue, getLatestCOT, getLatestSGE } from "./data-fetcher";
import { getHMMState, getLastHMMClassification, isHMMTrained } from "./hmm-engine";
import { getLastMRSGARCHState, getMRSGARCHModel, isMRSGARCHTrained } from "./mrs-garch";
import { storage, type JournalEntry } from "./storage";
import { calcATR, calcBBWidth, calcEMA, calcSMA, calcMACD, calcADX, calcOBV, calcVWAP, calcVolumeSMA, calcVolumeProfile } from "./regime-engine";
import crypto from "crypto";

const openai = replit_openai;

const AI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
console.log(`[AI] Using model: ${AI_MODEL} (Replit integration)`);

export function getAIModelInfo() {
  return { model: AI_MODEL, source: "replit_integration" };
}

export type HistoricalRunSummary = {
  id: string;
  createdAt: string;
  dataSource: string;
  config: BacktestConfig;
  stats: BacktestStats;
  diagnostics?: Record<string, number>;
  monthlyReturns?: { month: string; return: number; trades: number }[];
};

export type AdvisorRequest = {
  backtestId?: string;
  stats?: BacktestStats;
  config?: BacktestConfig;
  trades?: Trade[];
  diagnostics?: Record<string, number>;
  monthlyReturns?: { month: string; return: number; trades: number }[];
  regimeCounts?: { range: number; trend: number; no_trade: number };
  asianMarkets?: AsianMarketSnapshot[];
  upcomingEvents?: EconomicEvent[];
  userQuestion?: string;
  historicalRuns?: HistoricalRunSummary[];
};

export type AdvisorResponse = {
  marketAnalysis: string;
  patternObservations: string;
  parameterSuggestions: ParameterSuggestion[];
  riskWarnings: string[];
  overallAssessment: string;
};

export type ParameterSuggestion = {
  parameter: string;
  currentValue: string | number | boolean;
  suggestedValue: string | number | boolean;
  rationale: string;
  expectedImpact: string;
};

const advisorResponseSchema = z.object({
  marketAnalysis: z.string().default("No market analysis available."),
  patternObservations: z.string().default("No patterns identified."),
  parameterSuggestions: z.array(z.object({
    parameter: z.string(),
    currentValue: z.union([z.string(), z.number(), z.boolean()]),
    suggestedValue: z.union([z.string(), z.number(), z.boolean()]),
    rationale: z.string(),
    expectedImpact: z.string(),
  })).default([]),
  riskWarnings: z.array(z.string()).default([]),
  overallAssessment: z.string().default("Unable to generate assessment."),
});

export const analyzeRequestSchema = z.object({
  backtestId: z.string().optional(),
  userQuestion: z.string().max(1000).optional(),
});

export const chatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  context: z.object({
    backtestId: z.string().optional(),
  }).optional(),
  attachments: z.array(z.object({
    type: z.enum(["text", "csv", "image"]),
    name: z.string().max(256),
    content: z.string().max(6000000),
  })).max(5).optional(),
});

let lastCallTimestamp = 0;
const MIN_INTERVAL_MS = 2000;

export function checkRateLimit(): boolean {
  const now = Date.now();
  if (now - lastCallTimestamp < MIN_INTERVAL_MS) {
    return false;
  }
  lastCallTimestamp = now;
  return true;
}

type BacktestAction = { type: string; params: Record<string, any>; result: string };
type ChatEntry = { role: "user" | "assistant" | "action"; content: string; actions?: BacktestAction[] };
let chatHistory: ChatEntry[] = [];
const MAX_CHAT_HISTORY = 30;

export function getChatHistory(): ChatEntry[] {
  return chatHistory;
}

export function clearChatHistory(): void {
  chatHistory = [];
}

export async function recordAnalysisSuggestions(
  suggestions: Array<{ parameter: string; currentValue: string | number | boolean; suggestedValue: string | number | boolean; rationale: string; expectedImpact?: string }>,
  beforeBacktestId?: string,
  beforeStats?: { returnPct: number; maxDrawdownPct: number; winRate: number; totalTrades: number; profitFactor: number }
): Promise<string> {
  const id = crypto.randomBytes(4).toString("hex");
  const entry: JournalEntry = {
    id,
    createdAt: new Date().toISOString(),
    source: "analysis",
    suggestions: suggestions.map(s => ({
      parameter: s.parameter,
      fromValue: s.currentValue,
      toValue: s.suggestedValue,
      rationale: s.rationale,
    })),
    beforeBacktestId,
    beforeStats,
    outcome: "pending",
  };
  await storage.saveJournalEntry(entry);
  console.log(`[Journal] Recorded analysis suggestions (${suggestions.length} params) → journal ${id}`);
  return id;
}

export async function recordChatBacktestResult(
  backtestId: string,
  stats: { returnPct: number; maxDrawdownPct: number; winRate: number; totalTrades: number; profitFactor: number },
  changedParams: Array<{ parameter: string; fromValue: string | number; toValue: string | number; rationale: string }>,
  previousStats?: { returnPct: number; maxDrawdownPct: number; winRate: number; totalTrades: number; profitFactor: number }
): Promise<void> {
  const pending = await storage.getLatestPendingJournal();

  if (pending && changedParams.length > 0) {
    const pendingParamNames = new Set(pending.suggestions.map(s => s.parameter));
    const changedParamNames = new Set(changedParams.map(c => c.parameter));
    const overlap = [...pendingParamNames].filter(p => changedParamNames.has(p));
    const matchRatio = pendingParamNames.size > 0 ? overlap.length / pendingParamNames.size : 0;

    if (matchRatio >= 0.5) {
      const before = pending.beforeStats || previousStats;
      let outcome: "improved" | "worsened" | "mixed" = "mixed";
      if (before) {
        const retBetter = stats.returnPct > before.returnPct;
        const ddBetter = stats.maxDrawdownPct <= before.maxDrawdownPct;
        if (retBetter && ddBetter) outcome = "improved";
        else if (!retBetter && !ddBetter) outcome = "worsened";
        else outcome = "mixed";
      }

      const learnings = generateLearnings(pending.suggestions, before, stats);

      await storage.updateJournalEntry(pending.id, {
        afterBacktestId: backtestId,
        afterStats: stats,
        outcome,
        learnings,
      });
      console.log(`[Journal] Updated journal ${pending.id}: ${outcome} (ret ${before?.returnPct ?? '?'}%→${stats.returnPct}%, dd ${before?.maxDrawdownPct ?? '?'}%→${stats.maxDrawdownPct}%)`);
      return;
    }
  }

  if (changedParams.length > 0) {
    const id = crypto.randomBytes(4).toString("hex");
    let outcome: "improved" | "worsened" | "mixed" = "mixed";
    if (previousStats) {
      const retBetter = stats.returnPct > previousStats.returnPct;
      const ddBetter = stats.maxDrawdownPct <= previousStats.maxDrawdownPct;
      if (retBetter && ddBetter) outcome = "improved";
      else if (!retBetter && !ddBetter) outcome = "worsened";
    }
    const entry: JournalEntry = {
      id,
      createdAt: new Date().toISOString(),
      source: "chat",
      suggestions: changedParams,
      beforeStats: previousStats,
      afterBacktestId: backtestId,
      afterStats: stats,
      outcome,
      learnings: generateLearnings(changedParams, previousStats, stats),
    };
    await storage.saveJournalEntry(entry);
    console.log(`[Journal] Recorded chat backtest result → journal ${id}: ${outcome}`);
  }

  if (pending && pending.outcome === "pending") {
    const ageMs = Date.now() - new Date(pending.createdAt).getTime();
    if (ageMs > 30 * 60 * 1000) {
      await storage.updateJournalEntry(pending.id, { outcome: "pending" as any, learnings: "Expired — no matching backtest was run within 30 minutes." });
    }
  }
}

function generateLearnings(
  suggestions: JournalEntry["suggestions"],
  before: { returnPct: number; maxDrawdownPct: number; winRate: number; totalTrades: number; profitFactor: number } | undefined,
  after: { returnPct: number; maxDrawdownPct: number; winRate: number; totalTrades: number; profitFactor: number }
): string {
  if (!before) return `First recorded result: ${after.returnPct}% return, ${after.maxDrawdownPct}% DD, ${after.winRate}% WR.`;

  const parts: string[] = [];
  const paramChanges = suggestions.map(s => `${s.parameter}: ${s.fromValue}→${s.toValue}`).join(', ');
  parts.push(`Changed: ${paramChanges}`);

  const retDelta = after.returnPct - before.returnPct;
  const ddDelta = after.maxDrawdownPct - before.maxDrawdownPct;
  parts.push(`Return: ${before.returnPct}%→${after.returnPct}% (${retDelta >= 0 ? '+' : ''}${retDelta.toFixed(1)}%)`);
  parts.push(`DD: ${before.maxDrawdownPct}%→${after.maxDrawdownPct}% (${ddDelta >= 0 ? '+' : ''}${ddDelta.toFixed(1)}%)`);
  parts.push(`WR: ${before.winRate}%→${after.winRate}%, PF: ${before.profitFactor}→${after.profitFactor}`);

  if (retDelta > 0 && ddDelta <= 0) parts.push(`VERDICT: Pure improvement — keep these changes.`);
  else if (retDelta < 0 && ddDelta > 0) parts.push(`VERDICT: Worse on both metrics — REVERT these changes.`);
  else if (retDelta > 0 && ddDelta > 0) parts.push(`VERDICT: Higher return but higher risk — evaluate if trade-off is worth it.`);
  else parts.push(`VERDICT: Lower return but safer — may be useful for conservative configs.`);

  return parts.join(' | ');
}

async function formatJournalForPrompt(): Promise<string> {
  const entries = await storage.listJournalEntries(30);
  if (entries.length === 0) return '';

  const lines = entries.reverse().map((e, i) => {
    const paramStr = e.suggestions.map(s => `${s.parameter}: ${s.fromValue}→${s.toValue}`).join(', ');
    let result = `  #${i + 1} [${e.source.toUpperCase()}] ${e.createdAt.substring(0, 16)} | ${paramStr}`;
    if (e.beforeStats && e.afterStats) {
      result += `\n    Before: ${e.beforeStats.returnPct}% ret, ${e.beforeStats.maxDrawdownPct}% DD, ${e.beforeStats.winRate}% WR`;
      result += `\n    After:  ${e.afterStats.returnPct}% ret, ${e.afterStats.maxDrawdownPct}% DD, ${e.afterStats.winRate}% WR`;
      result += ` → ${e.outcome?.toUpperCase()}`;
    } else if (e.afterStats) {
      result += `\n    Result: ${e.afterStats.returnPct}% ret, ${e.afterStats.maxDrawdownPct}% DD, ${e.afterStats.winRate}% WR → ${e.outcome?.toUpperCase()}`;
    } else {
      result += ` → PENDING (not yet tested)`;
    }
    if (e.learnings) {
      const truncated = e.learnings.length > 200 ? e.learnings.substring(0, 200) + '...' : e.learnings;
      result += `\n    Learning: ${truncated}`;
    }
    return result;
  });

  return `\n## OPTIMIZATION JOURNAL (${entries.length} entries — YOUR MEMORY of past experiments)\nThis is your persistent learning history. NEVER repeat changes that WORSENED results. BUILD on changes that IMPROVED results.\n${lines.join('\n\n')}`;
}

const BACKTEST_TOOL_DEFINITION = {
  type: "function" as const,
  function: {
    name: "run_backtest",
    description: "Run a backtest with specified parameters. Use this to test parameter changes, compare configs, or iterate toward optimal settings. The backtest runs against real XAUUSD market data and returns full stats. You can call this multiple times to iterate.",
    parameters: {
      type: "object",
      properties: {
        rewardRatio: { type: "number", description: "Take profit / stop loss ratio (1-20)" },
        atrStopMultiplier: { type: "number", description: "Stop loss = ATR × this (0.5-5)" },
        compressionThreshold: { type: "number", description: "BB width for range detection (0.001-0.1)" },
        expansionThreshold: { type: "number", description: "ATR ratio for trend detection (1.01-3)" },
        rangeWidthBars: { type: "number", description: "H4 range lookback bars (5-50)" },
        midpointBandPct: { type: "number", description: "No-trade zone width (0.01-0.5)" },
        retestBuffer: { type: "number", description: "Acceptance retest tolerance (0.5-50)" },
        wickRatio: { type: "number", description: "Rejection candle wick ratio (0.3-5)" },
        executionTimeframe: { type: "string", enum: ["1h", "15min", "1min"], description: "Execution candle timeframe. H4 always used for regime detection. Lower TF = more precise entries but needs more data." },
        sessionMode: { type: "string", enum: ["London+NewYork", "London", "NewYork", "Asian", "Asian+London", "Asian+London+NewYork", "All"] },
        entryWindowBars: { type: "number", description: "Only allow entries in the first N hours after session open (0=disabled, 1-12). E.g. entryWindowBars=2 with London session = only trade 07:00-08:00 UTC" },
        maxTradesPerDay: { type: "number", description: "Max trades per day (1-10)" },
        riskPerTradePct: { type: "number", description: "% of balance risked per trade (0.1-10)" },
        leverage: { type: "number", description: "Margin leverage (FIXED at 10, determines max position via margin only — does NOT multiply risk)" },
        maxDrawdownPct: { type: "number", description: "Circuit breaker DD threshold (5-25, MUST NOT exceed 25)" },
        maxDailyLossPct: { type: "number", description: "Daily loss cap % (0.5-20)" },
        maxConsecutiveLosses: { type: "number", description: "Pause after N consecutive losses (1-20)" },
        postLossCooldownBars: { type: "number", description: "Bars to sit out after consec loss limit (0-20)" },
        reduceSizeAfterLoss: { type: "boolean", description: "Use reduced risk after a loss" },
        reducedRiskPerTradePct: { type: "number", description: "Risk % used after a loss (0.1-10)" },
        atrRiskScaleEnabled: { type: "boolean", description: "Reduce risk when ATR elevated" },
        atrRiskScaleThreshold: { type: "number", description: "ATR/avgATR ratio trigger (1.01-5)" },
        atrRiskScaleFactor: { type: "number", description: "Multiply risk by this when ATR elevated (0.1-1)" },
        secondTradeRiskFactor: { type: "number", description: "Multiply risk on 2nd+ trade of day (0.1-1)" },
        atrPeriod: { type: "number", description: "ATR calculation period (5-50)" },
        spreadPoints: { type: "number", description: "Bid/Ask spread in price points for XAUUSD (0-5, default 0.30). Set this to match your broker's typical spread for realistic results." },
        slippagePoints: { type: "number", description: "Execution slippage in price points (0-5, default 0.10)" },
        commissionPerLot: { type: "number", description: "Per-lot commission in dollars (0-50, default 0)" },
        avoidHoursEnabled: { type: "boolean", description: "Block entries during low-liquidity hours (default true)" },
        avoidHoursUTC: { type: "array", items: { type: "number" }, description: "UTC hours to avoid entries, e.g. [21,22,23,0] (default [21,22,23,0])" },
        peakHoursEnabled: { type: "boolean", description: "Only allow entries during specified peak hours (default false)" },
        peakHoursUTC: { type: "array", items: { type: "number" }, description: "UTC hours to allow entries when peakHoursEnabled=true, e.g. [8,9,10,13,14]" },
        startDate: { type: "string", description: "Backtest start date in YYYY-MM-DD format. IMPORTANT: Always set this to match what the user requested. If user says 'from Jan 2026', use '2026-01-01'. If not specified by the user, ALWAYS default to '2026-01-01'. NEVER use dates before 2026-01-01." },
        endDate: { type: "string", description: "Backtest end date in YYYY-MM-DD format. IMPORTANT: Always set this to match what the user requested. If not specified, use today's date." },
      },
      required: [],
    },
  },
};

const SAVE_STRATEGY_TOOL_DEFINITION = {
  type: "function" as const,
  function: {
    name: "save_strategy",
    description: "Save a strategy configuration with a name and risk category for future reference. Use this when the user asks to save, bookmark, or remember a strategy. Categories: V-LOW, LOW, MED, HIGH (or custom).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for the strategy (e.g., 'Conservative Range', 'Aggressive Trend')" },
        category: { type: "string", description: "Risk category: V-LOW, LOW, MED, HIGH, or custom label" },
        config: { type: "object", description: "Full backtest config object to save" },
        stats: { type: "object", description: "Backtest stats from the run to save alongside the config" },
        notes: { type: "string", description: "Optional notes about why this strategy was saved" },
      },
      required: ["name", "category", "config", "stats"],
    },
  },
};

const LIST_STRATEGIES_TOOL_DEFINITION = {
  type: "function" as const,
  function: {
    name: "list_strategies",
    description: "Retrieve all saved strategies. Use this when the user asks to compare strategies, recall saved configs, or review their strategy library.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

const GET_MARKET_SNAPSHOT_TOOL_DEFINITION = {
  type: "function" as const,
  function: {
    name: "get_market_snapshot",
    description: "Get a live snapshot of the current gold market: latest price, ATR, regime state, key support/resistance levels, trend direction, upcoming economic events, and Asian market sentiment. Use this after backtests to assess whether the strategy fits current conditions, suggest entry points, and build a trading plan.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

const PROPOSE_LOCKED_PARAMS_TOOL_DEFINITION = {
  type: "function" as const,
  function: {
    name: "propose_locked_params",
    description: "Propose changes to the LOCKED trading parameters (the live production params). Only use this when you have strong backtest evidence that new params clearly outperform current ones. The proposal will be sent for user approval — it will NOT be applied automatically. Include the backtest stats that prove the improvement. The user will see a side-by-side comparison of current vs proposed params with before/after performance stats.",
    parameters: {
      type: "object",
      properties: {
        proposedParams: {
          type: "object",
          description: "Full set of proposed locked params (include ALL params, not just changed ones)",
        },
        currentStats: {
          type: "object",
          description: "Performance stats of current locked params (returnPct, maxDrawdownPct, winRate, totalTrades, profitFactor)",
          properties: {
            returnPct: { type: "number" },
            maxDrawdownPct: { type: "number" },
            winRate: { type: "number" },
            totalTrades: { type: "number" },
            profitFactor: { type: "number" },
          },
          required: ["returnPct", "maxDrawdownPct", "winRate", "totalTrades", "profitFactor"],
        },
        proposedStats: {
          type: "object",
          description: "Performance stats of proposed params from backtest (returnPct, maxDrawdownPct, winRate, totalTrades, profitFactor)",
          properties: {
            returnPct: { type: "number" },
            maxDrawdownPct: { type: "number" },
            winRate: { type: "number" },
            totalTrades: { type: "number" },
            profitFactor: { type: "number" },
          },
          required: ["returnPct", "maxDrawdownPct", "winRate", "totalTrades", "profitFactor"],
        },
        rationale: {
          type: "string",
          description: "Detailed explanation of why these params are better and what changed",
        },
        backtestId: {
          type: "string",
          description: "ID of the backtest run that demonstrated the improvement (optional)",
        },
      },
      required: ["proposedParams", "currentStats", "proposedStats", "rationale"],
    },
  },
};

const APPLY_LOCKED_PARAMS_TOOL_DEFINITION = {
  type: "function" as const,
  function: {
    name: "apply_locked_params",
    description: "DIRECTLY APPLY changes to the locked trading parameters. Unlike propose_locked_params, this takes effect IMMEDIATELY — no user approval needed. Use this when you have strong evidence (backtest results) and the user has given you authority to manage parameters autonomously. Always log what you changed and why. The live trader will automatically reload with the new params.",
    parameters: {
      type: "object",
      properties: {
        params: {
          type: "object",
          description: "Key-value pairs of params to change (only include the ones you want to change, not the full set)",
        },
        rationale: {
          type: "string",
          description: "Explanation of why you're making this change — what evidence supports it",
        },
      },
      required: ["params", "rationale"],
    },
  },
};

const EXECUTE_TRADE_TOOL_DEFINITION = {
  type: "function" as const,
  function: {
    name: "execute_trade",
    description: "Place a REAL market order on the connected cTrader account via the cTrader API. You have FULL AUTHORITY to execute trades autonomously — no user confirmation needed. The trade uses proper risk management (ATR-based SL, R:R ratio, position sizing). Use this whenever market conditions warrant a trade, when the user asks you to trade, or when your analysis identifies a high-probability setup.",
    parameters: {
      type: "object",
      properties: {
        side: { type: "string", enum: ["buy", "sell"], description: "Trade direction" },
        riskPercent: { type: "number", description: "Risk per trade as % of account balance (default: use locked param riskPerTradePct). Range: 0.1-5" },
        stopLossPrice: { type: "number", description: "Optional explicit stop loss price. If not provided, uses ATR-based calculation (ATR × atrStopMultiplier)" },
        takeProfitPrice: { type: "number", description: "Optional explicit take profit price. If not provided, uses SL distance × rewardRatio" },
      },
      required: ["side"],
    },
  },
};

export type DailyAnalysisResponse = {
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

export const NO_ASCII_ART_RULES = `CRITICAL FORMATTING RULES — VIOLATING THESE WILL BREAK THE UI:
- All text fields must be plain English prose ONLY.
- NEVER include ASCII art, ASCII charts, ASCII diagrams, box-drawing characters, or any decorative character patterns.
- NEVER use long runs of repeated symbols like ####, @@@@, ****, ====, ----, ::::, %%%%, ++++ etc.
- NEVER attempt to "draw" candles, charts, levels, or trends with characters.
- Use real numbers in numeric fields. Describe patterns in words, not pictures.
- Keep prose fields concise.`;

export function cleanProseString(s: string): string {
  let out = s;
  out = out.replace(/[#@%*+=\-:.~`^|\\\/]{6,}/g, " ");
  out = out.replace(/(?:[\u2500-\u257F\u2580-\u259F])+/g, " ");
  out = out.replace(/(.)\1{5,}/g, "$1");
  out = out.split(/\r?\n/).filter(line => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return true;
    const symbolCount = (trimmed.match(/[#@%*+=\-:.~`^|\\\/]/g) ?? []).length;
    return symbolCount / trimmed.length < 0.5;
  }).join("\n");
  return out.replace(/\s{3,}/g, " ").trim();
}

export function sanitizeAnalysisStrings(obj: any): void {
  if (!obj || typeof obj !== "object") return;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === "string") {
      obj[key] = cleanProseString(v);
    } else if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        if (typeof v[i] === "string") v[i] = cleanProseString(v[i]);
        else if (typeof v[i] === "object") sanitizeAnalysisStrings(v[i]);
      }
    } else if (typeof v === "object" && v !== null) {
      sanitizeAnalysisStrings(v);
    }
  }
}

export async function getDailyAnalysis(): Promise<DailyAnalysisResponse> {
  const cached = getCachedData();
  const snapshot = await getMarketSnapshot();
  const { getLatestAnalystIdeas } = await import("./goldviewfx-fetcher");
  const analystContent = await getLatestAnalystIdeas(5);
  const lockedParams = await (await import("./locked-params")).getLockedParams();
  const learnings = await storage.getLearnings(undefined, 0);

  const prompt = `You are a senior XAUUSD (Gold) trading analyst. Produce a comprehensive daily market analysis in JSON format.

CURRENT MARKET DATA:
${snapshot}

GOLDVIEWFX (Mr Gold) ANALYST INSIGHTS:
${analystContent || "No analyst data available today."}

CURRENT BOT LOCKED PARAMETERS:
${JSON.stringify(lockedParams, null, 2)}

AI LEARNINGS FROM RECENT TRADING:
${learnings.length > 0 ? learnings.map(l => `- [${l.category}] ${l.insight} (confidence: ${l.confidence})`).join('\n') : 'No learnings yet.'}

GVZ REGIME FILTER CONTEXT:
The bot uses GVZ (CBOE Gold Volatility Index) percentile rank to confirm regime classification:
- GVZ percentile <25 = low implied vol → confirms RANGE regime (mean-reversion conditions)
- GVZ percentile >75 = high implied vol → confirms TREND regime (breakout/momentum conditions)
- When GVZ and technical indicators disagree, the bot enters NO_TRADE to avoid false signals
When assessing regime and volatility, incorporate the GVZ data from the market snapshot. If GVZ is elevated (P>60), bias toward TREND/ELEVATED readings. If low (P<40), bias toward RANGE/LOW.

SGE PREMIUM FILTER CONTEXT:
The bot uses the Shanghai Gold Exchange (SGE) premium — the price difference between Shanghai gold and international spot price in $/oz — as a daily directional bias filter:
- SGE premium >$10/oz = strong Chinese physical demand = BULLISH bias → blocks trend short breakouts (don't sell against Chinese buying)
- SGE premium < -$5/oz = SGE discount = BEARISH/cautionary → blocks trend long breakouts
- Normal range ($-5 to $10) = NEUTRAL — no directional filter applied
When assessing market bias, incorporate the SGE premium from the market snapshot. Persistent high premiums ($15-30+) signal exceptional demand. Discounts are rare and signal weak demand or capital outflows.

${NO_ASCII_ART_RULES}
- Keep "summary" to 3-4 sentences.

Return ONLY valid JSON matching this exact structure:
{
  "marketOverview": {
    "currentPrice": <number>,
    "dailyChange": "<+/-X.XX%>",
    "regime": "<RANGE|TREND|NO_TRADE>",
    "regimeReason": "<1-2 sentence explanation>",
    "volatility": "<LOW|NORMAL|ELEVATED|HIGH>",
    "trend": "<BULLISH|BEARISH|NEUTRAL>",
    "keyLevels": { "resistance": <number>, "support": <number>, "midpoint": <number> }
  },
  "analystInsights": {
    "source": "GoldViewFX (Mr Gold)",
    "summary": "<2-3 sentence summary of latest analysis>",
    "bias": "<BULLISH|BEARISH|NEUTRAL>",
    "keyPoints": ["<point1>", "<point2>", "<point3>"]
  },
  "asianMarkets": {
    "sentiment": "<RISK-ON|RISK-OFF|NEUTRAL>",
    "details": [{"name": "<index>", "changePct": <number>}],
    "goldImpact": "<1-2 sentence impact on gold>"
  },
  "newsEvents": {
    "highImpact": [{"event": "<name>", "time": "<HH:MM UTC>", "hoursAway": "<X.Xh>"}],
    "tradingImplication": "<how these events affect today's trading>"
  },
  "automatedPlan": {
    "status": "<ACTIVE|STANDBY|CAUTION>",
    "regime": "<detected regime>",
    "direction": "<BUY|SELL|WAIT>",
    "entryZone": "<price level or range>",
    "stopLoss": "<price level>",
    "takeProfit": "<price level>",
    "riskPerTrade": "<X%>",
    "reasoning": "<why the bot should take this trade>",
    "warnings": ["<warning1>", "<warning2>"]
  },
  "manualPlan": {
    "bias": "<BULLISH|BEARISH|NEUTRAL>",
    "entryIdea": "<specific manual trade idea with entry, SL, TP>",
    "keyLevelsToWatch": ["<level1: description>", "<level2: description>"],
    "bestTimeToTrade": "<recommended session and hours UTC>",
    "riskManagement": "<position sizing and risk advice>",
    "alternativeScenario": "<what to do if the primary plan fails>"
  },
  "confidence": <1-10>,
  "summary": "<3-4 sentence executive summary combining all insights>"
}`;

  const response = await openai.chat.completions.create({
    model: AI_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    max_tokens: 3000,
    response_format: { type: "json_object" },
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw);
  sanitizeAnalysisStrings(parsed);

  const h1 = cached.h1;
  const livePrice = await fetchLivePrice();
  const price = livePrice?.price ?? (h1.length > 0 ? h1[h1.length - 1].close : 0);

  return {
    timestamp: new Date().toISOString(),
    marketOverview: parsed.marketOverview ?? {
      currentPrice: price,
      dailyChange: "0%",
      regime: "UNKNOWN",
      regimeReason: "Unable to determine",
      volatility: "UNKNOWN",
      trend: "NEUTRAL",
      keyLevels: { resistance: 0, support: 0, midpoint: 0 },
    },
    analystInsights: parsed.analystInsights ?? {
      source: "GoldViewFX (Mr Gold)",
      summary: "No analyst data available.",
      bias: "NEUTRAL",
      keyPoints: [],
    },
    asianMarkets: parsed.asianMarkets ?? {
      sentiment: "NEUTRAL",
      details: cached.asian.map(a => ({ name: a.name, changePct: a.changePct })),
      goldImpact: "No data available.",
    },
    newsEvents: parsed.newsEvents ?? {
      highImpact: [],
      tradingImplication: "No significant events today.",
    },
    automatedPlan: parsed.automatedPlan ?? {
      status: "STANDBY",
      regime: "UNKNOWN",
      direction: "WAIT",
      entryZone: "-",
      stopLoss: "-",
      takeProfit: "-",
      riskPerTrade: `${lockedParams.riskPerTradePct ?? 1.5}%`,
      reasoning: "Insufficient data for automated plan.",
      warnings: [],
    },
    manualPlan: parsed.manualPlan ?? {
      bias: "NEUTRAL",
      entryIdea: "Wait for clearer setup.",
      keyLevelsToWatch: [],
      bestTimeToTrade: "London session (08:00-12:00 UTC)",
      riskManagement: "Risk 1-2% per trade maximum.",
      alternativeScenario: "Stand aside if conditions are unclear.",
    },
    confidence: parsed.confidence ?? 5,
    summary: parsed.summary ?? "Analysis could not be completed.",
  };
}

export async function getMarketSnapshot(): Promise<string> {
  const cached = getCachedData();
  if (cached.h1.length === 0) {
    return "No market data loaded. Fetch market data first to get a live snapshot.";
  }

  const parts: string[] = [];
  const h1 = cached.h1;
  const h4 = cached.h4;
  const daily = cached.daily;
  parts.push(`Data available: M1=${cached.m1.length} | M15=${cached.m15.length} | H1=${h1.length} | H4=${h4.length} | Daily=${daily.length}`);

  const livePrice = await fetchLivePrice();
  if (livePrice) {
    parts.push(`\n🔴 LIVE SPOT PRICE: $${livePrice.price.toFixed(2)} (fetched ${livePrice.timestamp})`);
    parts.push(`Use this as the CURRENT price — candle close prices below may be delayed.`);
  }

  const freshness = getDataFreshness();
  if (freshness.warning) {
    parts.push(`\n⚠️ ${freshness.warning}`);
    parts.push(`Candle data age: ${freshness.ageMinutes} minutes since last full fetch. Technical indicators (ATR, EMA, BB) are based on cached candles.\n`);
  } else {
    parts.push(`Candle data: ${freshness.ageMinutes} min since last fetch (OK)`);
  }

  const latestH1 = h1[h1.length - 1];
  const prevH1 = h1.length > 1 ? h1[h1.length - 2] : null;
  const nowSnap = new Date();
  const snapDay = nowSnap.getUTCDay();
  const snapHour = nowSnap.getUTCHours();
  const marketClosed = snapDay === 6 || (snapDay === 0 && snapHour < 22) || (snapDay === 5 && snapHour >= 22);
  parts.push(`\n=== MARKET STATUS ===`);
  parts.push(`Time: ${nowSnap.toUTCString()}`);
  parts.push(`Market: ${marketClosed ? '⛔ CLOSED — DO NOT attempt trades' : '✅ OPEN'}`);
  if (marketClosed) {
    parts.push(`XAUUSD hours: Sunday 22:00 UTC – Friday 22:00 UTC. No trading possible right now.`);
  }
  parts.push(`=== GOLD MARKET SNAPSHOT ===`);
  parts.push(`Latest H1 candle: ${latestH1.timestamp}`);
  parts.push(`Candle close: ${latestH1.close.toFixed(2)} (O:${latestH1.open.toFixed(2)} H:${latestH1.high.toFixed(2)} L:${latestH1.low.toFixed(2)} C:${latestH1.close.toFixed(2)})`);
  if (prevH1) {
    const change = latestH1.close - prevH1.close;
    const changePct = (change / prevH1.close) * 100;
    parts.push(`Change: ${change >= 0 ? '+' : ''}${change.toFixed(2)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(3)}%)`);
  }

  const h1Atrs = calcATR(h1, 14);
  const currentATR_H1 = h1Atrs[h1Atrs.length - 1];
  if (!isNaN(currentATR_H1)) {
    const avgATR_H1_20 = h1Atrs.slice(-20).filter(a => !isNaN(a));
    const avgH1 = avgATR_H1_20.length > 0 ? avgATR_H1_20.reduce((a, b) => a + b, 0) / avgATR_H1_20.length : currentATR_H1;
    parts.push(`\nH1 ATR(14): ${currentATR_H1.toFixed(2)} | 20-period avg: ${avgH1.toFixed(2)} | Ratio: ${(currentATR_H1 / avgH1).toFixed(2)}x`);
    parts.push(`Volatility: ${currentATR_H1 > avgH1 * 1.2 ? 'ELEVATED' : currentATR_H1 < avgH1 * 0.8 ? 'LOW' : 'NORMAL'}`);
  }

  const h1Closes = h1.map(c => c.close);
  const sma50_h1 = calcSMA(h1Closes, 50);
  const sma200_h1 = calcSMA(h1Closes, 200);
  const lastSMA50 = sma50_h1[sma50_h1.length - 1];
  const lastSMA200 = sma200_h1[sma200_h1.length - 1];
  const price = livePrice?.price ?? latestH1.close;

  parts.push(`\n=== H1 MOVING AVERAGES ===`);
  if (!isNaN(lastSMA50)) parts.push(`SMA 50: $${lastSMA50.toFixed(2)} — price ${price > lastSMA50 ? 'ABOVE ✅' : 'BELOW ❌'} (gap: $${Math.abs(price - lastSMA50).toFixed(2)})`);
  if (!isNaN(lastSMA200)) parts.push(`SMA 200: $${lastSMA200.toFixed(2)} — price ${price > lastSMA200 ? 'ABOVE ✅' : 'BELOW ❌'} (gap: $${Math.abs(price - lastSMA200).toFixed(2)})`);
  if (!isNaN(lastSMA50) && !isNaN(lastSMA200)) {
    const crossType = lastSMA50 > lastSMA200 ? 'GOLDEN CROSS (SMA50 > SMA200) — BULLISH' : 'DEATH CROSS (SMA50 < SMA200) — BEARISH';
    parts.push(`Cross: ${crossType}`);
    parts.push(`SMA spread: $${Math.abs(lastSMA50 - lastSMA200).toFixed(2)} (${((lastSMA50 - lastSMA200) / lastSMA200 * 100).toFixed(2)}%)`);
  }

  const macd = calcMACD(h1Closes, 12, 26, 9);
  const lastMACD = macd.macdLine[macd.macdLine.length - 1];
  const lastSignal = macd.signalLine[macd.signalLine.length - 1];
  const lastHist = macd.histogram[macd.histogram.length - 1];
  parts.push(`\n=== MACD (12, 26, 9) ===`);
  if (!isNaN(lastMACD)) parts.push(`MACD Line: ${lastMACD.toFixed(2)}`);
  if (!isNaN(lastSignal)) parts.push(`Signal Line: ${lastSignal.toFixed(2)}`);
  if (!isNaN(lastHist)) {
    parts.push(`Histogram: ${lastHist.toFixed(2)} — ${lastHist > 0 ? 'BULLISH momentum' : 'BEARISH momentum'}`);
    const prevHist = macd.histogram[macd.histogram.length - 2];
    if (!isNaN(prevHist)) {
      const histChange = lastHist > 0
        ? (lastHist > prevHist ? 'INCREASING (strengthening bulls)' : 'DECREASING (weakening bulls)')
        : (lastHist < prevHist ? 'INCREASING (strengthening bears)' : 'DECREASING (weakening bears)');
      parts.push(`Histogram trend: ${histChange}`);
    }
  }
  if (!isNaN(lastMACD) && !isNaN(lastSignal)) {
    parts.push(`MACD vs Signal: ${lastMACD > lastSignal ? 'BULLISH crossover' : 'BEARISH crossover'}`);
  }

  const dmi = calcADX(h1, 14);
  const lastADX = dmi.adx[dmi.adx.length - 1];
  const lastPlusDI = dmi.plusDI[dmi.plusDI.length - 1];
  const lastMinusDI = dmi.minusDI[dmi.minusDI.length - 1];
  parts.push(`\n=== DMI / ADX (14) ===`);
  if (!isNaN(lastADX)) {
    const trendStrength = lastADX > 50 ? 'VERY STRONG' : lastADX > 25 ? 'STRONG' : lastADX > 20 ? 'MODERATE' : 'WEAK';
    parts.push(`ADX: ${lastADX.toFixed(1)} — ${trendStrength} trend`);
  }
  if (!isNaN(lastPlusDI)) parts.push(`+DI: ${lastPlusDI.toFixed(1)}`);
  if (!isNaN(lastMinusDI)) parts.push(`-DI: ${lastMinusDI.toFixed(1)}`);
  if (!isNaN(lastPlusDI) && !isNaN(lastMinusDI)) {
    parts.push(`Direction: ${lastPlusDI > lastMinusDI ? 'BULLISH (+DI > -DI)' : 'BEARISH (-DI > +DI)'}`);
  }

  const gvzData = getLatestGVZ();
  if (gvzData) {
    const gvzVal = Number(gvzData.value);
    const gvzPct = gvzData.percentile;
    const gvzInterpretation = gvzPct > 75 ? 'HIGH VOLATILITY — confirms trend environment, expect large moves'
      : gvzPct < 25 ? 'LOW VOLATILITY — confirms range environment, expect mean-reversion'
      : gvzPct > 50 ? 'ABOVE AVERAGE — leaning toward trend conditions'
      : 'BELOW AVERAGE — leaning toward range conditions';
    parts.push(`\n=== GVZ (GOLD VOLATILITY INDEX) ===`);
    parts.push(`GVZ Value: ${gvzVal.toFixed(1)} (date: ${gvzData.date})`);
    parts.push(`GVZ Percentile (252-day): P${gvzPct}`);
    parts.push(`Interpretation: ${gvzInterpretation}`);
    parts.push(`Regime signal: ${gvzPct > 75 ? 'TREND CONFIRMED' : gvzPct < 25 ? 'RANGE CONFIRMED' : 'NEUTRAL — no strong regime signal from GVZ'}`);
  }

  const cotData = getLatestCOT();
  if (cotData) {
    parts.push(`\n=== COT (COMMITMENT OF TRADERS — GOLD FUTURES) ===`);
    parts.push(`Report Date: ${cotData.date}`);
    parts.push(`Non-Commercial Net Position: ${cotData.netPosition.toLocaleString()} (Long: ${cotData.noncommLong.toLocaleString()}, Short: ${cotData.noncommShort.toLocaleString()})`);
    parts.push(`Open Interest: ${cotData.openInterest.toLocaleString()}`);
    parts.push(`Net Position Percentile (3yr): P${cotData.percentile}`);
    parts.push(`Sentiment: ${cotData.sentiment}`);
    parts.push(`Regime signal: ${cotData.percentile > 75 ? 'BULLISH POSITIONING — confirms upside trend' : cotData.percentile < 25 ? 'BEARISH POSITIONING — confirms downside trend or counter-trend caution' : 'NEUTRAL POSITIONING — no strong directional bias from speculators'}`);
  }

  const sgeData = getLatestSGE();
  if (sgeData) {
    parts.push(`\n=== SGE (SHANGHAI GOLD EXCHANGE) PREMIUM ===`);
    parts.push(`Date: ${sgeData.date}`);
    parts.push(`Premium: $${sgeData.premium.toFixed(2)}/oz`);
    parts.push(`Signal: ${sgeData.premium > 10 ? 'BULLISH — strong Chinese demand (premium >$10), supports longs' : sgeData.premium < -5 ? 'BEARISH — SGE discount, caution on longs' : 'NEUTRAL — normal premium range'}`);
    parts.push(`Note: Premium >$10-15 = bullish bias (Chinese buying pressure). Sustained discount = cautionary for longs.`);
  }

  const hmmMeta = getHMMState();
  const hmmClassification = getLastHMMClassification();
  parts.push(`\n=== HMM (HIDDEN MARKOV MODEL) ===`);
  if (hmmMeta && hmmMeta.trained) {
    parts.push(`Trained: YES (${hmmMeta.nSamples} samples, ${hmmMeta.trainedAt})`);
    for (const em of hmmMeta.emissions) {
      parts.push(`  ${em}`);
    }
    if (hmmClassification) {
      const stateLabel = hmmClassification.state === 'low_vol' ? 'LOW VOL (range-confirming)' : hmmClassification.state === 'high_vol' ? 'HIGH VOL (trend-confirming)' : 'MEDIUM VOL (transitional)';
      parts.push(`Current HMM State: ${stateLabel}`);
      parts.push(`Confidence: ${(hmmClassification.confidence * 100).toFixed(1)}%`);
      parts.push(`State Probabilities: low_vol=${(hmmClassification.probabilities.low_vol * 100).toFixed(1)}%, medium_vol=${(hmmClassification.probabilities.medium_vol * 100).toFixed(1)}%, high_vol=${(hmmClassification.probabilities.high_vol * 100).toFixed(1)}%`);
      const signal = hmmClassification.state === 'low_vol' ? 'Confirms RANGE — blocks trend breakout entries' : hmmClassification.state === 'high_vol' ? 'Confirms TREND — blocks range mean-reversion entries' : 'NEUTRAL — neither confirms nor blocks';
      parts.push(`Signal: ${signal}`);
    } else {
      parts.push(`Current HMM State: No recent classification available`);
    }
  } else {
    parts.push(`Trained: NO — HMM will train on first backtest run. Currently inactive.`);
  }

  parts.push(`\n=== MRS-GARCH (Markov Regime-Switching GARCH) ===`);
  if (isMRSGARCHTrained()) {
    const garchState = getLastMRSGARCHState();
    const garchModel = getMRSGARCHModel();
    parts.push(`Trained: YES (${garchModel ? Object.keys(garchModel.garchParams).length : 0} regime-specific GARCH models)`);
    if (garchState) {
      parts.push(`Current GARCH Volatility: ${garchState.garchVolatility.toFixed(6)}`);
      parts.push(`Annualized Vol: ${garchState.annualizedVol.toFixed(1)}%`);
      parts.push(`Vol Forecast (1-step): ${garchState.volForecast.toFixed(6)}`);
      parts.push(`Vol Percentile: ${garchState.volPercentile.toFixed(0)}th`);
      parts.push(`Regime Stability: ${(garchState.regimeStability * 100).toFixed(1)}%`);
      parts.push(`Position Size Multiplier: ${garchState.positionSizeMultiplier.toFixed(3)}x`);
      const volSignal = garchState.volPercentile > 80 ? 'HIGH VOL — reduce position size (0.6x)' : garchState.volPercentile > 60 ? 'ELEVATED VOL — moderate reduction (0.8x)' : garchState.volPercentile < 20 ? 'LOW VOL — slightly increase size (1.15x)' : 'NORMAL VOL — standard sizing';
      parts.push(`Signal: ${volSignal}`);
    }
  } else {
    parts.push(`Trained: NO — MRS-GARCH requires 100+ bars and trained HMM. Currently inactive.`);
  }

  const { getLockedParams: getSnapshotParams } = await import("./locked-params");
  const snapParams = await getSnapshotParams();
  const currentHour = new Date().getUTCHours();
  const avoidActive = snapParams.avoidHoursEnabled !== false && (snapParams.avoidHoursUTC || [21,22,23,0]).includes(currentHour);
  const peakActive = snapParams.peakHoursEnabled && (snapParams.peakHoursUTC || []).length > 0;
  const inPeakWindow = peakActive ? (snapParams.peakHoursUTC || []).includes(currentHour) : true;
  parts.push(`\n=== SESSION TIMING ===`);
  parts.push(`Current UTC hour: ${currentHour}`);
  parts.push(`Avoid Hours: ${snapParams.avoidHoursEnabled !== false ? 'ENABLED' : 'DISABLED'} | Blocked hours: [${(snapParams.avoidHoursUTC || [21,22,23,0]).join(',')}] | Currently ${avoidActive ? '⛔ BLOCKED' : '✅ OK'}`);
  parts.push(`Peak Hours: ${peakActive ? 'ENABLED' : 'DISABLED'}${peakActive ? ` | Allowed hours: [${(snapParams.peakHoursUTC || []).join(',')}] | Currently ${inPeakWindow ? '✅ IN WINDOW' : '⛔ OUTSIDE'}` : ''}`);

  const hasVolume = h1.some(c => (c.volume ?? 0) > 0);
  if (hasVolume) {
    const lastVol = h1[h1.length - 1].volume ?? 0;
    const volSma20 = calcVolumeSMA(h1, 20);
    const lastVolSma = volSma20[volSma20.length - 1];
    const obv = calcOBV(h1);
    const lastOBV = obv[obv.length - 1];
    const prevOBV = obv.length > 1 ? obv[obv.length - 2] : lastOBV;
    const vwap = calcVWAP(h1.slice(-50));
    const lastVWAP = vwap[vwap.length - 1];

    parts.push(`\n=== VOLUME ANALYSIS (H1) ===`);
    parts.push(`Current volume: ${lastVol.toLocaleString()}`);
    if (!isNaN(lastVolSma)) {
      const volRatio = lastVol / lastVolSma;
      parts.push(`Volume SMA(20): ${lastVolSma.toLocaleString()} | Ratio: ${volRatio.toFixed(2)}x`);
      parts.push(`Volume status: ${volRatio > 1.5 ? 'HIGH VOLUME (confirmation)' : volRatio > 1.0 ? 'ABOVE AVERAGE' : volRatio > 0.5 ? 'BELOW AVERAGE' : 'LOW VOLUME (caution)'}`);
    }
    parts.push(`OBV: ${lastOBV.toLocaleString()} — ${lastOBV > prevOBV ? 'RISING (accumulation)' : lastOBV < prevOBV ? 'FALLING (distribution)' : 'FLAT'}`);
    if (!isNaN(lastVWAP)) {
      parts.push(`VWAP (50-bar): $${lastVWAP.toFixed(2)} — price ${price > lastVWAP ? 'ABOVE (bullish)' : 'BELOW (bearish)'}`);
    }
  }

  if (h4.length > 0) {
    const h4Atrs = calcATR(h4, 14);
    const currentATR_H4 = h4Atrs[h4Atrs.length - 1];
    const latestH4 = h4[h4.length - 1];
    parts.push(`\nH4 candle: ${latestH4.timestamp} (O:${latestH4.open.toFixed(2)} H:${latestH4.high.toFixed(2)} L:${latestH4.low.toFixed(2)} C:${latestH4.close.toFixed(2)})`);

    if (!isNaN(currentATR_H4)) {
      const lookback = Math.min(8, h4.length);
      let avgAtrH4 = 0;
      let atrCount = 0;
      for (let i = h4.length - lookback; i < h4.length; i++) {
        if (!isNaN(h4Atrs[i])) { avgAtrH4 += h4Atrs[i]; atrCount++; }
      }
      avgAtrH4 = atrCount > 0 ? avgAtrH4 / atrCount : currentATR_H4;
      parts.push(`H4 ATR(14): ${currentATR_H4.toFixed(2)} | 8-bar avg: ${avgAtrH4.toFixed(2)} | Ratio: ${(currentATR_H4 / avgAtrH4).toFixed(2)}x`);

      const rangeWidthBars = 8;
      const lookbackH4 = Math.min(rangeWidthBars, h4.length);
      let rangeHigh = -Infinity, rangeLow = Infinity;
      for (let i = h4.length - lookbackH4; i < h4.length; i++) {
        rangeHigh = Math.max(rangeHigh, h4[i].high);
        rangeLow = Math.min(rangeLow, h4[i].low);
      }
      parts.push(`\nH4 Range (${lookbackH4}-bar): ${rangeLow.toFixed(2)} — ${rangeHigh.toFixed(2)} (width: ${(rangeHigh - rangeLow).toFixed(2)})`);
      const mid = (rangeHigh + rangeLow) / 2;
      parts.push(`Midpoint: ${mid.toFixed(2)}`);

      if (price > rangeHigh) {
        parts.push(`⚠️ LIVE PRICE ($${price.toFixed(2)}) HAS BROKEN ABOVE the H4 range high ($${rangeHigh.toFixed(2)}) by $${(price - rangeHigh).toFixed(2)} — this is a BREAKOUT. Do NOT report old resistance as current resistance. Actual resistance is ABOVE current price.`);
        rangeHigh = price;
      } else if (price < rangeLow) {
        parts.push(`⚠️ LIVE PRICE ($${price.toFixed(2)}) HAS BROKEN BELOW the H4 range low ($${rangeLow.toFixed(2)}) by $${(rangeLow - price).toFixed(2)} — this is a BREAKDOWN. Do NOT report old support as current support. Actual support is BELOW current price.`);
        rangeLow = price;
      }
      const pctFromHigh = ((rangeHigh - price) / (rangeHigh - rangeLow)) * 100;
      const pctFromLow = ((price - rangeLow) / (rangeHigh - rangeLow)) * 100;
      parts.push(`Price position: ${pctFromLow.toFixed(0)}% from low, ${pctFromHigh.toFixed(0)}% from high`);

      const h4Closes = h4.map(c => c.close);
      const h4BBWidths = calcBBWidth(h4Closes, 20);
      const bbWidth = h4BBWidths[h4BBWidths.length - 1];

      const atrExpanding = currentATR_H4 > avgAtrH4 * 1.05;
      const priceAbove = price > rangeHigh;
      const priceBelow = price < rangeLow;
      const compressed = !isNaN(bbWidth) && bbWidth < 0.022;
      const inMidZone = price >= mid - (rangeHigh - rangeLow) * 0.1 && price <= mid + (rangeHigh - rangeLow) * 0.1;

      let regime = "NO_TRADE";
      let regimeReason = "";
      if (atrExpanding && (priceAbove || priceBelow)) {
        regime = "TREND";
        regimeReason = `ATR expanding (${(currentATR_H4 / avgAtrH4).toFixed(2)}x avg) + price ${priceAbove ? 'above' : 'below'} range`;
      } else if (inMidZone) {
        regime = "NO_TRADE (midpoint)";
        regimeReason = `Price in midpoint dead zone (${mid.toFixed(2)} ± ${((rangeHigh - rangeLow) * 0.1).toFixed(2)})`;
      } else if (!atrExpanding && price >= rangeLow && price <= rangeHigh) {
        regime = "RANGE";
        regimeReason = `ATR flat, price inside range${compressed ? ', BB compressed' : ''}`;
      } else {
        regimeReason = "No clear regime conditions met";
      }

      parts.push(`\n=== CURRENT REGIME: ${regime} ===`);
      parts.push(`Reason: ${regimeReason}`);
      if (!isNaN(bbWidth)) {
        parts.push(`BB Width: ${bbWidth.toFixed(4)} (threshold: 0.022 → ${compressed ? 'COMPRESSED' : 'not compressed'})`);
      }

      parts.push(`\n=== KEY LEVELS ===`);
      parts.push(`Resistance (H4 range high): ${rangeHigh.toFixed(2)}`);
      parts.push(`Support (H4 range low): ${rangeLow.toFixed(2)}`);
      parts.push(`Midpoint: ${mid.toFixed(2)}`);

      if (snapParams.volumeProfileEnabled !== false && h4.length >= 5) {
        const vpPeriod = snapParams.volumeProfilePeriod ?? 50;
        const vpBins = snapParams.volumeProfileBins ?? 24;
        const vpValueAreaPct = snapParams.volumeProfileValueAreaPct ?? 70;
        const vpPocProx = snapParams.vpPocProximityPct ?? 0.15;
        const vpEndIdx = Math.max(0, h4.length - 1);
        const vpStartIdx = Math.max(0, vpEndIdx - vpPeriod + 1);
        const vpCandles = h4.slice(vpStartIdx, vpEndIdx + 1);
        const vp = calcVolumeProfile(vpCandles, vpBins, vpValueAreaPct);
        if (vp.poc > 0) {
          const pocDist = Math.abs(price - vp.poc);
          const vpRange = vp.vah - vp.val;
          const pocProxRatio = vpRange > 0 ? pocDist / vpRange : 1;
          const nearPoc = pocProxRatio < vpPocProx;
          const insideValueArea = price >= vp.val && price <= vp.vah;
          parts.push(`\n=== VOLUME PROFILE (${vpPeriod}-bar H4) ===`);
          parts.push(`POC (Point of Control): $${vp.poc.toFixed(2)} — highest volume price level (magnet)`);
          parts.push(`VAH (Value Area High): $${vp.vah.toFixed(2)} — upper ${vpValueAreaPct}% volume boundary (resistance)`);
          parts.push(`VAL (Value Area Low): $${vp.val.toFixed(2)} — lower ${vpValueAreaPct}% volume boundary (support)`);
          parts.push(`Value Area Range: $${vpRange.toFixed(2)}`);
          parts.push(`Price distance from POC: $${pocDist.toFixed(2)} (${(pocProxRatio * 100).toFixed(1)}% of VA range)`);
          parts.push(`Price location: ${insideValueArea ? 'INSIDE value area' : price > vp.vah ? 'ABOVE value area (breakout zone)' : 'BELOW value area (breakdown zone)'}`);
          if (nearPoc) {
            parts.push(`⚠️ NEAR POC — congestion zone, avoid entries (price tends to chop near POC)`);
          } else if (!insideValueArea) {
            parts.push(`✅ Outside value area — potential trend continuation zone with less volume resistance`);
          } else {
            parts.push(`Price within value area — normal trading zone`);
          }
        }
      }

      if (regime === "RANGE") {
        const nearSupport = price < mid;
        const stopDistance = currentATR_H1 * 1.5;
        const entryDirection = nearSupport ? "BUY" : "SELL";
        const entryPrice = nearSupport ? rangeLow : rangeHigh;
        const stopLoss = nearSupport ? entryPrice - stopDistance : entryPrice + stopDistance;
        const tp2R = nearSupport ? entryPrice + stopDistance * 2 : entryPrice - stopDistance * 2;
        const tp3R = nearSupport ? entryPrice + stopDistance * 3 : entryPrice - stopDistance * 3;

        parts.push(`\n=== POTENTIAL ENTRY (Range regime) ===`);
        parts.push(`Direction: ${entryDirection} (price near ${nearSupport ? 'support' : 'resistance'})`);
        parts.push(`Entry zone: ~${entryPrice.toFixed(2)} (wait for rejection candle)`);
        parts.push(`Current price: ${price.toFixed(2)} — ${Math.abs(price - entryPrice).toFixed(2)} from entry zone`);
        parts.push(`Stop loss: ${stopLoss.toFixed(2)} (ATR×1.5 = ${stopDistance.toFixed(2)})`);
        parts.push(`TP @ 2R: ${tp2R.toFixed(2)} | TP @ 3R: ${tp3R.toFixed(2)}`);
        parts.push(`Risk/Reward check: SL=${stopDistance.toFixed(2)} → 2R target=${(stopDistance*2).toFixed(2)}, 3R target=${(stopDistance*3).toFixed(2)}`);
      } else if (regime === "TREND") {
        const trendDirection = priceAbove ? "BUY (breakout above range)" : "SELL (breakdown below range)";
        const stopDistance = currentATR_H1 * 2;
        const entryPrice = priceAbove ? rangeHigh : rangeLow;
        const stopLoss = priceAbove ? entryPrice - stopDistance : entryPrice + stopDistance;
        const tp3R = priceAbove ? entryPrice + stopDistance * 3 : entryPrice - stopDistance * 3;

        parts.push(`\n=== POTENTIAL ENTRY (Trend regime) ===`);
        parts.push(`Direction: ${trendDirection}`);
        parts.push(`Entry (retest level): ${entryPrice.toFixed(2)} — wait for acceptance retest`);
        parts.push(`Current price: ${price.toFixed(2)} — ${Math.abs(price - entryPrice).toFixed(2)} from entry`);
        parts.push(`Stop loss: ${stopLoss.toFixed(2)} (ATR×2 = ${stopDistance.toFixed(2)})`);
        parts.push(`TP @ 3R: ${tp3R.toFixed(2)}`);
      } else {
        parts.push(`\n=== NO ENTRY SUGGESTED ===`);
        parts.push(`Current regime is NO_TRADE — wait for price to move to range extremes or for a trend breakout.`);
      }
    }
  }

  if (daily.length > 0) {
    const dailyCloses = daily.map(c => c.close);
    const ema50 = calcEMA(dailyCloses, 50);
    const ema200 = calcEMA(dailyCloses, 200);
    const lastEma50 = ema50[ema50.length - 1];
    const lastEma200 = ema200[ema200.length - 1];
    const lastDaily = daily[daily.length - 1];

    parts.push(`\n=== DAILY TREND CONTEXT ===`);
    parts.push(`Latest daily close: ${lastDaily.close.toFixed(2)} (${lastDaily.timestamp})`);
    if (!isNaN(lastEma50)) parts.push(`EMA50: ${lastEma50.toFixed(2)} — price ${lastDaily.close > lastEma50 ? 'ABOVE' : 'BELOW'}`);
    if (!isNaN(lastEma200)) parts.push(`EMA200: ${lastEma200.toFixed(2)} — price ${lastDaily.close > lastEma200 ? 'ABOVE' : 'BELOW'}`);
    if (!isNaN(lastEma50) && !isNaN(lastEma200)) {
      parts.push(`Trend: ${lastEma50 > lastEma200 ? 'BULLISH (EMA50 > EMA200)' : 'BEARISH (EMA50 < EMA200)'}`);
    }

    const last5 = daily.slice(-5);
    const last5Change = ((last5[last5.length - 1].close - last5[0].open) / last5[0].open) * 100;
    parts.push(`5-day change: ${last5Change >= 0 ? '+' : ''}${last5Change.toFixed(2)}%`);

    const last20 = daily.slice(-20);
    const last20Change = ((last20[last20.length - 1].close - last20[0].open) / last20[0].open) * 100;
    parts.push(`20-day change: ${last20Change >= 0 ? '+' : ''}${last20Change.toFixed(2)}%`);
  }

  if (cached.events.length > 0) {
    const now = new Date();
    const upcoming = cached.events
      .filter(e => new Date(e.timestamp) > now && new Date(e.timestamp) < new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .slice(0, 10);

    if (upcoming.length > 0) {
      parts.push(`\n=== UPCOMING EVENTS (next 7 days) ===`);
      for (const e of upcoming) {
        const dt = new Date(e.timestamp);
        const hoursAway = ((dt.getTime() - now.getTime()) / 3600000).toFixed(1);
        parts.push(`${e.timestamp.substring(0, 16)} | ${e.event} [${e.impact.toUpperCase()}] — ${hoursAway}h away`);
      }
      const nextHigh = upcoming.find(e => e.impact === 'high');
      if (nextHigh) {
        const hoursToHigh = ((new Date(nextHigh.timestamp).getTime() - now.getTime()) / 3600000).toFixed(1);
        parts.push(`⚠ Next HIGH-IMPACT event: ${nextHigh.event} in ${hoursToHigh}h — consider news blackout window`);
      }
    }
  }

  if (cached.asian.length > 0) {
    parts.push(`\n=== ASIAN MARKET SENTIMENT ===`);
    for (const a of cached.asian) {
      parts.push(`${a.name}: ${a.price.toFixed(2)} (${a.changePct >= 0 ? '+' : ''}${a.changePct.toFixed(2)}%)`);
    }
    const avgChange = cached.asian.reduce((s, a) => s + a.changePct, 0) / cached.asian.length;
    parts.push(`Overall Asian sentiment: ${avgChange >= 0.5 ? 'RISK-ON (bearish gold)' : avgChange <= -0.5 ? 'RISK-OFF (bullish gold)' : 'NEUTRAL'} (avg: ${avgChange >= 0 ? '+' : ''}${avgChange.toFixed(2)}%)`);
  }

  if (h1.length > 100) {
    parts.push(`\n=== HISTORICAL TIME-OF-DAY ANALYSIS ===`);
    parts.push(`Based on ${h1.length} H1 candles in database:`);
    const hourlyVolatility = new Map<number, { totalRange: number; totalBody: number; count: number; bullish: number; bearish: number }>();
    for (let h = 0; h < 24; h++) hourlyVolatility.set(h, { totalRange: 0, totalBody: 0, count: 0, bullish: 0, bearish: 0 });
    for (const c of h1) {
      const hour = new Date(c.timestamp).getUTCHours();
      const bucket = hourlyVolatility.get(hour)!;
      bucket.totalRange += c.high - c.low;
      bucket.totalBody += Math.abs(c.close - c.open);
      bucket.count++;
      if (c.close > c.open) bucket.bullish++;
      else if (c.close < c.open) bucket.bearish++;
    }

    const hourlyStats = Array.from(hourlyVolatility.entries())
      .filter(([_, d]) => d.count > 5)
      .map(([hour, d]) => ({
        hour,
        avgRange: d.totalRange / d.count,
        avgBody: d.totalBody / d.count,
        bullishPct: (d.bullish / d.count) * 100,
        count: d.count,
      }))
      .sort((a, b) => b.avgRange - a.avgRange);

    const topVolatile = hourlyStats.slice(0, 5);
    const lowVolatile = hourlyStats.slice(-3);
    const asianHours = hourlyStats.filter(h => h.hour >= 0 && h.hour < 7);
    const londonHours = hourlyStats.filter(h => h.hour >= 7 && h.hour < 16);
    const nyHours = hourlyStats.filter(h => h.hour >= 12 && h.hour < 21);

    parts.push(`\nMost volatile hours (UTC): ${topVolatile.map(h => `${h.hour}:00 (avg range: ${h.avgRange.toFixed(2)}, body: ${h.avgBody.toFixed(2)}, ${h.bullishPct.toFixed(0)}% bullish)`).join(' | ')}`);
    parts.push(`Quietest hours (UTC): ${lowVolatile.map(h => `${h.hour}:00 (avg range: ${h.avgRange.toFixed(2)})`).join(' | ')}`);

    if (asianHours.length > 0) {
      const asianAvgRange = asianHours.reduce((s, h) => s + h.avgRange, 0) / asianHours.length;
      const asianBullish = asianHours.reduce((s, h) => s + h.bullishPct, 0) / asianHours.length;
      parts.push(`\nAsian session (00-07 UTC): avg range ${asianAvgRange.toFixed(2)}, ${asianBullish.toFixed(0)}% bullish`);
      const bestAsian = asianHours.sort((a, b) => b.avgRange - a.avgRange)[0];
      if (bestAsian) parts.push(`Best Asian hour: ${bestAsian.hour}:00 UTC (range ${bestAsian.avgRange.toFixed(2)}, ${bestAsian.bullishPct.toFixed(0)}% bullish)`);
    }
    if (londonHours.length > 0) {
      const londonAvgRange = londonHours.reduce((s, h) => s + h.avgRange, 0) / londonHours.length;
      parts.push(`London session (07-16 UTC): avg range ${londonAvgRange.toFixed(2)}`);
    }
    if (nyHours.length > 0) {
      const nyAvgRange = nyHours.reduce((s, h) => s + h.avgRange, 0) / nyHours.length;
      parts.push(`New York session (12-21 UTC): avg range ${nyAvgRange.toFixed(2)}`);
    }

    const dayVolatility = new Map<number, { totalRange: number; count: number; bullish: number }>();
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    for (let d = 0; d < 7; d++) dayVolatility.set(d, { totalRange: 0, count: 0, bullish: 0 });
    for (const c of h1) {
      const dow = new Date(c.timestamp).getUTCDay();
      const bucket = dayVolatility.get(dow)!;
      bucket.totalRange += c.high - c.low;
      bucket.count++;
      if (c.close > c.open) bucket.bullish++;
    }
    parts.push(`\nDay-of-week volatility:`);
    Array.from(dayVolatility.entries())
      .filter(([_, d]) => d.count > 5)
      .sort((a, b) => a[0] - b[0])
      .forEach(([day, d]) => {
        parts.push(`  ${dayNames[day]}: avg range ${(d.totalRange / d.count).toFixed(2)} (${d.count} candles, ${((d.bullish / d.count) * 100).toFixed(0)}% bullish)`);
      });
  }

  try {
    const { getLiveTraderState } = await import("./live-trader");
    const state = getLiveTraderState();
    if (state) {
      parts.push(`\n=== LIVE TRADING STATUS ===`);
      parts.push(`Engine: ${state.running ? 'RUNNING' : 'STOPPED'} | Connected: ${state.connected ? 'YES' : 'NO'}`);
      parts.push(`Regime: ${state.regime || 'unknown'} | Daily P&L: $${state.dailyPnl?.toFixed(2) || '0.00'} | Total P&L: $${state.totalPnl?.toFixed(2) || '0.00'}`);
      if (state.positions && state.positions.length > 0) {
        parts.push(`OPEN POSITIONS (${state.positions.length}):`);
        for (const pos of state.positions) {
          const side = pos.tradeSide === 1 ? 'BUY' : 'SELL';
          const vol = (pos.volume / 100).toFixed(2);
          const currentPx = livePrice?.price ?? latestH1.close;
          const unrealized = pos.tradeSide === 1
            ? (currentPx - (pos.entryPrice || 0)) * (pos.volume / 100)
            : ((pos.entryPrice || 0) - currentPx) * (pos.volume / 100);
          parts.push(`  #${pos.positionId}: ${side} ${vol} lots @ $${pos.entryPrice?.toFixed(2) || 'N/A'} | SL: $${pos.stopLoss?.toFixed(2) || 'none'} | TP: $${pos.takeProfit?.toFixed(2) || 'none'} | Unrealized: $${unrealized.toFixed(2)}`);
        }
      } else {
        parts.push(`Open Positions: NONE`);
      }
    }
  } catch { }

  return parts.join('\n');
}

async function executeBacktest(params: Record<string, any>): Promise<{ success: boolean; result?: string; error?: string; backtestId?: string; fullConfig?: Record<string, any> }> {
  try {
    await ensureDataReady();
    const cached = getCachedData();
    if (cached.h1.length === 0) {
      return { success: false, error: "No market data loaded. Cannot run backtest." };
    }

    const defaults = backtestConfigSchema.parse({});
    const config: any = { ...defaults };
    const schemaKeys = new Set(Object.keys(backtestConfigSchema.shape));
    for (const [key, value] of Object.entries(params)) {
      if (schemaKeys.has(key)) {
        config[key] = value;
      }
    }

    if (!config.endDate) {
      config.endDate = new Date().toISOString().substring(0, 10);
    }
    if (!config.startDate) {
      config.startDate = new Date(Date.now() - 180 * 86400000).toISOString().substring(0, 10);
    }

    if (config.startDate && config.endDate && config.startDate > config.endDate) {
      return { success: false, error: `Invalid date range: startDate (${config.startDate}) is after endDate (${config.endDate})` };
    }

    if (config.leverage && config.leverage > 10) {
      console.log(`[AI Advisor] Clamping leverage from ${config.leverage} to 10 (max allowed)`);
      config.leverage = 10;
    }
    if (config.maxDrawdownPct && config.maxDrawdownPct > 25) {
      console.log(`[AI Advisor] Clamping maxDrawdownPct from ${config.maxDrawdownPct} to 25 (max allowed)`);
      config.maxDrawdownPct = 25;
    }

    const parsed = backtestConfigSchema.safeParse(config);
    if (!parsed.success) {
      return { success: false, error: `Invalid config: ${parsed.error.flatten().fieldErrors}` };
    }

    const result = runBacktest(parsed.data, {
      m1: cached.m1,
      m15: cached.m15,
      h1: cached.h1,
      h4: cached.h4,
      daily: cached.daily,
      events: cached.events.map(e => ({ timestamp: e.timestamp })),
      gvz: cached.gvz.map((g: any) => ({ date: g.date, value: Number(g.value) })),
      cot: cached.cot.map((c: any) => ({ date: c.date, noncommLong: c.noncommLong, noncommShort: c.noncommShort, netPosition: c.netPosition, openInterest: c.openInterest })),
    });

    storage.saveBacktestResult(result).catch(err => console.error("Failed to save backtest:", err));

    const s = result.stats;
    const rdr = s.maxDrawdownPct > 0 ? (s.returnPct / s.maxDrawdownPct).toFixed(2) : (s.returnPct > 0 ? "999" : "0");
    const d = result.diagnostics;

    const summary = [
      `BACKTEST RESULTS (ID: ${result.id})`,
      `Date Range: ${result.config.startDate || 'all data'} → ${result.config.endDate || 'latest'}`,
      `Config: RR=${parsed.data.rewardRatio}, risk=${parsed.data.riskPerTradePct}%, lev=${parsed.data.leverage}x, ATR stop=${parsed.data.atrStopMultiplier}, expansion=${parsed.data.expansionThreshold}, execTF=${parsed.data.executionTimeframe ?? '1h'}, session=${parsed.data.sessionMode}${parsed.data.entryWindowBars > 0 ? `, entryWindow=${parsed.data.entryWindowBars}h` : ''}`,
      `Risk controls: maxDD=${parsed.data.maxDrawdownPct}%, dailyLoss=${parsed.data.maxDailyLossPct}%, consecLimit=${parsed.data.maxConsecutiveLosses}, cooldown=${parsed.data.postLossCooldownBars}, reduceAfterLoss=${parsed.data.reduceSizeAfterLoss}`,
      ``,
      `Trades: ${s.totalTrades} total | ${s.wins}W / ${s.losses}L | Win Rate: ${s.winRate}%`,
      `P&L: $${s.netPnl.toFixed(2)} | Return: ${s.returnPct}% | Profit Factor: ${s.profitFactor}`,
      `Drawdown: $${s.maxDrawdown.toFixed(2)} (${s.maxDrawdownPct}%) | Return/DD Ratio: ${rdr}`,
      `Avg R: ${s.avgR} | Consecutive: ${s.consecutiveWins}W / ${s.consecutiveLosses}L | Avg Hold: ${s.avgHoldingBars} bars`,
      `Range: ${s.rangeTrades}t, ${s.rangeWinRate}%WR, $${s.rangePnl.toFixed(2)} | Trend: ${s.trendTrades}t, ${s.trendWinRate}%WR, $${s.trendPnl.toFixed(2)}`,
      ``,
      `Diagnostics: session=${d?.blockedBySession ?? 0}, entryWindow=${d?.blockedByEntryWindow ?? 0}, news=${d?.blockedByNews ?? 0}, gap=${d?.blockedByGap ?? 0}, midpoint=${d?.blockedByMidpointBand ?? 0}`,
      `  retest=${d?.blockedByRetestDistance ?? 0}, wick=${d?.blockedByWickRatio ?? 0}, compression=${d?.blockedByCompression ?? 0}, expansion=${d?.blockedByExpansion ?? 0}`,
      `  maxTrades=${d?.blockedByMaxTradesPerDay ?? 0}, maxDD=${d?.blockedByMaxDrawdown ?? 0}, dailyLoss=${d?.blockedByDailyLossLimit ?? 0}, consecLimit=${d?.blockedByConsecutiveLossLimit ?? 0}`,
      `  reducedSize=${d?.reducedSizeAfterLossCount ?? 0}, atrScaled=${d?.atrScaledRiskCount ?? 0}, 2ndTradeReduced=${d?.secondTradeReducedRiskCount ?? 0}`,
      `  buyCandidates=${d?.buyCandidates ?? 0}, sellCandidates=${d?.sellCandidates ?? 0}, acceptedBuys=${d?.acceptedBuyTrades ?? 0}, acceptedSells=${d?.acceptedSellTrades ?? 0}`,
    ];

    if (result.monthlyReturns && result.monthlyReturns.length > 0) {
      summary.push(``);
      summary.push(`Monthly: ${result.monthlyReturns.map(m => `${m.month}: ${m.return >= 0 ? '+' : ''}${m.return.toFixed(1)}%`).join(', ')}`);
    }

    if (result.hourlyPerformance && result.hourlyPerformance.length > 0) {
      summary.push(``);
      summary.push(`HOURLY PERFORMANCE (by entry hour UTC):`);
      const profitable = result.hourlyPerformance.filter(h => h.pnl > 0).sort((a, b) => b.pnl - a.pnl);
      const losing = result.hourlyPerformance.filter(h => h.pnl <= 0).sort((a, b) => a.pnl - b.pnl);
      if (profitable.length > 0) {
        summary.push(`  Best hours: ${profitable.slice(0, 5).map(h => `${h.hour}:00 (${h.trades}t, ${h.winRate}%WR, $${h.pnl.toFixed(0)}, avgR ${h.avgR})`).join(' | ')}`);
      }
      if (losing.length > 0) {
        summary.push(`  Worst hours: ${losing.slice(0, 3).map(h => `${h.hour}:00 (${h.trades}t, ${h.winRate}%WR, $${h.pnl.toFixed(0)}, avgR ${h.avgR})`).join(' | ')}`);
      }
      summary.push(`  All hours: ${result.hourlyPerformance.map(h => `${h.hour}h:${h.trades}t/${h.winRate}%/$${h.pnl.toFixed(0)}`).join(', ')}`);
    }

    if (result.dayOfWeekPerformance && result.dayOfWeekPerformance.length > 0) {
      summary.push(`DAY-OF-WEEK: ${result.dayOfWeekPerformance.map(d => `${d.dayName.substring(0, 3)}:${d.trades}t/${d.winRate}%/$${d.pnl.toFixed(0)}`).join(', ')}`);
    }

    return { success: true, result: summary.join('\n'), backtestId: result.id, fullConfig: parsed.data as Record<string, any> };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

function parseStatsFromResult(resultText: string): { returnPct: number; maxDrawdownPct: number; winRate: number; totalTrades: number; profitFactor: number } | undefined {
  try {
    const lines = resultText.split('\n');
    const get = (prefix: string) => {
      const l = lines.find(l => l.includes(prefix));
      return l || '';
    };
    const parseNum = (s: string) => parseFloat(s.replace(/[^0-9.\-]/g, '')) || 0;

    const tradesLine = get('Trades:');
    const totalTrades = parseNum(tradesLine.split('total')[0].replace(/.*Trades:\s*/, ''));
    const winRateMatch = get('Win Rate:').match(/Win Rate:\s*([\d.]+)%/);
    const winRate = winRateMatch ? parseFloat(winRateMatch[1]) : 0;
    const returnMatch = get('Return:').match(/Return:\s*([\d.\-]+)%/);
    const returnPct = returnMatch ? parseFloat(returnMatch[1]) : 0;
    const pfMatch = get('Profit Factor:').match(/Profit Factor:\s*([\d.]+)/);
    const profitFactor = pfMatch ? parseFloat(pfMatch[1]) : 0;
    const ddMatch = get('Drawdown:').match(/\(([\d.]+)%\)/);
    const maxDrawdownPct = ddMatch ? parseFloat(ddMatch[1]) : 0;

    if (totalTrades === 0 && returnPct === 0) return undefined;
    return { returnPct, maxDrawdownPct, winRate, totalTrades, profitFactor };
  } catch {
    return undefined;
  }
}

function detectChangedParams(
  prevParams: Record<string, any>,
  currentParams: Record<string, any>
): Array<{ parameter: string; fromValue: string | number; toValue: string | number; rationale: string }> {
  const changes: Array<{ parameter: string; fromValue: string | number; toValue: string | number; rationale: string }> = [];
  for (const key of Object.keys(currentParams)) {
    if (prevParams[key] !== undefined && prevParams[key] !== currentParams[key]) {
      changes.push({
        parameter: key,
        fromValue: prevParams[key],
        toValue: currentParams[key],
        rationale: "AI chat iteration",
      });
    }
  }
  return changes;
}

function buildChatSystemPrompt(): string {
  return `You are an expert quantitative trading advisor and optimizer for XAUUSD (Gold). You have FULL CONTROL over a 3-state regime classifier backtester.

YOU CAN AND SHOULD:
- Run backtests by calling the run_backtest tool with any parameter combination
- Analyze results, identify weaknesses, tweak parameters, and run again
- Iterate multiple times in a single conversation turn to find optimal settings
- Test hypotheses by running controlled experiments (change one thing at a time)
- Push for maximum Return/DD ratio while keeping drawdown under control
- SAVE strategies using the save_strategy tool when user asks to save/bookmark/remember configs (use risk categories: V-LOW, LOW, MED, HIGH)
- RETRIEVE saved strategies using the list_strategies tool when user asks to compare, recall, or review saved configs
- When saving strategies, always include the FULL config object and stats from the most recent backtest run

CURRENT GOLD MARKET CONTEXT (2025-2026):
- Gold is in an unprecedented bull run driven by geopolitical conflicts, wars, and economic uncertainty
- Heavy bullish momentum with violent retracements — NOT a normal range-bound market
- Entry point is CRUCIAL: buy at the bottom of retracement ranges, sell at the top, and ride trends
- Be cautious of breakouts — many are false breakouts in this volatile environment
- Asian session (00:00-07:00 UTC) often sets the day's direction for gold — use it as a leading indicator
- The right TIME OF DAY to trade is critical for edge — backtest data reveals which hours perform best
- Every backtest now includes HOURLY PERFORMANCE data — analyze it to find optimal trading windows
- When recommending strategies, always highlight the best and worst hours from the data
- Asian session overlap with early London (06:00-09:00 UTC) and London-NY overlap (12:00-16:00 UTC) are historically significant

STRATEGY OVERVIEW:
- ATR-based stop losses, configurable R:R ratio, risk-based position sizing
- Range trading at H4 support/resistance, Trend trading on breakout acceptance
- 10 risk management controls (drawdown circuit breaker, daily loss cap, consecutive loss pause, etc.)
- 19 diagnostics counters tracking filter activity
- lotSize is auto-calculated from riskPerTradePct — do NOT set lotSize directly
- GVZ (Gold Volatility Index) integration: CBOE GVZ percentile rank (252-day) confirms regime classification. GVZ P<25 = low vol confirms RANGE, P>75 = high vol confirms TREND. When BB width and GVZ disagree, regime defaults to NO_TRADE. Controlled by gvzEnabled, gvzRangeThreshold (default 25), gvzTrendThreshold (default 75).
- COT (Commitment of Traders) integration: CFTC weekly positioning data. Non-commercial net position percentile (3-year rolling, 156 weeks). COT P>75 = BULLISH positioning, blocks short breakouts. COT P<25 = BEARISH positioning, blocks long breakouts. This prevents trading against the smart money flow. Controlled by cotEnabled, cotBullishThreshold (default 75), cotBearishThreshold (default 25).
- SGE (Shanghai Gold Exchange) premium filter: SGE premium = Shanghai gold price - international spot price in $/oz. Premium >$10 = strong Chinese demand = bullish bias (blocks trend shorts). Discount <-$5 = weak demand = caution on longs (blocks trend longs). Data from SGE benchmark + FRED USD/CNY exchange rate. Controlled by sgeEnabled, sgeBullishThreshold (default $10), sgeBearishThreshold (default -$5).
- Volume Profile integration: Distributes H4 candle volume across price bins to find POC (Point of Control — highest volume price, acts as magnet), VAH (Value Area High — resistance), VAL (Value Area Low — support). Range trades are blocked near POC (congestion zone where price chops). Trend trades are blocked if breakout price is still inside the value area (buy blocked if price < VAH, sell blocked if price > VAL). Controlled by volumeProfileEnabled, volumeProfilePeriod (default 50), volumeProfileBins (default 24), volumeProfileValueAreaPct (default 70), vpPocProximityPct (default 0.15).
- HMM (Hidden Markov Model) integration: Probabilistic 3-state Gaussian HMM trained via Baum-Welch on observable features (ATR ratio, BB width percentile, ADX, log returns). States: low_vol (confirms range, blocks trend), medium_vol (transitional, neutral), high_vol (confirms trend, blocks range). Only filters when confidence > hmmConfidenceThreshold (default 60%). Trained on enriched candle data at startup. Controlled by hmmEnabled, hmmConfidenceThreshold (default 0.6).

KEY PARAMETERS (with ranges):
Entry/Structure: rewardRatio(1-20), atrStopMultiplier(0.5-5), compressionThreshold(0.001-0.1), expansionThreshold(1.01-3), rangeWidthBars(5-50), midpointBandPct(0.01-0.5), retestBuffer(0.5-50), wickRatio(0.3-5), executionTimeframe(1h|15min|1min — execution candle size; H4 always used for regime), sessionMode(London+NewYork|London|NewYork|Asian|Asian+London|Asian+London+NewYork|All), entryWindowBars(0-12, 0=disabled — limits entries to first N hours after session open), maxTradesPerDay(1-10)
Risk: riskPerTradePct(0.1-10), leverage(FIXED at 10, NEVER change), maxDrawdownPct(FIXED at 25, NEVER change), maxDailyLossPct(0.5-20), maxConsecutiveLosses(1-20), postLossCooldownBars(0-20), reduceSizeAfterLoss(bool), reducedRiskPerTradePct(0.1-10), atrRiskScaleEnabled(bool), atrRiskScaleThreshold(1.01-5), atrRiskScaleFactor(0.1-1), secondTradeRiskFactor(0.1-1)
Trading Costs (for cTrader realism): spreadPoints(0-5, default 0.30 — XAUUSD typical spread), slippagePoints(0-5, default 0.10), commissionPerLot(0-50, default 0)
GVZ Regime Filter: gvzEnabled(bool, default true — uses CBOE Gold Volatility Index to confirm regimes), gvzRangeThreshold(5-50, default 25 — GVZ percentile below this confirms range), gvzTrendThreshold(50-95, default 75 — GVZ percentile above this confirms trend)
COT Regime Filter: cotEnabled(bool, default true — uses CFTC Commitment of Traders positioning), cotBullishThreshold(50-95, default 75 — net position percentile above this = bullish, blocks short breakouts), cotBearishThreshold(5-50, default 25 — net position percentile below this = bearish, blocks long breakouts)
Session Timing: avoidHoursEnabled(bool, default true — blocks entries during low-liquidity hours), avoidHoursUTC(array of 0-23, default [21,22,23,0] — UTC hours to avoid), peakHoursEnabled(bool, default false — optional whitelist restricting entries to best hours only), peakHoursUTC(array of 0-23, default [] — UTC hours to allow when enabled)
Volume Profile: volumeProfileEnabled(bool, default true — distributes volume across price levels to find POC/VAH/VAL), volumeProfilePeriod(10-200, default 50 — H4 bar lookback), volumeProfileBins(10-100, default 24 — number of price bins), volumeProfileValueAreaPct(50-95, default 70 — % of total volume defining value area), vpPocProximityPct(0.01-0.5, default 0.15 — distance from POC as fraction of VA range; if closer, entry is blocked as congestion)
SGE Premium Filter: sgeEnabled(bool, default true — uses Shanghai Gold Exchange premium to filter trades), sgeBullishThreshold(0-100, default 10 — premium above this in $/oz = bullish, blocks trend shorts), sgeBearishThreshold(-50-10, default -5 — premium below this in $/oz = bearish, blocks trend longs)
HMM Regime Filter: hmmEnabled(bool, default true — probabilistic Hidden Markov Model regime confirmation), hmmConfidenceThreshold(0.3-0.95, default 0.6 — minimum HMM state probability to apply filter)

IMPORTANT — BACKTEST DATE RANGE:
- ALWAYS set startDate and endDate when running backtests. Today is ${new Date().toISOString().substring(0, 10)}.
- If the user specifies a date range (e.g., "from Jan 2026" or "last 3 months"), use EXACTLY those dates.
- If the user does NOT specify dates, ALWAYS default to: startDate="2026-01-01", endDate="${new Date().toISOString().substring(0, 10)}".
- NEVER use a startDate before 2026-01-01. The strategy is calibrated for 2026+ data only.
- NEVER run a backtest without setting startDate and endDate. Without them, the backtest uses ALL available data which may go back years and distort results.
- When iterating/optimizing across multiple runs, keep the SAME date range for fair comparison.

IMPORTANT — REALISTIC BACKTESTING:
- ALWAYS include spreadPoints and slippagePoints in your backtests. The default spread of $0.30 and slippage of $0.10 models real cTrader execution.
- Without spread/slippage, backtest results will be OVEROPTIMISTIC and won't match cTrader's actual performance.
- If the user says results differ from cTrader, suggest increasing spread (typical XAUUSD spread is $0.20-$0.50 depending on broker/session).
- Entry cost: buys fill at close + halfSpread + slippage, sells fill at close - halfSpread - slippage.
- Exit cost: exits also incur halfSpread against the position.

CRITICAL LEARNING RULES:
- You are given the TOP 5 BEST and WORST 5 historical runs with their FULL configs. STUDY THEM before running any backtest.
- NEVER repeat parameter combinations that appear in the WORST runs. ALWAYS start from the BEST known config and make incremental improvements.
- Track what parameters improve vs degrade performance across iterations. If a change makes things worse, REVERT it immediately — never drift away from known-good settings.
- After finding a good config (R/DD > 4), ALWAYS save it using save_strategy with a descriptive name so it is remembered permanently.
- When you see a pattern (e.g. "lower wickRatio always helps", "expansion > 1.1 hurts"), state it explicitly and follow it consistently.

OPTIMIZATION JOURNAL:
- You have a PERSISTENT OPTIMIZATION JOURNAL that survives between sessions. It records every suggestion you made, the before/after stats, and whether the change improved or worsened performance.
- ALWAYS check the journal before making suggestions. If the journal shows a parameter change WORSENED results previously, DO NOT suggest it again.
- If the journal shows a parameter change IMPROVED results, build on it — push further in that direction.
- Reference specific journal entries when explaining your reasoning (e.g. "Journal entry #3 shows lowering wickRatio from 0.6→0.4 improved return by 12%").
- The journal is your accumulated wisdom — treat it as your memory of what works and what doesn't.

OPTIMIZATION APPROACH:
1. FIRST: Study the TOP 5 BEST historical runs. Start your first backtest from the BEST known config, NOT from defaults.
2. Analyze what's working and what isn't — look at diagnostics to find bottlenecks
3. Change 1-2 parameters at a time (controlled experimentation). NEVER change more than 2 params at once.
4. Run the backtest and compare. If it improved, push further in that direction. If it worsened, IMMEDIATELY revert to the last good config and try a different parameter.
5. You can run up to 12 iterations per conversation turn. Use all of them.
6. Primary metric: Return/DD ratio. Secondary: absolute return, win rate, profit factor
7. Target: maximize return while keeping drawdown under 25%
8. After optimization, ALWAYS auto-save the best result using save_strategy

EVALUATION GRADES (apply mechanically):
WIN RATE (R:R context): R:R>=3: <20%=F, 20-30%=D, 30-40%=C, 40-50%=B, >50%=A | R:R>=2: <30%=F, 30-40%=D, 40-50%=C, 50-55%=B, >55%=A
PROFIT FACTOR: <1.0=F, 1.0-1.3=D, 1.3-1.7=C, 1.7-2.2=B, >2.2=A
MAX DRAWDOWN: >30%=F, 25-30%=D, 15-25%=C, 5-15%=B, <5%=A
RETURN/DD: <0.5=F, 0.5-1.5=D, 1.5-4.0=C, 4.0-8.0=B, >8.0=A

PRICE STRUCTURE ANALYSIS (Goldviewfx Method):
When analyzing gold price action, apply these structural reading principles:
- HIGHER LOWS IN A BEARISH TREND: When price is trending down (lower highs & lower lows) but starts forming higher lows, this is an EARLY signal that selling momentum is fading and buyers are stepping in earlier. Trends don't reverse randomly — they TRANSITION through structural shifts.
- STRUCTURAL SHIFT CHECKLIST: (1) Clear bearish trend with lower highs & lower lows, (2) Price fails to make a new low, (3) Consecutive higher lows form, (4) Compression/tightening price action appears, (5) Breakout or strong bullish push follows. The same applies in reverse for bullish-to-bearish transitions (lower highs forming in an uptrend).
- This connects directly to our regime engine: compression (BB width narrowing) often accompanies these structural transitions. When the regime shows "range" after a trend, CHECK whether higher lows (or lower highs) are forming — this tells you the DIRECTION of the likely breakout.
- PRACTICAL APPLICATION: When providing market analysis or trade setups:
  * Look at recent swing lows — are they rising (bullish) or falling (bearish)?
  * Is the range compressing? (BB width narrowing, ATR declining)
  * Where is price relative to the range midpoint? Above midpoint + higher lows = bullish bias. Below midpoint + lower highs = bearish bias.
  * Don't blindly trade the regime — read the STRUCTURE within the regime to determine directional bias.
- KEY INSIGHT: "Stay patient, trust structure, and let price tell the story." Don't force entries. Wait for the structural evidence (higher lows or lower highs) to confirm before committing to a directional view.

LIVE MARKET ANALYSIS:
- You have access to get_market_snapshot which returns a LIVE SPOT PRICE (real-time from API), plus cached candle data for ATR, regime state, key S/R levels, daily trend, upcoming events, and Asian market sentiment
- The snapshot shows "LIVE SPOT PRICE" at the top — ALWAYS use this as the current price when reporting to the user. The candle close prices below it may be minutes to hours old.
- If the snapshot contains a WARNING about stale candle data, note that technical indicators (ATR, BB, EMA) are based on older candles but the live spot price is still real-time. Recommend refreshing if the candle data is very old.
- NEVER present candle close prices as the "current price" — always use the LIVE SPOT PRICE.
- After running backtests or when the user asks about current market conditions, ALWAYS call get_market_snapshot
- When providing market analysis, include:
  1. Whether the backtested strategy suits the CURRENT market regime (range/trend/no-trade)
  2. What modifications (if any) would better fit current conditions
  3. Specific entry points with exact price levels, stop loss, and take profit targets
  4. Your trading plan: what to watch for, when to enter, when to stay flat
  5. Risk assessment given upcoming economic events and volatility state
- If the user asks "would this strategy work now" or "what's your plan", call get_market_snapshot first

LOCKED PARAMS MANAGEMENT:
- The system has LOCKED PARAMS — the live production trading parameters used by the live trader.
- You have FULL AUTHORITY to change these parameters when you have evidence to support changes.
- You have TWO tools for managing params:
  1. apply_locked_params — DIRECTLY APPLY changes immediately. Use this when you have strong evidence and want to act autonomously. The live trader auto-reloads with new params. All changes are logged with your rationale in the changelog.
  2. propose_locked_params — Creates a proposal for user approval. Use this when you want the user to review before applying, or for major/risky changes.
- When applying params directly, always explain what you changed and why in the rationale.
- First run a backtest with the current locked params to get baseline stats, then run with your proposed params, then apply if the proposed clearly wins.
- The current locked params are injected into your context below — use them as your baseline.

RULES:
1. ALWAYS quote exact numbers from backtest results
2. When the user asks you to optimize/tune/find settings, DO IT — run backtests, don't just suggest
3. Explain what you changed and why after each run
4. If the user asks a question, answer it directly with data
5. Be concise in explanations between runs, detailed in final summaries
6. Remember conversation history — build on previous findings
7. After completing backtest optimization, proactively offer live market analysis

Respond in plain text with markdown formatting. Between backtest runs, briefly explain what you're changing and why. After your final run, give a comprehensive summary.`;
}

const MAX_TOOL_ITERATIONS = 12;

async function callOpenAIWithRetry(params: any, retries = 2): Promise<any> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await openai.chat.completions.create(params);
    } catch (err: any) {
      const isRetryable = err.status === 429 || err.status === 502 || err.status === 503 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (attempt < retries && isRetryable) {
        const delay = (attempt + 1) * 2000;
        console.log(`[AI Chat] Retry ${attempt + 1}/${retries} after ${delay}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

export async function getChatResponse(
  message: string,
  contextData: string,
  onProgress?: (update: { type: string; message: string }) => void,
  attachments?: Array<{ type: string; name: string; content: string }>
): Promise<{ reply: string; actions: Array<{ type: string; params: Record<string, any>; result: string }> }> {
  const savedStrategies = await storage.listStrategies();
  const cappedStrategies = savedStrategies.slice(0, 15);
  const savedStrategiesSummary = cappedStrategies.length > 0
    ? `\n\nSAVED STRATEGIES (${savedStrategies.length} total, showing ${cappedStrategies.length}):\n${cappedStrategies.map(s => {
        const rdr = s.stats.maxDrawdownPct > 0 ? (s.stats.returnPct / s.stats.maxDrawdownPct).toFixed(2) : 'N/A';
        return `  [${s.category}] "${s.name}" — ${s.stats.totalTrades}t, ${s.stats.winRate}%WR, ${s.stats.returnPct}%ret, R/DD=${rdr}, RR=${s.config.rewardRatio}`;
      }).join('\n')}`
    : '';

  let backtestHistoryContext = '';
  try {
    const activeBacktests = await storage.listBacktestResults();
    const archivedBacktests = await storage.listArchivedBacktests();
    const allBacktests = [...activeBacktests, ...archivedBacktests]
      .sort((a, b) => (b.stats.returnPct || 0) - (a.stats.returnPct || 0));
    const top20 = allBacktests.slice(0, 20);
    if (top20.length > 0) {
      backtestHistoryContext = `\n\nBACKTEST HISTORY (${activeBacktests.length} active, ${archivedBacktests.length} archived — showing top 20 by return):\n` +
        top20.map((b: any) => {
          const archived = b.archived ? ' [ARCHIVED]' : '';
          const label = b.label ? ` "${b.label}"` : '';
          const dates = b.config.startDate && b.config.endDate ? `${b.config.startDate} to ${b.config.endDate}` : 'full range';
          return `  ${b.stats.returnPct}%ret, ${b.stats.totalTrades}t, ${b.stats.winRate}%WR, ${b.stats.maxDrawdownPct}%DD, PF=${b.stats.profitFactor}, dates=${dates}${label}${archived}`;
        }).join('\n');
    }
  } catch {}

  let changelogContext = '';
  try {
    const changelog = await storage.getStrategyChangelog();
    const recentChanges = changelog.slice(0, 10);
    if (recentChanges.length > 0) {
      changelogContext = `\n\nSTRATEGY CHANGELOG (recent ${recentChanges.length} entries):\n` +
        recentChanges.map((e: any) => {
          const date = new Date(e.created_at).toISOString().substring(0, 16);
          const desc = e.description || e.action;
          return `  ${date} | ${e.action}: ${desc}`;
        }).join('\n');
    }
  } catch {}

  const journalContext = await formatJournalForPrompt();
  let lockedParamsContext = '';
  try {
    const { getLockedParams: getLP } = await import("./locked-params");
    const lp = await getLP();
    const { storage: st } = await import("./storage");
    const cl = await st.listParamChangelog(1);
    const lastCh = cl.length > 0 ? cl[0] : null;
    const src = lastCh?.source === "ai_advisor" ? "AI Advisor" :
      lastCh?.source === "backtest_apply" ? "Backtest Apply" :
      lastCh?.source === "champion_apply" ? "Strategy Page (Champion)" :
      lastCh?.source === "auto_tuner" ? "Auto-Tuner" :
      lastCh?.source === "user" ? "Manual Update" : "System Default";
    lockedParamsContext = `\n\nCURRENT ACTIVE STRATEGY (these are the LIVE locked params being traded right now):`;
    if (lastCh) {
      lockedParamsContext += `\nLast changed by: ${src}${lastCh.timestamp ? ` on ${new Date(lastCh.timestamp).toISOString().split('T')[0]}` : ''}`;
      if (lastCh.rationale) lockedParamsContext += `\nRationale: "${lastCh.rationale}"`;
      if (lastCh.changed_keys || lastCh.changedKeys) lockedParamsContext += `\nChanged fields: ${JSON.stringify(lastCh.changed_keys || lastCh.changedKeys)}`;
    }
    lockedParamsContext += `\nParameters:\n${JSON.stringify(lp, null, 2)}`;
  } catch { }
  let analystContext = '';
  try {
    const { getLatestAnalystIdeas } = await import("./goldviewfx-fetcher");
    analystContext = await getLatestAnalystIdeas();
  } catch { }
  let liveLearningsContext = '';
  try {
    const { getAILearningsSummary } = await import("./ai-monitor");
    liveLearningsContext = await getAILearningsSummary();
  } catch { }
  let liveDecisionContext = '';
  try {
    const stats = await storage.getTradeDecisionStats();
    const recent = await storage.getRecentTradeDecisions(10);
    if (stats.total > 0) {
      liveDecisionContext = `\n\n## LIVE TRADING RECORD\nTotal decisions: ${stats.total} (${stats.entries} entries, ${stats.skips} skips) | Wins: ${stats.wins} | Losses: ${stats.losses} | P&L: $${stats.totalPnl.toFixed(2)}`;
      if (recent.length > 0) {
        liveDecisionContext += `\nRecent:\n` + recent.slice(0, 5).map((d: any) =>
          `  ${new Date(d.timestamp).toISOString().substring(0, 16)} | ${d.decision} ${d.block_reason || d.side || ''} | $${Number(d.price).toFixed(2)} | ${d.regime}`
        ).join('\n');
      }
    }
  } catch { }
  let liveStatusContext = '';
  try {
    const { getLiveTraderState } = await import("./live-trader");
    const state = getLiveTraderState();
    if (state) {
      const parts: string[] = [];
      parts.push(`\n\n## LIVE TRADING STATUS (real-time)`);
      parts.push(`Trading Engine: ${state.running ? 'RUNNING' : 'STOPPED'}`);
      parts.push(`Connection: ${state.connected ? 'CONNECTED' : 'DISCONNECTED'}`);
      parts.push(`Current Regime: ${state.regime || 'unknown'}`);
      parts.push(`Current Price: $${state.currentPrice?.toFixed(2) || 'N/A'}`);
      parts.push(`Daily P&L: $${state.dailyPnl?.toFixed(2) || '0.00'}`);
      parts.push(`Total P&L: $${state.totalPnl?.toFixed(2) || '0.00'}`);
      parts.push(`Trades Today: ${state.tradestoday || 0}`);
      parts.push(`Consecutive Losses: ${state.consecutiveLosses || 0}`);
      if (state.positions && state.positions.length > 0) {
        parts.push(`\n### OPEN POSITIONS (${state.positions.length}):`);
        for (const pos of state.positions) {
          const side = pos.tradeSide === 1 ? 'BUY' : 'SELL';
          const vol = (pos.volume / 100).toFixed(2);
          parts.push(`  Position #${pos.positionId}: ${side} ${vol} lots @ $${pos.entryPrice?.toFixed(2) || 'N/A'} | SL: $${pos.stopLoss?.toFixed(2) || 'none'} | TP: $${pos.takeProfit?.toFixed(2) || 'none'}`);
        }
      } else {
        parts.push(`Open Positions: NONE`);
      }
      liveStatusContext = parts.join('\n');
    }
  } catch { }
  const messages: Array<any> = [
    { role: "system", content: buildChatSystemPrompt() },
  ];

  const hasContext = contextData || savedStrategiesSummary || backtestHistoryContext || changelogContext || journalContext || lockedParamsContext || analystContext || liveLearningsContext || liveDecisionContext || liveStatusContext;
  if (hasContext) {
    messages.push({ role: "user", content: `[CONTEXT — current state and history]\n${contextData}${savedStrategiesSummary}${backtestHistoryContext}${changelogContext}${journalContext}${lockedParamsContext}${analystContext}${liveLearningsContext}${liveDecisionContext}${liveStatusContext}` });
    messages.push({ role: "assistant", content: "I have the full context loaded including live trading status, backtest history, and optimization journal. I can see open positions, current regime, and what changes previously worked or didn't. What would you like me to do?" });
  }

  for (const msg of chatHistory) {
    if (msg.role === "user" || msg.role === "assistant") {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  if (attachments && attachments.length > 0) {
    const contentParts: Array<any> = [];
    let textParts = message;
    for (const att of attachments) {
      if (att.type === "image") {
        const mimeMatch = att.content.match(/^data:(image\/\w+);base64,/);
        const mime = mimeMatch ? mimeMatch[1] : "image/png";
        const base64 = mimeMatch ? att.content.slice(mimeMatch[0].length) : att.content;
        contentParts.push({
          type: "image_url",
          image_url: { url: `data:${mime};base64,${base64}`, detail: "high" },
        });
      } else {
        textParts += `\n\n[Attached file: ${att.name}]\n${att.content}`;
      }
    }
    contentParts.unshift({ type: "text", text: textParts });
    messages.push({ role: "user", content: contentParts });
  } else {
    messages.push({ role: "user", content: message });
  }

  const actions: Array<{ type: string; params: Record<string, any>; result: string }> = [];
  let finalReply = "";

  const isAutonomousOptimization = /keep going|don'?t stop|find.*(perfect|best|optimal)|optimize|auto.?tune|iterate|without.*(input|me|further)|on your own|autonomous/i.test(message);
  const MIN_AUTONOMOUS_RUNS = isAutonomousOptimization ? 5 : 1;
  let backtestRunCount = 0;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS + 1; iteration++) {
    onProgress?.({ type: "thinking", message: iteration === 0 ? "Thinking..." : `Analyzing results (step ${iteration + 1})...` });

    const forceStop = iteration >= MAX_TOOL_ITERATIONS;
    const forceContinue = isAutonomousOptimization && backtestRunCount < MIN_AUTONOMOUS_RUNS && !forceStop;

    const response = await callOpenAIWithRetry({
      model: AI_MODEL,
      messages,
      temperature: 0.15,
      max_tokens: 4096,
      tools: [BACKTEST_TOOL_DEFINITION, SAVE_STRATEGY_TOOL_DEFINITION, LIST_STRATEGIES_TOOL_DEFINITION, GET_MARKET_SNAPSHOT_TOOL_DEFINITION, PROPOSE_LOCKED_PARAMS_TOOL_DEFINITION, APPLY_LOCKED_PARAMS_TOOL_DEFINITION, EXECUTE_TRADE_TOOL_DEFINITION],
      tool_choice: forceStop ? "none" : (forceContinue ? { type: "function", function: { name: "run_backtest" } } : "auto"),
    });

    const choice = response.choices[0];

    if (choice.finish_reason === "tool_calls" || (choice.message.tool_calls && choice.message.tool_calls.length > 0)) {
      messages.push(choice.message);

      for (const toolCall of choice.message.tool_calls || []) {
        let params: Record<string, any> = {};
        try {
          params = JSON.parse(toolCall.function.arguments);
        } catch {
          params = {};
        }

        if (toolCall.function.name === "run_backtest") {
          console.log(`[AI Chat] Running backtest iteration ${iteration + 1} with params:`, JSON.stringify(params));
          onProgress?.({ type: "tool_call", message: `Running backtest ${backtestRunCount + 1}${isAutonomousOptimization ? ` of ${MIN_AUTONOMOUS_RUNS}+` : ''}...` });
          const toolResult = await executeBacktest(params);

          if (toolResult.success) backtestRunCount++;

          const resultText = toolResult.success
            ? toolResult.result!
            : `ERROR: ${toolResult.error}`;

          const resolvedParams = toolResult.fullConfig || params;
          actions.push({ type: "run_backtest", params: resolvedParams, result: resultText });

          if (toolResult.success && toolResult.backtestId) {
            try {
              const prevAction = [...actions].slice(0, -1).reverse().find(a => a.type === "run_backtest" && !a.result.startsWith('ERROR:'));
              const prevStats = prevAction ? parseStatsFromResult(prevAction.result) : undefined;
              const currentStats = parseStatsFromResult(resultText);
              const changedParams = prevAction ? detectChangedParams(prevAction.params, resolvedParams) : [];
              if (currentStats) {
                await recordChatBacktestResult(toolResult.backtestId, currentStats, changedParams, prevStats);
              }
            } catch (journalErr) {
              console.error("[Journal] Failed to record chat backtest:", journalErr);
            }
          }

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: resultText,
          });
        } else if (toolCall.function.name === "save_strategy") {
          console.log(`[AI Chat] Saving strategy: "${params.name}" (${params.category})`);
          try {
            let configToSave = params.config || {};
            let statsToSave = params.stats || {};
            let diagToSave = params.diagnostics || undefined;

            if (Object.keys(configToSave).length < 5 || Object.keys(statsToSave).length < 3) {
              const lastBacktestAction = [...actions].reverse().find(a => a.type === "run_backtest" && !a.result.startsWith('ERROR:'));
              if (lastBacktestAction) {
                if (Object.keys(configToSave).length < 5) {
                  configToSave = lastBacktestAction.params;
                }
                if (Object.keys(statsToSave).length < 3) {
                  const lines = lastBacktestAction.result.split('\n');
                  const get = (prefix: string) => {
                    const l = lines.find(l => l.startsWith(prefix));
                    return l ? l.replace(prefix, '').trim() : '';
                  };
                  const parseNum = (s: string) => parseFloat(s.replace(/[^0-9.\-]/g, '')) || 0;
                  statsToSave = {
                    totalTrades: parseNum(get('Trades:')),
                    winRate: parseNum(get('WinRate:').split('%')[0]),
                    netPnl: parseNum(get('P&L:')),
                    returnPct: parseNum(get('Return:').split('%')[0]),
                    profitFactor: parseNum(get('PF:')),
                    maxDrawdown: parseNum(get('Drawdown:').split('(')[0]),
                    maxDrawdownPct: parseNum((get('Drawdown:').match(/\(([\d.]+)%\)/) || ['', '0'])[1]),
                    avgR: parseNum(get('AvgR:')),
                    wins: 0, losses: 0, rangeTrades: 0, trendTrades: 0,
                    noTradeBarCount: 0, rangeWins: 0, rangeLosses: 0,
                    trendWins: 0, trendLosses: 0, rangePnl: 0, trendPnl: 0,
                    rangeWinRate: 0, trendWinRate: 0, finalBalance: 0,
                    avgHoldingBars: 0, consecutiveWins: 0, consecutiveLosses: 0,
                  };
                }
              }
            }

            const id = `strat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            await storage.saveStrategy({
              id,
              name: params.name || "Unnamed",
              category: params.category || "",
              config: configToSave,
              stats: statsToSave,
              diagnostics: diagToSave,
              notes: params.notes || undefined,
              createdAt: new Date().toISOString(),
            });
            const resultText = `Saved strategy "${params.name}" [${params.category}] with id=${id}. Config has ${Object.keys(configToSave).length} fields.`;
            actions.push({ type: "save_strategy", params: { id, name: params.name, category: params.category }, result: resultText });
            messages.push({ role: "tool", tool_call_id: toolCall.id, content: resultText });
          } catch (err: any) {
            const errorText = `ERROR saving strategy: ${err.message}`;
            messages.push({ role: "tool", tool_call_id: toolCall.id, content: errorText });
          }
        } else if (toolCall.function.name === "list_strategies") {
          console.log(`[AI Chat] Listing saved strategies`);
          try {
            const strategies = await storage.listStrategies();
            if (strategies.length === 0) {
              messages.push({ role: "tool", tool_call_id: toolCall.id, content: "No saved strategies found." });
            } else {
              const summaries = strategies.map(s => {
                const rdr = s.stats.maxDrawdownPct > 0 ? (s.stats.returnPct / s.stats.maxDrawdownPct).toFixed(2) : 'N/A';
                return `[${s.category}] "${s.name}" — ${s.stats.totalTrades}t, ${s.stats.winRate}%WR, ${s.stats.returnPct}%ret, ${s.stats.maxDrawdownPct}%DD, R/DD=${rdr}, PF=${s.stats.profitFactor}, RR=${s.config.rewardRatio}${s.notes ? ` | Notes: ${s.notes}` : ''}`;
              });
              const resultText = `${strategies.length} saved strategies:\n${summaries.join('\n')}`;
              messages.push({ role: "tool", tool_call_id: toolCall.id, content: resultText });
            }
          } catch (err: any) {
            messages.push({ role: "tool", tool_call_id: toolCall.id, content: `ERROR listing strategies: ${err.message}` });
          }
        } else if (toolCall.function.name === "get_market_snapshot") {
          console.log(`[AI Chat] Getting market snapshot for live analysis`);
          onProgress?.({ type: "tool_call", message: "Fetching live price & analyzing market..." });
          const snapshot = await getMarketSnapshot();
          actions.push({ type: "get_market_snapshot", params: {}, result: snapshot });
          messages.push({ role: "tool", tool_call_id: toolCall.id, content: snapshot });
        } else if (toolCall.function.name === "apply_locked_params") {
          console.log(`[AI Chat] Directly applying locked params change`);
          onProgress?.({ type: "tool_call", message: "Applying parameter changes directly..." });
          try {
            const allowedKeys = new Set([
              'lotSize', 'atrPeriod', 'atrStopMultiplier', 'rewardRatio', 'compressionThreshold',
              'expansionThreshold', 'rangeWidthBars', 'midpointBandPct', 'entryWindowBars', 'wickRatio', 'minRangeATR', 'maxTrendATRRatio',
              'sessionMode', 'sessionORBEnabled', 'riskPerTradePct', 'leverage', 'maxDrawdownPct',
              'maxDailyLossPct', 'maxConsecutiveLosses', 'maxTradesPerDay', 'trailingStopEnabled',
              'trailingStopTriggerR', 'startingBalance', 'retestBuffer', 'reduceSizeAfterLoss',
              'reducedRiskPerTradePct', 'gapFilterEnabled', 'gapThresholdAtr', 'gapCooldownBars',
              'postLossCooldownBars', 'atrRiskScaleEnabled', 'atrRiskScaleFactor', 'atrRiskScaleThreshold',
              'secondTradeRiskFactor', 'newsBeforeMin', 'newsAfterMin',
              'spreadPoints', 'slippagePoints', 'commissionPerLot',
              'avoidHoursEnabled', 'avoidHoursUTC', 'peakHoursEnabled', 'peakHoursUTC',
            ]);
            const { getLockedParams: getLP, updateLockedParams: updateLP } = await import("./locked-params");
            const currentParams = await getLP();
            const rawParams = params.params || {};
            const newParams: Record<string, any> = {};
            const rejectedKeys: string[] = [];
            for (const [k, v] of Object.entries(rawParams)) {
              if (allowedKeys.has(k)) { newParams[k] = v; } else { rejectedKeys.push(k); }
            }
            if (Object.keys(newParams).length === 0) {
              const resultText = `No valid params to apply.${rejectedKeys.length > 0 ? ` Rejected unknown keys: ${rejectedKeys.join(', ')}` : ''}`;
              actions.push({ type: "apply_locked_params", params: {}, result: resultText });
              messages.push({ role: "tool", tool_call_id: toolCall.id, content: resultText });
              continue;
            }
            const changedKeys: string[] = [];
            const oldValues: Record<string, any> = {};
            const newValues: Record<string, any> = {};
            for (const key of Object.keys(newParams)) {
              if (JSON.stringify(newParams[key]) !== JSON.stringify(currentParams[key])) {
                changedKeys.push(key);
                oldValues[key] = currentParams[key];
                newValues[key] = newParams[key];
              }
            }
            if (changedKeys.length === 0) {
              const resultText = "No changes detected — all proposed values match current locked params.";
              actions.push({ type: "apply_locked_params", params: {}, result: resultText });
              messages.push({ role: "tool", tool_call_id: toolCall.id, content: resultText });
            } else {
              const updated = await updateLP(newParams);
              await storage.saveParamChangelog({
                source: "ai",
                changedKeys,
                oldValues,
                newValues,
                rationale: params.rationale || "AI-applied change",
                fullParams: updated,
              });
              const { getActiveLiveTrader } = await import("./routes");
              const trader = getActiveLiveTrader();
              if (trader) {
                await trader.reloadLockedParams();
              }
              const changesSummary = changedKeys.map(k => `${k}: ${oldValues[k]} → ${newValues[k]}`).join(', ');
              const resultText = `APPLIED: ${changesSummary}. Live trader reloaded with new params. Rationale logged: "${params.rationale}"`;
              console.log(`[AI Chat] Applied locked params: ${changesSummary}`);
              actions.push({ type: "apply_locked_params", params: { changedKeys }, result: resultText });
              messages.push({ role: "tool", tool_call_id: toolCall.id, content: resultText });
            }
          } catch (err: any) {
            messages.push({ role: "tool", tool_call_id: toolCall.id, content: `ERROR applying params: ${err.message}` });
          }
        } else if (toolCall.function.name === "execute_trade") {
          console.log(`[AI Chat] Executing trade via cTrader`);
          onProgress?.({ type: "tool_call", message: `Placing ${params.side?.toUpperCase() || "?"} order on cTrader...` });
          try {
            const { getActiveLiveTrader } = await import("./routes");
            const trader = getActiveLiveTrader();
            if (!trader) {
              const errMsg = "Live trader is not active. Go to the Live Trading page and connect to cTrader first.";
              messages.push({ role: "tool", tool_call_id: toolCall.id, content: errMsg });
            } else {
              const result = await trader.manualTrade({
                side: params.side,
                riskPercent: params.riskPercent,
                stopLossPrice: params.stopLossPrice,
                takeProfitPrice: params.takeProfitPrice,
              });
              const resultText = result.success
                ? `TRADE EXECUTED SUCCESSFULLY: ${result.details}`
                : `TRADE FAILED: ${result.details}`;
              actions.push({ type: "execute_trade", params: { side: params.side }, result: resultText });
              messages.push({ role: "tool", tool_call_id: toolCall.id, content: resultText });
            }
          } catch (err: any) {
            messages.push({ role: "tool", tool_call_id: toolCall.id, content: `ERROR executing trade: ${err.message}` });
          }

        } else if (toolCall.function.name === "propose_locked_params") {
          console.log(`[AI Chat] Proposing locked params change`);
          onProgress?.({ type: "tool_call", message: "Creating locked params proposal for your approval..." });
          try {
            const { getLockedParams: getLP } = await import("./locked-params");
            const currentParams = await getLP();
            const changedKeys: string[] = [];
            const proposed = params.proposedParams || {};
            for (const key of Object.keys(proposed)) {
              if (JSON.stringify(proposed[key]) !== JSON.stringify(currentParams[key])) {
                changedKeys.push(key);
              }
            }
            const proposalId = `prop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const proposal = {
              id: proposalId,
              createdAt: new Date().toISOString(),
              source: "ai-chat",
              currentParams,
              proposedParams: { ...currentParams, ...proposed },
              changedKeys,
              currentStats: params.currentStats,
              proposedStats: params.proposedStats,
              rationale: params.rationale || "",
              status: "pending" as const,
              backtestId: params.backtestId,
            };
            await storage.saveLockedParamsProposal(proposal);
            const changesSummary = changedKeys.map(k => `${k}: ${currentParams[k]} → ${proposed[k]}`).join(', ');
            const resultText = `Proposal created (id: ${proposalId}). Changed params: ${changesSummary}. Status: PENDING — awaiting user approval in the Admin panel. Current stats: ${params.currentStats.returnPct}% return, ${params.currentStats.profitFactor} PF | Proposed stats: ${params.proposedStats.returnPct}% return, ${params.proposedStats.profitFactor} PF.`;
            actions.push({ type: "propose_locked_params", params: { proposalId, changedKeys }, result: resultText });
            messages.push({ role: "tool", tool_call_id: toolCall.id, content: resultText });
          } catch (err: any) {
            messages.push({ role: "tool", tool_call_id: toolCall.id, content: `ERROR proposing params: ${err.message}` });
          }
        }
      }
      continue;
    }

    if (isAutonomousOptimization && backtestRunCount < MIN_AUTONOMOUS_RUNS && iteration < MAX_TOOL_ITERATIONS - 1) {
      messages.push(choice.message);
      messages.push({
        role: "user",
        content: `You've only run ${backtestRunCount} backtest(s) so far. The user asked you to keep iterating autonomously. Continue experimenting — change 1-2 parameters based on your analysis of the previous results and run another backtest. Don't stop until you've tried at least ${MIN_AUTONOMOUS_RUNS} variations. Keep going.`,
      });
      onProgress?.({ type: "thinking", message: `Continuing optimization (${backtestRunCount}/${MIN_AUTONOMOUS_RUNS} runs)...` });
      continue;
    }

    finalReply = cleanProseString(choice.message.content || "");
    break;
  }

  if (!finalReply && actions.length > 0) {
    finalReply = "I ran the backtests above. Check the results for details.";
  }

  const backtestRuns = actions.filter(a => a.type === "run_backtest" && !a.result.startsWith('ERROR:'));
  if (backtestRuns.length >= 2) {
    const bestRun = backtestRuns.reduce((best, cur) => {
      const getReturnDD = (r: string) => { const m = r.match(/Return\/DD(?:\s+Ratio)?:\s*([\d.]+)/); return m ? parseFloat(m[1]) : 0; };
      return getReturnDD(cur.result) > getReturnDD(best.result) ? cur : best;
    });
    const rddMatch = bestRun.result.match(/Return\/DD(?:\s+Ratio)?:\s*([\d.]+)/);
    const rdd = rddMatch ? parseFloat(rddMatch[1]) : 0;
    const retMatch = bestRun.result.match(/Return:\s*([\d.]+)%/);
    const retPct = retMatch ? parseFloat(retMatch[1]) : 0;
    if (rdd >= 2 && retPct > 0) {
      const alreadySaved = actions.some(a => a.type === "save_strategy");
      if (!alreadySaved) {
        try {
          const existingStrategies = await storage.listStrategies();
          const existingReturns = existingStrategies.map(s => s.stats.returnPct);
          const maxExistingReturn = existingReturns.length > 0 ? Math.max(...existingReturns) : 0;
          if (retPct > maxExistingReturn * 0.8 || existingStrategies.length < 5) {
            const text = bestRun.result;
            const grab = (rx: RegExp) => { const m = text.match(rx); return m ? parseFloat(m[1]) || 0 : 0; };
            const totalTrades = grab(/Trades:\s*([\d]+)/);
            const winRate = grab(/Win Rate:\s*([\d.]+)%/);
            const netPnl = grab(/P&L:\s*\$?([\-\d.]+)/);
            const profitFactor = grab(/Profit Factor:\s*([\d.]+)/);
            const maxDrawdown = grab(/Drawdown:\s*\$?([\d.]+)/);
            const maxDrawdownPct = grab(/\(([\d.]+)%\)/);
            const avgR = grab(/Avg R:\s*([\-\d.]+)/);
            const id = `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            await storage.saveStrategy({
              id,
              name: `AI Optimized R/DD ${rdd.toFixed(1)} (${retPct.toFixed(0)}% ret)`,
              category: rdd >= 8 ? "HIGH" : rdd >= 4 ? "MED" : "LOW",
              config: bestRun.params as any,
              stats: {
                totalTrades, winRate, netPnl, returnPct: retPct, profitFactor, maxDrawdown,
                maxDrawdownPct, avgR,
                wins: 0, losses: 0, rangeTrades: 0, trendTrades: 0, noTradeBarCount: 0,
                rangeWins: 0, rangeLosses: 0, trendWins: 0, trendLosses: 0,
                rangePnl: 0, trendPnl: 0, rangeWinRate: 0, trendWinRate: 0,
                finalBalance: 0, avgHoldingBars: 0, consecutiveWins: 0, consecutiveLosses: 0,
              },
              notes: `Auto-saved from AI optimization (${backtestRuns.length} iterations)`,
              createdAt: new Date().toISOString(),
            });
            finalReply += `\n\n📊 **Auto-saved** this config to your Strategy Library as "${id}" (R/DD ${rdd.toFixed(1)}).`;
            console.log(`[AI Chat] Auto-saved best strategy: R/DD=${rdd.toFixed(2)}, ret=${retPct}%`);
          }
        } catch (err: any) {
          console.error("[AI Chat] Failed to auto-save strategy:", err.message);
        }
      }
    }
  }

  const userSummary = message.length > 500 ? message.substring(0, 500) + "..." : message;
  chatHistory.push({ role: "user", content: userSummary });

  if (actions.length > 0) {
    const btCount = actions.filter(a => a.type === "run_backtest").length;
    const snapCount = actions.filter(a => a.type === "get_market_snapshot").length;
    const labelParts: string[] = [];
    if (btCount > 0) labelParts.push(`Ran ${btCount} backtest${btCount > 1 ? 's' : ''}`);
    if (snapCount > 0) labelParts.push(`Analyzed live market`);
    if (labelParts.length === 0) labelParts.push(`${actions.length} action${actions.length > 1 ? 's' : ''}`);
    chatHistory.push({
      role: "action",
      content: labelParts.join(' + '),
      actions,
    });
  }

  const assistantSummary = finalReply.length > 2000 ? finalReply.substring(0, 2000) + "..." : finalReply;
  chatHistory.push({ role: "assistant", content: assistantSummary });

  if (chatHistory.length > MAX_CHAT_HISTORY * 3) {
    chatHistory = chatHistory.slice(-MAX_CHAT_HISTORY * 3);
  }

  return { reply: finalReply, actions };
}

function buildSystemPrompt(): string {
  return `You are an expert quantitative trading advisor specializing in XAUUSD (Gold) strategies. You analyze backtest results from a 3-state regime classifier (Range/Trend/No-Trade) that trades gold using H4 structure detection and H1 execution.

The strategy uses:
- ATR-based stop losses (configurable multiplier × H1 ATR)
- Fixed reward:risk ratio (configurable, default 2:1)
- Risk-based position sizing: each trade risks riskPerTradePct% of balance, with lot size = (balance × risk%) / (stopDistance × leverage)
- Range trading: rejection entries at H4 support/resistance extremes
- Trend trading: breakout acceptance with retest confirmation
- No-trade filter: midpoint dead zone, news blackouts, session filters
- Gap detection: blocks entries after large open-vs-prev-close gaps
- Session Opening Range Bias (ORB): first H1 candle of session sets directional filter
- GVZ (Gold Volatility Index) regime confirmation: CBOE GVZ percentile (252-day rolling) confirms regime — P<25 confirms range, P>75 confirms trend. When technical signals and GVZ disagree, regime defaults to no_trade to avoid false signals

Key configurable parameters:
Entry/Structure:
- atrPeriod (5-50, default 14) — ATR calculation period
- atrStopMultiplier (0.5-5, default 2.0) — stop loss = ATR × multiplier
- rewardRatio (1-20, default 2.0) — take profit = stop × ratio
- compressionThreshold (0.001-0.1, default 0.022) — H4 BB width for range detection
- expansionThreshold (1.01-3, default 1.05) — ATR ratio for trend detection
- rangeWidthBars (5-50, default 8) — lookback for H4 range
- midpointBandPct (0.01-0.5, default 0.10) — no-trade zone width
- retestBuffer (0.1-20, default 12.0) — acceptance retest tolerance
- wickRatio (0.5-5, default 0.6) — rejection candle validation
- executionTimeframe — 1h (default), 15min, 1min. Lower TF gives more precise entries. H4 always used for regime.
- sessionMode — Asian, Asian+London, London, NewYork, London+NewYork, Asian+London+NewYork, All
- entryWindowBars (0-12, default 0) — only allow entries in first N hours after session open (0=disabled)
- maxTradesPerDay (1-20, default 5)

Risk Management:
- riskPerTradePct (0.1-10, default 0.75) — % of balance risked per trade
- leverage (FIXED at 10, cannot be changed) — margin leverage, determines max position size via margin only (does NOT multiply risk per trade)
- maxDrawdownPct (FIXED at 25, cannot be changed) — circuit breaker: stops all trading when DD exceeds this
- maxDailyLossPct (0.5-10, default 2.0) — stops trading for the day when daily loss exceeds this %
- maxConsecutiveLosses (1-10, default 2) — pauses entries after N consecutive losses
- postLossCooldownBars (0-10, default 2) — bars to sit out after hitting consecutive loss limit
- reduceSizeAfterLoss (true/false, default true) — use reduced risk on trade after a loss
- reducedRiskPerTradePct (0.1-5, default 0.50) — risk % used after a loss
- atrRiskScaleEnabled (true/false, default true) — reduce risk when ATR is elevated
- atrRiskScaleThreshold (1.05-3, default 1.25) — ATR/avgATR ratio that triggers scaling
- atrRiskScaleFactor (0.1-1, default 0.65) — multiply risk by this when ATR elevated
- secondTradeRiskFactor (0.1-1, default 0.75) — multiply risk on 2nd+ trade of the day

Diagnostics counters tracked: blockedBySession, blockedByNews, blockedByGap, blockedByMidpointBand, blockedByRetestDistance, blockedByWickRatio, blockedByCompression, blockedByExpansion, blockedByMaxTradesPerDay, blockedByMaxDrawdown, blockedByDailyLossLimit, blockedByConsecutiveLossLimit, reducedSizeAfterLossCount, atrScaledRiskCount, secondTradeReducedRiskCount, buyCandidates, sellCandidates, acceptedBuyTrades, acceptedSellTrades

CRITICAL LEARNING RULES:
- Always start from the best known configuration (highest return %) and make incremental changes
- Never repeat parameter combinations from the WORST runs
- After multi-run optimization (2+ runs), the system auto-saves good results to the Strategy Library
- Primary goal: MAXIMIZE RETURN % (target 100%+). Secondary goal: reduce drawdown below 25% while preserving as much return as possible
- The TOP 5 LEADERBOARD is ranked by return % — these are the scores to beat. When optimizing, NEVER sacrifice more than 20% of return to reduce drawdown. Preserve profits first, then tighten risk.

BACKTEST HISTORY: You will receive key historical runs (top 5 best, worst 5, recent 10) with their configs, stats, and diagnostics. You MUST:
1. Compare runs chronologically to identify which parameter changes improved or worsened performance
2. Identify patterns: which configs produce the best return/DD ratio
3. Learn from failures: if a parameter change hurt performance, explain why and warn against repeating it
4. Track the evolution of the strategy and recommend the next logical tuning step
5. Reference specific past runs when making suggestions (e.g., "Run #3 with RR=3.5 achieved 48% WR vs Run #7 with RR=2 at 51% WR")
6. Focus on the return-to-drawdown ratio as the primary optimization metric, not raw return
7. Consider whether real-data runs confirm or contradict synthetic-data findings

OPTIMIZATION JOURNAL: You will also receive a PERSISTENT OPTIMIZATION JOURNAL — this is your memory across sessions. It shows:
- Every suggestion you previously made and the resulting before/after performance
- Whether each change IMPROVED, WORSENED, or had MIXED results
- Accumulated learnings about what works and what doesn't
CRITICAL: Study the journal FIRST. Never repeat suggestions that previously worsened results. Build on what improved results. Reference journal entries in your analysis.

CONSISTENCY RULES — apply these EXACT fixed evaluation grades mechanically every time:

WIN RATE (with R:R context):
- R:R >= 3: WR < 20% = F, 20-30% = D, 30-40% = C, 40-50% = B, > 50% = A
- R:R >= 2: WR < 30% = F, 30-40% = D, 40-50% = C, 50-55% = B, > 55% = A
- R:R < 2:  WR < 40% = F, 40-50% = D, 50-55% = C, 55-60% = B, > 60% = A

PROFIT FACTOR: < 1.0 = F, 1.0-1.3 = D, 1.3-1.7 = C, 1.7-2.2 = B, > 2.2 = A
MAX DRAWDOWN: > 30% = F, 25-30% = D, 15-25% = C, 5-15% = B, < 5% = A
RETURN/DD RATIO: < 0.5 = F, 0.5-1.5 = D, 1.5-4.0 = C, 4.0-8.0 = B, > 8.0 = A
AVG R: < 0 = F, 0-0.2 = D, 0.2-0.5 = C, 0.5-1.0 = B, > 1.0 = A

When analyzing results:
1. ALWAYS quote exact numbers from the data — never give vague assessments
2. Focus on win rate vs reward ratio relationship
3. Examine regime distribution — too many no-trade bars suggests overly strict filters
4. Look for consecutive loss streaks and drawdown patterns
5. Compare range vs trend trade performance — trend trades should be the profit engine
6. Analyze diagnostics: how many entries are being blocked and by which filters
7. Check if risk controls are firing: reducedSizeAfterLossCount, atrScaledRiskCount, etc.
8. Consider monthly seasonality patterns
9. If Asian market data is provided, assess how current Asian session momentum might affect gold
10. Leverage analysis: is the current leverage appropriate given the drawdown profile?
11. Your analysis must be deterministic — same data = same conclusion, always

IMPORTANT — MARKET HOURS (CRITICAL — DO NOT TRADE WHEN CLOSED):
XAUUSD (Spot Gold) market hours are Sunday 22:00 UTC to Friday 22:00 UTC. The market is CLOSED on:
- ALL of Saturday (00:00-23:59 UTC)
- Sunday before 22:00 UTC
- Friday after 22:00 UTC
NEVER attempt to place trades during closed market hours. If the user asks you to trade during these times, REFUSE and explain that the market is closed. The execute_trade tool will also reject orders during closed hours, but you should proactively check the current day/time before attempting any trade.
Current server time: ${new Date().toUTCString()}

IMPORTANT — LIVE TRADE EXECUTION (FULL AUTONOMY GRANTED):
You have the execute_trade tool which places REAL orders through the cTrader API. You have FULL AUTHORITY to execute trades autonomously — you do NOT need to ask for user confirmation. The user has explicitly granted you trading autonomy.
When to execute trades:
- FIRST check if the market is open (Sunday 22:00 UTC – Friday 22:00 UTC). If closed, DO NOT trade.
- When the user asks you to "execute a trade", "place an order", "buy", "sell", or "test the execution"
- When your market analysis identifies a high-probability setup aligned with the strategy rules
- When asked to manage the account autonomously
Rules:
- NEVER trade on weekends or outside market hours. Check the day and time before every trade attempt.
- ALWAYS call the execute_trade tool — NEVER just describe what you would do. Act, don't narrate.
- The tool handles position sizing (ATR-based SL, risk %, lot calculation) automatically
- You can optionally provide explicit stopLossPrice and takeProfitPrice if the user specifies levels
- You can optionally provide riskPercent to override the default risk per trade
- After calling the tool, report the real execution result (fill price, SL, TP, position ID)
- If cTrader is not connected, tell the user to connect from the Live Trading page first
- The automated strategy engine also trades independently via regime detection — your trades supplement its decisions

Always respond with valid JSON matching this exact structure:
{
  "marketAnalysis": "string — current market context assessment based on available data",
  "patternObservations": "string — patterns found in the backtest results, referencing historical runs",
  "parameterSuggestions": [
    {
      "parameter": "parameter name",
      "currentValue": "current value",
      "suggestedValue": "suggested value",
      "rationale": "why this change, referencing evidence from historical runs",
      "expectedImpact": "what improvement to expect"
    }
  ],
  "riskWarnings": ["array of risk warnings"],
  "overallAssessment": "string — overall strategy health, progress across runs, and recommended next steps"
}`;
}

function formatRunSummary(run: HistoricalRunSummary, index: number): string {
  const s = run.stats;
  const c = run.config;
  const returnDD = s.maxDrawdownPct > 0 ? (s.returnPct / s.maxDrawdownPct).toFixed(2) : "N/A";
  let line = `Run #${index + 1} [${run.dataSource.toUpperCase()}] ${new Date(run.createdAt).toISOString().substring(0, 16)}`;
  line += `\n  Config: RR=${c.rewardRatio}, risk=${c.riskPerTradePct ?? '-'}%, lev=${c.leverage ?? 1}x, expansion=${c.expansionThreshold}, maxDD=${c.maxDrawdownPct ?? '-'}%`;
  line += `\n  Risk: dailyLoss=${c.maxDailyLossPct ?? '-'}%, consecLimit=${c.maxConsecutiveLosses ?? '-'}, cooldown=${c.postLossCooldownBars ?? '-'}, reduceAfterLoss=${c.reduceSizeAfterLoss ?? false}, atrScale=${c.atrRiskScaleEnabled ?? false}`;
  line += `\n  Results: ${s.totalTrades} trades, ${s.winRate}% WR, PF ${s.profitFactor}, Return ${s.returnPct}%, MaxDD ${s.maxDrawdownPct}%, Return/DD ratio: ${returnDD}`;
  line += `\n  Breakdown: Range ${s.rangeTrades}t/${s.rangeWinRate}%WR/$${s.rangePnl.toFixed(0)}, Trend ${s.trendTrades}t/${s.trendWinRate}%WR/$${s.trendPnl.toFixed(0)}`;
  line += `\n  Streaks: ${s.consecutiveWins} consec wins, ${s.consecutiveLosses} consec losses, ${s.avgHoldingBars} avg hold bars`;
  if (run.diagnostics) {
    const d = run.diagnostics;
    line += `\n  Diagnostics: session=${d.blockedBySession ?? 0}, expansion=${d.blockedByExpansion ?? 0}, wick=${d.blockedByWickRatio ?? 0}, retest=${d.blockedByRetestDistance ?? 0}, consecPause=${d.blockedByConsecutiveLossLimit ?? 0}, reducedSize=${d.reducedSizeAfterLossCount ?? 0}, atrScaled=${d.atrScaledRiskCount ?? 0}`;
  }
  if (run.monthlyReturns && run.monthlyReturns.length > 0) {
    const lossingMonths = run.monthlyReturns.filter(m => m.return < 0);
    const winningMonths = run.monthlyReturns.filter(m => m.return >= 0);
    line += `\n  Monthly: ${winningMonths.length} green months, ${lossingMonths.length} red months`;
    if (lossingMonths.length > 0) {
      const worstMonth = lossingMonths.reduce((a, b) => a.return < b.return ? a : b);
      line += `, worst: ${worstMonth.month} (${worstMonth.return.toFixed(1)}%)`;
    }
  }
  return line;
}

function buildUserPrompt(req: AdvisorRequest): string {
  const parts: string[] = [];

  if (req.historicalRuns && req.historicalRuns.length > 0) {
    const sorted = [...req.historicalRuns].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const byReturn = [...sorted].filter(r => r.stats.totalTrades > 0).sort((a, b) => b.stats.returnPct - a.stats.returnPct);
    const top5 = byReturn.slice(0, 5);
    const worst5 = byReturn.slice(-5).reverse();
    const recent10 = sorted.slice(-10);

    const uniqueRuns = new Map<string, HistoricalRunSummary>();
    for (const r of [...top5, ...worst5, ...recent10]) uniqueRuns.set(r.id, r);
    const capped = [...uniqueRuns.values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    parts.push(`## BACKTEST HISTORY (${sorted.length} total runs, showing ${capped.length} key runs)
TOP 5 BEST by return %, WORST 5, and MOST RECENT 10. Analyze the progression.

${capped.map((r, i) => {
  const isTop = top5.some(t => t.id === r.id);
  const isWorst = worst5.some(w => w.id === r.id);
  const tag = isTop ? ' [TOP]' : isWorst ? ' [WORST]' : '';
  return formatRunSummary(r, i) + tag;
}).join('\n\n')}`);
  }

  if (req.config) {
    parts.push(`## Currently Selected Configuration
${JSON.stringify(req.config, null, 2)}`);
  }

  if (req.stats) {
    parts.push(`## Currently Selected Backtest Statistics
- Total Trades: ${req.stats.totalTrades}
- Win Rate: ${req.stats.winRate}%
- Net P&L: $${req.stats.netPnl.toFixed(2)} (${req.stats.returnPct}%)
- Profit Factor: ${req.stats.profitFactor}x
- Max Drawdown: $${req.stats.maxDrawdown.toFixed(2)} (${req.stats.maxDrawdownPct.toFixed(1)}%)
- Average R: ${req.stats.avgR}R
- Range Trades: ${req.stats.rangeTrades} (Win: ${req.stats.rangeWinRate}%, P&L: $${req.stats.rangePnl.toFixed(2)})
- Trend Trades: ${req.stats.trendTrades} (Win: ${req.stats.trendWinRate}%, P&L: $${req.stats.trendPnl.toFixed(2)})
- No-Trade Bars: ${req.stats.noTradeBarCount}
- Consecutive Wins: ${req.stats.consecutiveWins}
- Consecutive Losses: ${req.stats.consecutiveLosses}
- Avg Holding Bars: ${req.stats.avgHoldingBars}`);
  }

  if (req.diagnostics) {
    parts.push(`## Diagnostics Counters
${Object.entries(req.diagnostics).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`);
  }

  if (req.regimeCounts) {
    const total = req.regimeCounts.range + req.regimeCounts.trend + req.regimeCounts.no_trade;
    parts.push(`## Regime Distribution
- Range bars: ${req.regimeCounts.range} (${((req.regimeCounts.range / total) * 100).toFixed(1)}%)
- Trend bars: ${req.regimeCounts.trend} (${((req.regimeCounts.trend / total) * 100).toFixed(1)}%)
- No-trade bars: ${req.regimeCounts.no_trade} (${((req.regimeCounts.no_trade / total) * 100).toFixed(1)}%)`);
  }

  if (req.monthlyReturns && req.monthlyReturns.length > 0) {
    parts.push(`## Monthly Returns
${req.monthlyReturns.map(m => `${m.month}: ${m.return >= 0 ? '+' : ''}${m.return.toFixed(2)}% (${m.trades} trades)`).join('\n')}`);
  }

  if (req.trades && req.trades.length > 0) {
    const last20 = req.trades.slice(-20);
    parts.push(`## Recent Trades (last ${last20.length})
${last20.map(t => `${t.entryTime.substring(0, 10)} ${t.side.toUpperCase()} ${t.regime} | Entry: ${t.entryPrice.toFixed(2)} Exit: ${t.exitPrice.toFixed(2)} | ${t.exitReason} | ${t.resultR >= 0 ? '+' : ''}${t.resultR}R ($${t.pnl.toFixed(2)})`).join('\n')}`);
  }

  if (req.asianMarkets && req.asianMarkets.length > 0) {
    parts.push(`## Current Asian Market Session
${req.asianMarkets.map(a => `${a.name} (${a.symbol}): ${a.price.toLocaleString()} | ${a.changePct >= 0 ? '+' : ''}${a.changePct.toFixed(2)}%`).join('\n')}`);
  }

  if (req.upcomingEvents && req.upcomingEvents.length > 0) {
    const upcoming = req.upcomingEvents
      .filter(e => new Date(e.timestamp) >= new Date())
      .slice(0, 10);
    if (upcoming.length > 0) {
      parts.push(`## Upcoming Economic Events
${upcoming.map(e => `${e.timestamp.substring(0, 16)} | ${e.event} (${e.impact} impact)`).join('\n')}`);
    }
  }

  if (req.userQuestion) {
    parts.push(`## User Question
${req.userQuestion}`);
  }

  if (parts.length === 0) {
    parts.push("No backtest data provided. Please provide general XAUUSD strategy guidance for a 3-state regime classifier approach.");
  }

  return parts.join('\n\n');
}

export async function getAdvisorAnalysis(req: AdvisorRequest): Promise<AdvisorResponse> {
  const systemPrompt = buildSystemPrompt();
  const journalContext = await formatJournalForPrompt();
  const userPrompt = buildUserPrompt(req) + journalContext;

  const response = await openai.chat.completions.create({
    model: AI_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
    max_tokens: 3000,
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("No response from AI advisor");
  }

  const raw = JSON.parse(content);
  sanitizeAnalysisStrings(raw);
  const parsed = advisorResponseSchema.parse(raw);

  if (parsed.parameterSuggestions.length > 0 && req.stats) {
    try {
      await recordAnalysisSuggestions(
        parsed.parameterSuggestions,
        req.backtestId,
        {
          returnPct: req.stats.returnPct,
          maxDrawdownPct: req.stats.maxDrawdownPct,
          winRate: req.stats.winRate,
          totalTrades: req.stats.totalTrades,
          profitFactor: req.stats.profitFactor,
        }
      );
    } catch (err) {
      console.error("[Journal] Failed to record analysis suggestions:", err);
    }
  }

  return parsed as AdvisorResponse;
}
