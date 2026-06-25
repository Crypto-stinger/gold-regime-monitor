import { openai as replit_openai } from "./replit_integrations/audio/client";
import { storage } from "./storage";
import { getCachedData, getDataFreshness, getLatestGVZ, getGVZPercentileForValue, getLatestCOT, getLatestSGE } from "./data-fetcher";
import { getHMMState, getLastHMMClassification } from "./hmm-engine";
import { getLastMRSGARCHState, isMRSGARCHTrained } from "./mrs-garch";
import { getLockedParams } from "./locked-params";
import { calcATR, calcBBWidth, calcVolumeProfile } from "./regime-engine";
import { getWatchdogStatus } from "./system-watchdog";
import type { LiveTrader } from "./live-trader";

const openai = replit_openai;
const AI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

let monitorInterval: NodeJS.Timeout | null = null;
let startupTimeout: NodeJS.Timeout | null = null;
let activeLiveTrader: LiveTrader | null = null;
let lastReviewHour = -1;

export function setMonitorTrader(trader: LiveTrader) {
  activeLiveTrader = trader;
}

export function startAIMonitor(trader: LiveTrader) {
  activeLiveTrader = trader;
  if (monitorInterval) clearInterval(monitorInterval);

  monitorInterval = setInterval(() => {
    runMonitorCycle().catch(err => console.error("[AI Monitor] cycle error:", err.message));
  }, 5 * 60 * 1000);

  if (startupTimeout) clearTimeout(startupTimeout);
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    runInitialReview().catch(err => console.error("[AI Monitor] initial review error:", err.message));
  }, 30000);

  console.log("[AI Monitor] Started — reviewing market every 5 minutes, deep analysis every hour");
}

async function runInitialReview() {
  if (!activeLiveTrader || !activeLiveTrader.isRunning) return;
  console.log("[AI Monitor] Running startup review");
  lastReviewHour = new Date().getUTCHours();
  await runHourlyReview();
}

export function stopAIMonitor() {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  console.log("[AI Monitor] Stopped");
}

async function runMonitorCycle() {
  if (!activeLiveTrader || !activeLiveTrader.isRunning) return;

  const now = new Date();
  const utcDay = now.getUTCDay();
  const utcHour = now.getUTCHours();

  const isMarketHours = utcDay >= 1 && utcDay <= 5 && utcHour >= 6 && utcHour <= 22;

  if (utcHour !== lastReviewHour) {
    lastReviewHour = utcHour;
    if (isMarketHours) {
      await runHourlyReview();
    } else if (utcHour % 4 === 0) {
      await runHourlyReview();
    }
  }
}

