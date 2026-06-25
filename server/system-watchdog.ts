import { getActiveCTraderAPI, getActiveLiveTrader, autoConnectAndTrade, isConnectionCoolingDown } from "./routes";
import { autoRefreshIfStale, getCachedData, getDataFreshness } from "./data-fetcher";


interface HealthCheck {
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
  lastChecked: Date;
}

interface SystemEvent {
  timestamp: Date;
  source: string;
  severity: "info" | "warn" | "error";
  message: string;
  autoFixed?: boolean;
}

interface WatchdogState {
  running: boolean;
  lastCycle: Date | null;
  checks: HealthCheck[];
  events: SystemEvent[];
  fixes: { timestamp: Date; action: string; result: string }[];
  reconnectAttempts: number;
  dataRefreshAttempts: number;
}

const state: WatchdogState = {
  running: false,
  lastCycle: null,
  checks: [],
  events: [],
  fixes: [],
  reconnectAttempts: 0,
  dataRefreshAttempts: 0,
};

const MAX_EVENTS = 100;
const MAX_FIXES = 50;
const MAX_RECONNECT_ATTEMPTS = 3;
const MAX_DATA_REFRESH_ATTEMPTS = 3;
const WATCHDOG_INTERVAL = 3 * 60 * 1000;
const RECONNECT_COOLDOWN_MS = 15 * 60 * 1000;
let lastReconnectReset: number = 0;

let watchdogTimer: NodeJS.Timeout | null = null;
let pendingErrors: SystemEvent[] = [];
let stderrBuffer: string[] = [];
const MAX_STDERR_BUFFER = 50;
const KNOWN_HARMLESS = [
  "UNSUPPORTED_MESSAGE",
  "ProtoOASymbolCategoryListRes",
  "ExperimentalWarning",
  "DeprecationWarning",
  "punycode",
];

export function reportError(source: string, message: string) {
  const event: SystemEvent = {
    timestamp: new Date(),
    source,
    severity: "error",
    message,
  };
  pendingErrors.push(event);
  addEvent(event);
  console.error(`[Watchdog] Error reported by ${source}: ${message}`);
}

export function reportWarning(source: string, message: string) {
  const event: SystemEvent = {
    timestamp: new Date(),
    source,
    severity: "warn",
    message,
  };
  addEvent(event);
}

function addEvent(event: SystemEvent) {
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) {
    state.events = state.events.slice(-MAX_EVENTS);
  }
}

function logFix(action: string, result: string) {
  console.log(`[Watchdog] FIX ${action}: ${result}`);
  state.fixes.push({ timestamp: new Date(), action, result });
  if (state.fixes.length > MAX_FIXES) {
    state.fixes = state.fixes.slice(-MAX_FIXES);
  }
}

async function checkCTraderConnection(): Promise<HealthCheck> {
  const api = getActiveCTraderAPI();
  if (!api) {
    return { name: "cTrader Connection", status: "warn", message: "No active API instance", lastChecked: new Date() };
  }

  if (!api.isConnected) {
    return { name: "cTrader Connection", status: "error", message: "WebSocket disconnected or not fully authenticated", lastChecked: new Date() };
  }

  return { name: "cTrader Connection", status: "ok", message: "Connected and authenticated", lastChecked: new Date() };
}

async function checkLiveTrader(): Promise<HealthCheck> {
  const trader = getActiveLiveTrader();
  if (!trader) {
    return { name: "Live Trader", status: "warn", message: "Not initialized", lastChecked: new Date() };
  }

  if (!trader.isRunning) {
    return { name: "Live Trader", status: "warn", message: "Stopped", lastChecked: new Date() };
  }

  const traderState = trader.getState();
  if (traderState.currentPrice === 0) {
    return { name: "Live Trader", status: "error", message: "Price stuck at $0 — no spot data", lastChecked: new Date() };
  }

  return { name: "Live Trader", status: "ok", message: `Running, price=$${traderState.currentPrice.toFixed(2)}, regime=${traderState.regime}`, lastChecked: new Date() };
}

