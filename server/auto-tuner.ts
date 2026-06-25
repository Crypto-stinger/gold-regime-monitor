import crypto from "crypto";
import { openai } from "./replit_integrations/audio/client";
import { runBacktest } from "./backtest";
import { storage } from "./storage";
import type { BacktestConfig, BacktestResult, Candle } from "../shared/schema";
import { backtestConfigSchema } from "../shared/schema";
import type { JournalEntry } from "./storage";

export type AutoTuneIteration = {
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

export type AutoTuneResult = {
  iterations: AutoTuneIteration[];
  bestIteration: number;
  bestReturnDDRatio: number;
  bestConfig: BacktestConfig;
  status: "completed" | "target_reached" | "no_improvement" | "error";
  message: string;
};

export type AutoTuneProgress = {
  running: boolean;
  currentIteration: number;
  maxIterations: number;
  iterations: AutoTuneIteration[];
  status: string;
};

let activeProgress: AutoTuneProgress | null = null;

export function getAutoTuneProgress(): AutoTuneProgress | null {
  return activeProgress;
}

const TUNER_SYSTEM_PROMPT = `You are an AI optimizer for a XAUUSD (Gold) trading strategy backtester. Your job is to analyze backtest results and suggest improved parameter values for the next iteration.

You receive the history of all iterations so far. Each shows the config used and the resulting stats. Your goal is to maximize the Return/DD ratio (return divided by max drawdown) while keeping max drawdown under the target.

Tunable parameters and their valid ranges:
- rewardRatio (1-20, default 2.0) — take profit / stop loss ratio
- atrStopMultiplier (0.5-5, default 2.0) — stop = ATR × this
- compressionThreshold (0.001-0.1, default 0.022) — BB width for range detection
- expansionThreshold (1.01-3, default 1.05) — ATR ratio for trend detection
- rangeWidthBars (5-50, default 8) — H4 range lookback
- midpointBandPct (0.01-0.5, default 0.10) — no-trade zone width
- retestBuffer (0.5-50, default 12.0) — retest tolerance
- wickRatio (0.3-5, default 0.6) — rejection candle validation
- maxTradesPerDay (1-10, default 5)
- riskPerTradePct (0.1-10, default 0.75) — % balance risked per trade
- leverage (FIXED at 10, cannot be changed) — margin leverage only, does NOT multiply risk
- maxDrawdownPct (FIXED at 25, cannot be changed) — circuit breaker threshold
- maxDailyLossPct (0.5-20, default 2.0) — daily loss cap
- maxConsecutiveLosses (1-20, default 2)
- postLossCooldownBars (0-20, default 2)
- reduceSizeAfterLoss (true/false, default true)
- reducedRiskPerTradePct (0.1-10, default 0.50)
- atrRiskScaleEnabled (true/false, default true)
- atrRiskScaleThreshold (1.01-5, default 1.25)
- atrRiskScaleFactor (0.1-1, default 0.65)
- secondTradeRiskFactor (0.1-1, default 0.75)

Strategy rules:
- Only change 1-3 parameters at a time for controlled experimentation
- If a change hurt performance in a previous iteration, don't repeat it
- Higher leverage multiplies both return and drawdown proportionally
- The return/DD ratio is the primary optimization target
- If drawdown exceeds the target max DD, prioritize reducing it
- Track which direction of parameter changes helped vs hurt

OPTIMIZATION JOURNAL:
You may receive a persistent optimization journal showing past experiments and their outcomes.
- NEVER repeat parameter changes that WORSENED results in the journal
- BUILD on changes that IMPROVED results — push further in the same direction
- If the journal shows that lowering a parameter helped, try lowering it more
- Reference specific journal entries when making decisions

Respond with valid JSON:
{
  "changes": ["description of each change and why"],
  "config": { ...only the parameters you want to change, not the full config... },
  "reasoning": "brief explanation of strategy for this iteration",
  "stop": false
}

Set "stop": true if you believe no further meaningful improvements are possible.`;

async function buildHistoricalContext(): Promise<string> {
  const parts: string[] = [];

  try {
    const allResults = await storage.listBacktestResults();
    const withTrades = allResults.filter(r => r.stats.totalTrades >= 3);
    if (withTrades.length > 0) {
      const byReturn = [...withTrades].sort((a, b) => b.stats.returnPct - a.stats.returnPct);
      const top5 = byReturn.slice(0, 5);
      parts.push("## HISTORICAL BEST RUNS (learn from these — build on what worked):");
      for (const r of top5) {
        const rdr = r.stats.maxDrawdownPct > 0 ? (r.stats.returnPct / r.stats.maxDrawdownPct).toFixed(2) : "N/A";
        parts.push(`  ${r.stats.totalTrades}t, ${r.stats.winRate}%WR, ${r.stats.returnPct}%ret, ${r.stats.maxDrawdownPct}%DD, R/DD=${rdr} | RR=${r.config.rewardRatio}, risk=${r.config.riskPerTradePct}%, lev=${r.config.leverage}x, expansion=${r.config.expansionThreshold}, session=${r.config.sessionMode}`);
      }
      const worst3 = byReturn.slice(-3).reverse();
      parts.push("\n## WORST RUNS (avoid these parameter combinations):");
      for (const r of worst3) {
        parts.push(`  ${r.stats.totalTrades}t, ${r.stats.returnPct}%ret, ${r.stats.maxDrawdownPct}%DD | RR=${r.config.rewardRatio}, risk=${r.config.riskPerTradePct}%, expansion=${r.config.expansionThreshold}`);
      }
    }
  } catch (e) {
    console.log("[AutoTuner] Could not load historical results:", e);
  }

  try {
    const journal = await storage.listJournalEntries(20);
    if (journal.length > 0) {
      parts.push("\n## OPTIMIZATION JOURNAL (persistent memory of past experiments):");
      parts.push("CRITICAL: NEVER repeat changes that WORSENED results. BUILD on changes that IMPROVED results.");
      for (const e of journal.reverse()) {
        const paramStr = e.suggestions.map(s => `${s.parameter}: ${s.fromValue}→${s.toValue}`).join(', ');
        let line = `  [${e.outcome?.toUpperCase() ?? 'UNKNOWN'}] ${paramStr}`;
        if (e.beforeStats && e.afterStats) {
          line += ` | ret: ${e.beforeStats.returnPct}%→${e.afterStats.returnPct}%, DD: ${e.beforeStats.maxDrawdownPct}%→${e.afterStats.maxDrawdownPct}%`;
        }
        if (e.learnings) {
          const truncated = e.learnings.length > 150 ? e.learnings.substring(0, 150) + '...' : e.learnings;
          line += ` | ${truncated}`;
        }
        parts.push(line);
      }
    }
  } catch (e) {
    console.log("[AutoTuner] Could not load journal:", e);
  }

  return parts.length > 0 ? parts.join("\n") : "";
}

async function buildIterationPrompt(
  iterations: AutoTuneIteration[],
  currentConfig: BacktestConfig,
  targetReturnPct: number,
  maxAllowedDD: number
): Promise<string> {
  const parts: string[] = [];

  const historical = await buildHistoricalContext();
  if (historical) {
    parts.push(historical);
    parts.push("");
  }

  parts.push(`Target: ${targetReturnPct}% return with max ${maxAllowedDD}% drawdown.`);
  parts.push(`Current iteration: ${iterations.length + 1}`);
  parts.push("");

  if (iterations.length === 0) {
    parts.push("This is the first iteration. The baseline config is:");
    parts.push(JSON.stringify(currentConfig, null, 2));
    parts.push("");
    parts.push("Analyze the historical context above (best/worst runs, journal entries) and this baseline. Suggest your first optimization based on what previously worked. Start with the most impactful parameters.");
  } else {
    parts.push("## Iteration History (oldest first):");
    for (const iter of iterations) {
      parts.push(`\nIteration ${iter.iteration}:`);
      parts.push(`  Changes: ${iter.changes.join(", ")}`);
      parts.push(`  Results: ${iter.stats.totalTrades} trades, ${iter.stats.winRate}% WR, PF ${iter.stats.profitFactor}, Return ${iter.stats.returnPct}%, MaxDD ${iter.stats.maxDrawdownPct}%, Return/DD ${iter.stats.returnDDRatio}`);
    }
    parts.push(`\nCurrent config for next iteration:`);
    parts.push(JSON.stringify(currentConfig, null, 2));

    const best = iterations.reduce((a, b) => a.stats.returnDDRatio > b.stats.returnDDRatio ? a : b);
    parts.push(`\nBest so far: Iteration ${best.iteration} with Return/DD ${best.stats.returnDDRatio}`);

    if (iterations.length >= 2) {
      const last = iterations[iterations.length - 1];
      const prev = iterations[iterations.length - 2];
      if (last.stats.returnDDRatio < prev.stats.returnDDRatio) {
        parts.push(`\nWARNING: Last change HURT performance (${prev.stats.returnDDRatio} → ${last.stats.returnDDRatio}). Consider reverting those changes.`);
      }
    }
  }

  return parts.join("\n");
}

export async function runAutoTune(
  baseConfig: BacktestConfig,
  data: { h1: Candle[]; h4: Candle[]; daily: Candle[]; events?: { timestamp: string }[] },
  maxIterations: number = 10,
  targetReturnPct: number = 100,
  maxAllowedDD: number = 25
): Promise<AutoTuneResult> {
  const iterations: AutoTuneIteration[] = [];
  let currentConfig = { ...baseConfig };
  let bestReturnDDRatio = 0;
  let bestIteration = 0;
  let bestConfig = { ...baseConfig };

  activeProgress = {
    running: true,
    currentIteration: 0,
    maxIterations,
    iterations: [],
    status: "Starting baseline run...",
  };

  try {
    const baselineResult = runBacktest(currentConfig, data);
    await storage.saveBacktestResult(baselineResult);

    const baselineRDR = baselineResult.stats.maxDrawdownPct > 0
      ? parseFloat((baselineResult.stats.returnPct / baselineResult.stats.maxDrawdownPct).toFixed(2))
      : (baselineResult.stats.returnPct > 0 ? 999 : 0);

    const baselineIter: AutoTuneIteration = {
      iteration: 0,
      config: { ...currentConfig },
      stats: {
        totalTrades: baselineResult.stats.totalTrades,
        winRate: baselineResult.stats.winRate,
        returnPct: baselineResult.stats.returnPct,
        maxDrawdownPct: baselineResult.stats.maxDrawdownPct,
        profitFactor: baselineResult.stats.profitFactor,
        returnDDRatio: baselineRDR,
      },
      changes: ["Baseline run — no changes"],
      backtestId: baselineResult.id,
    };
    iterations.push(baselineIter);
    bestReturnDDRatio = baselineRDR;
    bestConfig = { ...currentConfig };

    activeProgress.iterations = [...iterations];
    activeProgress.currentIteration = 0;

    for (let i = 1; i <= maxIterations; i++) {
      activeProgress.status = `Iteration ${i}/${maxIterations}: AI analyzing...`;
      activeProgress.currentIteration = i;

      const userPrompt = await buildIterationPrompt(iterations, currentConfig, targetReturnPct, maxAllowedDD);

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: TUNER_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 2000,
        response_format: { type: "json_object" },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        activeProgress.status = `Iteration ${i}: AI returned empty response, stopping.`;
        break;
      }

      let aiSuggestion: any;
      try {
        aiSuggestion = JSON.parse(content);
        const { sanitizeAnalysisStrings } = await import("./ai-advisor");
        sanitizeAnalysisStrings(aiSuggestion);
      } catch {
        activeProgress.status = `Iteration ${i}: Failed to parse AI response, stopping.`;
        break;
      }

      if (aiSuggestion.stop === true) {
        activeProgress.status = "AI determined no further improvements possible.";
        activeProgress.running = false;
        activeProgress.iterations = [...iterations];
        return {
          iterations,
          bestIteration,
          bestReturnDDRatio,
          bestConfig,
          status: "no_improvement",
          message: aiSuggestion.reasoning || "AI stopped — no further improvements found.",
        };
      }

      const changes = aiSuggestion.changes || [];
      const configPatch = aiSuggestion.config || {};

      for (const [key, value] of Object.entries(configPatch)) {
        if (key in currentConfig) {
          (currentConfig as any)[key] = value;
        }
      }

      const parseResult = backtestConfigSchema.safeParse(currentConfig);
      if (!parseResult.success) {
        activeProgress.status = `Iteration ${i}: AI suggested invalid config, reverting.`;
        currentConfig = { ...bestConfig };
        continue;
      }
      currentConfig = parseResult.data;
      currentConfig.leverage = Math.min(currentConfig.leverage, 10);
      currentConfig.maxDrawdownPct = Math.min(currentConfig.maxDrawdownPct, 25);

      activeProgress.status = `Iteration ${i}/${maxIterations}: Running backtest...`;

      const result = runBacktest(currentConfig, data);
      await storage.saveBacktestResult(result);

      const rdr = result.stats.maxDrawdownPct > 0
        ? parseFloat((result.stats.returnPct / result.stats.maxDrawdownPct).toFixed(2))
        : (result.stats.returnPct > 0 ? 999 : 0);

      const iter: AutoTuneIteration = {
        iteration: i,
        config: { ...currentConfig },
        stats: {
          totalTrades: result.stats.totalTrades,
          winRate: result.stats.winRate,
          returnPct: result.stats.returnPct,
          maxDrawdownPct: result.stats.maxDrawdownPct,
          profitFactor: result.stats.profitFactor,
          returnDDRatio: rdr,
        },
        changes,
        backtestId: result.id,
      };
      iterations.push(iter);
      activeProgress.iterations = [...iterations];

      if (iterations.length >= 2) {
        const prev = iterations[iterations.length - 2];
        const curr = iter;
        const changedParams: JournalEntry["suggestions"] = [];
        for (const [key, value] of Object.entries(configPatch)) {
          changedParams.push({
            parameter: key,
            fromValue: (prev.config as any)[key] ?? "unknown",
            toValue: value as any,
            rationale: `Auto-tuner iteration ${i}`,
          });
        }
        if (changedParams.length > 0) {
          try {
            const jid = crypto.randomBytes(4).toString("hex");
            const beforeStats = { returnPct: prev.stats.returnPct, maxDrawdownPct: prev.stats.maxDrawdownPct, winRate: prev.stats.winRate, totalTrades: prev.stats.totalTrades, profitFactor: prev.stats.profitFactor };
            const afterStats = { returnPct: curr.stats.returnPct, maxDrawdownPct: curr.stats.maxDrawdownPct, winRate: curr.stats.winRate, totalTrades: curr.stats.totalTrades, profitFactor: curr.stats.profitFactor };
            const retBetter = afterStats.returnPct > beforeStats.returnPct;
            const ddBetter = afterStats.maxDrawdownPct <= beforeStats.maxDrawdownPct;
            const outcome: "improved" | "worsened" | "mixed" = retBetter && ddBetter ? "improved" : !retBetter && !ddBetter ? "worsened" : "mixed";
            const paramChanges = changedParams.map(s => `${s.parameter}: ${s.fromValue}→${s.toValue}`).join(', ');
            const learnings = `[AutoTuner] Changed: ${paramChanges} | Return: ${beforeStats.returnPct}%→${afterStats.returnPct}% | DD: ${beforeStats.maxDrawdownPct}%→${afterStats.maxDrawdownPct}% | ${outcome.toUpperCase()}`;
            await storage.saveJournalEntry({
              id: jid,
              createdAt: new Date().toISOString(),
              source: "chat",
              suggestions: changedParams,
              beforeBacktestId: prev.backtestId,
              beforeStats,
              afterBacktestId: curr.backtestId,
              afterStats,
              outcome,
              learnings,
            });
          } catch (journalErr) {
            console.error("[AutoTuner] Failed to record journal:", journalErr);
          }
        }
      }

      if (rdr > bestReturnDDRatio) {
        bestReturnDDRatio = rdr;
        bestIteration = i;
        bestConfig = { ...currentConfig };
      }

      if (result.stats.returnPct >= targetReturnPct && result.stats.maxDrawdownPct <= maxAllowedDD) {
        activeProgress.status = `Target reached at iteration ${i}!`;
        activeProgress.running = false;
        return {
          iterations,
          bestIteration: i,
          bestReturnDDRatio: rdr,
          bestConfig: { ...currentConfig },
          status: "target_reached",
          message: `Target of ${targetReturnPct}% return with ≤${maxAllowedDD}% DD achieved at iteration ${i}.`,
        };
      }
    }

    activeProgress.status = "All iterations completed.";
    activeProgress.running = false;
    activeProgress.iterations = [...iterations];

    return {
      iterations,
      bestIteration,
      bestReturnDDRatio,
      bestConfig,
      status: "completed",
      message: `Completed ${maxIterations} iterations. Best: iteration ${bestIteration} with Return/DD ratio ${bestReturnDDRatio}.`,
    };
  } catch (err: any) {
    activeProgress.status = `Error: ${err.message}`;
    activeProgress.running = false;
    return {
      iterations,
      bestIteration,
      bestReturnDDRatio,
      bestConfig,
      status: "error",
      message: err.message,
    };
  }
}