async function runHourlyReview() {
  try {
    const state = activeLiveTrader!.getState();
    const analysis = activeLiveTrader!.getAnalysis();
    const decisions = await storage.getRecentTradeDecisions(20);
    const observations = await storage.getRecentObservations(12);
    const learnings = await storage.getLearnings(undefined, 0.3);
    const decisionStats = await storage.getTradeDecisionStats();
    const cached = getCachedData();
    const params = await getLockedParams();

    const events = (cached as any)?.events || [];
    const upcomingEvents = events
      .filter((e: any) => new Date(e.timestamp || e.date).getTime() > Date.now())
      .slice(0, 5);

    const recentDecisionSummary = decisions.slice(0, 10).map((d: any) => {
      return `${new Date(d.timestamp).toISOString().substring(11, 16)} UTC | ${d.decision.toUpperCase()} | ${d.block_reason || d.side || '-'} | price=$${Number(d.price).toFixed(2)} | regime=${d.regime}`;
    }).join('\n');

    const observationSummary = observations.slice(0, 6).map((o: any) => {
      return `${new Date(o.timestamp).toISOString().substring(11, 16)} UTC | $${Number(o.price).toFixed(2)} | spread=$${Number(o.spread || 0).toFixed(2)} | ATR_H1=$${Number(o.atr_h1 || 0).toFixed(2)} | regime=${o.regime}`;
    }).join('\n');

    const learningSummary = learnings.slice(0, 20).map((l: any) => {
      return `[${l.category}] (conf=${Number(l.confidence).toFixed(1)}, seen=${l.times_reinforced}x): ${l.insight}`;
    }).join('\n');

    const watchdog = getWatchdogStatus();
    const recentWatchdogErrors = watchdog.recentEvents
      .filter((e: any) => e.severity === "error" && (Date.now() - new Date(e.timestamp).getTime()) < 60 * 60 * 1000)
      .map((e: any) => `${new Date(e.timestamp).toISOString().substring(11, 16)} UTC | [${e.source}] ${e.message}`)
      .join('\n');
    const healthSummary = watchdog.checks
      .filter((c: any) => c.status !== "ok")
      .map((c: any) => `[${c.status.toUpperCase()}] ${c.name}: ${c.message}`)
      .join('\n');

    const prompt = `You are the AI brain of a XAUUSD algorithmic trading system running on a live demo account (treated as real money). Your role is to continuously learn from real market behavior and improve over time.

## SYSTEM HEALTH
${healthSummary || 'All systems healthy'}

## RECENT SYSTEM ERRORS (last hour)
${recentWatchdogErrors || 'No errors'}

## MARKET HOURS
XAUUSD market: Sunday 22:00 UTC – Friday 22:00 UTC. Closed all Saturday and Sunday until 22:00.
Current time: ${new Date().toUTCString()}
Market status: ${(() => { const d = new Date(); const day = d.getUTCDay(); const h = d.getUTCHours(); if (day === 6) return 'CLOSED (Saturday)'; if (day === 0 && h < 22) return 'CLOSED (Sunday pre-open)'; if (day === 5 && h >= 22) return 'CLOSED (Friday post-close)'; return 'OPEN'; })()}

## CURRENT STATE
- Price: $${state.currentPrice.toFixed(2)}
- Regime: ${state.regime}
- GVZ (Gold Volatility Index): ${(() => { const g = getLatestGVZ(); return g ? `${Number(g.value).toFixed(1)} (P${getGVZPercentileForValue(Number(g.value))}, date=${g.date})` : 'N/A'; })()}
- COT (Commitment of Traders): ${(() => { const c = getLatestCOT(); return c ? `Net ${c.netPosition.toLocaleString()} (P${c.percentile}, ${c.sentiment}, date=${c.date})` : 'N/A'; })()}
- SGE Premium: ${(() => { const s = getLatestSGE(); return s ? `$${s.premium.toFixed(2)}/oz (date=${s.date}) — ${s.premium > 10 ? 'BULLISH (strong Chinese demand)' : s.premium < -5 ? 'BEARISH (discount)' : 'NEUTRAL'}` : 'N/A'; })()}
- HMM (Hidden Markov Model): ${(() => { const h = getHMMState(); const cls = getLastHMMClassification(); if (!h || !h.trained) return 'Not trained yet'; const meta = `Trained on ${h.nSamples} samples`; if (!cls) return `${meta} — no recent classification`; const label = cls.state === 'low_vol' ? 'LOW VOL (range-confirming)' : cls.state === 'high_vol' ? 'HIGH VOL (trend-confirming)' : 'MEDIUM VOL (transitional)'; return `${meta} | Current: ${label} @ ${(cls.confidence * 100).toFixed(1)}% confidence | Probs: low=${(cls.probabilities.low_vol * 100).toFixed(0)}% med=${(cls.probabilities.medium_vol * 100).toFixed(0)}% high=${(cls.probabilities.high_vol * 100).toFixed(0)}%`; })()}
- MRS-GARCH: ${(() => { if (!isMRSGARCHTrained()) return 'Not trained yet (requires 100+ bars + HMM)'; const g = getLastMRSGARCHState(); if (!g) return 'Trained but no recent state'; return `Vol=${g.annualizedVol.toFixed(1)}% | Forecast=${g.volForecast.toFixed(6)} | P${g.volPercentile.toFixed(0)} | Stability=${(g.regimeStability * 100).toFixed(0)}% | Size=${g.positionSizeMultiplier.toFixed(2)}x — ${g.volPercentile > 80 ? 'HIGH VOL: reduce size' : g.volPercentile < 20 ? 'LOW VOL: increase size' : 'NORMAL'}`; })()}
- Volume Profile: ${(() => { if (params.volumeProfileEnabled === false) return 'DISABLED'; const h4 = getCachedData().h4; if (h4.length < 5) return 'Insufficient data'; const vpP = params.volumeProfilePeriod ?? 50; const vpB = params.volumeProfileBins ?? 24; const vpVA = params.volumeProfileValueAreaPct ?? 70; const end = Math.max(0, h4.length - 1); const start = Math.max(0, end - vpP + 1); const vp = calcVolumeProfile(h4.slice(start, end + 1), vpB, vpVA); if (vp.poc <= 0) return 'Insufficient data'; const p = state.currentPrice; const dist = Math.abs(p - vp.poc); const vaRange = vp.vah - vp.val; const proxRatio = vaRange > 0 ? dist / vaRange : 1; const nearPoc = proxRatio < (params.vpPocProximityPct ?? 0.15); const inside = p >= vp.val && p <= vp.vah; return `POC=$${vp.poc.toFixed(2)} VAH=$${vp.vah.toFixed(2)} VAL=$${vp.val.toFixed(2)} | Price ${inside ? 'INSIDE' : p > vp.vah ? 'ABOVE' : 'BELOW'} value area | ${nearPoc ? '⚠️ NEAR POC (congestion)' : '✅ Clear of POC'}`; })()}
- Positions: ${state.positions.length} open
- Today's P&L: $${state.dailyPnl.toFixed(2)}
- Total P&L: $${state.totalPnl.toFixed(2)}
- Trades today: ${state.tradestoday}/${params.maxTradesPerDay}
- Consecutive losses: ${state.consecutiveLosses}/${params.maxConsecutiveLosses}
- Balance: $${(state.params.startingBalance + state.totalPnl).toFixed(2)}

## RECENT DECISIONS (last 10)
${recentDecisionSummary || 'No decisions recorded yet'}

## RECENT MARKET OBSERVATIONS (hourly snapshots)
${observationSummary || 'No observations yet'}

## LIFETIME STATS
- Total decisions: ${decisionStats.total} (${decisionStats.entries} entries, ${decisionStats.skips} skips)
- Outcomes: ${decisionStats.wins} wins, ${decisionStats.losses} losses
- Total realized P&L: $${Number(decisionStats.total_pnl || 0).toFixed(2)}

## YOUR ACCUMULATED LEARNINGS
${learningSummary || 'No learnings yet — this is a fresh start. Begin building knowledge.'}

## UPCOMING EVENTS
${upcomingEvents.map((e: any) => `${e.timestamp || e.date} | ${e.title || e.event}`).join('\n') || 'None upcoming'}

## LOCKED PARAMETERS
ATR Stop: ${params.atrStopMultiplier}x | RR: ${params.rewardRatio}:1 | Risk: ${params.riskPerTradePct}%
Session: ${params.sessionMode} | Compression: ${params.compressionThreshold} | Expansion: ${params.expansionThreshold}
GVZ Filter: ${params.gvzEnabled !== false ? 'ENABLED' : 'DISABLED'} | Range threshold: P${params.gvzRangeThreshold ?? 25} | Trend threshold: P${params.gvzTrendThreshold ?? 75}
COT Filter: ${params.cotEnabled !== false ? 'ENABLED' : 'DISABLED'} | Bullish threshold: P${params.cotBullishThreshold ?? 75} | Bearish threshold: P${params.cotBearishThreshold ?? 25}
Avoid Hours: ${params.avoidHoursEnabled !== false ? 'ENABLED' : 'DISABLED'} | Hours (UTC): ${(params.avoidHoursUTC || [21,22,23,0]).join(',')}
Peak Hours: ${params.peakHoursEnabled ? 'ENABLED' : 'DISABLED'}${params.peakHoursEnabled && params.peakHoursUTC?.length ? ' | Hours (UTC): ' + params.peakHoursUTC.join(',') : ''}
Volume Profile: ${params.volumeProfileEnabled !== false ? 'ENABLED' : 'DISABLED'} | Period: ${params.volumeProfilePeriod ?? 50} H4 bars | Bins: ${params.volumeProfileBins ?? 24} | Value Area: ${params.volumeProfileValueAreaPct ?? 70}% | POC Proximity: ${((params.vpPocProximityPct ?? 0.15) * 100).toFixed(0)}%
SGE Premium: ${params.sgeEnabled !== false ? 'ENABLED' : 'DISABLED'} | Bullish threshold: $${params.sgeBullishThreshold ?? 10}/oz | Bearish threshold: $${params.sgeBearishThreshold ?? -5}/oz
HMM: ${params.hmmEnabled !== false ? 'ENABLED' : 'DISABLED'} | Confidence threshold: ${((params.hmmConfidenceThreshold ?? 0.6) * 100).toFixed(0)}%

## HMM (HIDDEN MARKOV MODEL) INTERPRETATION GUIDE
The HMM is a probabilistic regime detection model that learns 3 hidden market volatility states from observable features (ATR ratio, BB width percentile, ADX, log returns):
- LOW_VOL state: Low ATR, low BB width, low ADX — classic range/consolidation environment. CONFIRMS range regime, BLOCKS trend trades.
- MEDIUM_VOL state: Moderate readings across features — transitional state. Neither confirms nor blocks either regime.
- HIGH_VOL state: High ATR, expanding BB width, high ADX — breakout/trending environment. CONFIRMS trend regime, BLOCKS range trades.
- The HMM is trained via Baum-Welch on historical enriched candle data and uses learned emission distributions + transition probabilities.
- Confidence threshold (default 60%): Only applies regime filter when HMM confidence exceeds this threshold.
- HMM DISAGREEMENT with technical regime = trade blocked (no_trade). This is a probabilistic safety layer on top of the rule-based regime detection.

## GVZ INTERPRETATION GUIDE
The GVZ (Gold Volatility Index) is the CBOE's implied volatility index for gold options — it measures how much the market EXPECTS gold to move.
- GVZ Percentile is a 252-day (1 trading year) rolling rank of the current GVZ value vs history.
- P<25 = LOW implied volatility → market expects calm, mean-reverting price action → CONFIRMS RANGE regime. Best for range-bound entries at support/resistance.
- P>75 = HIGH implied volatility → market expects large moves → CONFIRMS TREND regime. Best for breakout/momentum entries.
- P25-P75 = NEUTRAL — GVZ neither confirms nor denies the technical regime signal. The system relies purely on BB width, ADX, and ATR.
- DISAGREEMENT: When technical indicators say "range" but GVZ says "high vol" (or vice versa), the system blocks trades (no_trade). This is a SAFETY feature — learn when these disagreements happen and what follows.
- Track whether GVZ-filtered trades have better outcomes than non-filtered ones. Note when GVZ transitions predict regime changes.

## COT (COMMITMENT OF TRADERS) INTERPRETATION GUIDE
COT data from CFTC shows speculative (non-commercial) positioning in Gold futures — it reveals what "smart money" is doing.
- Net Position = Non-Commercial Long - Non-Commercial Short contracts. Positive = speculators are net long (bullish).
- Percentile is a 156-week (3-year) rolling rank of current net position vs history.
- P>75 = EXTREMELY BULLISH positioning → speculators heavily long → confirms upside trend breakouts, blocks short breakouts (don't fight the crowd).
- P<25 = EXTREMELY BEARISH positioning → speculators heavily short or reduced longs → confirms downside trend, blocks long breakouts.
- P25-P75 = NEUTRAL positioning — COT doesn't override technical signals.
- COT is WEEKLY data (released Fridays) — it changes slowly. Use it as a medium-term directional bias, not for intraday timing.
- Rising net position + rising price = healthy trend. Rising net position + falling price = divergence (potential reversal).
- Track whether COT-aligned trades outperform COT-neutral ones. Note when extreme positioning precedes reversals.

## VOLUME PROFILE INTERPRETATION GUIDE
Volume Profile distributes traded volume across price levels from H4 candles to identify key structural zones:
- POC (Point of Control): The price with the highest traded volume — acts as a price magnet. Price tends to gravitate back toward POC.
- VAH (Value Area High): Upper boundary of the value area (where 70% of volume occurred) — acts as resistance.
- VAL (Value Area Low): Lower boundary of the value area — acts as support.
- RANGE TRADES: If price is near POC (within ${((params.vpPocProximityPct ?? 0.15) * 100).toFixed(0)}% of VA range), entries are BLOCKED — price chops in congestion zones around POC.
- TREND TRADES: Breakouts are blocked if price hasn't cleared the value area (buy blocked if price < VAH, sell blocked if price > VAL) — true breakouts need to escape the high-volume zone.
- Low Volume Nodes (LVN): Price zones between POC and VA edges with minimal volume — these are "air pockets" where price moves quickly through. Ideal breakout confirmation zones.
- Track whether VP-filtered trades (clear of POC) outperform entries near POC. Note how POC/VAH/VAL act as support/resistance levels.

## SGE (SHANGHAI GOLD EXCHANGE) PREMIUM INTERPRETATION GUIDE
The SGE premium is the price difference between Shanghai gold and international spot gold in USD/oz — it measures Chinese physical demand pressure:
- Premium > $10/oz = BULLISH — strong Chinese physical buying demand. Supports long positions, blocks trend short breakouts (don't sell against Chinese buying).
- Premium > $20/oz = VERY BULLISH — exceptional demand, often during Chinese holidays or geopolitical uncertainty. Strong tailwind for longs.
- Premium $0-10 = NEUTRAL — normal import economics, no strong directional bias.
- Premium < -$5/oz = BEARISH/CAUTIONARY — SGE discount signals weak Chinese demand or capital outflows. Caution on longs, blocks trend long breakouts.
- SGE premium is a DAILY filter — it changes slowly. Use it as a medium-term demand bias, not for intraday timing.
- Track whether SGE-aligned trades (going long with high premium) outperform neutral trades. Note when premium shifts precede price moves.

## YOUR TASK
Analyze the current state and produce ACTIONABLE learnings — not vague observations. Focus on TRADE OUTCOMES and WHAT WENT WRONG/RIGHT.

BEFORE generating learnings, review what you already know (YOUR ACCUMULATED LEARNINGS above). Do NOT repeat the same observation you've already made. Only generate a learning if it is GENUINELY NEW information, contradicts a prior learning, or adds a concrete metric/number not previously captured.

Respond with a JSON object:
{
  "marketAssessment": "Brief current market read — include specific price levels, ATR value, and regime rationale (2-3 sentences)",
  "learnings": [
    {
      "category": "one of: regime_behavior, entry_timing, risk_management, market_structure, spread_patterns, news_impact, session_patterns, price_action, gvz_volatility, cot_positioning, system_issues",
      "insight": "MUST follow this format: [WHAT HAPPENED] → [WHY IT MATTERS] → [WHAT TO DO]. Example: 'Stop-loss at 2x ATR ($36) was hit 3 times this week during London session fakeouts → ATR may be too tight for current vol regime → Consider 2.5x ATR during GVZ>P70 periods'. Must reference specific numbers, prices, or timeframes from the data above.",
      "confidence": 0.3-0.9,
      "supersedes": "If this learning updates/replaces a prior learning, briefly describe which one. Otherwise null."
    }
  ],
  "concerns": ["Any immediate risk concerns — be specific about what could go wrong and at what price levels"],
  "systemHealthNotes": "If you see system errors above, diagnose them specifically. Otherwise null.",
  "suggestion": "One specific, implementable action with exact parameters. Example: 'Increase atrStopMultiplier from 2.0 to 2.5 during high-GVZ (>P70) sessions to reduce fakeout stops'. Or null if nothing actionable."
}

RULES:
- NEVER repeat an observation you've already made. Check YOUR ACCUMULATED LEARNINGS first.
- Only generate learnings from REAL data visible above — specific prices, times, trade results.
- Every learning MUST include at least one concrete number (price, percentage, time, count).
- If the last 10 decisions are all skips with no entries, analyze WHY the bot isn't trading and whether filters are too restrictive.
- If trades are being rejected (system errors), that IS a learning — categorize as system_issues.
- Max 2 learnings per cycle. ZERO if nothing new happened since last review.
- If market is closed or quiet with no new data, return empty learnings array.
- Focus on trade outcomes: wins, losses, rejected orders, missed entries. Not price descriptions.`;

    const response = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 1000,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return;

    const result = JSON.parse(content);
    const { sanitizeAnalysisStrings } = await import("./ai-advisor");
    sanitizeAnalysisStrings(result);

    if (result.learnings && Array.isArray(result.learnings)) {
      for (const learning of result.learnings) {
        if (learning.insight && learning.category) {
          await storage.saveLearning(
            learning.category,
            learning.insight,
            learning.confidence || 0.5,
            { source: "hourly_review", timestamp: new Date().toISOString() }
          );
        }
      }
      if (result.learnings.length > 0) {
        console.log(`[AI Monitor] Recorded ${result.learnings.length} learning(s): ${result.learnings.map((l: any) => l.category).join(', ')}`);
      }
    }

    if (result.marketAssessment) {
      console.log(`[AI Monitor] Assessment: ${result.marketAssessment}`);
    }

    if (result.concerns && result.concerns.length > 0) {
      console.log(`[AI Monitor] Concerns: ${result.concerns.join('; ')}`);
    }

    if (result.systemHealthNotes && result.systemHealthNotes !== "null") {
      console.log(`[AI Monitor] System Health: ${result.systemHealthNotes}`);
    }

    if (result.suggestion && result.suggestion !== "null" && result.suggestion.trim()) {
      console.log(`[AI Monitor] Suggestion: ${result.suggestion}`);
      await storage.saveLearning(
        "ai_suggestion",
        result.suggestion,
        0.6,
        { source: "hourly_review_suggestion", timestamp: new Date().toISOString() }
      );
    }

  } catch (err: any) {
    console.error("[AI Monitor] Review error:", err.message);
  }
}