async function checkDataFreshness(): Promise<HealthCheck> {
  const data = getCachedData();
  if (!data || data.h1.length === 0) {
    return { name: "Market Data", status: "error", message: "No H1 candle data loaded", lastChecked: new Date() };
  }

  const freshness = getDataFreshness();

  const recentDataErrors = state.events.filter(
    e => e.source === "data-fetch" && e.severity === "error" &&
    (Date.now() - e.timestamp.getTime()) < 30 * 60 * 1000
  );

  if (freshness.isStale) {
    const extra = recentDataErrors.length > 0 ? ` + ${recentDataErrors.length} fetch error(s)` : "";
    return { name: "Market Data", status: "error", message: `H1 data ${freshness.ageMinutes}min stale${extra}`, lastChecked: new Date() };
  }

  if (recentDataErrors.length > 0) {
    return {
      name: "Market Data",
      status: "warn",
      message: `${data.h1.length} H1 bars, ${Math.round(freshness.ageMinutes / 60)}h old — ${recentDataErrors.length} fetch error(s)`,
      lastChecked: new Date(),
    };
  }

  if (freshness.ageMinutes > 24 * 60) {
    return { name: "Market Data", status: "warn", message: `H1 data ${Math.round(freshness.ageMinutes / 60)}h old`, lastChecked: new Date() };
  }

  return { name: "Market Data", status: "ok", message: `${data.h1.length} H1 bars, ${Math.round(freshness.ageMinutes / 60)}h old`, lastChecked: new Date() };
}

async function checkMemoryUsage(): Promise<HealthCheck> {
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);

  if (rssMB > 900) {
    return { name: "Memory", status: "error", message: `RSS ${rssMB}MB — near limit`, lastChecked: new Date() };
  }
  if (rssMB > 600) {
    return { name: "Memory", status: "warn", message: `RSS ${rssMB}MB, heap ${heapMB}MB`, lastChecked: new Date() };
  }
  return { name: "Memory", status: "ok", message: `RSS ${rssMB}MB, heap ${heapMB}MB`, lastChecked: new Date() };
}

async function checkRecentErrors(): Promise<HealthCheck> {
  const recentErrors = state.events.filter(
    e => e.severity === "error" && (Date.now() - e.timestamp.getTime()) < 10 * 60 * 1000
  );

  if (recentErrors.length >= 5) {
    return { name: "Error Rate", status: "error", message: `${recentErrors.length} errors in last 10min`, lastChecked: new Date() };
  }
  if (recentErrors.length > 0) {
    return { name: "Error Rate", status: "warn", message: `${recentErrors.length} error(s) in last 10min: ${recentErrors[recentErrors.length - 1].source}`, lastChecked: new Date() };
  }
  return { name: "Error Rate", status: "ok", message: "No recent errors", lastChecked: new Date() };
}

