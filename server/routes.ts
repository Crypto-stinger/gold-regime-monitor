import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage, pool } from "./storage";
import { runBacktest } from "./backtest";
import { openai as replit_openai } from "./replit_integrations/audio/client";
const openai = replit_openai;
const AI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
import { runRSIBacktest } from "./rsi-backtest";
import { backtestConfigSchema } from "../shared/schema";
import { fetchXAUUSD, fetchLowerTimeframes, fetchAllTimeframes, fetchEconomicEvents, fetchAsianMarkets, getCachedData, getDataStatus, hasApiKeys, loadCachedDataFromDB, getDbPriceStatus, ensureDataReady, getLatestGVZ, getGVZPercentileForValue, fetchGVZData, getLatestCOT, fetchCOTData, getLatestSGE, fetchSGEData, getSGEData } from "./data-fetcher";
import { getHMMState, isHMMTrained, getLastHMMClassification } from "./hmm-engine";
import { getLastMRSGARCHState, getMRSGARCHModel, isMRSGARCHTrained } from "./mrs-garch";
import { getAdvisorAnalysis, analyzeRequestSchema, chatRequestSchema, checkRateLimit, getChatResponse, getChatHistory, clearChatHistory, getMarketSnapshot, recordChatBacktestResult, getDailyAnalysis } from "./ai-advisor";
import { runAutoTune, getAutoTuneProgress } from "./auto-tuner";
import { generateCTraderBot, generateStrategyJSON, lockCriticalParameters } from "./ctrader-export";
import { generateStrategyPDF } from "./pdf-export";
import { validateStrategy, getRiskRating } from "./risk-validator";
import { compileCTraderBot, isCompilerAvailable } from "./ctrader-compiler";
import { CTraderAPI, type CTraderConfig } from "./ctrader-api";
import { LiveTrader, registerLiveTrader } from "./live-trader";
import { getLockedParams, updateLockedParams, invalidateLockedParamsCache } from "./locked-params";
import { getWatchdogStatus } from "./system-watchdog";

let activeCTraderAPI: CTraderAPI | null = null;
let activeLiveTrader: LiveTrader | null = null;
let connectionInProgress = false;
let lastConnectionAttempt = 0;
let rateLimitCooldownUntil = 0;

const MIN_CONNECTION_INTERVAL_MS = 30_000;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

function isRateLimited(err: any): boolean {
  return err?.message?.includes("BLOCKED_PAYLOAD_TYPE") || err?.message?.includes("rate limit");
}

function canAttemptConnection(source: string): boolean {
  if (connectionInProgress) {
    console.log(`[${source}] Connection already in progress — skipping`);
    return false;
  }
  const now = Date.now();
  if (now < rateLimitCooldownUntil) {
    const remainSec = Math.ceil((rateLimitCooldownUntil - now) / 1000);
    console.log(`[${source}] Rate-limit cooldown active — ${remainSec}s remaining, skipping`);
    return false;
  }
  if (now - lastConnectionAttempt < MIN_CONNECTION_INTERVAL_MS) {
    const remainSec = Math.ceil((MIN_CONNECTION_INTERVAL_MS - (now - lastConnectionAttempt)) / 1000);
    console.log(`[${source}] Too soon since last attempt — ${remainSec}s remaining, skipping`);
    return false;
  }
  return true;
}

export function getActiveCTraderAPI() { return activeCTraderAPI; }
export function getActiveLiveTrader() { return activeLiveTrader; }
export function isConnectionCoolingDown(): boolean { return Date.now() < rateLimitCooldownUntil; }

export async function autoConnectAndTrade(): Promise<void> {
  if (!canAttemptConnection("auto-connect")) return;

  const clientId = process.env.CTRADER_CLIENT_ID;
  const clientSecret = process.env.CTRADER_CLIENT_SECRET;
  const accessToken = process.env.CTRADER_ACCESS_TOKEN;
  const accountId = process.env.CTRADER_ACCOUNT_ID;
  const autoTrade = process.env.CTRADER_AUTO_TRADE;

  if (!clientId || !clientSecret || !accessToken || !accountId) {
    console.log("[auto-connect] cTrader credentials not fully configured — skipping auto-connect");
    return;
  }

  if (autoTrade !== "true" && autoTrade !== "1") {
    console.log("[auto-connect] CTRADER_AUTO_TRADE is not enabled — skipping auto-connect. Set CTRADER_AUTO_TRADE=true to enable.");
    return;
  }

  const parsedAccountId = parseInt(accountId);
  if (isNaN(parsedAccountId) || parsedAccountId <= 0) {
    console.log("[auto-connect] Invalid CTRADER_ACCOUNT_ID — skipping auto-connect");
    return;
  }

  connectionInProgress = true;
  const config: CTraderConfig = {
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    accessToken: accessToken.trim(),
    accountId: parsedAccountId,
    isLive: process.env.CTRADER_IS_LIVE === "true",
  };

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    lastConnectionAttempt = Date.now();
    try {
      console.log(`[auto-connect] Connecting to cTrader (attempt ${attempt}/${MAX_RETRIES})...`);

      activeCTraderAPI = new CTraderAPI(config);
      await activeCTraderAPI.connect();

      const symbolId = await activeCTraderAPI.findXAUUSDSymbol();
      await activeCTraderAPI.subscribeSpots(symbolId);
      const trader = await activeCTraderAPI.getTraderInfo();

      console.log(`[auto-connect] Connected to cTrader successfully. Account: ${config.accountId}, Balance: ${activeCTraderAPI.getStatus().balance ?? "N/A"}`);

      console.log("[auto-connect] Starting live trader...");
      activeLiveTrader = new LiveTrader(activeCTraderAPI);
      registerLiveTrader(activeLiveTrader);
      setupLiveTraderReconnect(activeCTraderAPI, activeLiveTrader);
      await activeLiveTrader.start();
      console.log("[auto-connect] Live trader started successfully — trading is now active");

      const { startAIMonitor } = await import("./ai-monitor");
      startAIMonitor(activeLiveTrader);
      console.log("[auto-connect] AI monitor started — continuous learning active");
      connectionInProgress = false;
      return;
    } catch (err: any) {
      const isCantRoute = err.message?.includes("CANT_ROUTE_REQUEST");
      console.error(`[auto-connect] Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);

      if (activeLiveTrader) {
        try { activeLiveTrader.stop(); } catch {}
        activeLiveTrader = null;
        registerLiveTrader(null);
      }
      if (activeCTraderAPI) {
        try { activeCTraderAPI.disconnect(); } catch {}
        activeCTraderAPI = null;
      }

      if (isRateLimited(err)) {
        rateLimitCooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        console.log(`[auto-connect] Rate-limited by cTrader — entering ${RATE_LIMIT_COOLDOWN_MS / 60000}min cooldown. No connection attempts until ${new Date(rateLimitCooldownUntil).toLocaleTimeString()}`);
        break;
      }

      if (attempt < MAX_RETRIES) {
        const delay = isCantRoute ? 30000 * attempt : 15000 * attempt;
        console.log(`[auto-connect] Retrying in ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error(`[auto-connect] All ${MAX_RETRIES} attempts failed. Watchdog will retry after cooldown.`);
      }
    }
  }
  connectionInProgress = false;
}