export async function getAIMonitorStatus() {
  const learnings = await storage.getLearnings(undefined, 0);
  const decisionStats = await storage.getTradeDecisionStats();
  const obsCount = await storage.getObservationCount();

  const byCategory: Record<string, number> = {};
  for (const l of learnings) {
    byCategory[l.category] = (byCategory[l.category] || 0) + 1;
  }

  return {
    active: monitorInterval !== null,
    totalLearnings: learnings.length,
    learningsByCategory: byCategory,
    totalObservations: obsCount,
    decisionStats,
    topLearnings: learnings
      .sort((a: any, b: any) => (b.confidence * b.times_reinforced) - (a.confidence * a.times_reinforced))
      .slice(0, 10)
      .map((l: any) => ({
        category: l.category,
        insight: l.insight,
        confidence: Number(l.confidence),
        timesReinforced: l.times_reinforced,
      })),
  };
}

export async function getAILearningsSummary(): Promise<string> {
  const learnings = await storage.getLearnings(undefined, 0.3);
  if (learnings.length === 0) return "";

  const lines = learnings.map((l: any) => {
    return `[${l.category}] (confidence=${Number(l.confidence).toFixed(1)}, reinforced=${l.times_reinforced}x): ${l.insight}`;
  });

  return `\n## AI ACCUMULATED LEARNINGS (${learnings.length} insights from live observation)\n${lines.join('\n')}`;
}