async function autoFix() {
  const api = getActiveCTraderAPI();
  const trader = getActiveLiveTrader();

  if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS && (Date.now() - lastReconnectReset) > RECONNECT_COOLDOWN_MS) {
    console.log(`[Watchdog] Resetting reconnect counter after ${RECONNECT_COOLDOWN_MS / 60000}min cooldown — will retry cTrader connection`);
    state.reconnectAttempts = 0;
    lastReconnectReset = Date.now();
  }

  const needsConnect = (!api && process.env.CTRADER_CLIENT_ID) || (api && !api.isConnected);

  if (needsConnect && isConnectionCoolingDown()) {
    console.log("[Watchdog] Skipping cTrader reconnect — global rate-limit cooldown active");
  } else if (needsConnect && state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    state.reconnectAttempts++;
    const label = api ? "cTrader reconnect" : "cTrader init";
    logFix(label, `Attempt ${state.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
    try {
      await autoConnectAndTrade();
      state.reconnectAttempts = 0;
      logFix(label, "Success — connection restored");
    } catch (err: any) {
      logFix(label, `Failed: ${err.message}`);
      if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log(`[Watchdog] All ${MAX_RECONNECT_ATTEMPTS} reconnect attempts exhausted. Will retry after ${RECONNECT_COOLDOWN_MS / 60000}min cooldown.`);
        lastReconnectReset = Date.now();
      }
    }
  } else if (api && api.isConnected) {
    state.reconnectAttempts = 0;
  }

  if (trader && trader.isRunning) {
    const ts = trader.getState();
    if (ts.currentPrice === 0) {
      logFix("Price seed", "Attempting to seed price from cached spot");
      try {
        if (api && api.currentSpot) {
          trader.seedPrice(api.currentSpot);
          logFix("Price seed", `Seeded from cached spot: $${api.currentSpot.bid}`);
        }
      } catch (err: any) {
        logFix("Price seed", `Failed: ${err.message}`);
      }
    }
  }

  const freshness = getDataFreshness();
  if (freshness.isStale && state.dataRefreshAttempts < MAX_DATA_REFRESH_ATTEMPTS) {
    state.dataRefreshAttempts++;
    logFix("Data refresh", `Data is stale (${freshness.ageMinutes}min), attempt ${state.dataRefreshAttempts}/${MAX_DATA_REFRESH_ATTEMPTS}`);
    try {
      const refreshed = await autoRefreshIfStale();
      if (refreshed) {
        state.dataRefreshAttempts = 0;
        logFix("Data refresh", "Refreshed successfully");
      } else {
        logFix("Data refresh", "autoRefreshIfStale returned false — may still be stale");
      }
    } catch (err: any) {
      logFix("Data refresh", `Failed: ${err.message}`);
    }
  } else if (!freshness.isStale) {
    state.dataRefreshAttempts = 0;
  }

  const dataFetchErrors = pendingErrors.filter(e => e.source === "data-fetch");
  if (dataFetchErrors.length > 0) {
    logFix("Data fetch errors", `${dataFetchErrors.length} fetch error(s) detected, retrying stale timeframes on next refresh cycle`);
  }

  pendingErrors = [];
}

async function runWatchdogCycle() {
  try {
    processStderrBuffer();

    const checks = await Promise.all([
      checkCTraderConnection(),
      checkLiveTrader(),
      checkDataFreshness(),
      checkMemoryUsage(),
      checkRecentErrors(),
    ]);

    state.checks = checks;
    state.lastCycle = new Date();

    const issues = checks.filter(c => c.status === "error" || c.status === "warn");
    const errors = checks.filter(c => c.status === "error");

    if (issues.length > 0) {
      console.log(`[Watchdog] ${issues.length} issue(s): ${issues.map(e => `[${e.status.toUpperCase()}] ${e.name}: ${e.message}`).join(" | ")}`);
    }

    if (errors.length > 0 || pendingErrors.length > 0) {
      await autoFix();
    }
  } catch (err: any) {
    console.error("[Watchdog] Cycle error:", err.message);
  }
}

function installStderrInterceptor() {
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function (chunk: any, ...args: any[]) {
    const msg = typeof chunk === "string" ? chunk : chunk.toString();
    const trimmed = msg.trim();
    if (trimmed.length > 0) {
      const isHarmless = KNOWN_HARMLESS.some(h => trimmed.includes(h));
      if (!isHarmless && !trimmed.startsWith("[Watchdog]")) {
        stderrBuffer.push(trimmed);
        if (stderrBuffer.length > MAX_STDERR_BUFFER) {
          stderrBuffer = stderrBuffer.slice(-MAX_STDERR_BUFFER);
        }
      }
    }
    return origWrite(chunk, ...args as any);
  } as any;
}

function processStderrBuffer() {
  if (stderrBuffer.length === 0) return;

  const errors = [...stderrBuffer];
  stderrBuffer = [];

  const grouped = new Map<string, number>();
  for (const err of errors) {
    const key = err.substring(0, 120);
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }

  for (const [msg, count] of grouped) {
    const suffix = count > 1 ? ` (x${count})` : "";
    const source = extractSource(msg);
    addEvent({
      timestamp: new Date(),
      source,
      severity: "error",
      message: msg.substring(0, 200) + suffix,
    });
    console.log(`[Watchdog] Captured stderr: [${source}] ${msg.substring(0, 150)}${suffix}`);
  }
}

function extractSource(msg: string): string {
  const bracketMatch = msg.match(/^\[([^\]]+)\]/);
  if (bracketMatch) return bracketMatch[1].toLowerCase();
  if (msg.includes("cTrader") || msg.includes("ctrader")) return "ctrader";
  if (msg.includes("ECONNREFUSED") || msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT")) return "network";
  if (msg.includes("database") || msg.includes("postgres") || msg.includes("pg_")) return "database";
  if (msg.includes("TypeError") || msg.includes("ReferenceError") || msg.includes("SyntaxError")) return "runtime";
  return "stderr";
}

export function startWatchdog() {
  if (state.running) return;
  state.running = true;

  installStderrInterceptor();

  process.on("uncaughtException", (err) => {
    reportError("uncaught-exception", `${err.name}: ${err.message}`);
    console.error("[Watchdog] Uncaught exception:", err);
  });

  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    reportError("unhandled-rejection", msg);
  });

  const initialDelay = process.env.NODE_ENV === "production" ? 90_000 : 10_000;
  setTimeout(() => runWatchdogCycle(), initialDelay);

  watchdogTimer = setInterval(runWatchdogCycle, WATCHDOG_INTERVAL);
  console.log(`[Watchdog] Started — checking system health every ${WATCHDOG_INTERVAL / 1000}s with log self-monitoring`);
}

export function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  state.running = false;
  console.log("[Watchdog] Stopped");
}

export function getWatchdogStatus() {
  return {
    running: state.running,
    lastCycle: state.lastCycle,
    checks: state.checks,
    recentEvents: state.events.slice(-20),
    recentFixes: state.fixes.slice(-15),
    reconnectAttempts: state.reconnectAttempts,
    dataRefreshAttempts: state.dataRefreshAttempts,
  };
}