function setupLiveTraderReconnect(api: CTraderAPI, trader: LiveTrader) {
  api.on("reconnected", async () => {
    console.log("[auto-reconnect] cTrader reconnected — restarting live trader...");
    try {
      if (trader.isRunning) {
        trader.stop();
      }
      await trader.start();
      console.log("[auto-reconnect] Live trader restarted successfully after reconnection");
    } catch (err: any) {
      console.error(`[auto-reconnect] Failed to restart live trader: ${err.message}`);
    }
  });
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {

  // ─── System Watchdog ─────────────────────────────────────────────
  app.get("/api/system/health", async (req, res) => {
    res.json(getWatchdogStatus());
  });

  // ─── Market Data Endpoints ────────────────────────────────────────
  app.get("/api/market/status", async (req, res) => {
    res.json({ keys: hasApiKeys(), data: getDataStatus() });
  });

  app.post("/api/market/fetch-xauusd", async (req, res) => {
    const apiKey = process.env.TWELVE_DATA_API_KEY;
    if (!apiKey) return res.status(400).json({ error: "TWELVE_DATA_API_KEY not configured" });
    try {
      const data = await fetchXAUUSD(apiKey);
      res.json({
        success: true,
        h1Count: data.h1.length,
        h4Count: data.h4.length,
        dailyCount: data.daily.length,
        h1Range: data.h1.length > 0 ? { from: data.h1[0].timestamp, to: data.h1[data.h1.length - 1].timestamp } : null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/market/fetch-events", async (req, res) => {
    const finnhubKey = process.env.FINNHUB_API_KEY;
    try {
      const events = await fetchEconomicEvents(finnhubKey || undefined);
      res.json({ success: true, count: events.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/market/fetch-asian", async (req, res) => {
    const apiKey = process.env.TWELVE_DATA_API_KEY;
    if (!apiKey) return res.status(400).json({ error: "TWELVE_DATA_API_KEY not configured" });
    try {
      const snapshots = await fetchAsianMarkets(apiKey);
      res.json({ success: true, indices: snapshots });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/market/fetch-all", async (req, res) => {
    const twelveKey = process.env.TWELVE_DATA_API_KEY;
    const finnhubKey = process.env.FINNHUB_API_KEY;
    const errors: string[] = [];
    const results: any = {};

    if (twelveKey) {
      try {
        const xau = await fetchXAUUSD(twelveKey);
        results.xauusd = { h1: xau.h1.length, h4: xau.h4.length, daily: xau.daily.length };
      } catch (err: any) {
        errors.push(`XAUUSD: ${err.message}`);
      }
      results.asianNote = "Asian markets fetched separately — use the Fetch Asian Markets button after 1 minute to avoid rate limits.";
    } else {
      errors.push("TWELVE_DATA_API_KEY not configured");
    }

    try {
      const events = await fetchEconomicEvents(finnhubKey || undefined);
      results.events = { count: events.length };
    } catch (err: any) {
      errors.push(`Events: ${err.message}`);
    }

    res.json({ success: errors.length === 0, results, errors: errors.length > 0 ? errors : undefined });
  });

  app.post("/api/market/fetch-lower-timeframes", async (req, res) => {
    const twelveKey = process.env.TWELVE_DATA_API_KEY;
    if (!twelveKey) {
      return res.status(400).json({ error: "TWELVE_DATA_API_KEY not configured" });
    }
    try {
      const counts = await fetchLowerTimeframes(twelveKey);
      res.json({ success: true, results: counts });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/market/fetch-all-timeframes", async (req, res) => {
    const twelveKey = process.env.TWELVE_DATA_API_KEY;
    if (!twelveKey) {
      return res.status(400).json({ error: "TWELVE_DATA_API_KEY not configured" });
    }
    try {
      const forceAll = req.body?.forceAll === true;
      const result = await fetchAllTimeframes(twelveKey, forceAll);
      res.json({
        success: result.errors.length === 0,
        results: { m1: result.m1, m15: result.m15, h1: result.h1, h4: result.h4, daily: result.daily },
        errors: result.errors.length > 0 ? result.errors : undefined,
        skipped: result.skipped.length > 0 ? result.skipped : undefined,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/market/db-status", async (req, res) => {
    try {
      const dbStatus = await getDbPriceStatus();
      res.json(dbStatus);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/market/load-from-db", async (req, res) => {
    try {
      const counts = await loadCachedDataFromDB();
      res.json({ success: true, ...counts });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/market/cached", async (req, res) => {
    const cached = getCachedData();
    res.json({
      xauusd: { m1: cached.m1.length, m15: cached.m15.length, h1: cached.h1.length, h4: cached.h4.length, daily: cached.daily.length },
      events: cached.events.length,
      asian: cached.asian,
    });
  });

  app.get("/api/market/asian", async (req, res) => {
    const cached = getCachedData();
    res.json(cached.asian);
  });

  app.get("/api/market/events", async (req, res) => {
    const cached = getCachedData();
    res.json(cached.events);
  });

  // ─── Locked Params Endpoints ─────────────────────────────────────
  app.get("/api/locked-params", async (_req, res) => {
    try {
      const params = await getLockedParams();
      res.json(params);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/active-strategy-summary", async (_req, res) => {
    try {
      const params = await getLockedParams();
      const changelog = await storage.listParamChangelog(1);
      const lastChange = changelog.length > 0 ? changelog[0] : null;
      const results = await storage.listBacktestResults();
      const keyParams = ['rewardRatio', 'atrStopMultiplier', 'compressionThreshold', 'expansionThreshold', 'riskPerTradePct', 'sessionMode', 'entryWindowBars', 'reduceSizeAfterLoss', 'atrRiskScaleEnabled', 'secondTradeRiskFactor'];
      const matchingBacktest = results.find(r => {
        const cfg = r.config as Record<string, any>;
        return keyParams.every(k => String(cfg[k]) === String(params[k]));
      });
      const catalogue = await storage.listStrategies();
      const matchingStrategy = catalogue.find((s: any) => {
        const cfg = s.config as Record<string, any>;
        return keyParams.every(k => String(cfg[k]) === String(params[k]));
      });
      res.json({
        params,
        lastChange: lastChange ? {
          source: lastChange.source || lastChange.changed_by,
          timestamp: lastChange.timestamp,
          changedKeys: lastChange.changed_keys || lastChange.changedKeys,
          rationale: lastChange.rationale,
        } : null,
        matchingBacktest: matchingBacktest ? {
          id: matchingBacktest.id,
          returnPct: matchingBacktest.stats.returnPct,
          maxDrawdownPct: matchingBacktest.stats.maxDrawdownPct,
          winRate: matchingBacktest.stats.winRate,
          totalTrades: matchingBacktest.stats.totalTrades,
          profitFactor: matchingBacktest.stats.profitFactor,
          label: matchingBacktest.label,
        } : null,
        activeStrategy: matchingStrategy ? {
          id: (matchingStrategy as any).id,
          name: (matchingStrategy as any).name,
          category: (matchingStrategy as any).category,
          notes: (matchingStrategy as any).notes,
          stats: (matchingStrategy as any).stats,
        } : null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/locked-params", async (req, res) => {
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
      const currentParams = await getLockedParams();
      const filtered: Record<string, any> = {};
      for (const [k, v] of Object.entries(req.body)) {
        if (allowedKeys.has(k)) filtered[k] = v;
      }
      filtered.leverage = 10;
      filtered.maxDrawdownPct = 25;
      if (Object.keys(filtered).length === 0) return res.status(400).json({ error: "No valid params provided" });
      const changedKeys: string[] = [];
      const oldValues: Record<string, any> = {};
      const newValues: Record<string, any> = {};
      for (const k of Object.keys(filtered)) {
        if (JSON.stringify(filtered[k]) !== JSON.stringify(currentParams[k])) {
          changedKeys.push(k);
          oldValues[k] = currentParams[k];
          newValues[k] = filtered[k];
        }
      }
      const updated = await updateLockedParams(filtered);
      if (changedKeys.length > 0) {
        await storage.saveParamChangelog({
          source: req.body._source || "user",
          changedKeys,
          oldValues,
          newValues,
          rationale: req.body._rationale || "Manual update via Settings",
          fullParams: updated,
        });
      }
      if (activeLiveTrader) {
        await activeLiveTrader.reloadLockedParams();
      }
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/locked-params/changelog", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const changelog = await storage.listParamChangelog(limit);
      res.json(changelog);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/analyst-ideas", async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, source, title, url, content, chart_url, video_url, fetched_at FROM analyst_ideas WHERE source = 'goldviewfx' ORDER BY fetched_at DESC LIMIT 10`
      );
      res.json(result.rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/analyst-ideas/refresh", async (_req, res) => {
    try {
      const { fetchGoldviewfxIdeas } = await import("./goldviewfx-fetcher");
      const count = await fetchGoldviewfxIdeas();
      res.json({ refreshed: count });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/locked-params/proposals", async (_req, res) => {
    try {
      const proposals = await storage.listLockedParamsProposals();
      res.json(proposals);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/locked-params/proposals/:id", async (req, res) => {
    try {
      const proposal = await storage.getLockedParamsProposal(req.params.id);
      if (!proposal) return res.status(404).json({ error: "Proposal not found" });
      res.json(proposal);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/locked-params/proposals/:id/approve", async (req, res) => {
    try {
      const proposal = await storage.getLockedParamsProposal(req.params.id);
      if (!proposal) return res.status(404).json({ error: "Proposal not found" });
      if (proposal.status !== "pending") return res.status(400).json({ error: `Proposal already ${proposal.status}` });

      const currentParams = await getLockedParams();
      const updated = await updateLockedParams(proposal.proposedParams);
      await storage.updateLockedParamsProposalStatus(req.params.id, "approved");
      const changedKeys = proposal.changedKeys || [];
      const oldValues: Record<string, any> = {};
      const newValues: Record<string, any> = {};
      for (const k of changedKeys) {
        oldValues[k] = currentParams[k];
        newValues[k] = proposal.proposedParams[k];
      }
      await storage.saveParamChangelog({
        source: `ai-proposal-${proposal.source || "ai"}`,
        changedKeys,
        oldValues,
        newValues,
        rationale: proposal.rationale || "Approved AI proposal",
        fullParams: updated,
      });
      if (activeLiveTrader) {
        await activeLiveTrader.reloadLockedParams();
      }
      res.json({ success: true, params: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/locked-params/proposals/:id/reject", async (req, res) => {
    try {
      const proposal = await storage.getLockedParamsProposal(req.params.id);
      if (!proposal) return res.status(404).json({ error: "Proposal not found" });
      if (proposal.status !== "pending") return res.status(400).json({ error: `Proposal already ${proposal.status}` });

      await storage.updateLockedParamsProposalStatus(req.params.id, "rejected");
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Internal apply params (temporary) ─────────────────────────
  app.put("/api/internal/apply-params", async (req, res) => {
    try {
      const currentParams = await getLockedParams();
      const body = req.body;
      const allowedKeys = new Set([
        'lotSize', 'atrPeriod', 'atrStopMultiplier', 'rewardRatio', 'compressionThreshold',
        'expansionThreshold', 'rangeWidthBars', 'midpointBandPct', 'entryWindowBars', 'wickRatio', 'minRangeATR', 'maxTrendATRRatio',
        'sessionMode', 'sessionORBEnabled', 'riskPerTradePct', 'leverage', 'maxDrawdownPct',
        'maxDailyLossPct', 'maxConsecutiveLosses', 'maxTradesPerDay', 'trailingStopEnabled',
        'trailingStopTriggerR', 'reduceSizeAfterLoss', 'reducedRiskPerTradePct',
        'atrRiskScaleEnabled', 'atrRiskScaleFactor', 'atrRiskScaleThreshold',
        'secondTradeRiskFactor', 'postLossCooldownBars',
        'spreadPoints', 'slippagePoints', 'commissionPerLot',
      ]);
      const filtered: Record<string, any> = {};
      for (const [k, v] of Object.entries(body)) {
        if (allowedKeys.has(k)) filtered[k] = v;
      }
      filtered.leverage = 10;
      filtered.maxDrawdownPct = 25;
      const changedKeys: string[] = [];
      const oldValues: Record<string, any> = {};
      const newValues: Record<string, any> = {};
      for (const k of Object.keys(filtered)) {
        if (JSON.stringify(filtered[k]) !== JSON.stringify(currentParams[k])) {
          changedKeys.push(k);
          oldValues[k] = currentParams[k];
          newValues[k] = filtered[k];
        }
      }
      const updated = await updateLockedParams(filtered);
      if (changedKeys.length > 0) {
        await storage.saveParamChangelog({
          source: body._source || "champion_apply",
          changedKeys,
          oldValues,
          newValues,
          rationale: body._rationale || "Applied via internal API",
          fullParams: updated,
        });
      }
      if (activeLiveTrader) {
        await activeLiveTrader.reloadLockedParams();
      }
      res.json({ success: true, changed: changedKeys, params: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Internal batch backtest (temporary) ─────────────────────────
  app.post("/api/internal/seed-strategies", async (req, res) => {
    try {
      const { strategies } = req.body;
      if (!Array.isArray(strategies)) return res.status(400).json({ error: "strategies array required" });
      const saved = [];
      for (const s of strategies) {
        const id = `strat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const result = await storage.saveStrategy({
          id,
          name: s.name,
          category: s.category || '',
          config: s.config,
          stats: s.stats,
          notes: s.notes || undefined,
          createdAt: new Date().toISOString(),
        });
        saved.push(result);
      }
      res.json({ saved: saved.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/internal/batch-backtest", async (req, res) => {
    try {
      const { baseConfig, variations } = req.body;
      await ensureDataReady();
      const cached = getCachedData();
      const dataPayload = {
        m1: cached.m1, m15: cached.m15, h1: cached.h1, h4: cached.h4, daily: cached.daily,
        events: cached.events.map((e: any) => ({ timestamp: e.timestamp })),
        gvz: cached.gvz.map((g: any) => ({ date: g.date, value: Number(g.value) })),
        cot: cached.cot.map((c: any) => ({ date: c.date, noncommLong: c.noncommLong, noncommShort: c.noncommShort, netPosition: c.netPosition, openInterest: c.openInterest })),
        sge: cached.sge?.map((s: any) => ({ date: s.date, premium: Number(s.premium) })),
      };
      const results: any[] = [];
      for (const v of variations) {
        const config = { ...baseConfig, ...v.changes };
        const parsed = backtestConfigSchema.safeParse(config);
        if (!parsed.success) { results.push({ label: v.label, error: "Invalid config" }); continue; }
        parsed.data.leverage = 10; parsed.data.maxDrawdownPct = 25;
        try {
          const result = runBacktest(parsed.data, dataPayload);
          await storage.saveBacktestResult(result);
          results.push({ label: v.label, stats: result.stats, id: result.id });
        } catch (err: any) { results.push({ label: v.label, error: err.message }); }
      }
      res.json({ results });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ─── Backtest Endpoints ───────────────────────────────────────────
  app.post("/api/backtest", async (req, res) => {
    try {
      const { config: rawConfig, data: uploadedData, useAutoData } = req.body;
      const parsed = backtestConfigSchema.safeParse(rawConfig ?? req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid config", details: parsed.error.flatten() });
      }

      parsed.data.leverage = Math.min(parsed.data.leverage, 10);
      parsed.data.maxDrawdownPct = Math.min(parsed.data.maxDrawdownPct, 25);
      if (!parsed.data.startingBalance || parsed.data.startingBalance < 100) {
        parsed.data.startingBalance = 3000;
      }

      let dataPayload = uploadedData;

      if (useAutoData) {
        await ensureDataReady();
        const cached = getCachedData();
        if (cached.h1.length > 0 && cached.h4.length > 0 && cached.daily.length > 0) {
          dataPayload = {
            m1: cached.m1,
            m15: cached.m15,
            h1: cached.h1,
            h4: cached.h4,
            daily: cached.daily,
            events: cached.events.map((e) => ({ timestamp: e.timestamp })),
            gvz: cached.gvz.map((g: any) => ({ date: g.date, value: Number(g.value) })),
            cot: cached.cot.map((c: any) => ({ date: c.date, noncommLong: c.noncommLong, noncommShort: c.noncommShort, netPosition: c.netPosition, openInterest: c.openInterest })),
            sge: cached.sge?.map((s: any) => ({ date: s.date, premium: Number(s.premium) })),
          };
        } else {
          return res.status(400).json({ error: "No market data available. Configure TWELVE_DATA_API_KEY or upload CSV files." });
        }
      }

      const strategyMode = parsed.data.strategyMode ?? "regime";
      const result = strategyMode === "rsi_bot"
        ? runRSIBacktest(parsed.data, dataPayload)
        : runBacktest(parsed.data, dataPayload);

      const existing = await storage.listBacktestResults();
      const archived = await storage.listArchivedBacktests();
      const allExisting = [...existing, ...archived];
      const existingMatch = allExisting.find(e =>
        e.config.startDate === result.config.startDate &&
        e.config.endDate === result.config.endDate &&
        e.stats.returnPct === result.stats.returnPct &&
        e.stats.maxDrawdownPct === result.stats.maxDrawdownPct &&
        e.stats.totalTrades === result.stats.totalTrades &&
        e.stats.winRate === result.stats.winRate &&
        e.stats.netPnl === result.stats.netPnl
      );
      if (!existingMatch) {
        await storage.saveBacktestResult(result);
        const allResults = await storage.listBacktestResults();
        const sorted = [...allResults].sort((a, b) => (b.stats.returnPct || 0) - (a.stats.returnPct || 0));
        const previousBest = sorted.find(r => r.id !== result.id);
        await storage.logStrategyChange({
          backtestId: result.id,
          action: "backtest_saved",
          description: `${result.stats.returnPct}% return, ${result.stats.totalTrades} trades, ${result.stats.maxDrawdownPct}% DD, WR ${result.stats.winRate}%`,
          configSnapshot: result.config,
          statsSnapshot: result.stats,
          previousBestId: previousBest?.id,
          previousBestStats: previousBest?.stats,
        });
        res.json(result);
      } else {
        console.log(`[Backtest] Returning existing match: ${existingMatch.id} (${result.stats.returnPct}% ret, ${result.stats.totalTrades} trades)`);
        res.json(existingMatch);
      }
    } catch (err: any) {
      console.error("Backtest error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/backtests", async (req, res) => {
    try {
      const results = await storage.listBacktestResults();
      const limit = parseInt(req.query.limit as string) || 0;
      const sorted = [...results].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const sliced = limit > 0 ? sorted.slice(0, limit) : sorted;
      const summaries = sliced.map(({ trades, equityCurve, ...rest }) => ({
        ...rest,
        tradeCount: trades.length,
      }));
      res.json(summaries);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/backtests/leaderboard", async (req, res) => {
    try {
      const sortBy = (req.query.sort as string) || "performance";
      const catalogue = await storage.listStrategies();
      const catalogueStrategies = catalogue
        .filter((s: any) => s.stats && Number(s.stats.totalTrades) >= 1)
        .map((s: any) => {
          const rdd = Number(s.stats.maxDrawdownPct) > 0 ? Number(s.stats.returnPct) / Number(s.stats.maxDrawdownPct) : 0;
          return {
            id: s.id,
            label: s.name,
            config: s.config,
            stats: s.stats,
            dataSource: "real" as const,
            category: s.category,
            notes: s.notes,
            returnDD: Math.round(rdd * 100) / 100,
            tradeCount: Number(s.stats.totalTrades),
          };
        });

      const sortFn = sortBy === "risk"
        ? (a: any, b: any) => Number(a.stats.maxDrawdownPct) - Number(b.stats.maxDrawdownPct) || b.returnDD - a.returnDD
        : (a: any, b: any) => Number(b.stats.returnPct) - Number(a.stats.returnPct) || b.returnDD - a.returnDD;

      if (catalogueStrategies.length >= 3) {
        return res.json(catalogueStrategies.sort(sortFn).slice(0, 10));
      }

      const results = await storage.listBacktestResults();
      const withRDD = results
        .filter(r => r.stats.totalTrades >= 5 && r.dataSource === "real")
        .map(r => {
          const rdd = r.stats.maxDrawdownPct > 0 ? r.stats.returnPct / r.stats.maxDrawdownPct : 0;
          return { ...r, returnDD: Math.round(rdd * 100) / 100 };
        })
        .sort(sortFn);

      const seen = new Set<string>();
      const ranked = withRDD.filter(r => {
        const key = `${r.stats.returnPct}_${r.stats.maxDrawdownPct}_${r.stats.totalTrades}_${r.stats.winRate}_${r.stats.profitFactor}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
        .slice(0, 10)
        .map(({ trades, equityCurve, ...rest }) => ({
          ...rest,
          tradeCount: trades.length,
        }));
      res.json(ranked);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/backtest/:id", async (req, res) => {
    try {
      const result = await storage.getBacktestResult(req.params.id);
      if (!result) return res.status(404).json({ error: "Not found" });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/backtest/:id", async (req, res) => {
    try {
      await storage.deleteBacktestResult(req.params.id);
      res.json({ success: true, archived: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/backtest/:id/archive", async (req, res) => {
    try {
      const reason = req.body?.reason || "archived";
      await storage.archiveBacktestResult(req.params.id, reason);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/backtest/:id/restore", async (req, res) => {
    try {
      await storage.restoreBacktestResult(req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/backtest/:id/label", async (req, res) => {
    try {
      const label = req.body?.label || "";
      await storage.labelBacktestResult(req.params.id, label);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/backtests/archived", async (_req, res) => {
    try {
      const results = await storage.listArchivedBacktests();
      res.json(results);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/strategy-changelog", async (_req, res) => {
    try {
      const log = await storage.getStrategyChangelog();
      res.json(log);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/strategy-changelog", async (req, res) => {
    try {
      await storage.logStrategyChange(req.body);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Export endpoints ──────────────────────────────────────────────
  app.get("/api/backtest/:id/export/csv", async (req, res) => {
    try {
      const result = await storage.getBacktestResult(req.params.id);
      if (!result) return res.status(404).json({ error: "Not found" });

      const headers = [
        "Entry Date", "Exit Date", "Side", "Regime", "Entry Reason", "Exit Reason",
        "Entry Price", "Exit Price", "Stop Loss", "Take Profit", "P&L", "Result R", "Balance"
      ];
      const rows = result.trades.map((t) => [
        t.entryTime.substring(0, 19), t.exitTime.substring(0, 19),
        t.side, t.regime, t.entryReason, t.exitReason,
        t.entryPrice.toFixed(2), t.exitPrice.toFixed(2),
        t.stopLoss.toFixed(2), t.takeProfit.toFixed(2),
        t.pnl.toFixed(2), t.resultR.toFixed(2), t.balance.toFixed(2),
      ]);
      const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="gold_regime_trades_${result.createdAt.substring(0, 10)}.csv"`);
      res.send(csv);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/backtest/:id/export/json", async (req, res) => {
    try {
      const result = await storage.getBacktestResult(req.params.id);
      if (!result) return res.status(404).json({ error: "Not found" });
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="gold_regime_results_${result.createdAt.substring(0, 10)}.json"`);
      res.send(JSON.stringify(result, null, 2));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/backtest/:id/export/txt", async (req, res) => {
    try {
    const result = await storage.getBacktestResult(req.params.id);
    if (!result) return res.status(404).json({ error: "Not found" });

    const s = result.stats;
    const c = result.config;
    const lines = [
      "===================================================",
      "       GOLD REGIME LAB v9 - BACKTEST REPORT        ",
      "===================================================",
      "",
      `Date Generated: ${new Date(result.createdAt).toLocaleString()}`,
      `Data Source:     ${result.dataSource}`,
      "",
      "--- Configuration ------------------------------------",
      `  Starting Balance:    $${c.startingBalance.toLocaleString()}`,
      `  Lot Size:            ${c.lotSize}`,
      `  ATR Period:          ${c.atrPeriod}`,
      `  ATR Stop Multiplier: ${c.atrStopMultiplier}x`,
      `  Reward:Risk Ratio:   ${c.rewardRatio}:1`,
      `  Range Width Bars:    ${c.rangeWidthBars}`,
      `  Midpoint Band:       ${(c.midpointBandPct * 100).toFixed(0)}%`,
      `  Wick Ratio:          ${c.wickRatio}`,
      `  Session:             ${c.sessionMode}`,
      `  Max Trades/Day:      ${c.maxTradesPerDay}`,
      "",
      "--- Performance Summary ------------------------------",
      `  Final Balance:       $${s.finalBalance.toLocaleString()}`,
      `  Net P&L:             $${s.netPnl >= 0 ? "+" : ""}${s.netPnl.toFixed(2)} (${s.returnPct >= 0 ? "+" : ""}${s.returnPct}%)`,
      `  Profit Factor:       ${s.profitFactor}x`,
      `  Average R:           ${s.avgR}R`,
      `  Max Drawdown:        $${s.maxDrawdown.toFixed(2)} (${s.maxDrawdownPct.toFixed(1)}%)`,
      "",
      "--- Trade Statistics ---------------------------------",
      `  Total Trades:        ${s.totalTrades}`,
      `  Wins / Losses:       ${s.wins} / ${s.losses}`,
      `  Win Rate:            ${s.winRate}%`,
      `  Consec. Wins:        ${s.consecutiveWins}`,
      `  Consec. Losses:      ${s.consecutiveLosses}`,
      "",
      "--- Regime Breakdown ---------------------------------",
      `  Range Trades:        ${s.rangeTrades} (Win: ${s.rangeWinRate}%) P&L: $${s.rangePnl.toFixed(2)}`,
      `  Trend Trades:        ${s.trendTrades} (Win: ${s.trendWinRate}%) P&L: $${s.trendPnl.toFixed(2)}`,
      `  No-Trade Bars:       ${s.noTradeBarCount}`,
      "",
      "--- Regime Bar Counts --------------------------------",
      `  Range bars:          ${result.regimeCounts.range}`,
      `  Trend bars:          ${result.regimeCounts.trend}`,
      `  No-trade bars:       ${result.regimeCounts.no_trade}`,
      "",
      "--- Monthly Returns ----------------------------------",
      ...result.monthlyReturns.map(
        (m) => `  ${m.month}:  ${m.return >= 0 ? "+" : ""}${m.return.toFixed(2)}%  (${m.trades} trades)`
      ),
      "",
      "===================================================",
    ];

    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Disposition", `attachment; filename="gold_regime_report_${result.createdAt.substring(0, 10)}.txt"`);
    res.send(lines.join("\n"));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── AI Advisor Endpoints ─────────────────────────────────────────
  app.post("/api/ai/analyze", async (req, res) => {
    try {
      if (!checkRateLimit()) {
        return res.status(429).json({ error: "Please wait a few seconds between AI requests" });
      }

      const parsed = analyzeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      }

      const { backtestId, userQuestion } = parsed.data;
      const cached = getCachedData();

      const allResults = await storage.listBacktestResults();
      const currentParams = await getLockedParams();
      const keyParams = ['rewardRatio', 'atrStopMultiplier', 'compressionThreshold', 'expansionThreshold', 'riskPerTradePct', 'sessionMode', 'entryWindowBars'];

      let result = null;
      if (backtestId) {
        result = allResults.find(r => r.id === backtestId) ?? null;
      }
      if (!result) {
        result = allResults.find(r => {
          const cfg = r.config as Record<string, any>;
          return keyParams.every(k => String(cfg[k]) === String(currentParams[k]));
        }) ?? null;
      }
      if (!result && allResults.length > 0) {
        result = allResults[0];
      }

      const historicalRuns = allResults.map(r => ({
        id: r.id,
        createdAt: r.createdAt,
        dataSource: r.dataSource,
        config: r.config,
        stats: r.stats,
        diagnostics: r.diagnostics,
        monthlyReturns: r.monthlyReturns,
      }));

      const analysis = await getAdvisorAnalysis({
        backtestId: result?.id,
        stats: result?.stats,
        config: result?.config,
        trades: result?.trades,
        diagnostics: result?.diagnostics,
        monthlyReturns: result?.monthlyReturns,
        regimeCounts: result?.regimeCounts,
        asianMarkets: cached.asian,
        upcomingEvents: cached.events,
        userQuestion,
        historicalRuns,
      });

      res.json(analysis);
    } catch (err: any) {
      console.error("AI Advisor error:", err);
      res.status(500).json({ error: err.message || "AI analysis failed" });
    }
  });

  app.post("/api/ai/daily-analysis", async (req, res) => {
    try {
      if (!checkRateLimit()) {
        return res.status(429).json({ error: "Please wait a few seconds between AI requests" });
      }
      const analysis = await getDailyAnalysis();
      res.json(analysis);
    } catch (err: any) {
      console.error("Daily analysis error:", err);
      res.status(500).json({ error: err.message || "Daily analysis failed" });
    }
  });

  app.post("/api/ai/chat", async (req, res) => {
    try {
      if (!checkRateLimit()) {
        return res.status(429).json({ error: "Please wait a few seconds between AI requests" });
      }

      const parsed = chatRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      }

      const { message, context, attachments } = parsed.data;
      const cached = getCachedData();
      const allResults = await storage.listBacktestResults();
      const currentParams = await getLockedParams();
      const keyParams = ['rewardRatio', 'atrStopMultiplier', 'compressionThreshold', 'expansionThreshold', 'riskPerTradePct', 'sessionMode', 'entryWindowBars'];

      let result = null;
      if (context?.backtestId) {
        result = allResults.find(r => r.id === context.backtestId) ?? null;
      }
      if (!result) {
        result = allResults.find(r => {
          const cfg = r.config as Record<string, any>;
          return keyParams.every(k => String(cfg[k]) === String(currentParams[k]));
        }) ?? null;
      }
      if (!result && allResults.length > 0) {
        result = allResults[0];
      }

      const contextParts: string[] = [];
      if (result) {
        const s = result.stats;
        const rdr = s.maxDrawdownPct > 0 ? (s.returnPct / s.maxDrawdownPct).toFixed(2) : 'N/A';
        contextParts.push(`Latest backtest: ${s.totalTrades} trades, ${s.winRate}% WR, ${s.returnPct}% return, ${s.maxDrawdownPct}% DD, PF ${s.profitFactor}, R/DD ${rdr}`);
        contextParts.push(`Config: RR=${result.config.rewardRatio}, risk=${result.config.riskPerTradePct}%, lev=${result.config.leverage}x, ATR stop=${result.config.atrStopMultiplier}, expansion=${result.config.expansionThreshold}, compression=${result.config.compressionThreshold}`);
        contextParts.push(`Full config: ${JSON.stringify(result.config)}`);
        if (result.diagnostics) {
          const d = result.diagnostics;
          contextParts.push(`Diagnostics: session=${d.blockedBySession}, wick=${d.blockedByWickRatio}, retest=${d.blockedByRetestDistance}, consec=${d.blockedByConsecutiveLossLimit}, reduced=${d.reducedSizeAfterLossCount}, expansion=${d.blockedByExpansion}, compression=${d.blockedByCompression}`);
        }
        contextParts.push(`Range: ${s.rangeTrades}t ${s.rangeWinRate}%WR $${s.rangePnl.toFixed(0)} | Trend: ${s.trendTrades}t ${s.trendWinRate}%WR $${s.trendPnl.toFixed(0)}`);
      }
      if (allResults.length > 1) {
        contextParts.push(`\nTOTAL BACKTEST HISTORY: ${allResults.length} runs`);

        const sorted = [...allResults]
          .filter(r => r.stats.totalTrades > 0)
          .sort((a, b) => b.stats.returnPct - a.stats.returnPct || (
            (b.stats.maxDrawdownPct > 0 ? b.stats.returnPct / b.stats.maxDrawdownPct : 0) -
            (a.stats.maxDrawdownPct > 0 ? a.stats.returnPct / a.stats.maxDrawdownPct : 0)
          ));

        if (sorted.length > 0) {
          const top5 = sorted.slice(0, 5).map((r, i) => {
            const rdr = r.stats.maxDrawdownPct > 0 ? (r.stats.returnPct / r.stats.maxDrawdownPct).toFixed(2) : 'N/A';
            return `  #${i+1} BEST: ${r.stats.returnPct}%ret, ${r.stats.maxDrawdownPct}%DD, R/DD=${rdr}, ${r.stats.totalTrades}t, ${r.stats.winRate}%WR, PF=${r.stats.profitFactor} | session=${r.config.sessionMode}, RR=${r.config.rewardRatio}, risk=${r.config.riskPerTradePct}%, lev=${r.config.leverage}x, ATRstop=${r.config.atrStopMultiplier}, expansion=${r.config.expansionThreshold}, compression=${r.config.compressionThreshold}, rangeWidth=${r.config.rangeWidthBars}, midpoint=${r.config.midpointBandPct}, retest=${r.config.retestBuffer}, wickRatio=${r.config.wickRatio}, maxTrades=${r.config.maxTradesPerDay}, consec=${r.config.maxConsecutiveLosses}`;
          });
          contextParts.push(`TOP 5 BEST RUNS (by Return % — PRESERVE THIS RETURN, then reduce DD):\n${top5.join('\n')}`);
        }

        const worst5 = sorted.slice(-5).reverse().map((r, i) => {
          const rdr = r.stats.maxDrawdownPct > 0 ? (r.stats.returnPct / r.stats.maxDrawdownPct).toFixed(2) : 'N/A';
          return `  #${i+1} WORST: ${r.stats.totalTrades}t, ${r.stats.winRate}%WR, ${r.stats.returnPct}%ret, ${r.stats.maxDrawdownPct}%DD, R/DD=${rdr} | RR=${r.config.rewardRatio}, session=${r.config.sessionMode}, risk=${r.config.riskPerTradePct}%, lev=${r.config.leverage}x`;
        });
        if (worst5.length > 0) {
          contextParts.push(`WORST 5 RUNS (AVOID these settings):\n${worst5.join('\n')}`);
        }

        const recent5 = allResults.slice(0, 5).map((r, i) => {
          const rdr = r.stats.maxDrawdownPct > 0 ? (r.stats.returnPct / r.stats.maxDrawdownPct).toFixed(2) : 'N/A';
          return `  ${r.createdAt?.substring(0, 16)}: ${r.stats.totalTrades}t, ${r.stats.returnPct}%ret, ${r.stats.maxDrawdownPct}%DD, R/DD=${rdr}, RR=${r.config.rewardRatio}`;
        });
        contextParts.push(`RECENT 5 RUNS (chronological):\n${recent5.join('\n')}`);
      }

      req.setTimeout(300000);
      res.setTimeout(300000);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const keepAlive = setInterval(() => {
        res.write(': keepalive\n\n');
      }, 15000);

      try {
        const chatResult = await getChatResponse(message, contextParts.join('\n'), (update) => {
          res.write(`data: ${JSON.stringify({ ...update, type: "progress" })}\n\n`);
        }, attachments);

        res.write(`data: ${JSON.stringify({ type: "result", reply: chatResult.reply, actions: chatResult.actions, history: getChatHistory() })}\n\n`);
        res.write('data: [DONE]\n\n');
      } catch (innerErr: any) {
        console.error("AI Chat error:", innerErr);
        const errorMsg = innerErr.code === 'ECONNRESET' || innerErr.code === 'ETIMEDOUT'
          ? "Connection timed out — the AI was running too many backtests. Try a simpler request."
          : innerErr.message || "AI chat failed";
        res.write(`data: ${JSON.stringify({ type: "error", error: errorMsg })}\n\n`);
      } finally {
        clearInterval(keepAlive);
        res.end();
      }
    } catch (err: any) {
      console.error("AI Chat setup error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || "AI chat failed" });
      }
    }
  });

  app.get("/api/ai/chat/history", (req, res) => {
    res.json({ history: getChatHistory() });
  });

  app.post("/api/ai/chat/clear", (req, res) => {
    clearChatHistory();
    res.json({ cleared: true });
  });

  app.get("/api/ai/journal", async (req, res) => {
    try {
      const rawLimit = parseInt(req.query.limit as string) || 50;
      const limit = Math.max(1, Math.min(200, rawLimit));
      const entries = await storage.listJournalEntries(limit);
      const allEntries = await storage.listJournalEntries(200);
      res.json({ entries, count: allEntries.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ai/market-snapshot", async (req, res) => {
    try {
      const snapshot = await getMarketSnapshot();
      res.json({ snapshot });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/chart-data", async (req, res) => {
    try {
      const { calcATR, calcSMA, calcEMA, calcBBWidth } = await import("./regime-engine");
      const { getCachedData, fetchLivePrice } = await import("./data-fetcher");
      const cached = getCachedData();
      const tf = (req.query.timeframe as string) || "h1";
      const count = Math.min(Number(req.query.count) || 200, 500);

      let candles: any[];
      switch (tf) {
        case "h4": candles = cached.h4; break;
        case "daily": candles = cached.daily; break;
        default: candles = cached.h1; break;
      }

      if (candles.length === 0) {
        return res.json({ candles: [], levels: null });
      }

      const sliced = candles.slice(-count);
      const chartCandles = sliced.map((c: any) => ({
        time: Math.floor(new Date(c.timestamp).getTime() / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume ?? 0,
      })).sort((a: any, b: any) => a.time - b.time)
        .filter((c: any, i: number, arr: any[]) => i === 0 || c.time > arr[i - 1].time);

      const h4 = cached.h4;
      let levels: any = null;

      if (h4.length >= 10) {
        const rangeWidthBars = 7;
        const recentH4 = h4.slice(-rangeWidthBars);
        const rangeHigh = Math.max(...recentH4.map((c: any) => c.high));
        const rangeLow = Math.min(...recentH4.map((c: any) => c.low));
        const midpoint = (rangeHigh + rangeLow) / 2;
        const rangeWidth = rangeHigh - rangeLow;
        const midBandUpper = midpoint + rangeWidth * 0.10;
        const midBandLower = midpoint - rangeWidth * 0.10;

        const h1 = cached.h1;
        const h1Atrs = calcATR(h1, 14);
        const currentAtrH1 = h1Atrs[h1Atrs.length - 1] || 0;
        const slDistance = currentAtrH1 * 2.75;
        const tpDistance = slDistance * 4;

        const tfCloses = candles.map((c: any) => c.close);
        const sma50All = calcSMA(tfCloses, 50);
        const sma200All = calcSMA(tfCloses, 200);

        const sma50Sliced = sma50All.slice(-count);
        const sma200Sliced = sma200All.slice(-count);
        const sma50Data = sma50Sliced.map((v: number, i: number) => ({
          time: chartCandles[i]?.time,
          value: isNaN(v) ? undefined : Number(v.toFixed(2)),
        })).filter((d: any) => d.value !== undefined && d.time);
        const sma200Data = sma200Sliced.map((v: number, i: number) => ({
          time: chartCandles[i]?.time,
          value: isNaN(v) ? undefined : Number(v.toFixed(2)),
        })).filter((d: any) => d.value !== undefined && d.time);

        const daily = cached.daily;
        const dailyCloses = daily.map((c: any) => c.close);
        const ema50Daily = calcEMA(dailyCloses, 50);
        const lastEma50Daily = ema50Daily[ema50Daily.length - 1];

        const live = await fetchLivePrice();
        const currentPrice = live?.price ?? h1[h1.length - 1].close;

        levels = {
          rangeHigh: Number(rangeHigh.toFixed(2)),
          rangeLow: Number(rangeLow.toFixed(2)),
          midpoint: Number(midpoint.toFixed(2)),
          midBandUpper: Number(midBandUpper.toFixed(2)),
          midBandLower: Number(midBandLower.toFixed(2)),
          currentPrice: Number(currentPrice.toFixed(2)),
          atrH1: Number(currentAtrH1.toFixed(2)),
          slDistance: Number(slDistance.toFixed(2)),
          tpDistance: Number(tpDistance.toFixed(2)),
          ema50Daily: !isNaN(lastEma50Daily) ? Number(lastEma50Daily.toFixed(2)) : null,
          sma50: sma50Data,
          sma200: sma200Data,
        };
      }

      let trades: any[] = [];
      if (activeLiveTrader) {
        try {
          const analysis = activeLiveTrader.getAnalysis();
          if (analysis.regime) {
            levels = levels || {};
            levels.regime = analysis.regime;
          }
        } catch {}
      }

      res.json({ candles: chartCandles, levels, trades });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/technical-indicators", async (req, res) => {
    try {
      const { calcSMA, calcMACD, calcADX, calcATR, calcRSI, calcOBV, calcVWAP, calcVolumeSMA } = await import("./regime-engine");
      const { getCachedData, fetchLivePrice } = await import("./data-fetcher");
      const cached = getCachedData();
      const h1 = cached.h1;
      if (h1.length === 0) {
        return res.json({ indicators: null, message: "No H1 data available" });
      }

      const h1Closes = h1.map((c: any) => c.close);
      const live = await fetchLivePrice();
      const currentPrice = live?.price ?? h1[h1.length - 1].close;

      const sma50Arr = calcSMA(h1Closes, 50);
      const sma200Arr = calcSMA(h1Closes, 200);
      const sma50 = sma50Arr[sma50Arr.length - 1];
      const sma200 = sma200Arr[sma200Arr.length - 1];

      const macd = calcMACD(h1Closes, 12, 26, 9);
      const macdLine = macd.macdLine[macd.macdLine.length - 1];
      const signalLine = macd.signalLine[macd.signalLine.length - 1];
      const histogram = macd.histogram[macd.histogram.length - 1];
      const prevHistogram = macd.histogram[macd.histogram.length - 2];

      const dmi = calcADX(h1, 14);
      const adx = dmi.adx[dmi.adx.length - 1];
      const plusDI = dmi.plusDI[dmi.plusDI.length - 1];
      const minusDI = dmi.minusDI[dmi.minusDI.length - 1];

      const atrArr = calcATR(h1, 14);
      const atr = atrArr[atrArr.length - 1];

      const rsiArr = calcRSI(h1Closes, 14);
      const rsi = rsiArr[rsiArr.length - 1];

      res.json({
        indicators: {
          price: currentPrice,
          timestamp: h1[h1.length - 1].timestamp,
          sma: {
            sma50: isNaN(sma50) ? null : Number(sma50.toFixed(2)),
            sma200: isNaN(sma200) ? null : Number(sma200.toFixed(2)),
            priceAboveSMA50: !isNaN(sma50) && currentPrice > sma50,
            priceAboveSMA200: !isNaN(sma200) && currentPrice > sma200,
            goldenCross: !isNaN(sma50) && !isNaN(sma200) && sma50 > sma200,
          },
          macd: {
            line: isNaN(macdLine) ? null : Number(macdLine.toFixed(2)),
            signal: isNaN(signalLine) ? null : Number(signalLine.toFixed(2)),
            histogram: isNaN(histogram) ? null : Number(histogram.toFixed(2)),
            bullish: !isNaN(histogram) && histogram > 0,
            increasing: !isNaN(histogram) && !isNaN(prevHistogram) && Math.abs(histogram) > Math.abs(prevHistogram),
          },
          dmi: {
            adx: isNaN(adx) ? null : Number(adx.toFixed(1)),
            plusDI: isNaN(plusDI) ? null : Number(plusDI.toFixed(1)),
            minusDI: isNaN(minusDI) ? null : Number(minusDI.toFixed(1)),
            trendStrength: isNaN(adx) ? 'N/A' : adx > 50 ? 'Very Strong' : adx > 25 ? 'Strong' : adx > 20 ? 'Moderate' : 'Weak',
            bullish: !isNaN(plusDI) && !isNaN(minusDI) && plusDI > minusDI,
          },
          atr: isNaN(atr) ? null : Number(atr.toFixed(2)),
          rsi: isNaN(rsi) ? null : Number(rsi.toFixed(1)),
          volume: (() => {
            const hasVol = h1.some((c: any) => (c.volume ?? 0) > 0);
            if (!hasVol) return null;
            const lastVol = h1[h1.length - 1].volume ?? 0;
            const volSmaArr = calcVolumeSMA(h1, 20);
            const volSma20 = volSmaArr[volSmaArr.length - 1];
            const obv = calcOBV(h1);
            const lastOBV = obv[obv.length - 1];
            const prevOBV = obv.length > 1 ? obv[obv.length - 2] : lastOBV;
            const vwapArr = calcVWAP(h1.slice(-50));
            const vwapVal = vwapArr[vwapArr.length - 1];
            return {
              current: Math.round(lastVol),
              sma20: !isNaN(volSma20) ? Math.round(volSma20) : null,
              ratio: !isNaN(volSma20) && volSma20 > 0 ? Number((lastVol / volSma20).toFixed(2)) : null,
              status: !isNaN(volSma20) && volSma20 > 0
                ? (lastVol / volSma20 > 1.5 ? 'High' : lastVol / volSma20 > 1.0 ? 'Above Avg' : lastVol / volSma20 > 0.5 ? 'Below Avg' : 'Low')
                : 'N/A',
              obv: Math.round(lastOBV),
              obvTrend: lastOBV > prevOBV ? 'Rising' : lastOBV < prevOBV ? 'Falling' : 'Flat',
              vwap: !isNaN(vwapVal) ? Number(vwapVal.toFixed(2)) : null,
              priceAboveVWAP: !isNaN(vwapVal) && currentPrice > vwapVal,
            };
          })(),
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Saved Strategies Endpoints ──────────────────────────────────
  app.get("/api/strategies", async (req, res) => {
    try {
      const strategies = await storage.listStrategies();
      res.json(strategies);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/strategies", async (req, res) => {
    try {
      const { name, category, config, stats, diagnostics, notes } = req.body;
      if (!name || !config || !stats) {
        return res.status(400).json({ error: "name, config, and stats are required" });
      }
      const id = `strat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const strategy = await storage.saveStrategy({
        id,
        name,
        category: category || '',
        config,
        stats,
        diagnostics: diagnostics || undefined,
        notes: notes || undefined,
        createdAt: new Date().toISOString(),
      });
      res.json(strategy);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/strategies/:id", async (req, res) => {
    try {
      await storage.deleteStrategy(req.params.id);
      res.json({ deleted: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/strategies/:id/export/ctrader", async (req, res) => {
    try {
      const strategies = await storage.listStrategies();
      const strategy = strategies.find(s => s.id === req.params.id);
      if (!strategy) return res.status(404).json({ error: "Strategy not found" });
      const code = generateCTraderBot(strategy);
      const safeName = strategy.name.replace(/[^a-zA-Z0-9_-]/g, "_");

      if (isCompilerAvailable()) {
        try {
          const algoBuffer = compileCTraderBot(code, safeName);
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Content-Disposition", `attachment; filename="${safeName}.algo"`);
          res.send(algoBuffer);
          return;
        } catch (compileErr: any) {
          console.error("[ctrader-compile] Compilation failed, falling back to .cs:", compileErr.message);
        }
      }

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}.cs"`);
      res.send(Buffer.from(code, "utf-8"));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/strategies/:id/export/json", async (req, res) => {
    try {
      const strategies = await storage.listStrategies();
      const strategy = strategies.find(s => s.id === req.params.id);
      if (!strategy) return res.status(404).json({ error: "Strategy not found" });
      const json = generateStrategyJSON(strategy);
      const filename = strategy.name.replace(/[^a-zA-Z0-9_-]/g, "_") + ".strategy.json";
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(json);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/strategies/:id/export/pdf", async (req, res) => {
    try {
      const strategies = await storage.listStrategies();
      const strategy = strategies.find(s => s.id === req.params.id);
      if (!strategy) return res.status(404).json({ error: "Strategy not found" });
      const pdfBuffer = await generateStrategyPDF(strategy);
      const filename = strategy.name.replace(/[^a-zA-Z0-9_-]/g, "_") + "_Report.pdf";
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(pdfBuffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/strategies/:id/validate", async (req, res) => {
    try {
      const strategies = await storage.listStrategies();
      const strategy = strategies.find(s => s.id === req.params.id);
      if (!strategy) return res.status(404).json({ error: "Strategy not found" });
      const warnings = validateStrategy(strategy.config);
      const riskRating = getRiskRating(strategy.config, warnings);
      res.json({ riskRating, warnings, totalWarnings: warnings.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Batch Sweep — background job with polling ───
  let sweepProgress: {
    running: boolean;
    current: number;
    total: number;
    validResults: number;
    newSaved: number;
    bestReturnPct: number;
    done: boolean;
    error?: string;
    result?: any;
  } | null = null;

  app.post("/api/batch-sweep", async (req, res) => {
    try {
      if (sweepProgress?.running) {
        return res.status(409).json({ error: "Sweep already running", progress: sweepProgress });
      }

      await ensureDataReady();
      const cached = getCachedData();
      if (cached.h1.length === 0 || cached.h4.length === 0 || cached.daily.length === 0) {
        return res.status(400).json({ error: "No market data available." });
      }

      const data = {
        m1: cached.m1, m15: cached.m15, h1: cached.h1, h4: cached.h4, daily: cached.daily,
        events: cached.events.map(e => ({ timestamp: e.timestamp })),
        gvz: cached.gvz.map((g: any) => ({ date: g.date, value: Number(g.value) })),
        cot: cached.cot.map((c: any) => ({ date: c.date, noncommLong: c.noncommLong, noncommShort: c.noncommShort, netPosition: c.netPosition, openInterest: c.openInterest })),
        sge: cached.sge?.map((s: any) => ({ date: s.date, premium: Number(s.premium) })),
      };

      const maxDD = req.body.maxDD || 25;
      const existingResults = await storage.listBacktestResults();
      const sorted = maxDD < 25
        ? [...existingResults].filter(r => r.stats.maxDrawdownPct <= maxDD && r.stats.maxDrawdownPct > 0).sort((a, b) => b.stats.returnPct - a.stats.returnPct)
        : [...existingResults].sort((a, b) => b.stats.returnPct - a.stats.returnPct);
      const currentBest = sorted[0]?.stats.returnPct || 0;
      const seedConfigs = sorted.slice(0, 5).map(r => r.config);

      if (seedConfigs.length === 0) {
        return res.status(400).json({ error: "No existing backtests to improve upon. Run some backtests first." });
      }

      const mutateParam = (val: number, range: [number, number], steps: number[]): number[] => {
        return steps.map(s => Math.max(range[0], Math.min(range[1], Math.round((val + s) * 1000) / 1000)));
      };

      const allConfigs: any[] = [];
      const seen = new Set<string>();

      for (const seed of seedConfigs) {
        const mutations: Record<string, { range: [number, number]; steps: number[] }> = {
          rewardRatio: { range: [2, 6], steps: [-0.5, -0.25, 0.25, 0.5, 1] },
          atrStopMultiplier: { range: [1.5, 5], steps: [-0.5, -0.25, 0.25, 0.5] },
          riskPerTradePct: { range: [0.25, 2], steps: [-0.25, 0.25, 0.5] },
          compressionThreshold: { range: [0.01, 0.04], steps: [-0.004, -0.002, 0.002, 0.004] },
          rangeWidthBars: { range: [4, 16], steps: [-2, -1, 1, 2] },
          midpointBandPct: { range: [0.04, 0.15], steps: [-0.02, -0.01, 0.01, 0.02] },
          retestBuffer: { range: [4, 20], steps: [-2, -1, 1, 2] },
          expansionThreshold: { range: [1.0, 1.5], steps: [-0.05, -0.025, 0.025, 0.05, 0.1] },
          wickRatio: { range: [0.3, 0.9], steps: [-0.1, -0.05, 0.05, 0.1] },
          leverage: { range: [5, 20], steps: [5, 10] },
          entryWindowBars: { range: [0, 6], steps: [-1, 1, 2] },
          atrRiskScaleThreshold: { range: [0.8, 1.8], steps: [-0.15, -0.05, 0.05, 0.15] },
          atrRiskScaleFactor: { range: [0.2, 0.8], steps: [-0.15, -0.05, 0.05, 0.15] },
          secondTradeRiskFactor: { range: [0.25, 1], steps: [-0.25, 0.25] },
        };

        for (const [param, { range, steps }] of Object.entries(mutations)) {
          const currentVal = (seed as any)[param];
          if (currentVal === undefined) continue;
          const variants = mutateParam(currentVal, range, steps);
          for (const v of variants) {
            if (v === currentVal) continue;
            const cfg = { ...seed, [param]: v };
            const key = `${cfg.rewardRatio}_${cfg.atrStopMultiplier}_${cfg.riskPerTradePct}_${cfg.compressionThreshold}_${cfg.rangeWidthBars}_${cfg.midpointBandPct}_${cfg.retestBuffer}_${cfg.expansionThreshold}_${cfg.wickRatio}_${cfg.leverage}_${cfg.entryWindowBars}_${cfg.sessionMode}_${cfg.atrRiskScaleThreshold}_${cfg.atrRiskScaleFactor}_${cfg.secondTradeRiskFactor}`;
            if (!seen.has(key)) {
              seen.add(key);
              allConfigs.push(cfg);
            }
          }
        }

        for (const session of ["London+NewYork", "London", "Asian+London+NewYork"]) {
          if (session !== seed.sessionMode) {
            const cfg = { ...seed, sessionMode: session };
            const key = `session_${session}_${JSON.stringify(seed).slice(0, 50)}`;
            if (!seen.has(key)) { seen.add(key); allConfigs.push(cfg); }
          }
        }

        const combo1 = { ...seed, rewardRatio: (seed.rewardRatio || 3.5) + 0.5, riskPerTradePct: Math.min(2, (seed.riskPerTradePct || 1) + 0.25) };
        const combo2 = { ...seed, atrStopMultiplier: Math.max(1.5, (seed.atrStopMultiplier || 3) - 0.5), rewardRatio: (seed.rewardRatio || 3.5) + 0.5 };
        const combo3 = { ...seed, compressionThreshold: (seed.compressionThreshold || 0.02) + 0.003, rangeWidthBars: Math.max(4, (seed.rangeWidthBars || 8) - 1) };
        const combo4 = { ...seed, leverage: Math.min(20, (seed.leverage || 10) + 5), riskPerTradePct: (seed.riskPerTradePct || 1) };
        [combo1, combo2, combo3, combo4].forEach(c => {
          const key = `combo_${JSON.stringify(c).slice(0, 80)}`;
          if (!seen.has(key)) { seen.add(key); allConfigs.push(c); }
        });
      }

      const totalConfigs = allConfigs.length;
      sweepProgress = { running: true, current: 0, total: totalConfigs, validResults: 0, newSaved: 0, bestReturnPct: currentBest, done: false };
      res.json({ started: true, total: totalConfigs, currentBest });

      (async () => {
        try {
          console.log(`[Hill-Climb Sweep] Seeded from top ${seedConfigs.length} configs (current best: ${currentBest}%). Testing ${totalConfigs} mutations...`);
          const improvements: any[] = [];
          let errors = 0;

          for (let i = 0; i < allConfigs.length; i++) {
            sweepProgress!.current = i + 1;
            try {
              const result = runBacktest(allConfigs[i], data);
              if (result.stats.totalTrades < 5) continue;

              const isDup = existingResults.some(e =>
                e.stats.returnPct === result.stats.returnPct &&
                e.stats.maxDrawdownPct === result.stats.maxDrawdownPct &&
                e.stats.totalTrades === result.stats.totalTrades &&
                e.stats.netPnl === result.stats.netPnl
              );

              if (result.stats.returnPct > currentBest * 0.9 && (maxDD >= 25 || result.stats.maxDrawdownPct <= maxDD)) {
                if (!isDup) {
                  await storage.saveBacktestResult(result);
                  existingResults.push(result);
                  sweepProgress!.newSaved++;
                }

                const rdd = result.stats.maxDrawdownPct > 0 ? result.stats.returnPct / result.stats.maxDrawdownPct : 0;
                improvements.push({
                  config: allConfigs[i],
                  returnPct: result.stats.returnPct,
                  maxDrawdownPct: result.stats.maxDrawdownPct,
                  returnDD: Math.round(rdd * 100) / 100,
                  totalTrades: result.stats.totalTrades,
                  winRate: result.stats.winRate,
                  profitFactor: result.stats.profitFactor,
                  isNewBest: result.stats.returnPct > currentBest,
                });
              }

              sweepProgress!.validResults = improvements.length;
              if (result.stats.returnPct > sweepProgress!.bestReturnPct) {
                sweepProgress!.bestReturnPct = result.stats.returnPct;
                console.log(`[Hill-Climb] NEW BEST: ${result.stats.returnPct}% ret / ${result.stats.maxDrawdownPct}% DD (beat ${currentBest}%)`);
              }
            } catch (e: any) {
              errors++;
              if (errors <= 3) console.warn(`[Hill-Climb] Config ${i} error: ${e.message}`);
            }

            if (i % 5 === 0) {
              await new Promise(r => setTimeout(r, 10));
            }
            if (i % 20 === 0) {
              console.log(`[Hill-Climb] Progress: ${i + 1}/${totalConfigs} | ${improvements.length} near-best | Best: ${sweepProgress!.bestReturnPct}%`);
            }
          }

          improvements.sort((a, b) => b.returnPct - a.returnPct);
          const top10 = improvements.slice(0, 10);
          const newBests = improvements.filter(r => r.isNewBest);

          const strategies = await storage.listStrategies();
          const savedStrategies: string[] = [];
          for (const r of newBests.slice(0, 3)) {
            const alreadySaved = strategies.some(s =>
              s.stats.returnPct === r.returnPct && s.stats.maxDrawdownPct === r.maxDrawdownPct
            );
            if (alreadySaved) continue;
            const id = `climb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            await storage.saveStrategy({
              id,
              name: `Hill-Climb ${r.returnPct}% ret / ${r.maxDrawdownPct}% DD (${r.config.sessionMode})`,
              category: r.returnDD >= 8 ? "HIGH" : r.returnDD >= 4 ? "MED" : "LOW",
              config: r.config,
              stats: {
                totalTrades: r.totalTrades, winRate: r.winRate, netPnl: 0,
                returnPct: r.returnPct, profitFactor: r.profitFactor, maxDrawdown: 0,
                maxDrawdownPct: r.maxDrawdownPct, avgR: 0,
                wins: 0, losses: 0, rangeTrades: 0, trendTrades: 0, noTradeBarCount: 0,
                rangeWins: 0, rangeLosses: 0, trendWins: 0, trendLosses: 0,
                rangePnl: 0, trendPnl: 0, rangeWinRate: 0, trendWinRate: 0,
                finalBalance: 0, avgHoldingBars: 0, consecutiveWins: 0, consecutiveLosses: 0,
              },
              notes: `Hill-climb from ${currentBest}% best — only saved because it beat it`,
              createdAt: new Date().toISOString(),
            });
            savedStrategies.push(id);
          }

          sweepProgress!.running = false;
          sweepProgress!.done = true;
          sweepProgress!.result = {
            totalTested: totalConfigs,
            previousBest: currentBest,
            newBest: sweepProgress!.bestReturnPct,
            improved: sweepProgress!.bestReturnPct > currentBest,
            newBestsFound: newBests.length,
            nearBestResults: improvements.length,
            newSaved: sweepProgress!.newSaved,
            strategiesCreated: savedStrategies,
            top10,
          };
          console.log(`[Hill-Climb] Done: ${totalConfigs} tested | Previous best: ${currentBest}% | New best: ${sweepProgress!.bestReturnPct}% | ${newBests.length} improvements found | ${savedStrategies.length} strategies saved`);
        } catch (err: any) {
          console.error("[Hill-Climb] Error:", err);
          sweepProgress!.running = false;
          sweepProgress!.done = true;
          sweepProgress!.error = err.message;
        }
      })();
    } catch (err: any) {
      console.error("[Hill-Climb] Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/batch-sweep/progress", (_req, res) => {
    res.json(sweepProgress || { running: false, done: false });
  });

  // ─── AI-Driven Optimization Loop ──────────────────────────────────
  let aiOptProgress: {
    running: boolean;
    round: number;
    totalRounds: number;
    testsThisRound: number;
    totalTestsThisRound: number;
    globalBest: number;
    improvements: number;
    done: boolean;
    error?: string;
    log: string[];
    result?: any;
  } | null = null;

  app.post("/api/ai-optimize", async (req, res) => {
    try {
      if (aiOptProgress?.running) {
        return res.status(409).json({ error: "AI optimization already running", progress: aiOptProgress });
      }

      await ensureDataReady();
      const cached = getCachedData();
      if (cached.h1.length === 0 || cached.h4.length === 0) {
        return res.status(400).json({ error: "No market data available." });
      }

      const data = {
        m1: cached.m1, m15: cached.m15, h1: cached.h1, h4: cached.h4, daily: cached.daily,
        events: cached.events.map(e => ({ timestamp: e.timestamp })),
        gvz: cached.gvz.map((g: any) => ({ date: g.date, value: Number(g.value) })),
        cot: cached.cot.map((c: any) => ({ date: c.date, noncommLong: c.noncommLong, noncommShort: c.noncommShort, netPosition: c.netPosition, openInterest: c.openInterest })),
        sge: cached.sge?.map((s: any) => ({ date: s.date, premium: Number(s.premium) })),
      };

      const rounds = Math.min(req.body.rounds || 5, 10);
      const existingResults = await storage.listBacktestResults();
      const sorted = [...existingResults].sort((a, b) => b.stats.returnPct - a.stats.returnPct);
      const globalBestStart = sorted[0]?.stats.returnPct || 0;

      aiOptProgress = {
        running: true, round: 0, totalRounds: rounds,
        testsThisRound: 0, totalTestsThisRound: 0,
        globalBest: globalBestStart, improvements: 0,
        done: false, log: [`Starting AI optimization: ${rounds} rounds, current best ${globalBestStart}%`],
      };

      res.json({ started: true, rounds, currentBest: globalBestStart });

      (async () => {
        try {
          let globalBest = globalBestStart;
          let bestConfig = sorted[0]?.config || {};
          let bestStats: any = sorted[0]?.stats || null;
          let bestBacktestId: string | undefined = sorted[0]?.id;
          const allLearnings: string[] = [];

          for (let round = 1; round <= rounds; round++) {
            aiOptProgress!.round = round;
            aiOptProgress!.log.push(`\n── Round ${round}/${rounds} ──`);
            console.log(`[AI-Optimize] Round ${round}/${rounds} starting. Best: ${globalBest}%`);

            const recentResults = await storage.listBacktestResults();
            const topResults = [...recentResults].sort((a, b) => b.stats.returnPct - a.stats.returnPct).slice(0, 5);
            const worstResults = [...recentResults].sort((a, b) => a.stats.returnPct - b.stats.returnPct).slice(0, 3);

            const existingLearnings = await storage.getLearnings(undefined, 0.3);
            const backtestLearnings = existingLearnings.filter(l =>
              l.category === 'optimization' || l.category === 'backtest_insight'
            ).slice(0, 40);

            const prompt = `You are an elite XAUUSD (gold) trading strategy optimizer. Your goal is to find the best risk-adjusted returns while respecting hard constraints.

HARD CONSTRAINTS (non-negotiable):
- Leverage is FIXED at 10x (margin only, not applied to position sizing)
- Max drawdown must stay under 25%
- Starting balance: $3,000
- Lot size: 0.01 (1 micro lot on cTrader)
- Position sizing: lotSize = riskAmount / stopDistance (NO leverage multiplier)

CURRENT BEST: ${globalBest}% return

TOP 5 RESULTS (proven winners — study these carefully):
${topResults.map((r, i) => `#${i+1}: ${r.stats.returnPct}% ret, ${r.stats.maxDrawdownPct}% DD, ${r.stats.totalTrades} trades, ${r.stats.winRate}% WR, PF=${r.stats.profitFactor}
  Config: RR=${r.config.rewardRatio}, ATRstop=${r.config.atrStopMultiplier}, risk=${r.config.riskPerTradePct}%, compression=${r.config.compressionThreshold}, expansion=${r.config.expansionThreshold}, rangeWidth=${r.config.rangeWidthBars}, midpoint=${r.config.midpointBandPct}, wickRatio=${r.config.wickRatio}, entryWindow=${r.config.entryWindowBars}, retestBuffer=${r.config.retestBuffer}, atrRiskScale=${r.config.atrRiskScaleFactor}, atrRiskThreshold=${r.config.atrRiskScaleThreshold}, 2ndTradeRisk=${r.config.secondTradeRiskFactor}, session=${r.config.sessionMode}, maxConsecLosses=${r.config.maxConsecutiveLosses}, spread=${r.config.spreadPoints}, slippage=${r.config.slippagePoints}, maxTrades=${r.config.maxTradesPerDay}`).join('\n')}

WORST 3 RESULTS (avoid these patterns):
${worstResults.map((r, i) => `#${i+1}: ${r.stats.returnPct}% ret, ${r.stats.maxDrawdownPct}% DD, ${r.stats.totalTrades} trades, PF=${r.stats.profitFactor}
  Config: RR=${r.config.rewardRatio}, ATRstop=${r.config.atrStopMultiplier}, risk=${r.config.riskPerTradePct}%, compression=${r.config.compressionThreshold}, expansion=${r.config.expansionThreshold}, rangeWidth=${r.config.rangeWidthBars}, entryWindow=${r.config.entryWindowBars}, session=${r.config.sessionMode}`).join('\n')}

${backtestLearnings.length > 0 ? `ACCUMULATED OPTIMIZATION INTELLIGENCE:\n${backtestLearnings.map(l => `- [${l.category}] ${l.insight} (confidence: ${l.confidence}, reinforced: ${l.times_reinforced}x)`).join('\n')}` : ''}

${allLearnings.length > 0 ? `SESSION LEARNINGS:\n${allLearnings.join('\n')}` : ''}

TUNABLE PARAMETER SPACE (leverage is NOT tunable — fixed at 10):
- rewardRatio: 2-8 (R:R on each trade)
- atrStopMultiplier: 1.0-5.0 (stop distance as multiple of ATR)
- riskPerTradePct: 1.0-10.0 (% of balance risked per trade — higher risk = more aggressive)
- compressionThreshold: 0.005-0.05 (BB width below this = range regime)
- expansionThreshold: 0.8-2.0 (ATR ratio above this = trend regime)
- rangeWidthBars: 3-20 (H4 lookback for range boundaries)
- midpointBandPct: 0.02-0.25 (dead zone width around range midpoint)
- wickRatio: 0.1-0.9 (minimum wick-to-body ratio for rejection candles)
- entryWindowBars: 0-8 (0=immediate entry on signal)
- retestBuffer: 2-30 (breakout retest pts)
- atrRiskScaleFactor: 0.2-1.0 (risk multiplier during high vol)
- atrRiskScaleThreshold: 0.3-2.5 (ATR threshold for risk scaling)
- secondTradeRiskFactor: 0.25-1.0 (risk multiplier for 2nd concurrent trade)
- maxConsecutiveLosses: 2-6 (halt after N consecutive losses)
- reduceSizeAfterLoss: true/false (halve risk after a loss)
- trailingStopEnabled: true/false (enable trailing stop)
- trailingStopTriggerR: 1.0-2.0 (R-multiple to activate trailing)
- spreadPoints: 0-0.5 (spread cost)
- slippagePoints: 0-0.3 (slippage cost)
- sessionMode: "London+NewYork" | "London" | "Asian+London+NewYork"
- maxTradesPerDay: 3-10

KEY INSIGHTS:
- More winning trades = compounding growth. A config with 10 trades at 80% WR outperforms 4 trades at 100% WR
- To get more trades: widen compressionThreshold, lower expansionThreshold, relax wickRatio, use more sessions, increase maxTradesPerDay
- Higher riskPerTradePct (5-10%) amplifies returns but watch drawdown — keep DD under 25%
- Tight stops (ATR 1.5-2.0) + high RR (3-5) + moderate-high risk = strong compounding
- Safety nets (reduceSizeAfterLoss, atrRiskScale) protect against drawdown spirals
- Trailing stops can lock in outsized moves on trend trades

STRATEGY: Generate 8 configurations. Make 4 aggressive variants near the current best (small mutations). Make 4 bold experiments targeting more trades or different risk profiles. Keep drawdown realistic (under 25%).

Respond with ONLY a JSON array of 8 objects (DO NOT include leverage — it is fixed):
{"rewardRatio":4,"atrStopMultiplier":2.0,"riskPerTradePct":5,"compressionThreshold":0.022,"expansionThreshold":1.15,"rangeWidthBars":7,"midpointBandPct":0.1,"wickRatio":0.5,"entryWindowBars":2,"retestBuffer":12,"atrRiskScaleFactor":0.65,"atrRiskScaleThreshold":1.25,"secondTradeRiskFactor":0.75,"maxConsecutiveLosses":4,"reduceSizeAfterLoss":false,"trailingStopEnabled":false,"trailingStopTriggerR":1.5,"spreadPoints":0.3,"slippagePoints":0.1,"sessionMode":"London","maxTradesPerDay":5,"hypothesis":"why this might work"}`;

            let suggestions: any[] = [];
            try {
              const aiRes = await openai.chat.completions.create({
                model: AI_MODEL,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.8,
                max_tokens: 4000,
              });

              const raw = aiRes.choices[0]?.message?.content || "[]";
              const jsonMatch = raw.match(/\[[\s\S]*\]/);
              if (jsonMatch) {
                suggestions = JSON.parse(jsonMatch[0]);
                const { sanitizeAnalysisStrings } = await import("./ai-advisor");
                for (const s of suggestions) sanitizeAnalysisStrings(s);
              }
            } catch (e: any) {
              aiOptProgress!.log.push(`AI suggestion failed: ${e.message}`);
              console.error(`[AI-Optimize] AI call failed:`, e.message);
              continue;
            }

            if (!Array.isArray(suggestions) || suggestions.length === 0) {
              aiOptProgress!.log.push(`No valid suggestions from AI in round ${round}`);
              continue;
            }

            aiOptProgress!.totalTestsThisRound = suggestions.length;
            aiOptProgress!.testsThisRound = 0;

            const roundResults: { config: any; stats: any; hypothesis: string }[] = [];

            for (let i = 0; i < suggestions.length; i++) {
              aiOptProgress!.testsThisRound = i + 1;
              const s = suggestions[i];
              const hypothesis = s.hypothesis || "No hypothesis provided";

              const fullConfig: any = {
                startDate: "2026-01-01",
                endDate: "2026-04-08",
                lotSize: 0.01,
                atrPeriod: 14,
                atrStopPeriod: 14,
                atrStopMultiplier: s.atrStopMultiplier ?? 2.0,
                rewardRatio: s.rewardRatio ?? 4,
                compressionThreshold: s.compressionThreshold ?? 0.022,
                expansionThreshold: s.expansionThreshold ?? 1.15,
                rangeWidthBars: s.rangeWidthBars ?? 7,
                midpointBandPct: s.midpointBandPct ?? 0.1,
                entryWindowBars: s.entryWindowBars ?? 2,
                wickRatio: s.wickRatio ?? 0.5,
                sessionMode: s.sessionMode ?? "London",
                sessionORBEnabled: true,
                riskPerTradePct: Math.min(s.riskPerTradePct ?? 5, 10),
                leverage: 10,
                maxDrawdownPct: 25,
                maxDailyLossPct: 8,
                maxConsecutiveLosses: s.maxConsecutiveLosses ?? 4,
                maxTradesPerDay: s.maxTradesPerDay ?? 5,
                trailingStopEnabled: s.trailingStopEnabled ?? false,
                trailingStopTriggerR: s.trailingStopTriggerR ?? 1.5,
                startingBalance: 3000,
                retestBuffer: s.retestBuffer ?? 12,
                minRangeATR: 1.5,
                maxTrendATRRatio: 5.0,
                reduceSizeAfterLoss: s.reduceSizeAfterLoss ?? false,
                reducedRiskPerTradePct: 0.5,
                gapFilterEnabled: true,
                gapThresholdAtr: 0.5,
                gapCooldownBars: 2,
                postLossCooldownBars: 2,
                atrRiskScaleEnabled: true,
                atrRiskScaleFactor: s.atrRiskScaleFactor ?? 0.65,
                atrRiskScaleThreshold: s.atrRiskScaleThreshold ?? 1.25,
                regimeAdaptiveSizing: false,
                secondTradeRiskFactor: s.secondTradeRiskFactor ?? 0.75,
                newsBeforeMin: 30,
                newsAfterMin: 30,
                ema200FilterEnabled: false,
                spreadPoints: s.spreadPoints ?? 0.3,
                slippagePoints: s.slippagePoints ?? 0.1,
                commissionPerLot: 0,
                gvzEnabled: false,
                cotEnabled: false,
                avoidHoursEnabled: false,
                peakHoursEnabled: false,
                mrsGarchEnabled: false,
              };

              try {
                const result = runBacktest(fullConfig, data);
                const st = result.stats;

                const existingAll = await storage.listBacktestResults();
                const archivedAll = await storage.listArchivedBacktests();
                const allExist = [...existingAll, ...archivedAll];
                const isDup = allExist.some(e =>
                  e.stats.returnPct === st.returnPct &&
                  e.stats.maxDrawdownPct === st.maxDrawdownPct &&
                  e.stats.totalTrades === st.totalTrades &&
                  e.stats.netPnl === st.netPnl
                );

                if (!isDup) {
                  await storage.saveBacktestResult(result);
                  if (st.maxDrawdownPct > 25) {
                    await storage.archiveBacktestResult(result.id, 'exceeds_max_drawdown');
                  }
                }

                const improved = st.returnPct > globalBest && st.maxDrawdownPct <= 25;
                const logLine = `  Test ${i+1}: ${st.returnPct}% ret, ${st.maxDrawdownPct}% DD, ${st.totalTrades}t, ${st.winRate}%WR, PF=${st.profitFactor} ${improved ? "★ NEW BEST" : ""} | ${hypothesis}`;
                aiOptProgress!.log.push(logLine);
                console.log(`[AI-Optimize] R${round} ${logLine}`);

                roundResults.push({ config: fullConfig, stats: st, hypothesis });

                if (improved) {
                  globalBest = st.returnPct;
                  bestConfig = fullConfig;
                  bestStats = st;
                  bestBacktestId = result.id;
                  aiOptProgress!.globalBest = globalBest;
                  aiOptProgress!.improvements++;
                }
              } catch (e: any) {
                aiOptProgress!.log.push(`  Test ${i+1}: ERROR — ${e.message}`);
              }

              await new Promise(r => setTimeout(r, 10));
            }

            roundResults.sort((a, b) => b.stats.returnPct - a.stats.returnPct);
            const best = roundResults[0];
            const worst = roundResults[roundResults.length - 1];

            if (best && worst) {
              const learnings: string[] = [];

              if (best.stats.returnPct > globalBestStart) {
                learnings.push(`Round ${round}: IMPROVEMENT found. ${best.stats.returnPct}% return (was ${globalBestStart}%). Hypothesis: ${best.hypothesis}`);
              }

              const diffKeys = ['rewardRatio', 'atrStopMultiplier', 'riskPerTradePct', 'leverage',
                'compressionThreshold', 'expansionThreshold', 'rangeWidthBars', 'midpointBandPct',
                'wickRatio', 'entryWindowBars', 'retestBuffer', 'atrRiskScaleFactor',
                'atrRiskScaleThreshold', 'secondTradeRiskFactor', 'maxConsecutiveLosses', 'sessionMode', 'maxTradesPerDay'];
              
              const bestVsWorst: string[] = [];
              for (const k of diffKeys) {
                if (best.config[k] !== worst.config[k]) {
                  bestVsWorst.push(`${k}: best=${best.config[k]} vs worst=${worst.config[k]}`);
                }
              }

              if (bestVsWorst.length > 0) {
                const insightText = `Round ${round} best (${best.stats.returnPct}%) vs worst (${worst.stats.returnPct}%): ${bestVsWorst.join(', ')}`;
                learnings.push(insightText);
                await storage.saveLearning('optimization', insightText, 0.7, { round, best: best.stats, worst: worst.stats });
              }

              if (best.stats.totalTrades > worst.stats.totalTrades + 2) {
                const insightTrades = `More trades correlated with higher returns: ${best.stats.totalTrades}t=${best.stats.returnPct}% vs ${worst.stats.totalTrades}t=${worst.stats.returnPct}%`;
                learnings.push(insightTrades);
                await storage.saveLearning('backtest_insight', insightTrades, 0.6, { round });
              }

              if (best.stats.profitFactor > worst.stats.profitFactor + 1) {
                await storage.saveLearning('backtest_insight', 
                  `Higher profit factor (${best.stats.profitFactor} vs ${worst.stats.profitFactor}) correlated with better returns. Config: RR=${best.config.rewardRatio}, ATRstop=${best.config.atrStopMultiplier}`,
                  0.65, { round });
              }

              const highRetResults = roundResults.filter(r => r.stats.returnPct > globalBestStart * 0.9);
              if (highRetResults.length >= 2) {
                const commonParams: string[] = [];
                for (const k of diffKeys) {
                  const vals = highRetResults.map(r => r.config[k]);
                  if (vals.every(v => v === vals[0])) {
                    commonParams.push(`${k}=${vals[0]}`);
                  }
                }
                if (commonParams.length > 0) {
                  const insight = `Common params in top results round ${round}: ${commonParams.join(', ')}`;
                  await storage.saveLearning('optimization', insight, 0.75, { round, count: highRetResults.length });
                  learnings.push(insight);
                }
              }

              allLearnings.push(...learnings);
              aiOptProgress!.log.push(`  Round ${round} learnings: ${learnings.length} insights saved`);
              console.log(`[AI-Optimize] Round ${round} done. Best this round: ${best.stats.returnPct}%, ${learnings.length} learnings saved`);
            }
          }

          let promotion: any = null;
          try {
            const meaningful = globalBest > globalBestStart * 1.05 && globalBest - globalBestStart >= 5;
            const withinLimits = bestStats
              && Number(bestStats.maxDrawdownPct) <= 25
              && Number(bestConfig.leverage) <= 10
              && Number(bestConfig.startingBalance ?? 3000) >= 3000
              && Number(bestStats.totalTrades) >= 10
              && Number(bestStats.profitFactor) >= 1.2;

            if (meaningful && withinLimits && bestStats) {
              const ret = Number(bestStats.returnPct);
              const category = ret >= 100 ? "HIGH" : ret >= 30 ? "MED" : "LOW";
              const stamp = new Date().toISOString().slice(0, 10);
              const baseName = `AI Discovery ${stamp} — ${ret.toFixed(1)}% / ${Number(bestStats.maxDrawdownPct).toFixed(1)}% DD`;
              let name = baseName;
              let suffix = 1;
              while (await storage.getStrategyByName(name)) {
                suffix++;
                name = `${baseName} (v${suffix})`;
              }

              const stratId = `strat-ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
              await storage.saveStrategy({
                id: stratId,
                name,
                category,
                config: bestConfig as any,
                stats: bestStats,
                notes: `Auto-promoted by AI-Optimize. Beat previous best ${globalBestStart.toFixed(2)}% → ${ret.toFixed(2)}%. Awaiting user authorization to go live.`,
                createdAt: new Date().toISOString(),
              });

              const currentParams = await getLockedParams();
              const proposedParams: Record<string, any> = { ...currentParams };
              const proposalKeys = ['rewardRatio', 'atrStopMultiplier', 'riskPerTradePct',
                'compressionThreshold', 'expansionThreshold', 'rangeWidthBars', 'midpointBandPct',
                'wickRatio', 'entryWindowBars', 'retestBuffer', 'atrRiskScaleFactor',
                'atrRiskScaleThreshold', 'secondTradeRiskFactor', 'maxConsecutiveLosses',
                'sessionMode', 'maxTradesPerDay'];
              const changedKeys: string[] = [];
              for (const k of proposalKeys) {
                if ((bestConfig as any)[k] !== undefined && (bestConfig as any)[k] !== currentParams[k]) {
                  proposedParams[k] = (bestConfig as any)[k];
                  changedKeys.push(k);
                }
              }
              proposedParams.leverage = 10;
              proposedParams.maxDrawdownPct = 25;

              if (changedKeys.length > 0) {
                const proposalId = `prop-ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const currentBacktest = await storage.getBacktestResult(bestBacktestId || "");
                await storage.saveLockedParamsProposal({
                  id: proposalId,
                  createdAt: new Date().toISOString(),
                  source: "ai-optimize",
                  currentParams,
                  proposedParams,
                  changedKeys,
                  currentStats: {
                    returnPct: Number(sorted[0]?.stats.returnPct || 0),
                    maxDrawdownPct: Number(sorted[0]?.stats.maxDrawdownPct || 0),
                    winRate: Number(sorted[0]?.stats.winRate || 0),
                    totalTrades: Number(sorted[0]?.stats.totalTrades || 0),
                    profitFactor: Number(sorted[0]?.stats.profitFactor || 0),
                  },
                  proposedStats: {
                    returnPct: Number(bestStats.returnPct),
                    maxDrawdownPct: Number(bestStats.maxDrawdownPct),
                    winRate: Number(bestStats.winRate),
                    totalTrades: Number(bestStats.totalTrades),
                    profitFactor: Number(bestStats.profitFactor),
                  },
                  rationale: `AI-Optimize discovered "${name}" with ${ret.toFixed(2)}% return, ${Number(bestStats.maxDrawdownPct).toFixed(2)}% DD, PF ${Number(bestStats.profitFactor).toFixed(2)}, ${bestStats.totalTrades} trades. Improvement of ${(ret - globalBestStart).toFixed(2)}pp over previous best (${globalBestStart.toFixed(2)}%). Hard limits respected: leverage=10, maxDD≤25%. Approve to apply to live trading.`,
                  status: "pending",
                  backtestId: bestBacktestId,
                });
                promotion = { strategyId: stratId, name, category, proposalId, changedKeys };
                aiOptProgress!.log.push(`★ PROMOTED: "${name}" saved to catalogue. Proposal ${proposalId} pending user authorization.`);
                console.log(`[AI-Optimize] Auto-promoted "${name}" → strat ${stratId}, proposal ${proposalId} (changes: ${changedKeys.join(", ")})`);
              } else {
                promotion = { strategyId: stratId, name, category, proposalId: null, note: "No locked-param changes vs current live config" };
                aiOptProgress!.log.push(`★ PROMOTED: "${name}" saved to catalogue. No live param changes needed.`);
              }
            } else if (globalBest > globalBestStart) {
              aiOptProgress!.log.push(`Improvement found (${globalBestStart.toFixed(2)}% → ${globalBest.toFixed(2)}%) but did not meet promotion thresholds (need ≥5pp gain, ≥10 trades, PF≥1.2, DD≤25%).`);
            }
          } catch (promoErr: any) {
            console.error("[AI-Optimize] Auto-promotion error:", promoErr);
            aiOptProgress!.log.push(`Auto-promotion error: ${promoErr.message}`);
          }

          aiOptProgress!.running = false;
          aiOptProgress!.done = true;
          aiOptProgress!.result = {
            totalRounds: rounds,
            startBest: globalBestStart,
            endBest: globalBest,
            improved: globalBest > globalBestStart,
            improvements: aiOptProgress!.improvements,
            learningsSaved: allLearnings.length,
            promotion,
          };
          console.log(`[AI-Optimize] Complete: ${rounds} rounds, ${globalBestStart}% → ${globalBest}% (${aiOptProgress!.improvements} improvements)`);
        } catch (err: any) {
          console.error("[AI-Optimize] Error:", err);
          if (aiOptProgress) {
            aiOptProgress.running = false;
            aiOptProgress.done = true;
            aiOptProgress.error = err.message;
          }
        }
      })();
    } catch (err: any) {
      console.error("[AI-Optimize] Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ai-optimize/progress", (_req, res) => {
    res.json(aiOptProgress || { running: false, done: false });
  });

  // ─── cTrader Export from Config ──────────────────────────────────
  app.post("/api/strategies/export/ctrader-from-config", (req, res) => {
    try {
      const { config, stats } = req.body.config ? req.body : { config: req.body, stats: {} };
      if (!config || typeof config !== "object") return res.status(400).json({ error: "Missing config object" });
      const defaults: Record<string, any> = {
        lotSize: 0.01, leverage: 10, atrPeriod: 14, wickRatio: 0.6, rewardRatio: 2,
        sessionMode: "London+NewYork", newsAfterMin: 30, retestBuffer: 12, newsBeforeMin: 30,
        maxDrawdownPct: 25, rangeWidthBars: 8, gapCooldownBars: 2, gapThresholdAtr: 0.5,
        maxDailyLossPct: 2, maxTradesPerDay: 5, midpointBandPct: 0.1, riskPerTradePct: 1,
        startingBalance: 3000, gapFilterEnabled: true, atrStopMultiplier: 2,
        sessionORBEnabled: true, atrRiskScaleFactor: 0.65, expansionThreshold: 1.05,
        atrRiskScaleEnabled: true, reduceSizeAfterLoss: true, trailingStopEnabled: false,
        compressionThreshold: 0.022, maxConsecutiveLosses: 2, postLossCooldownBars: 2,
        trailingStopTriggerR: 1, atrRiskScaleThreshold: 1.25, secondTradeRiskFactor: 0.75,
        reducedRiskPerTradePct: 0.5, entryWindowBars: 0,
      };
      const safeConfig = { ...defaults, ...config };
      const retPct = stats?.returnPct || 0;
      const ddPct = stats?.maxDrawdownPct || 0;
      const wins = stats?.wins || Math.round((stats?.totalTrades || 0) * (stats?.winRate || 0) / 100);
      const losses = (stats?.totalTrades || 0) - wins;
      const category = retPct >= 500 ? "HIGH" : retPct >= 100 ? "MODERATE" : "LOW";
      const fakeStrategy = {
        id: "export",
        name: `GoldRegime ${retPct}% ret / ${ddPct}% DD`,
        category,
        config: safeConfig,
        stats: { returnPct: retPct, maxDrawdownPct: ddPct, totalTrades: stats?.totalTrades || 0, winRate: stats?.winRate || 0, profitFactor: stats?.profitFactor || 0, netPnl: stats?.netPnl || 0, wins, losses, avgR: stats?.avgR || 0, maxConsecutiveLosses: stats?.maxConsecutiveLosses || 0 },
        createdAt: new Date().toISOString(),
      } as any;
      const code = generateCTraderBot(fakeStrategy);

      const format = req.query.format || req.body.format || "algo";
      if (format === "source") {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.send(code);
        return;
      }
      if (format === "algo" && isCompilerAvailable()) {
        try {
          const algoBuffer = compileCTraderBot(code, `GoldRegime_${retPct}pct`);
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Content-Disposition", `attachment; filename="GoldRegime_${retPct}pct.algo"`);
          res.send(algoBuffer);
          return;
        } catch (compileErr: any) {
          console.error("[ctrader-compile] Compilation failed, falling back to .cs:", compileErr.message);
        }
      }

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="GoldRegime.cs"`);
      res.send(Buffer.from(code, "utf-8"));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/strategies/recommended", async (_req, res) => {
    try {
      const catalogue = await storage.listStrategies();
      const allStrategies = catalogue.filter((s: any) => s.stats && Number(s.stats.totalTrades) >= 1);
      if (allStrategies.length > 0) {
        const sorted = [...allStrategies].sort((a: any, b: any) => {
          const aRDD = Number(a.stats.maxDrawdownPct) > 0 ? Number(a.stats.returnPct) / Number(a.stats.maxDrawdownPct) : 0;
          const bRDD = Number(b.stats.maxDrawdownPct) > 0 ? Number(b.stats.returnPct) / Number(b.stats.maxDrawdownPct) : 0;
          return bRDD - aRDD;
        });
        const best = sorted[0] as any;
        return res.json({
          id: best.id,
          name: best.name,
          category: best.category,
          config: best.config,
          stats: best.stats,
          notes: best.notes,
          createdAt: best.createdAt,
        });
      }
      const backtests = await storage.listBacktestResults();
      if (!backtests.length) return res.status(404).json({ error: "No backtests found" });
      const qualifying = backtests.filter((b: any) => {
        const s = b.stats;
        return s && s.returnPct >= 100 && s.maxDrawdownPct <= 25 && s.totalTrades >= 10;
      });
      if (!qualifying.length) return res.status(404).json({ error: "No qualifying strategies" });
      const sorted = [...qualifying].sort((a: any, b: any) => b.stats.returnPct - a.stats.returnPct);
      const best = sorted[0] as any;
      const retPct = Number(best.stats.returnPct);
      res.json({
        id: best.id,
        name: `GoldRegime ${retPct.toFixed(0)}% ret`,
        category: retPct >= 500 ? "High Risk" : retPct >= 100 ? "Medium Risk" : "Low Risk",
        config: best.config,
        stats: best.stats,
        notes: `Backtest fallback: ${retPct.toFixed(1)}% return, ${Number(best.stats.maxDrawdownPct).toFixed(1)}% DD`,
        createdAt: best.createdAt,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  async function getRecommendedStrategyForExport(): Promise<{ id: string; name: string; category: string; config: any; stats: any; createdAt: string } | null> {
    const catalogue = await storage.listStrategies();
    const safeStrategies = catalogue.filter((s: any) => s.category === "Medium Risk" || s.category === "Low Risk");
    if (safeStrategies.length > 0) {
      const sorted = [...safeStrategies].sort((a: any, b: any) => {
        const aRDD = Number(a.stats.maxDrawdownPct) > 0 ? Number(a.stats.returnPct) / Number(a.stats.maxDrawdownPct) : 0;
        const bRDD = Number(b.stats.maxDrawdownPct) > 0 ? Number(b.stats.returnPct) / Number(b.stats.maxDrawdownPct) : 0;
        return bRDD - aRDD;
      });
      const best = sorted[0] as any;
      return { id: best.id, name: best.name, category: best.category || "Medium Risk", config: best.config, stats: best.stats, createdAt: best.createdAt };
    }
    const backtests = await storage.listBacktestResults();
    const qualifying = backtests.filter((b: any) => {
      const s = b.stats;
      return s && s.returnPct >= 100 && s.maxDrawdownPct <= 25 && s.totalTrades >= 10;
    });
    if (!qualifying.length) return null;
    const sorted = [...qualifying].sort((a: any, b: any) => b.stats.returnPct - a.stats.returnPct);
    const best = sorted[0] as any;
    const retPct = Number(best.stats.returnPct);
    return {
      id: best.id,
      name: `GoldRegime ${retPct.toFixed(0)}% ret`,
      category: retPct >= 500 ? "High Risk" : retPct >= 100 ? "Medium Risk" : "Low Risk",
      config: best.config,
      stats: best.stats,
      createdAt: best.createdAt || new Date().toISOString(),
    };
  }

  app.get("/api/strategies/export/recommended.algo", async (_req, res) => {
    try {
      const best = await getRecommendedStrategyForExport();
      if (!best) return res.status(404).json({ error: "No recommended strategy found" });
      const retPct = Number(best.stats.returnPct).toFixed(0);
      const wins = best.stats.wins || Math.round((best.stats.totalTrades || 0) * (best.stats.winRate || 0) / 100);
      const losses = (best.stats.totalTrades || 0) - wins;
      const strategy = { ...best, stats: { ...best.stats, wins, losses } } as any;
      const code = generateCTraderBot(strategy);

      if (isCompilerAvailable()) {
        try {
          const algoBuffer = compileCTraderBot(code, `GoldRegime_${retPct}pct`);
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Content-Disposition", `attachment; filename="GoldRegime_${retPct}pct.algo"`);
          return res.send(algoBuffer);
        } catch (e: any) {
          console.error("[recommended.algo] compile failed:", e.message);
        }
      }
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="GoldRegime_${retPct}pct.cs"`);
      res.send(Buffer.from(code, "utf-8"));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/strategies/export/recommended-source", async (_req, res) => {
    try {
      const best = await getRecommendedStrategyForExport();
      if (!best) return res.status(404).json({ error: "No recommended strategy found" });
      const code = generateCTraderBot(best as any);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send(code);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/strategies/export/recommended-locked.algo", async (_req, res) => {
    try {
      const best = await getRecommendedStrategyForExport();
      if (!best) return res.status(404).json({ error: "No recommended strategy found" });
      const retPct = Number(best.stats.returnPct).toFixed(0);
      const wins = best.stats.wins || Math.round((best.stats.totalTrades || 0) * (best.stats.winRate || 0) / 100);
      const losses = (best.stats.totalTrades || 0) - wins;
      const strategy = { ...best, id: "recommended-locked", name: `${best.name} (LOCKED)`, stats: { ...best.stats, wins, losses } } as any;
      let code = generateCTraderBot(strategy);
      code = lockCriticalParameters(code, best.config);

      if (isCompilerAvailable()) {
        try {
          const algoBuffer = compileCTraderBot(code, `GoldRegime_Locked_${retPct}pct`);
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Content-Disposition", `attachment; filename="GoldRegime_Locked_${retPct}pct.algo"`);
          return res.send(algoBuffer);
        } catch (e: any) {
          console.error("[recommended-locked.algo] compile failed:", e.message);
        }
      }
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="GoldRegime_Locked_${retPct}pct.cs"`);
      res.send(Buffer.from(code, "utf-8"));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/strategies/export/recommended-locked-source", async (_req, res) => {
    try {
      const best = await getRecommendedStrategyForExport();
      if (!best) return res.status(404).json({ error: "No recommended strategy found" });
      let code = generateCTraderBot({ ...best, id: "recommended-locked", name: `${best.name} (LOCKED)` } as any);
      code = lockCriticalParameters(code, best.config);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send(code);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Bulk cTrader Export ────────────────────────────────────────
  app.get("/api/strategies/export/ctrader-all", async (req, res) => {
    try {
      const strategies = await storage.listStrategies();
      if (strategies.length === 0) return res.status(404).json({ error: "No strategies saved" });

      const sorted = [...strategies].sort((a, b) => b.stats.returnPct - a.stats.returnPct);
      const files = sorted.map(s => ({
        filename: s.name.replace(/[^a-zA-Z0-9_-]/g, "_") + ".cs",
        code: generateCTraderBot(s),
        stats: `${s.stats.returnPct}% ret, ${s.stats.maxDrawdownPct}% DD, ${s.stats.totalTrades}t`,
      }));

      const combined = files.map(f =>
        `// ═══════════════════════════════════════════════════════════\n// FILE: ${f.filename}\n// Stats: ${f.stats}\n// ═══════════════════════════════════════════════════════════\n\n${f.code}`
      ).join("\n\n\n");

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="GoldRegimeLab_AllStrategies_cTrader.cs"`);
      res.send(Buffer.from(combined, "utf-8"));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Auto-Tune Endpoints ─────────────────────────────────────────
  app.post("/api/ai/auto-tune", async (req, res) => {
    try {
      const progress = getAutoTuneProgress();
      if (progress?.running) {
        return res.status(409).json({ error: "Auto-tune already running", progress });
      }

      const { config: rawConfig } = req.body;
      const maxIterations = Math.max(1, Math.min(25, parseInt(req.body.maxIterations) || 10));
      const targetReturnPct = Math.max(10, Math.min(500, parseInt(req.body.targetReturnPct) || 100));
      const maxAllowedDD = Math.max(5, Math.min(50, parseInt(req.body.maxAllowedDD) || 25));
      const parsed = backtestConfigSchema.safeParse(rawConfig);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid config", details: parsed.error.flatten() });
      }

      const cached = getCachedData();
      if (cached.h1.length === 0 || cached.h4.length === 0 || cached.daily.length === 0) {
        return res.status(400).json({ error: "No market data cached. Fetch or load data first." });
      }

      const data = {
        m1: cached.m1,
        m15: cached.m15,
        h1: cached.h1,
        h4: cached.h4,
        daily: cached.daily,
        events: cached.events.map((e) => ({ timestamp: e.timestamp })),
        gvz: cached.gvz.map((g: any) => ({ date: g.date, value: Number(g.value) })),
        cot: cached.cot.map((c: any) => ({ date: c.date, noncommLong: c.noncommLong, noncommShort: c.noncommShort, netPosition: c.netPosition, openInterest: c.openInterest })),
        sge: cached.sge?.map((s: any) => ({ date: s.date, premium: Number(s.premium) })),
      };

      try {
        const result = await runAutoTune(parsed.data, data, maxIterations, targetReturnPct, maxAllowedDD);
        res.json(result);
      } catch (err: any) {
        console.error("Auto-tune execution error:", err);
        res.status(500).json({ error: err.message });
      }
    } catch (err: any) {
      console.error("Auto-tune start error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ai/auto-tune/status", async (req, res) => {
    const progress = getAutoTuneProgress();
    if (!progress) {
      return res.json({ running: false, status: "No auto-tune session active.", iterations: [] });
    }
    res.json(progress);
  });

  // ─── cTrader OAuth2 Authorization Flow ──────────────────────────

  app.get("/api/ctrader/auth-url", async (req, res) => {
    const clientId = process.env.CTRADER_CLIENT_ID;
    if (!clientId) {
      return res.status(400).json({ error: "CTRADER_CLIENT_ID not configured" });
    }
    const host = process.env.REPLIT_DEV_DOMAIN || req.get("host") || "localhost:5000";
    const redirectUri = `https://${host}/oauth/callback`;
    const authUrl = `https://openapi.ctrader.com/apps/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=trading`;
    res.json({ authUrl, redirectUri });
  });

  app.get("/oauth/callback", async (req, res) => {
    const code = req.query.code as string;
    if (!code) {
      return res.status(400).send("Missing authorization code from cTrader. Please try again.");
    }

    const clientId = process.env.CTRADER_CLIENT_ID;
    const clientSecret = process.env.CTRADER_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return res.status(400).send("Missing CTRADER_CLIENT_ID or CTRADER_CLIENT_SECRET.");
    }

    const host = process.env.REPLIT_DEV_DOMAIN || req.get("host") || "localhost:5000";
    const redirectUri = `https://${host}/oauth/callback`;

    try {
      const tokenUrl = `https://openapi.ctrader.com/apps/token?grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirectUri)}&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;
      const tokenRes = await fetch(tokenUrl, {
        method: "GET",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
      });
      const tokenData = await tokenRes.json() as any;

      if (tokenData.errorCode) {
        return res.status(400).send(`cTrader token error: ${tokenData.errorCode} - ${tokenData.description || "Unknown error"}`);
      }

      if (!tokenData.accessToken) {
        return res.status(400).send(`Unexpected token response: ${JSON.stringify(tokenData)}`);
      }

      process.env.CTRADER_ACCESS_TOKEN = tokenData.accessToken;
      if (tokenData.refreshToken) {
        process.env.CTRADER_REFRESH_TOKEN = tokenData.refreshToken;
      }

      console.log(`[cTrader OAuth] Token obtained. Expires in ${tokenData.expiresIn}s (~${Math.round((tokenData.expiresIn || 0) / 86400)} days)`);

      res.send(`
        <html>
        <head><title>cTrader Authorization Complete</title></head>
        <body style="font-family:system-ui;background:#1a1a2e;color:#e0e0e0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
          <div style="text-align:center;max-width:500px;padding:40px">
            <h1 style="color:#10b981">✓ Authorization Successful</h1>
            <p>Access token obtained and stored. Expires in ~${Math.round((tokenData.expiresIn || 0) / 86400)} days.</p>
            <p style="color:#888">You can close this tab and return to Gold Regime Lab.</p>
            <p style="margin-top:20px;font-size:12px;color:#666">Next: Go to the Live Trading page or Admin to discover and connect your accounts.</p>
          </div>
        </body>
        </html>
      `);
    } catch (err: any) {
      console.error("[cTrader OAuth] Token exchange failed:", err.message);
      res.status(500).send(`Token exchange failed: ${err.message}`);
    }
  });

  app.post("/api/ctrader/refresh-token", async (req, res) => {
    const clientId = process.env.CTRADER_CLIENT_ID;
    const clientSecret = process.env.CTRADER_CLIENT_SECRET;
    const refreshToken = process.env.CTRADER_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      return res.status(400).json({ error: "Missing credentials or refresh token. Please re-authorize." });
    }

    try {
      const tokenUrl = `https://openapi.ctrader.com/apps/token?grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;
      const tokenRes = await fetch(tokenUrl, {
        method: "GET",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
      });
      const tokenData = await tokenRes.json() as any;

      if (tokenData.errorCode || !tokenData.accessToken) {
        return res.status(400).json({ error: tokenData.errorCode || "Token refresh failed", description: tokenData.description });
      }

      process.env.CTRADER_ACCESS_TOKEN = tokenData.accessToken;
      if (tokenData.refreshToken) {
        process.env.CTRADER_REFRESH_TOKEN = tokenData.refreshToken;
      }

      console.log(`[cTrader OAuth] Token refreshed. Expires in ${tokenData.expiresIn}s`);
      res.json({ success: true, expiresIn: tokenData.expiresIn });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Live Trading Engine ─────────────────────────────────────────

  app.get("/api/live-trading/credentials-status", async (req, res) => {
    res.json({
      hasClientId: !!process.env.CTRADER_CLIENT_ID,
      hasClientSecret: !!process.env.CTRADER_CLIENT_SECRET,
      hasAccessToken: !!process.env.CTRADER_ACCESS_TOKEN,
      hasAccountId: !!process.env.CTRADER_ACCOUNT_ID,
      allConfigured: !!(process.env.CTRADER_CLIENT_ID && process.env.CTRADER_CLIENT_SECRET && process.env.CTRADER_ACCESS_TOKEN && process.env.CTRADER_ACCOUNT_ID),
    });
  });

  app.post("/api/live-trading/discover-accounts", async (req, res) => {
    try {
      const clientId = req.body.clientId || process.env.CTRADER_CLIENT_ID;
      const clientSecret = req.body.clientSecret || process.env.CTRADER_CLIENT_SECRET;
      const accessToken = req.body.accessToken || process.env.CTRADER_ACCESS_TOKEN;

      if (!clientId || !clientSecret || !accessToken) {
        return res.status(400).json({ error: "Missing credentials" });
      }

      if (activeCTraderAPI?.isConnected) {
        activeCTraderAPI.disconnect();
      }

      const tempConfig: CTraderConfig = {
        clientId: String(clientId).trim(),
        clientSecret: String(clientSecret).trim(),
        accessToken: String(accessToken).trim(),
        accountId: 0,
        isLive: req.body.isLive === true,
      };

      activeCTraderAPI = new CTraderAPI(tempConfig);
      await activeCTraderAPI.connectAppOnly();

      const accounts = await activeCTraderAPI.getAccounts();
      activeCTraderAPI.disconnect();
      activeCTraderAPI = null;

      res.json({ success: true, accounts });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/live-trading/connect", async (req, res) => {
    try {
      const now = Date.now();
      if (connectionInProgress) {
        return res.status(409).json({ error: "Connection already in progress. Please wait." });
      }
      if (now < rateLimitCooldownUntil) {
        const remainSec = Math.ceil((rateLimitCooldownUntil - now) / 1000);
        return res.status(429).json({ error: `Rate-limited by cTrader. Please wait ${remainSec} seconds before trying again.` });
      }

      const clientId = req.body.clientId || process.env.CTRADER_CLIENT_ID;
      const clientSecret = req.body.clientSecret || process.env.CTRADER_CLIENT_SECRET;
      const accessToken = req.body.accessToken || process.env.CTRADER_ACCESS_TOKEN;
      const accountId = req.body.accountId || process.env.CTRADER_ACCOUNT_ID;
      const isLive = req.body.isLive;

      if (!clientId || !clientSecret || !accessToken || !accountId) {
        return res.status(400).json({ error: "Missing required fields: clientId, clientSecret, accessToken, accountId. Set them as environment secrets or provide in request." });
      }

      connectionInProgress = true;
      lastConnectionAttempt = now;

      if (activeCTraderAPI?.isConnected) {
        activeCTraderAPI.disconnect();
      }

      const parsedAccountId = parseInt(accountId);
      if (isNaN(parsedAccountId) || parsedAccountId <= 0) {
        connectionInProgress = false;
        return res.status(400).json({ error: "Invalid accountId — must be a positive number" });
      }

      const config: CTraderConfig = {
        clientId: String(clientId).trim(),
        clientSecret: String(clientSecret).trim(),
        accessToken: String(accessToken).trim(),
        accountId: parsedAccountId,
        isLive: isLive === true,
      };

      activeCTraderAPI = new CTraderAPI(config);
      await activeCTraderAPI.connect();

      const symbolId = await activeCTraderAPI.findXAUUSDSymbol();
      await activeCTraderAPI.subscribeSpots(symbolId);
      const trader = await activeCTraderAPI.getTraderInfo();

      connectionInProgress = false;
      res.json({
        success: true,
        symbolId,
        accountId: config.accountId,
        isLive: config.isLive,
        balance: activeCTraderAPI?.getStatus().balance ?? null,
        currency: "USD",
      });
    } catch (err: any) {
      connectionInProgress = false;
      if (isRateLimited(err)) {
        rateLimitCooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        console.log(`[manual-connect] Rate-limited — ${RATE_LIMIT_COOLDOWN_MS / 60000}min cooldown active`);
      }
      if (activeCTraderAPI) {
        try { activeCTraderAPI.disconnect(); } catch {}
        activeCTraderAPI = null;
      }
      res.status(isRateLimited(err) ? 429 : 500).json({ error: err.message });
    }
  });

  app.post("/api/live-trading/disconnect", async (req, res) => {
    try {
      if (activeLiveTrader?.isRunning) {
        activeLiveTrader.stop();
        activeLiveTrader = null;
        registerLiveTrader(null);
      }
      if (activeCTraderAPI) {
        activeCTraderAPI.disconnect();
        activeCTraderAPI = null;
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/live-trading/start", async (req, res) => {
    try {
      if (!activeCTraderAPI?.isConnected) {
        return res.status(400).json({ error: "Not connected to cTrader. Connect first." });
      }

      if (activeLiveTrader?.isRunning) {
        return res.status(400).json({ error: "Live trader already running" });
      }

      activeLiveTrader = new LiveTrader(activeCTraderAPI);
      registerLiveTrader(activeLiveTrader);
      setupLiveTraderReconnect(activeCTraderAPI, activeLiveTrader);
      await activeLiveTrader.start();

      res.json({ success: true, state: activeLiveTrader.getState() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/live-trading/stop", async (req, res) => {
    try {
      if (activeLiveTrader) {
        activeLiveTrader.stop();
        const state = activeLiveTrader.getState();
        activeLiveTrader = null;
        registerLiveTrader(null);
        res.json({ success: true, state });
      } else {
        res.json({ success: true, message: "No trader running" });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/live-trading/status", async (req, res) => {
    try {
      const connectionStatus = activeCTraderAPI ? activeCTraderAPI.getStatus() : null;
      const traderState = activeLiveTrader ? activeLiveTrader.getState() : null;
      const tradeCounts = await storage.getTradeCountsByPeriod();
      const latestGVZ = getLatestGVZ();
      const gvzInfo = latestGVZ ? {
        value: Number(latestGVZ.value),
        date: latestGVZ.date,
        percentile: getGVZPercentileForValue(Number(latestGVZ.value)),
      } : null;

      const latestCOT = getLatestCOT();
      const cotInfo = latestCOT ? {
        netPosition: latestCOT.netPosition,
        noncommLong: latestCOT.noncommLong,
        noncommShort: latestCOT.noncommShort,
        openInterest: latestCOT.openInterest,
        date: latestCOT.date,
        percentile: latestCOT.percentile,
        sentiment: latestCOT.sentiment,
      } : null;

      const hmmRaw = getHMMState();
      const trained = isHMMTrained();
      const lastHMM = getLastHMMClassification();
      const hmmInfo = {
        trained,
        currentState: lastHMM?.state ?? null,
        confidence: lastHMM?.confidence ?? null,
        trainingSamples: hmmRaw?.nSamples ?? 0,
        states: lastHMM?.probabilities ?? null,
      };

      const garchTrained = isMRSGARCHTrained();
      const lastGarch = getLastMRSGARCHState();
      const garchModel = getMRSGARCHModel();
      const mrsGarchInfo = {
        trained: garchTrained,
        garchVolatility: lastGarch?.garchVolatility ?? null,
        annualizedVol: lastGarch?.annualizedVol ?? null,
        volForecast: lastGarch?.volForecast ?? null,
        volPercentile: lastGarch?.volPercentile ?? null,
        regimeStability: lastGarch?.regimeStability ?? null,
        positionSizeMultiplier: lastGarch?.positionSizeMultiplier ?? null,
        regimeCount: garchModel ? Object.keys(garchModel.garchParams).length : 0,
      };

      if (connectionStatus && (!connectionStatus.leverage || connectionStatus.leverage <= 0)) {
        const { getLockedParams } = await import("./locked-params");
        const lp = await getLockedParams();
        connectionStatus.leverage = lp.leverage || 10;
      }

      const { getLockedParams: getLPForStatus } = await import("./locked-params");
      const lpForStatus = await getLPForStatus();
      const startingBalance = lpForStatus.startingBalance || 3000;
      const brokerBalance = connectionStatus?.balance || traderState?.balance || 0;
      const accountPnl = brokerBalance > 0 ? brokerBalance - startingBalance : 0;

      res.json({
        connected: activeCTraderAPI?.isConnected || false,
        connection: connectionStatus,
        trader: traderState,
        tradeCounts,
        startingBalance,
        accountPnl,
        gvz: gvzInfo,
        cot: cotInfo,
        hmm: hmmInfo,
        mrsGarch: mrsGarchInfo,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/live-trading/trade-history", async (req, res) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit || "40")), 100);
      const { rows } = await pool.query(
        `SELECT id, decision, side, price, regime, outcome, pnl, timestamp, notes
         FROM trade_decisions
         WHERE decision = 'entry' AND outcome IS NOT NULL
         ORDER BY timestamp DESC
         LIMIT $1`,
        [limit]
      );
      res.json(rows.map(r => ({
        ...r,
        price: Number(r.price),
        pnl: r.pnl !== null ? Number(r.pnl) : null,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/live-trading/ctrader-deals", async (req, res) => {
    try {
      const trades = await storage.listLiveTrades(100);
      const stats = await storage.getLiveTradeStats();
      res.json({ trades, stats, count: trades.length, source: "live_trades" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/live-trades", async (req, res) => {
    try {
      const trades = await storage.listLiveTrades(100);
      const stats = await storage.getLiveTradeStats();
      res.json({ trades, stats });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/live-trades", async (req, res) => {
    try {
      const { openedAt, closedAt, side, entryPrice, exitPrice, volume, stopLoss, takeProfit, pnl, status, regime, source, notes } = req.body;
      if (!openedAt || !side || !entryPrice) {
        return res.status(400).json({ error: "openedAt, side, and entryPrice are required" });
      }
      const id = await storage.insertLiveTrade({
        openedAt, closedAt, side, entryPrice: Number(entryPrice), exitPrice: exitPrice ? Number(exitPrice) : null,
        volume: volume ? Number(volume) : 100, stopLoss: stopLoss ? Number(stopLoss) : null,
        takeProfit: takeProfit ? Number(takeProfit) : null, pnl: pnl !== undefined ? Number(pnl) : null,
        status: status || (closedAt ? "closed" : "open"), regime, source: source || "manual", notes,
      });
      res.json({ success: true, id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/live-trades/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      await storage.updateLiveTrade(id, req.body);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/live-trades/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      await storage.deleteLiveTrade(id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/live-trading/positions", async (req, res) => {
    try {
      if (!activeCTraderAPI?.isConnected) {
        return res.json({ positions: [] });
      }
      await activeCTraderAPI.reconcilePositions();
      res.json({ positions: activeCTraderAPI.currentPositions });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/live-trading/close-position", async (req, res) => {
    try {
      if (!activeCTraderAPI?.isConnected) {
        return res.status(400).json({ error: "Not connected" });
      }
      const { positionId, volume } = req.body;
      const parsedPositionId = parseInt(positionId);
      const parsedVolume = parseInt(volume);
      if (isNaN(parsedPositionId) || parsedPositionId <= 0 || isNaN(parsedVolume) || parsedVolume <= 0) {
        return res.status(400).json({ error: "Invalid positionId or volume — must be positive numbers" });
      }
      const result = await activeCTraderAPI.closePosition(parsedPositionId, parsedVolume);
      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/live-trading/analysis", async (req, res) => {
    try {
      if (!activeLiveTrader || !activeLiveTrader.isRunning) {
        return res.status(400).json({ error: "Live trader not running. Connect and start trading first." });
      }
      const analysis = activeLiveTrader.getAnalysis();
      res.json(analysis);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/live-trading/test-trade", async (req, res) => {
    try {
      if (!activeLiveTrader || !activeLiveTrader.isRunning) {
        return res.status(400).json({ error: "Live trader not running. Connect and start trading first." });
      }
      const result = await activeLiveTrader.testTrade();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.get("/api/live-trading/logs", async (req, res) => {
    try {
      if (!activeLiveTrader) {
        return res.json({ logs: [] });
      }
      const state = activeLiveTrader.getState();
      res.json({ logs: state.logs });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/live-trading/price-history", async (req, res) => {
    try {
      if (!activeLiveTrader) {
        return res.json({ prices: [] });
      }
      res.json({ prices: activeLiveTrader.getPriceHistory() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/live-trading/account-info", async (req, res) => {
    try {
      if (!activeCTraderAPI?.isConnected) {
        const { getLockedParams } = await import("./locked-params");
        const lp = await getLockedParams();
        return res.json({
          connected: false,
          accountId: process.env.CTRADER_ACCOUNT_ID || null,
          leverage: lp.leverage || null,
          leverageSource: "config",
        });
      }
      const status = activeCTraderAPI.getStatus();
      const brokerLeverage = status.leverage;
      let leverageSource = "broker";
      let leverage = brokerLeverage;
      if (!leverage || leverage <= 0) {
        const { getLockedParams } = await import("./locked-params");
        const lp = await getLockedParams();
        leverage = lp.leverage || 10;
        leverageSource = "config";
      }
      let traderLogin = activeCTraderAPI.traderLogin;
      if (!traderLogin && activeCTraderAPI.isConnected) {
        try { await activeCTraderAPI.getAccounts(); traderLogin = activeCTraderAPI.traderLogin; } catch {}
      }
      res.json({
        connected: true,
        accountId: String(activeCTraderAPI.configAccountId),
        traderLogin: traderLogin || null,
        balance: status.balance,
        leverage,
        leverageSource,
        lastSpot: status.lastSpot,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ai-monitor/status", async (req, res) => {
    try {
      const { getAIMonitorStatus } = await import("./ai-monitor");
      const status = await getAIMonitorStatus();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ai-monitor/decisions", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const decisions = await storage.getRecentTradeDecisions(limit);
      res.json(decisions);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ai-monitor/observations", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const observations = await storage.getRecentObservations(limit);
      res.json(observations);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ai-monitor/learnings", async (req, res) => {
    try {
      const category = req.query.category as string | undefined;
      const learnings = await storage.getLearnings(category, 0);
      res.json(learnings);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ai-monitor/counts", async (req, res) => {
    try {
      const { pool: dbPool } = await import("./storage");
      const [decisionStats, obsResult, learnResult] = await Promise.all([
        storage.getTradeDecisionStats(),
        dbPool.query("SELECT COUNT(*)::int as cnt FROM market_observations"),
        dbPool.query("SELECT COUNT(*)::int as cnt FROM ai_learnings"),
      ]);
      res.json({
        decisions: decisionStats.total,
        observations: obsResult.rows[0]?.cnt ?? 0,
        learnings: learnResult.rows[0]?.cnt ?? 0,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/live-trading/switch-account", async (req, res) => {
    try {
      const { accountId } = req.body;
      if (!accountId) {
        return res.status(400).json({ error: "Missing accountId" });
      }

      if (activeLiveTrader?.isRunning) {
        activeLiveTrader.stop();
        activeLiveTrader = null;
        registerLiveTrader(null);
      }
      if (activeCTraderAPI?.isConnected) {
        activeCTraderAPI.disconnect();
        activeCTraderAPI = null;
      }

      const clientId = process.env.CTRADER_CLIENT_ID;
      const clientSecret = process.env.CTRADER_CLIENT_SECRET;
      const accessToken = process.env.CTRADER_ACCESS_TOKEN;
      if (!clientId || !clientSecret || !accessToken) {
        return res.status(400).json({ error: "Missing cTrader credentials in environment" });
      }

      process.env.CTRADER_ACCOUNT_ID = String(accountId);

      const config: CTraderConfig = {
        clientId: String(clientId).trim(),
        clientSecret: String(clientSecret).trim(),
        accessToken: String(accessToken).trim(),
        accountId: Number(accountId),
        isLive: req.body.isLive === true,
      };

      activeCTraderAPI = new CTraderAPI(config);
      await activeCTraderAPI.connect();

      const traderInfo = await activeCTraderAPI.getTraderInfo();
      const symbolId = await activeCTraderAPI.findXAUUSDSymbol();
      await activeCTraderAPI.subscribeSpots(symbolId);

      activeLiveTrader = new LiveTrader(activeCTraderAPI);
      registerLiveTrader(activeLiveTrader);
      await activeLiveTrader.start();

      res.json({
        success: true,
        accountId: String(accountId),
        balance: activeCTraderAPI.getStatus().balance,
        leverage: activeCTraderAPI.getStatus().leverage,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Admin Data Sync Endpoints ──────────────────────────────────
  app.get("/api/admin/export", async (req, res) => {
    try {
      const backtests = await storage.listBacktestResults();
      const strategies = await storage.listStrategies();
      const journal = await storage.listJournalEntries(100000);

      const bundle: any = {
        exportedAt: new Date().toISOString(),
        backtests,
        strategies,
        journal,
      };

      if (req.query.includeCandles === "true") {
        const timeframes = ["1min", "15min", "1h", "4h", "1day"];
        const candleData: Record<string, any> = {};
        for (const tf of timeframes) {
          const count = await storage.getCandleCount(tf);
          const range = await storage.getCandleDateRange(tf);
          candleData[tf] = { count, range };
        }
        bundle.candleSummary = candleData;
      }

      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="gold-regime-lab-export-${new Date().toISOString().slice(0, 10)}.json"`);
      res.json(bundle);
    } catch (err: any) {
      console.error("Admin export error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/admin/counts", async (req, res) => {
    try {
      const backtests = await storage.listBacktestResults();
      const strategies = await storage.listStrategies();
      const journal = await storage.listJournalEntries(100000);

      const timeframes = ["1min", "15min", "1h", "4h", "1day"];
      const candles: Record<string, number> = {};
      for (const tf of timeframes) {
        candles[tf] = await storage.getCandleCount(tf);
      }

      res.json({
        backtests: backtests.length,
        strategies: strategies.length,
        journal: journal.length,
        candles,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/admin/import", async (req, res) => {
    try {
      const { backtests, strategies, journal } = req.body;

      if (!backtests && !strategies && !journal) {
        return res.status(400).json({ error: "No data to import. Expected backtests, strategies, or journal arrays." });
      }

      if (backtests && !Array.isArray(backtests)) return res.status(400).json({ error: "backtests must be an array" });
      if (strategies && !Array.isArray(strategies)) return res.status(400).json({ error: "strategies must be an array" });
      if (journal && !Array.isArray(journal)) return res.status(400).json({ error: "journal must be an array" });

      const summary = { backtests: 0, strategies: 0, journal: 0, skipped: { backtests: 0, journal: 0 }, errors: [] as string[] };

      if (Array.isArray(strategies)) {
        for (const s of strategies) {
          try {
            if (!s.id || !s.name || !s.config || !s.stats) throw new Error("Missing required strategy fields");
            await storage.saveStrategy(s);
            summary.strategies++;
          } catch (e: any) {
            summary.errors.push(`Strategy ${s.id || "unknown"}: ${e.message}`);
          }
        }
      }

      if (Array.isArray(backtests)) {
        for (const b of backtests) {
          try {
            if (!b.id || !b.config || !b.stats || !b.trades) throw new Error("Missing required backtest fields");
            const inserted = await storage.insertBacktestIfNotExists(b);
            if (inserted) summary.backtests++;
            else summary.skipped.backtests++;
          } catch (e: any) {
            summary.errors.push(`Backtest ${b.id || "unknown"}: ${e.message}`);
          }
        }
      }

      if (Array.isArray(journal)) {
        for (const j of journal) {
          try {
            if (!j.id || !j.source) throw new Error("Missing required journal fields");
            const inserted = await storage.insertJournalIfNotExists(j);
            if (inserted) summary.journal++;
            else summary.skipped.journal++;
          } catch (e: any) {
            summary.errors.push(`Journal ${j.id || "unknown"}: ${e.message}`);
          }
        }
      }

      res.json({
        success: summary.errors.length === 0,
        imported: { backtests: summary.backtests, strategies: summary.strategies, journal: summary.journal },
        skipped: summary.skipped,
        errors: summary.errors.length > 0 ? summary.errors : undefined,
      });
    } catch (err: any) {
      console.error("Admin import error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/admin/backtests", async (_req, res) => {
    try {
      const result = await pool.query("DELETE FROM backtest_results");
      res.json({ success: true, deleted: result.rowCount });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return httpServer;
}
