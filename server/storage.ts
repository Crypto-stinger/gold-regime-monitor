import pg from "pg";
import type { BacktestResult, Candle, SavedStrategy } from "../shared/schema";

export type JournalEntry = {
  id: string;
  createdAt: string;
  source: "analysis" | "chat";
  suggestions: Array<{
    parameter: string;
    fromValue: string | number | boolean;
    toValue: string | number | boolean;
    rationale: string;
  }>;
  beforeBacktestId?: string;
  beforeStats?: { returnPct: number; maxDrawdownPct: number; winRate: number; totalTrades: number; profitFactor: number };
  afterBacktestId?: string;
  afterStats?: { returnPct: number; maxDrawdownPct: number; winRate: number; totalTrades: number; profitFactor: number };
  outcome?: "improved" | "worsened" | "mixed" | "pending";
  learnings?: string;
};

export type LockedParamsProposal = {
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

export interface IStorage {
  saveBacktestResult(result: BacktestResult): Promise<BacktestResult>;
  insertBacktestIfNotExists(result: BacktestResult): Promise<boolean>;
  getBacktestResult(id: string): Promise<BacktestResult | undefined>;
  listBacktestResults(): Promise<BacktestResult[]>;
  deleteBacktestResult(id: string): Promise<void>;
  archiveBacktestResult(id: string, reason?: string): Promise<void>;
  restoreBacktestResult(id: string): Promise<void>;
  listArchivedBacktests(): Promise<BacktestResult[]>;
  labelBacktestResult(id: string, label: string): Promise<void>;
  logStrategyChange(entry: { backtestId?: string; action: string; description?: string; configSnapshot?: any; statsSnapshot?: any; previousBestId?: string; previousBestStats?: any }): Promise<void>;
  getStrategyChangelog(): Promise<any[]>;
  upsertCandles(timeframe: string, candles: Candle[]): Promise<number>;
  getCandles(timeframe: string): Promise<Candle[]>;
  getCandleCount(timeframe: string): Promise<number>;
  getCandleDateRange(timeframe: string): Promise<{ from: string; to: string } | null>;
  saveStrategy(strategy: SavedStrategy): Promise<SavedStrategy>;
  getStrategy(id: string): Promise<SavedStrategy | undefined>;
  getStrategyByName(name: string): Promise<SavedStrategy | undefined>;
  listStrategies(): Promise<SavedStrategy[]>;
  deleteStrategy(id: string): Promise<void>;
  saveJournalEntry(entry: JournalEntry): Promise<JournalEntry>;
  insertJournalIfNotExists(entry: JournalEntry): Promise<boolean>;
  updateJournalEntry(id: string, updates: Partial<JournalEntry>): Promise<void>;
  listJournalEntries(limit?: number): Promise<JournalEntry[]>;
  getLatestPendingJournal(): Promise<JournalEntry | undefined>;
  getLockedParams(): Promise<Record<string, any> | null>;
  setLockedParams(params: Record<string, any>): Promise<void>;
  saveLockedParamsProposal(proposal: LockedParamsProposal): Promise<void>;
  getLockedParamsProposal(id: string): Promise<LockedParamsProposal | undefined>;
  listLockedParamsProposals(): Promise<LockedParamsProposal[]>;
  updateLockedParamsProposalStatus(id: string, status: "approved" | "rejected"): Promise<void>;
  saveParamChangelog(entry: { source: string; changedKeys: string[]; oldValues: Record<string, any>; newValues: Record<string, any>; rationale: string; fullParams: Record<string, any> }): Promise<void>;
  listParamChangelog(limit?: number): Promise<any[]>;
}

const isProduction = process.env.NODE_ENV === "production";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  idleTimeoutMillis: isProduction ? 20000 : 30000,
  connectionTimeoutMillis: isProduction ? 15000 : 10000,
  max: isProduction ? 5 : 10,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  allowExitOnIdle: false,
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error (non-fatal):", err.message);
});

async function queryWithRetry(sql: string, params?: any[], retries = 3): Promise<pg.QueryResult> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await pool.query(sql, params);
    } catch (err: any) {
      const isConnectionError = err.message?.includes("terminated") ||
        err.message?.includes("timeout") ||
        err.message?.includes("ECONNRESET") ||
        err.message?.includes("Connection refused") ||
        err.code === "57P01" || err.code === "08006" || err.code === "08003";
      if (isConnectionError && attempt < retries) {
        console.warn(`[DB] Query failed (attempt ${attempt}/${retries}): ${err.message}. Retrying in ${attempt * 1000}ms...`);
        await new Promise(r => setTimeout(r, attempt * 1000));
        continue;
      }
      throw err;
    }
  }
  throw new Error("queryWithRetry: unreachable");
}

const priceTableReady = (async () => {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await pool.query(`SELECT 1`);
      break;
    } catch (err: any) {
      console.warn(`[DB] Connection check failed (attempt ${attempt}/5): ${err.message}`);
      if (attempt === 5) throw err;
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_data (
      id SERIAL PRIMARY KEY,
      timeframe TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      open NUMERIC NOT NULL,
      high NUMERIC NOT NULL,
      low NUMERIC NOT NULL,
      close NUMERIC NOT NULL,
      volume NUMERIC DEFAULT 0,
      UNIQUE (timeframe, timestamp)
    )
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE price_data ADD COLUMN IF NOT EXISTS volume NUMERIC DEFAULT 0;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_strategies (
      id VARCHAR(64) PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      config JSONB NOT NULL,
      stats JSONB NOT NULL,
      diagnostics JSONB,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS optimization_journal (
      id VARCHAR(64) PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source TEXT NOT NULL DEFAULT 'chat',
      suggestions JSONB NOT NULL DEFAULT '[]',
      before_backtest_id VARCHAR(64),
      before_stats JSONB,
      after_backtest_id VARCHAR(64),
      after_stats JSONB,
      outcome TEXT DEFAULT 'pending',
      learnings TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backtest_results (
      id VARCHAR(64) PRIMARY KEY,
      config JSONB NOT NULL,
      trades JSONB NOT NULL DEFAULT '[]',
      stats JSONB NOT NULL,
      equity_curve JSONB NOT NULL DEFAULT '[]',
      regime_counts JSONB,
      monthly_returns JSONB,
      diagnostics JSONB,
      data_source TEXT,
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      archive_reason TEXT,
      label TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE backtest_results ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE backtest_results ADD COLUMN IF NOT EXISTS archive_reason TEXT`);
  await pool.query(`ALTER TABLE backtest_results ADD COLUMN IF NOT EXISTS label TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS strategy_changelog (
      id SERIAL PRIMARY KEY,
      backtest_id VARCHAR(64),
      action TEXT NOT NULL,
      description TEXT,
      config_snapshot JSONB,
      stats_snapshot JSONB,
      previous_best_id VARCHAR(64),
      previous_best_stats JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS locked_params (
      key VARCHAR(64) PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS locked_params_proposals (
      id VARCHAR(64) PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source TEXT NOT NULL DEFAULT 'ai',
      current_params JSONB NOT NULL,
      proposed_params JSONB NOT NULL,
      changed_keys JSONB NOT NULL DEFAULT '[]',
      current_stats JSONB NOT NULL,
      proposed_stats JSONB NOT NULL,
      rationale TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      backtest_id VARCHAR(64)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS param_changelog (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source TEXT NOT NULL DEFAULT 'user',
      changed_keys JSONB NOT NULL DEFAULT '[]',
      old_values JSONB NOT NULL DEFAULT '{}',
      new_values JSONB NOT NULL DEFAULT '{}',
      rationale TEXT NOT NULL DEFAULT '',
      full_params JSONB NOT NULL DEFAULT '{}'
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analyst_ideas (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'goldviewfx',
      title TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      chart_url TEXT,
      video_url TEXT,
      published_at TEXT,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE analyst_ideas ADD COLUMN IF NOT EXISTS chart_url TEXT`);
  await pool.query(`ALTER TABLE analyst_ideas ADD COLUMN IF NOT EXISTS video_url TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_observations (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      price NUMERIC NOT NULL,
      bid NUMERIC,
      ask NUMERIC,
      spread NUMERIC,
      atr_h1 NUMERIC,
      atr_h4 NUMERIC,
      regime TEXT,
      range_high NUMERIC,
      range_low NUMERIC,
      session TEXT,
      conditions JSONB NOT NULL DEFAULT '{}',
      notes TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trade_decisions (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decision TEXT NOT NULL,
      side TEXT,
      price NUMERIC NOT NULL,
      regime TEXT,
      conditions JSONB NOT NULL DEFAULT '{}',
      block_reason TEXT,
      signal_details JSONB,
      market_context JSONB NOT NULL DEFAULT '{}',
      outcome TEXT,
      pnl NUMERIC,
      notes TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS live_trades (
      id SERIAL PRIMARY KEY,
      opened_at TIMESTAMPTZ NOT NULL,
      closed_at TIMESTAMPTZ,
      side TEXT NOT NULL,
      entry_price NUMERIC NOT NULL,
      exit_price NUMERIC,
      volume NUMERIC NOT NULL DEFAULT 100,
      stop_loss NUMERIC,
      take_profit NUMERIC,
      pnl NUMERIC,
      status TEXT NOT NULL DEFAULT 'open',
      regime TEXT,
      source TEXT NOT NULL DEFAULT 'bot',
      ctrader_position_id TEXT,
      ctrader_deal_id TEXT,
      notes TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_learnings (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      category TEXT NOT NULL,
      insight TEXT NOT NULL,
      confidence NUMERIC DEFAULT 0.5,
      source_data JSONB,
      times_reinforced INTEGER DEFAULT 1
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gvz_data (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      value NUMERIC NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cot_data (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      noncomm_long INTEGER NOT NULL,
      noncomm_short INTEGER NOT NULL,
      net_position INTEGER NOT NULL,
      open_interest INTEGER NOT NULL,
      comm_long INTEGER DEFAULT 0,
      comm_short INTEGER DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sge_data (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      sge_price_cny NUMERIC NOT NULL,
      usdcny_rate NUMERIC NOT NULL,
      sge_price_usd NUMERIC NOT NULL,
      spot_price_usd NUMERIC NOT NULL,
      premium NUMERIC NOT NULL
    )
  `);
})().catch((err) => console.error("Failed to create tables:", err));

export class DatabaseStorage implements IStorage {
  async upsertCandles(timeframe: string, candles: Candle[]): Promise<number> {
    await priceTableReady;
    if (candles.length === 0) return 0;

    const seen = new Set<string>();
    const deduped = candles.filter(c => {
      const key = String(c.timestamp);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const batchSize = 500;
    let inserted = 0;
    for (let i = 0; i < deduped.length; i += batchSize) {
      const batch = deduped.slice(i, i + batchSize);
      const values: any[] = [];
      const placeholders: string[] = [];
      batch.forEach((c, idx) => {
        const offset = idx * 7;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`
        );
        values.push(timeframe, c.timestamp, c.open, c.high, c.low, c.close, c.volume ?? 0);
      });
      const result = await queryWithRetry(
        `INSERT INTO price_data (timeframe, timestamp, open, high, low, close, volume)
         VALUES ${placeholders.join(", ")}
         ON CONFLICT (timeframe, timestamp) DO UPDATE SET volume = EXCLUDED.volume WHERE price_data.volume = 0 AND EXCLUDED.volume > 0`,
        values
      );
      inserted += result.rowCount ?? 0;
    }
    return inserted;
  }

  async getCandles(timeframe: string): Promise<Candle[]> {
    await priceTableReady;
    const { rows } = await queryWithRetry(
      `SELECT timestamp, open, high, low, close, COALESCE(volume, 0) AS volume FROM price_data
       WHERE timeframe = $1 ORDER BY timestamp ASC`,
      [timeframe]
    );
    return rows.map((r: any) => ({
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume) || 0,
    }));
  }

  async getCandleCount(timeframe: string): Promise<number> {
    await priceTableReady;
    const { rows } = await queryWithRetry(
      `SELECT COUNT(*)::int AS count FROM price_data WHERE timeframe = $1`,
      [timeframe]
    );
    return rows[0].count;
  }

  async getCandleDateRange(timeframe: string): Promise<{ from: string; to: string } | null> {
    await priceTableReady;
    const { rows } = await queryWithRetry(
      `SELECT MIN(timestamp) AS min_ts, MAX(timestamp) AS max_ts FROM price_data WHERE timeframe = $1`,
      [timeframe]
    );
    if (!rows[0].min_ts) return null;
    const fmt = (v: any) => (v instanceof Date ? v.toISOString() : v);
    return { from: fmt(rows[0].min_ts), to: fmt(rows[0].max_ts) };
  }

  async saveBacktestResult(result: BacktestResult): Promise<BacktestResult> {
    await queryWithRetry(
      `INSERT INTO backtest_results (id, config, trades, stats, equity_curve, regime_counts, monthly_returns, diagnostics, data_source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         config = EXCLUDED.config,
         trades = EXCLUDED.trades,
         stats = EXCLUDED.stats,
         equity_curve = EXCLUDED.equity_curve,
         regime_counts = EXCLUDED.regime_counts,
         monthly_returns = EXCLUDED.monthly_returns,
         diagnostics = EXCLUDED.diagnostics,
         data_source = EXCLUDED.data_source`,
      [
        result.id,
        JSON.stringify(result.config),
        JSON.stringify(result.trades),
        JSON.stringify(result.stats),
        JSON.stringify(result.equityCurve),
        JSON.stringify(result.regimeCounts),
        JSON.stringify(result.monthlyReturns),
        JSON.stringify(result.diagnostics),
        result.dataSource,
        result.createdAt,
      ]
    );
    return result;
  }

  async insertBacktestIfNotExists(result: BacktestResult): Promise<boolean> {
    const res = await queryWithRetry(
      `INSERT INTO backtest_results (id, config, trades, stats, equity_curve, regime_counts, monthly_returns, diagnostics, data_source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING`,
      [
        result.id,
        JSON.stringify(result.config),
        JSON.stringify(result.trades),
        JSON.stringify(result.stats),
        JSON.stringify(result.equityCurve),
        JSON.stringify(result.regimeCounts),
        JSON.stringify(result.monthlyReturns),
        JSON.stringify(result.diagnostics),
        result.dataSource,
        result.createdAt,
      ]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async getBacktestResult(id: string): Promise<BacktestResult | undefined> {
    const { rows } = await queryWithRetry(
      `SELECT * FROM backtest_results WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) return undefined;
    return this.rowToResult(rows[0]);
  }

  async listBacktestResults(): Promise<BacktestResult[]> {
    const { rows } = await queryWithRetry(
      `SELECT * FROM backtest_results WHERE archived = FALSE ORDER BY created_at DESC`
    );
    return rows.map((row) => this.rowToResult(row));
  }

  async deleteBacktestResult(id: string): Promise<void> {
    await queryWithRetry(
      `UPDATE backtest_results SET archived = TRUE, archive_reason = 'user_deleted' WHERE id = $1`,
      [id]
    );
  }

  async archiveBacktestResult(id: string, reason?: string): Promise<void> {
    await queryWithRetry(
      `UPDATE backtest_results SET archived = TRUE, archive_reason = $2 WHERE id = $1`,
      [id, reason || 'archived']
    );
  }

  async restoreBacktestResult(id: string): Promise<void> {
    await queryWithRetry(
      `UPDATE backtest_results SET archived = FALSE, archive_reason = NULL WHERE id = $1`,
      [id]
    );
  }

  async listArchivedBacktests(): Promise<BacktestResult[]> {
    const { rows } = await queryWithRetry(
      `SELECT * FROM backtest_results WHERE archived = TRUE ORDER BY created_at DESC`
    );
    return rows.map((row) => this.rowToResult(row));
  }

  async labelBacktestResult(id: string, label: string): Promise<void> {
    await queryWithRetry(
      `UPDATE backtest_results SET label = $2 WHERE id = $1`,
      [id, label]
    );
  }

  async logStrategyChange(entry: { backtestId?: string; action: string; description?: string; configSnapshot?: any; statsSnapshot?: any; previousBestId?: string; previousBestStats?: any }): Promise<void> {
    await queryWithRetry(
      `INSERT INTO strategy_changelog (backtest_id, action, description, config_snapshot, stats_snapshot, previous_best_id, previous_best_stats)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [entry.backtestId || null, entry.action, entry.description || null,
       entry.configSnapshot ? JSON.stringify(entry.configSnapshot) : null,
       entry.statsSnapshot ? JSON.stringify(entry.statsSnapshot) : null,
       entry.previousBestId || null,
       entry.previousBestStats ? JSON.stringify(entry.previousBestStats) : null]
    );
  }

  async getStrategyChangelog(): Promise<any[]> {
    const { rows } = await queryWithRetry(
      `SELECT * FROM strategy_changelog ORDER BY created_at DESC`
    );
    return rows;
  }

  private rowToResult(row: any): BacktestResult {
    const defaultDiagnostics = {
      blockedBySession: 0,
      blockedByNews: 0,
      blockedByGap: 0,
      blockedByMidpointBand: 0,
      blockedByRetestDistance: 0,
      blockedByWickRatio: 0,
      blockedByCompression: 0,
      blockedByExpansion: 0,
      blockedByMaxTradesPerDay: 0,
      blockedByMaxDrawdown: 0,
      blockedByDailyLossLimit: 0,
      blockedByConsecutiveLossLimit: 0,
      reducedSizeAfterLossCount: 0,
      atrScaledRiskCount: 0,
      secondTradeReducedRiskCount: 0,
      buyCandidates: 0,
      sellCandidates: 0,
      acceptedBuyTrades: 0,
      acceptedSellTrades: 0,
    };
    const config = { ...row.config };
    config.leverage = 10;
    config.maxDrawdownPct = 25;
    if (!config.startingBalance || config.startingBalance < 3000) config.startingBalance = 3000;
    return {
      id: row.id,
      config,
      trades: row.trades,
      stats: row.stats,
      equityCurve: row.equity_curve,
      regimeCounts: row.regime_counts,
      monthlyReturns: row.monthly_returns,
      diagnostics: { ...defaultDiagnostics, ...(row.diagnostics ?? {}) },
      dataSource: row.data_source,
      archived: row.archived ?? false,
      archiveReason: row.archive_reason ?? null,
      label: row.label ?? null,
      createdAt: row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
    };
  }

  async saveStrategy(strategy: SavedStrategy): Promise<SavedStrategy> {
    await priceTableReady;
    await queryWithRetry(
      `INSERT INTO saved_strategies (id, name, category, config, stats, diagnostics, notes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         category = EXCLUDED.category,
         config = EXCLUDED.config,
         stats = EXCLUDED.stats,
         diagnostics = EXCLUDED.diagnostics,
         notes = EXCLUDED.notes`,
      [
        strategy.id,
        strategy.name,
        strategy.category,
        JSON.stringify(strategy.config),
        JSON.stringify(strategy.stats),
        strategy.diagnostics ? JSON.stringify(strategy.diagnostics) : null,
        strategy.notes || null,
        strategy.createdAt,
      ]
    );
    return strategy;
  }

  async getStrategy(id: string): Promise<SavedStrategy | undefined> {
    await priceTableReady;
    const { rows } = await queryWithRetry(`SELECT * FROM saved_strategies WHERE id = $1`, [id]);
    if (rows.length === 0) return undefined;
    return this.rowToStrategy(rows[0]);
  }

  async getStrategyByName(name: string): Promise<SavedStrategy | undefined> {
    await priceTableReady;
    const { rows } = await queryWithRetry(`SELECT * FROM saved_strategies WHERE LOWER(name) = LOWER($1) LIMIT 1`, [name]);
    if (rows.length === 0) return undefined;
    return this.rowToStrategy(rows[0]);
  }

  async listStrategies(): Promise<SavedStrategy[]> {
    await priceTableReady;
    const { rows } = await queryWithRetry(`SELECT * FROM saved_strategies ORDER BY created_at DESC`);
    return rows.map((row: any) => this.rowToStrategy(row));
  }

  async deleteStrategy(id: string): Promise<void> {
    await priceTableReady;
    await queryWithRetry(`DELETE FROM saved_strategies WHERE id = $1`, [id]);
  }

  private rowToStrategy(row: any): SavedStrategy {
    const config = { ...row.config };
    config.leverage = 10;
    config.maxDrawdownPct = 25;
    if (!config.startingBalance || config.startingBalance < 3000) config.startingBalance = 3000;
    return {
      id: row.id,
      name: row.name,
      category: row.category || '',
      config,
      stats: row.stats,
      diagnostics: row.diagnostics || undefined,
      notes: row.notes || undefined,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }

  async saveJournalEntry(entry: JournalEntry): Promise<JournalEntry> {
    await priceTableReady;
    await queryWithRetry(
      `INSERT INTO optimization_journal (id, created_at, source, suggestions, before_backtest_id, before_stats, after_backtest_id, after_stats, outcome, learnings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         suggestions = EXCLUDED.suggestions,
         before_backtest_id = EXCLUDED.before_backtest_id,
         before_stats = EXCLUDED.before_stats,
         after_backtest_id = EXCLUDED.after_backtest_id,
         after_stats = EXCLUDED.after_stats,
         outcome = EXCLUDED.outcome,
         learnings = EXCLUDED.learnings`,
      [
        entry.id,
        entry.createdAt,
        entry.source,
        JSON.stringify(entry.suggestions),
        entry.beforeBacktestId || null,
        entry.beforeStats ? JSON.stringify(entry.beforeStats) : null,
        entry.afterBacktestId || null,
        entry.afterStats ? JSON.stringify(entry.afterStats) : null,
        entry.outcome || 'pending',
        entry.learnings || null,
      ]
    );
    return entry;
  }

  async insertJournalIfNotExists(entry: JournalEntry): Promise<boolean> {
    await priceTableReady;
    const res = await queryWithRetry(
      `INSERT INTO optimization_journal (id, created_at, source, suggestions, before_backtest_id, before_stats, after_backtest_id, after_stats, outcome, learnings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING`,
      [
        entry.id,
        entry.createdAt,
        entry.source,
        JSON.stringify(entry.suggestions),
        entry.beforeBacktestId || null,
        entry.beforeStats ? JSON.stringify(entry.beforeStats) : null,
        entry.afterBacktestId || null,
        entry.afterStats ? JSON.stringify(entry.afterStats) : null,
        entry.outcome || 'pending',
        entry.learnings || null,
      ]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async updateJournalEntry(id: string, updates: Partial<JournalEntry>): Promise<void> {
    await priceTableReady;
    const sets: string[] = [];
    const values: any[] = [];
    let idx = 1;
    if (updates.afterBacktestId !== undefined) { sets.push(`after_backtest_id = $${idx++}`); values.push(updates.afterBacktestId); }
    if (updates.afterStats !== undefined) { sets.push(`after_stats = $${idx++}`); values.push(JSON.stringify(updates.afterStats)); }
    if (updates.outcome !== undefined) { sets.push(`outcome = $${idx++}`); values.push(updates.outcome); }
    if (updates.learnings !== undefined) { sets.push(`learnings = $${idx++}`); values.push(updates.learnings); }
    if (sets.length === 0) return;
    values.push(id);
    await queryWithRetry(`UPDATE optimization_journal SET ${sets.join(', ')} WHERE id = $${idx}`, values);
  }

  async listJournalEntries(limit = 50): Promise<JournalEntry[]> {
    await priceTableReady;
    const { rows } = await queryWithRetry(
      `SELECT * FROM optimization_journal ORDER BY created_at DESC LIMIT $1`, [limit]
    );
    return rows.map((row: any) => ({
      id: row.id,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      source: row.source,
      suggestions: row.suggestions || [],
      beforeBacktestId: row.before_backtest_id || undefined,
      beforeStats: row.before_stats || undefined,
      afterBacktestId: row.after_backtest_id || undefined,
      afterStats: row.after_stats || undefined,
      outcome: row.outcome || 'pending',
      learnings: row.learnings || undefined,
    }));
  }

  async getLatestPendingJournal(): Promise<JournalEntry | undefined> {
    await priceTableReady;
    const { rows } = await queryWithRetry(
      `SELECT * FROM optimization_journal WHERE outcome = 'pending' ORDER BY created_at DESC LIMIT 1`
    );
    if (rows.length === 0) return undefined;
    const row = rows[0];
    return {
      id: row.id,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      source: row.source,
      suggestions: row.suggestions || [],
      beforeBacktestId: row.before_backtest_id || undefined,
      beforeStats: row.before_stats || undefined,
      afterBacktestId: row.after_backtest_id || undefined,
      afterStats: row.after_stats || undefined,
      outcome: row.outcome || 'pending',
      learnings: row.learnings || undefined,
    };
  }

  async getLockedParams(): Promise<Record<string, any> | null> {
    await priceTableReady;
    const { rows } = await queryWithRetry(`SELECT value FROM locked_params WHERE key = 'current' LIMIT 1`);
    return rows.length > 0 ? rows[0].value : null;
  }

  async setLockedParams(params: Record<string, any>): Promise<void> {
    await priceTableReady;
    await queryWithRetry(
      `INSERT INTO locked_params (key, value, updated_at) VALUES ('current', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(params)]
    );
  }

  async saveLockedParamsProposal(proposal: LockedParamsProposal): Promise<void> {
    await priceTableReady;
    await queryWithRetry(
      `INSERT INTO locked_params_proposals (id, created_at, source, current_params, proposed_params, changed_keys, current_stats, proposed_stats, rationale, status, backtest_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING`,
      [proposal.id, proposal.createdAt, proposal.source, JSON.stringify(proposal.currentParams), JSON.stringify(proposal.proposedParams), JSON.stringify(proposal.changedKeys), JSON.stringify(proposal.currentStats), JSON.stringify(proposal.proposedStats), proposal.rationale, proposal.status, proposal.backtestId || null]
    );
  }

  async getLockedParamsProposal(id: string): Promise<LockedParamsProposal | undefined> {
    await priceTableReady;
    const { rows } = await queryWithRetry(`SELECT * FROM locked_params_proposals WHERE id = $1`, [id]);
    if (rows.length === 0) return undefined;
    const r = rows[0];
    return {
      id: r.id,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      source: r.source,
      currentParams: r.current_params,
      proposedParams: r.proposed_params,
      changedKeys: r.changed_keys || [],
      currentStats: r.current_stats,
      proposedStats: r.proposed_stats,
      rationale: r.rationale,
      status: r.status,
      backtestId: r.backtest_id || undefined,
    };
  }

  async listLockedParamsProposals(): Promise<LockedParamsProposal[]> {
    await priceTableReady;
    const { rows } = await queryWithRetry(`SELECT * FROM locked_params_proposals ORDER BY created_at DESC LIMIT 50`);
    return rows.map((r: any) => ({
      id: r.id,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      source: r.source,
      currentParams: r.current_params,
      proposedParams: r.proposed_params,
      changedKeys: r.changed_keys || [],
      currentStats: r.current_stats,
      proposedStats: r.proposed_stats,
      rationale: r.rationale,
      status: r.status,
      backtestId: r.backtest_id || undefined,
    }));
  }

  async updateLockedParamsProposalStatus(id: string, status: "approved" | "rejected"): Promise<void> {
    await priceTableReady;
    await queryWithRetry(`UPDATE locked_params_proposals SET status = $1 WHERE id = $2`, [status, id]);
  }

  async saveParamChangelog(entry: { source: string; changedKeys: string[]; oldValues: Record<string, any>; newValues: Record<string, any>; rationale: string; fullParams: Record<string, any> }): Promise<void> {
    await priceTableReady;
    await queryWithRetry(
      `INSERT INTO param_changelog (source, changed_keys, old_values, new_values, rationale, full_params)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [entry.source, JSON.stringify(entry.changedKeys), JSON.stringify(entry.oldValues), JSON.stringify(entry.newValues), entry.rationale, JSON.stringify(entry.fullParams)]
    );
  }

  async listParamChangelog(limit = 50): Promise<any[]> {
    await priceTableReady;
    const result = await queryWithRetry(
      `SELECT id, timestamp, source, changed_keys, old_values, new_values, rationale FROM param_changelog ORDER BY timestamp DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      source: r.source,
      changedKeys: r.changed_keys,
      oldValues: r.old_values,
      newValues: r.new_values,
      rationale: r.rationale,
    }));
  }

  async saveMarketObservation(obs: {
    price: number; bid?: number; ask?: number; spread?: number;
    atrH1?: number; atrH4?: number; regime?: string;
    rangeHigh?: number; rangeLow?: number; session?: string;
    conditions?: Record<string, any>; notes?: string;
  }): Promise<void> {
    await priceTableReady;
    await queryWithRetry(
      `INSERT INTO market_observations (price, bid, ask, spread, atr_h1, atr_h4, regime, range_high, range_low, session, conditions, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [obs.price, obs.bid, obs.ask, obs.spread, obs.atrH1, obs.atrH4, obs.regime,
       obs.rangeHigh, obs.rangeLow, obs.session, JSON.stringify(obs.conditions || {}), obs.notes]
    );
  }

  async getRecentObservations(limit = 50): Promise<any[]> {
    await priceTableReady;
    const { rows } = await queryWithRetry(`SELECT * FROM market_observations ORDER BY timestamp DESC LIMIT $1`, [limit]);
    return rows;
  }

  async saveTradeDecision(dec: {
    decision: string; side?: string; price: number; regime?: string;
    conditions?: Record<string, any>; blockReason?: string;
    signalDetails?: Record<string, any>; marketContext?: Record<string, any>;
    outcome?: string; pnl?: number; notes?: string;
  }): Promise<number> {
    await priceTableReady;
    const { rows } = await queryWithRetry(
      `INSERT INTO trade_decisions (decision, side, price, regime, conditions, block_reason, signal_details, market_context, outcome, pnl, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [dec.decision, dec.side, dec.price, dec.regime, JSON.stringify(dec.conditions || {}),
       dec.blockReason, dec.signalDetails ? JSON.stringify(dec.signalDetails) : null,
       JSON.stringify(dec.marketContext || {}), dec.outcome, dec.pnl, dec.notes]
    );
    return rows[0].id;
  }

  async updateTradeDecisionOutcome(id: number, outcome: string, pnl?: number): Promise<void> {
    await priceTableReady;
    await queryWithRetry(`UPDATE trade_decisions SET outcome = $1, pnl = $2 WHERE id = $3`, [outcome, pnl, id]);
  }

  async getRecentTradeDecisions(limit = 100): Promise<any[]> {
    await priceTableReady;
    const { rows } = await queryWithRetry(`SELECT * FROM trade_decisions ORDER BY timestamp DESC LIMIT $1`, [limit]);
    return rows;
  }

  async getTradeDecisionStats(): Promise<{ total: number; entries: number; skips: number; wins: number; losses: number; totalPnl: number; total_pnl: number }> {
    await priceTableReady;
    const { rows } = await queryWithRetry(`
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE decision = 'entry')::int as entries,
        COUNT(*) FILTER (WHERE decision = 'skip')::int as skips,
        COUNT(*) FILTER (WHERE outcome = 'win')::int as wins,
        COUNT(*) FILTER (WHERE outcome = 'loss')::int as losses,
        COALESCE(SUM(pnl) FILTER (WHERE pnl IS NOT NULL), 0)::float as total_pnl
      FROM trade_decisions
    `);
    return rows[0];
  }

  async getTradeCountsByPeriod(): Promise<{ today: number; thisWeek: number; thisMonth: number; allTime: number; pnlToday: number; pnlThisWeek: number; pnlThisMonth: number; pnlAllTime: number }> {
    await priceTableReady;
    const { rows } = await queryWithRetry(`
      SELECT
        COUNT(*) FILTER (WHERE opened_at >= CURRENT_DATE)::int as today,
        COUNT(*) FILTER (WHERE opened_at >= date_trunc('week', CURRENT_DATE))::int as this_week,
        COUNT(*) FILTER (WHERE opened_at >= date_trunc('month', CURRENT_DATE))::int as this_month,
        COUNT(*)::int as all_time,
        COALESCE(SUM(pnl) FILTER (WHERE pnl IS NOT NULL AND opened_at >= CURRENT_DATE), 0)::float as pnl_today,
        COALESCE(SUM(pnl) FILTER (WHERE pnl IS NOT NULL AND opened_at >= date_trunc('week', CURRENT_DATE)), 0)::float as pnl_this_week,
        COALESCE(SUM(pnl) FILTER (WHERE pnl IS NOT NULL AND opened_at >= date_trunc('month', CURRENT_DATE)), 0)::float as pnl_this_month,
        COALESCE(SUM(pnl) FILTER (WHERE pnl IS NOT NULL), 0)::float as pnl_all_time
      FROM live_trades
    `);
    return {
      today: rows[0]?.today || 0,
      thisWeek: rows[0]?.this_week || 0,
      thisMonth: rows[0]?.this_month || 0,
      allTime: rows[0]?.all_time || 0,
      pnlToday: rows[0]?.pnl_today || 0,
      pnlThisWeek: rows[0]?.pnl_this_week || 0,
      pnlThisMonth: rows[0]?.pnl_this_month || 0,
      pnlAllTime: rows[0]?.pnl_all_time || 0,
    };
  }

  async seedHistoricalTrades(): Promise<void> {
    await priceTableReady;
    const { rows } = await queryWithRetry(`SELECT COUNT(*)::int as count FROM live_trades`);
    if (rows[0]?.count > 0) return;
    console.log("[seed] No live trades found — inserting 3 historical trades ($192.98 P&L)");
    const historicalTrades = [
      { opened_at: '2026-01-15 10:00:00+00', closed_at: '2026-01-16 14:00:00+00', side: 'buy', entry_price: 4720.05, exit_price: 4816.94, volume: 100, pnl: 193.47, status: 'closed', regime: 'trend' },
      { opened_at: '2026-02-20 09:00:00+00', closed_at: '2026-02-20 15:00:00+00', side: 'sell', entry_price: 4735.44, exit_price: 4735.13, volume: 100, pnl: 0.31, status: 'closed', regime: 'trend' },
      { opened_at: '2026-03-10 11:00:00+00', closed_at: '2026-03-10 16:00:00+00', side: 'buy', entry_price: 4780.00, exit_price: 4779.20, volume: 100, pnl: -0.80, status: 'closed', regime: 'trend' },
    ];
    for (const t of historicalTrades) {
      await queryWithRetry(
        `INSERT INTO live_trades (opened_at, closed_at, side, entry_price, exit_price, volume, pnl, status, regime)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
        [t.opened_at, t.closed_at, t.side, t.entry_price, t.exit_price, t.volume, t.pnl, t.status, t.regime]
      );
    }
    console.log("[seed] Historical trades seeded successfully");
  }

  async seedCuratedStrategies(): Promise<void> {
    await priceTableReady;
    const { rows } = await queryWithRetry(`SELECT id FROM saved_strategies WHERE id LIKE 'strat-1775982%' LIMIT 1`);
    if (rows.length > 0) return;
    console.log("[seed] Curated strategies not found — inserting 9 strategy catalogue entries");
    const strategies = [
      { id: "strat-1775982963975-r37w7z", name: "Conservative Guardian", category: "Low Risk", config: {"lotSize":0.01,"leverage":10,"atrPeriod":14,"wickRatio":0.35,"minRangeATR":1.5,"rewardRatio":4,"sessionMode":"London","newsAfterMin":30,"retestBuffer":12,"spreadPoints":0.3,"atrStopPeriod":14,"newsBeforeMin":30,"maxDrawdownPct":25,"rangeWidthBars":6,"slippagePoints":0.1,"entryWindowBars":0,"gapCooldownBars":2,"gapThresholdAtr":0.5,"maxDailyLossPct":2,"maxTradesPerDay":7,"midpointBandPct":0.08,"riskPerTradePct":1.5,"startingBalance":3000,"commissionPerLot":0,"gapFilterEnabled":true,"maxTrendATRRatio":5,"atrStopMultiplier":2,"sessionORBEnabled":true,"atrRiskScaleFactor":0.65,"expansionThreshold":1.06,"atrRiskScaleEnabled":true,"reduceSizeAfterLoss":true,"trailingStopEnabled":false,"compressionThreshold":0.008,"maxConsecutiveLosses":4,"postLossCooldownBars":2,"trailingStopTriggerR":1,"atrRiskScaleThreshold":1.25,"secondTradeRiskFactor":0.75,"reducedRiskPerTradePct":0.5}, stats: {"winRate":61.5,"returnPct":37.48,"returnPerDD":19.1,"totalTrades":13,"profitFactor":7.72,"maxDrawdownPct":1.96}, notes: "1.5% risk per trade with all safety nets active. Lowest drawdown, steady compounding. Best for capital preservation.", created_at: "2026-04-12 08:36:03.975+00" },
      { id: "strat-1775982963999-hnlawb", name: "Steady Compounder", category: "Low Risk", config: {"lotSize":0.01,"leverage":10,"atrPeriod":14,"wickRatio":0.35,"minRangeATR":1.5,"rewardRatio":4,"sessionMode":"London","newsAfterMin":30,"retestBuffer":12,"spreadPoints":0.3,"atrStopPeriod":14,"newsBeforeMin":30,"maxDrawdownPct":25,"rangeWidthBars":6,"slippagePoints":0.1,"entryWindowBars":0,"gapCooldownBars":2,"gapThresholdAtr":0.5,"maxDailyLossPct":2,"maxTradesPerDay":7,"midpointBandPct":0.08,"riskPerTradePct":2.5,"startingBalance":3000,"commissionPerLot":0,"gapFilterEnabled":true,"maxTrendATRRatio":5,"atrStopMultiplier":2,"sessionORBEnabled":true,"atrRiskScaleFactor":0.65,"expansionThreshold":1.06,"atrRiskScaleEnabled":true,"reduceSizeAfterLoss":true,"trailingStopEnabled":false,"compressionThreshold":0.008,"maxConsecutiveLosses":4,"postLossCooldownBars":2,"trailingStopTriggerR":1,"atrRiskScaleThreshold":1.25,"secondTradeRiskFactor":0.75,"reducedRiskPerTradePct":0.5}, stats: {"winRate":88.9,"returnPct":83.72,"returnPerDD":41.9,"totalTrades":9,"profitFactor":30.83,"maxDrawdownPct":2}, notes: "2.5% risk with all safety nets. The original champion baseline. Reliable and consistent performance.", created_at: "2026-04-12 08:36:03.999+00" },
      { id: "strat-1775982964001-8wpd31", name: "London Sniper", category: "Low Risk", config: {"lotSize":0.01,"leverage":10,"atrPeriod":14,"wickRatio":0.35,"minRangeATR":1.5,"rewardRatio":4,"sessionMode":"London","newsAfterMin":30,"retestBuffer":12,"spreadPoints":0.3,"atrStopPeriod":14,"newsBeforeMin":30,"maxDrawdownPct":25,"rangeWidthBars":6,"slippagePoints":0.1,"entryWindowBars":3,"gapCooldownBars":2,"gapThresholdAtr":0.5,"maxDailyLossPct":2,"maxTradesPerDay":7,"midpointBandPct":0.08,"riskPerTradePct":2.5,"startingBalance":3000,"commissionPerLot":0,"gapFilterEnabled":true,"maxTrendATRRatio":5,"atrStopMultiplier":2,"sessionORBEnabled":true,"atrRiskScaleFactor":0.65,"expansionThreshold":1.06,"atrRiskScaleEnabled":true,"reduceSizeAfterLoss":true,"trailingStopEnabled":false,"compressionThreshold":0.008,"maxConsecutiveLosses":4,"postLossCooldownBars":2,"trailingStopTriggerR":1,"atrRiskScaleThreshold":1.25,"secondTradeRiskFactor":0.75,"reducedRiskPerTradePct":0.5}, stats: {"winRate":80,"returnPct":76.38,"returnPerDD":46.6,"totalTrades":10,"profitFactor":15.77,"maxDrawdownPct":1.64}, notes: "2.5% risk with 3h London entry window. Extremely selective — only the best early London setups. Highest win rate in Low Risk class.", created_at: "2026-04-12 08:36:04.002+00" },
      { id: "strat-1775982964004-u63pdz", name: "Balanced Aggressor", category: "Medium Risk", config: {"lotSize":0.01,"leverage":10,"atrPeriod":14,"wickRatio":0.35,"minRangeATR":1.5,"rewardRatio":4,"sessionMode":"London","newsAfterMin":30,"retestBuffer":12,"spreadPoints":0.3,"atrStopPeriod":14,"newsBeforeMin":30,"maxDrawdownPct":25,"rangeWidthBars":6,"slippagePoints":0.1,"entryWindowBars":3,"gapCooldownBars":2,"gapThresholdAtr":0.5,"maxDailyLossPct":5,"maxTradesPerDay":7,"midpointBandPct":0.08,"riskPerTradePct":5,"startingBalance":3000,"commissionPerLot":0,"gapFilterEnabled":true,"maxTrendATRRatio":5,"atrStopMultiplier":2,"sessionORBEnabled":true,"atrRiskScaleFactor":0.65,"expansionThreshold":1.06,"atrRiskScaleEnabled":true,"reduceSizeAfterLoss":true,"trailingStopEnabled":false,"compressionThreshold":0.008,"maxConsecutiveLosses":6,"postLossCooldownBars":2,"trailingStopTriggerR":1,"atrRiskScaleThreshold":1.25,"secondTradeRiskFactor":0.75,"reducedRiskPerTradePct":0.5}, stats: {"winRate":80,"returnPct":172.22,"returnPerDD":52.8,"totalTrades":10,"profitFactor":12.61,"maxDrawdownPct":3.26}, notes: "5% risk with 3h entry window and all safety nets. Strong returns with controlled drawdown. Good balance of growth and protection.", created_at: "2026-04-12 08:36:04.004+00" },
      { id: "strat-1775982964007-hi805c", name: "Growth Engine", category: "Medium Risk", config: {"lotSize":0.01,"leverage":10,"atrPeriod":14,"wickRatio":0.35,"minRangeATR":1.5,"rewardRatio":3.5,"sessionMode":"London","newsAfterMin":30,"retestBuffer":12,"spreadPoints":0.3,"atrStopPeriod":14,"newsBeforeMin":30,"maxDrawdownPct":25,"rangeWidthBars":6,"slippagePoints":0.1,"entryWindowBars":3,"gapCooldownBars":2,"gapThresholdAtr":0.5,"maxDailyLossPct":5,"maxTradesPerDay":7,"midpointBandPct":0.08,"riskPerTradePct":7,"startingBalance":3000,"commissionPerLot":0,"gapFilterEnabled":true,"maxTrendATRRatio":5,"atrStopMultiplier":2,"sessionORBEnabled":true,"atrRiskScaleFactor":0.65,"expansionThreshold":1.06,"atrRiskScaleEnabled":true,"reduceSizeAfterLoss":true,"trailingStopEnabled":false,"compressionThreshold":0.008,"maxConsecutiveLosses":6,"postLossCooldownBars":2,"trailingStopTriggerR":1,"atrRiskScaleThreshold":1.25,"secondTradeRiskFactor":0.75,"reducedRiskPerTradePct":0.5}, stats: {"winRate":75,"returnPct":290.87,"returnPerDD":59.7,"totalTrades":12,"profitFactor":11.45,"maxDrawdownPct":4.87}, notes: "7% risk, RR 3.5, 3h entry window. Optimized for maximum growth while keeping safety nets. Excellent R/DD ratio of 59.73.", created_at: "2026-04-12 08:36:04.007+00" },
      { id: "strat-1775982964010-ftwg7m", name: "Momentum Rider", category: "Medium Risk", config: {"lotSize":0.01,"leverage":10,"atrPeriod":14,"wickRatio":0.35,"minRangeATR":1.5,"rewardRatio":4,"sessionMode":"London+NewYork","newsAfterMin":30,"retestBuffer":12,"spreadPoints":0.3,"atrStopPeriod":14,"newsBeforeMin":30,"maxDrawdownPct":25,"rangeWidthBars":6,"slippagePoints":0.1,"entryWindowBars":3,"gapCooldownBars":2,"gapThresholdAtr":0.5,"maxDailyLossPct":5,"maxTradesPerDay":7,"midpointBandPct":0.08,"riskPerTradePct":9,"startingBalance":3000,"commissionPerLot":0,"gapFilterEnabled":true,"maxTrendATRRatio":5,"atrStopMultiplier":2,"sessionORBEnabled":true,"atrRiskScaleFactor":0.65,"expansionThreshold":1.06,"atrRiskScaleEnabled":true,"reduceSizeAfterLoss":true,"trailingStopEnabled":true,"compressionThreshold":0.008,"maxConsecutiveLosses":6,"postLossCooldownBars":2,"trailingStopTriggerR":1.5,"atrRiskScaleThreshold":1.25,"secondTradeRiskFactor":0.75,"reducedRiskPerTradePct":0.5}, stats: {"winRate":70,"returnPct":505.53,"returnPerDD":86.4,"totalTrades":10,"profitFactor":14.44,"maxDrawdownPct":5.85}, notes: "9% risk with ATR scaling and trailing stops at 1.5R. Safety nets protect against large losses while trailing stops lock in outsized gains.", created_at: "2026-04-12 08:36:04.01+00" },
      { id: "strat-1775982964013-c4drjk", name: "Full Throttle", category: "High Risk", config: {"lotSize":0.01,"leverage":10,"atrPeriod":14,"wickRatio":0.35,"minRangeATR":1.5,"rewardRatio":4,"sessionMode":"London","newsAfterMin":30,"retestBuffer":12,"spreadPoints":0.3,"atrStopPeriod":14,"newsBeforeMin":30,"maxDrawdownPct":25,"rangeWidthBars":6,"slippagePoints":0.1,"entryWindowBars":2,"gapCooldownBars":2,"gapThresholdAtr":0.5,"maxDailyLossPct":8,"maxTradesPerDay":7,"midpointBandPct":0.08,"riskPerTradePct":10,"startingBalance":3000,"commissionPerLot":0,"gapFilterEnabled":true,"maxTrendATRRatio":5,"atrStopMultiplier":2,"sessionORBEnabled":true,"atrRiskScaleFactor":0.65,"expansionThreshold":1.06,"atrRiskScaleEnabled":false,"reduceSizeAfterLoss":false,"trailingStopEnabled":false,"compressionThreshold":0.008,"maxConsecutiveLosses":6,"postLossCooldownBars":2,"trailingStopTriggerR":1,"atrRiskScaleThreshold":1.25,"secondTradeRiskFactor":1,"reducedRiskPerTradePct":0.5}, stats: {"winRate":88.9,"returnPct":750.02,"returnPerDD":75,"totalTrades":9,"profitFactor":30,"maxDrawdownPct":10}, notes: "10% risk, no safety nets, RR 4:1, 2h London entry. The overall champion — 750% return with only 10% drawdown. Extremely selective: 9 trades, 89% win rate.", created_at: "2026-04-12 08:36:04.013+00" },
      { id: "strat-1775982964016-a97acy", name: "Trailing Titan", category: "High Risk", config: {"lotSize":0.01,"leverage":10,"atrPeriod":14,"wickRatio":0.35,"minRangeATR":1.5,"rewardRatio":4,"sessionMode":"London","newsAfterMin":30,"retestBuffer":12,"spreadPoints":0.3,"atrStopPeriod":14,"newsBeforeMin":30,"maxDrawdownPct":25,"rangeWidthBars":6,"slippagePoints":0.1,"entryWindowBars":3,"gapCooldownBars":2,"gapThresholdAtr":0.5,"maxDailyLossPct":8,"maxTradesPerDay":7,"midpointBandPct":0.08,"riskPerTradePct":10,"startingBalance":3000,"commissionPerLot":0,"gapFilterEnabled":true,"maxTrendATRRatio":5,"atrStopMultiplier":2,"sessionORBEnabled":true,"atrRiskScaleFactor":0.65,"expansionThreshold":1.06,"atrRiskScaleEnabled":false,"reduceSizeAfterLoss":false,"trailingStopEnabled":true,"compressionThreshold":0.008,"maxConsecutiveLosses":6,"postLossCooldownBars":2,"trailingStopTriggerR":1.5,"atrRiskScaleThreshold":1.25,"secondTradeRiskFactor":1,"reducedRiskPerTradePct":0.5}, stats: {"winRate":70,"returnPct":690.13,"returnPerDD":69,"totalTrades":10,"profitFactor":8.86,"maxDrawdownPct":10}, notes: "10% risk, no safety nets, trailing stop at 1.5R. 690% return — trailing stops lock in outsized moves while maintaining aggressive positioning.", created_at: "2026-04-12 08:36:04.016+00" },
      { id: "strat-1775982964018-zizgaz", name: "Risk-Adjusted King", category: "High Risk", config: {"lotSize":0.01,"leverage":10,"atrPeriod":14,"wickRatio":0.35,"minRangeATR":1.5,"rewardRatio":4,"sessionMode":"London+NewYork","newsAfterMin":30,"retestBuffer":12,"spreadPoints":0.3,"atrStopPeriod":14,"newsBeforeMin":30,"maxDrawdownPct":25,"rangeWidthBars":6,"slippagePoints":0.1,"entryWindowBars":3,"gapCooldownBars":2,"gapThresholdAtr":0.5,"maxDailyLossPct":5,"maxTradesPerDay":7,"midpointBandPct":0.08,"riskPerTradePct":10,"startingBalance":3000,"commissionPerLot":0,"gapFilterEnabled":true,"maxTrendATRRatio":5,"atrStopMultiplier":2,"sessionORBEnabled":true,"atrRiskScaleFactor":0.65,"expansionThreshold":1.06,"atrRiskScaleEnabled":true,"reduceSizeAfterLoss":false,"trailingStopEnabled":false,"compressionThreshold":0.008,"maxConsecutiveLosses":6,"postLossCooldownBars":2,"trailingStopTriggerR":1,"atrRiskScaleThreshold":1.25,"secondTradeRiskFactor":0.75,"reducedRiskPerTradePct":0.5}, stats: {"winRate":80,"returnPct":587.75,"returnPerDD":90.4,"totalTrades":10,"profitFactor":10.27,"maxDrawdownPct":6.5}, notes: "10% risk with ATR scaling kept on (no reduce after loss). Best R/DD ratio of 90.42 across all 75 backtests. ATR scaling provides intelligent position sizing in volatile conditions.", created_at: "2026-04-12 08:36:04.018+00" },
    ];
    for (const s of strategies) {
      await queryWithRetry(
        `INSERT INTO saved_strategies (id, name, category, config, stats, notes, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [s.id, s.name, s.category, JSON.stringify(s.config), JSON.stringify(s.stats), s.notes, s.created_at]
      );
    }
    console.log("[seed] 9 curated strategies seeded successfully");
  }

  async insertLiveTrade(trade: {
    openedAt: Date | string;
    closedAt?: Date | string | null;
    side: string;
    entryPrice: number;
    exitPrice?: number | null;
    volume?: number;
    stopLoss?: number | null;
    takeProfit?: number | null;
    pnl?: number | null;
    status?: string;
    regime?: string | null;
    source?: string;
    ctraderPositionId?: string | null;
    ctraderDealId?: string | null;
    notes?: string | null;
  }): Promise<number> {
    await priceTableReady;
    const { rows } = await queryWithRetry(
      `INSERT INTO live_trades (opened_at, closed_at, side, entry_price, exit_price, volume, stop_loss, take_profit, pnl, status, regime, source, ctrader_position_id, ctrader_deal_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [trade.openedAt, trade.closedAt || null, trade.side, trade.entryPrice, trade.exitPrice ?? null,
       trade.volume ?? 100, trade.stopLoss ?? null, trade.takeProfit ?? null, trade.pnl ?? null,
       trade.status || (trade.closedAt ? "closed" : "open"), trade.regime || null,
       trade.source || "bot", trade.ctraderPositionId || null, trade.ctraderDealId || null, trade.notes || null]
    );
    return rows[0].id;
  }

  async updateLiveTrade(id: number, updates: {
    closedAt?: Date | string;
    exitPrice?: number;
    pnl?: number;
    status?: string;
    notes?: string;
  }): Promise<void> {
    await priceTableReady;
    const sets: string[] = [];
    const vals: any[] = [];
    let idx = 1;
    if (updates.closedAt !== undefined) { sets.push(`closed_at = $${idx++}`); vals.push(updates.closedAt); }
    if (updates.exitPrice !== undefined) { sets.push(`exit_price = $${idx++}`); vals.push(updates.exitPrice); }
    if (updates.pnl !== undefined) { sets.push(`pnl = $${idx++}`); vals.push(updates.pnl); }
    if (updates.status !== undefined) { sets.push(`status = $${idx++}`); vals.push(updates.status); }
    if (updates.notes !== undefined) { sets.push(`notes = $${idx++}`); vals.push(updates.notes); }
    if (sets.length === 0) return;
    vals.push(id);
    await queryWithRetry(`UPDATE live_trades SET ${sets.join(", ")} WHERE id = $${idx}`, vals);
  }

  async closeLiveTradeByPositionId(positionId: string, updates: {
    closedAt?: Date | string;
    exitPrice?: number;
    pnl?: number;
  }): Promise<number | null> {
    await priceTableReady;
    const { rows } = await queryWithRetry(
      `UPDATE live_trades SET closed_at = $1, exit_price = $2, pnl = $3, status = 'closed'
       WHERE ctrader_position_id = $4 AND status = 'open' RETURNING id`,
      [updates.closedAt || new Date(), updates.exitPrice, updates.pnl, positionId]
    );
    return rows.length > 0 ? rows[0].id : null;
  }

  async listLiveTrades(limit = 100): Promise<any[]> {
    await priceTableReady;
    const { rows } = await queryWithRetry(
      `SELECT * FROM live_trades ORDER BY opened_at DESC LIMIT $1`, [limit]
    );
    return rows;
  }

  async getLiveTradeStats(): Promise<{ total: number; wins: number; losses: number; open: number; totalPnl: number; winRate: number }> {
    await priceTableReady;
    const { rows } = await queryWithRetry(`
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE status = 'closed' AND pnl > 0)::int as wins,
        COUNT(*) FILTER (WHERE status = 'closed' AND pnl <= 0)::int as losses,
        COUNT(*) FILTER (WHERE status = 'open')::int as open,
        COALESCE(SUM(pnl) FILTER (WHERE status = 'closed'), 0)::float as total_pnl
      FROM live_trades
    `);
    const r = rows[0];
    const closed = r.wins + r.losses;
    return {
      total: r.total,
      wins: r.wins,
      losses: r.losses,
      open: r.open,
      totalPnl: r.total_pnl,
      winRate: closed > 0 ? Math.round((r.wins / closed) * 1000) / 10 : 0,
    };
  }

  async deleteLiveTrade(id: number): Promise<void> {
    await priceTableReady;
    await queryWithRetry(`DELETE FROM live_trades WHERE id = $1`, [id]);
  }

  async saveLearning(category: string, insight: string, confidence = 0.5, sourceData?: Record<string, any>): Promise<void> {
    await priceTableReady;
    const { rows: existing } = await queryWithRetry(
      `SELECT id, insight, confidence, times_reinforced FROM ai_learnings WHERE category = $1 ORDER BY times_reinforced DESC, confidence DESC LIMIT 50`,
      [category]
    );
    const normalize = (s: string) => s.toLowerCase().replace(/\$[\d.]+/g, '$X').replace(/\d+(\.\d+)?%/g, 'X%').replace(/p\d+/gi, 'PX').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    const normNew = normalize(insight);
    const words = (s: string) => new Set(s.split(' ').filter(w => w.length > 3));
    const newWords = words(normNew);
    let matchId: number | null = null;
    for (const row of existing) {
      const normOld = normalize(row.insight);
      const oldWords = words(normOld);
      const intersection = [...newWords].filter(w => oldWords.has(w));
      const similarity = intersection.length / Math.max(newWords.size, oldWords.size, 1);
      if (similarity > 0.6) {
        matchId = row.id;
        break;
      }
    }
    if (matchId) {
      await queryWithRetry(
        `UPDATE ai_learnings SET times_reinforced = times_reinforced + 1, confidence = LEAST(confidence + 0.05, 1.0), insight = $2 WHERE id = $1`,
        [matchId, insight]
      );
    } else {
      await queryWithRetry(
        `INSERT INTO ai_learnings (category, insight, confidence, source_data) VALUES ($1,$2,$3,$4)`,
        [category, insight, confidence, sourceData ? JSON.stringify(sourceData) : null]
      );
    }
  }

  async getLearnings(category?: string, minConfidence = 0): Promise<any[]> {
    await priceTableReady;
    let query = `SELECT * FROM ai_learnings WHERE confidence >= $1`;
    const params: any[] = [minConfidence];
    if (category) {
      query += ` AND category = $2`;
      params.push(category);
    }
    query += ` ORDER BY confidence DESC, times_reinforced DESC LIMIT 100`;
    const { rows } = await queryWithRetry(query, params);
    return rows;
  }

  async getObservationCount(): Promise<number> {
    await priceTableReady;
    const { rows } = await queryWithRetry(`SELECT COUNT(*)::int as count FROM market_observations`);
    return rows[0].count;
  }

  async upsertGVZData(data: { date: string; value: number }[]): Promise<number> {
    await priceTableReady;
    if (data.length === 0) return 0;
    let inserted = 0;
    for (const row of data) {
      try {
        await queryWithRetry(
          `INSERT INTO gvz_data (date, value) VALUES ($1, $2) ON CONFLICT (date) DO UPDATE SET value = $2`,
          [row.date, row.value]
        );
        inserted++;
      } catch (err: any) {
        if (!err.message?.includes("duplicate")) {
          console.error(`[GVZ] Failed to insert ${row.date}: ${err.message}`);
        }
      }
    }
    return inserted;
  }

  async getGVZData(limit = 500): Promise<{ date: string; value: number }[]> {
    await priceTableReady;
    const { rows } = await queryWithRetry(
      `SELECT date::text, value::float FROM gvz_data ORDER BY date DESC LIMIT $1`,
      [limit]
    );
    return rows.reverse();
  }

  async getLatestGVZ(): Promise<{ date: string; value: number } | null> {
    await priceTableReady;
    const { rows } = await queryWithRetry(
      `SELECT date::text, value::float FROM gvz_data ORDER BY date DESC LIMIT 1`
    );
    return rows[0] || null;
  }

  async getGVZForDate(date: string): Promise<number | null> {
    await priceTableReady;
    const { rows } = await queryWithRetry(
      `SELECT value::float FROM gvz_data WHERE date <= $1 ORDER BY date DESC LIMIT 1`,
      [date]
    );
    return rows[0]?.value || null;
  }

  async upsertCOTData(data: { date: string; noncommLong: number; noncommShort: number; netPosition: number; openInterest: number; commLong?: number; commShort?: number }[]): Promise<number> {
    await priceTableReady;
    if (data.length === 0) return 0;
    let inserted = 0;
    for (const row of data) {
      try {
        await queryWithRetry(
          `INSERT INTO cot_data (date, noncomm_long, noncomm_short, net_position, open_interest, comm_long, comm_short)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (date) DO UPDATE SET noncomm_long=$2, noncomm_short=$3, net_position=$4, open_interest=$5, comm_long=$6, comm_short=$7`,
          [row.date, row.noncommLong, row.noncommShort, row.netPosition, row.openInterest, row.commLong ?? 0, row.commShort ?? 0]
        );
        inserted++;
      } catch (err: any) {
        if (!err.message?.includes("duplicate")) {
          console.error(`[COT] Failed to insert ${row.date}: ${err.message}`);
        }
      }
    }
    return inserted;
  }

  async getCOTData(limit = 260): Promise<{ date: string; noncommLong: number; noncommShort: number; netPosition: number; openInterest: number }[]> {
    await priceTableReady;
    const { rows } = await queryWithRetry(
      `SELECT date::text, noncomm_long::int as "noncommLong", noncomm_short::int as "noncommShort", net_position::int as "netPosition", open_interest::int as "openInterest" FROM cot_data ORDER BY date DESC LIMIT $1`,
      [limit]
    );
    return rows.reverse();
  }

  async getLatestCOT(): Promise<{ date: string; noncommLong: number; noncommShort: number; netPosition: number; openInterest: number } | null> {
    await priceTableReady;
    const { rows } = await queryWithRetry(
      `SELECT date::text, noncomm_long::int as "noncommLong", noncomm_short::int as "noncommShort", net_position::int as "netPosition", open_interest::int as "openInterest" FROM cot_data ORDER BY date DESC LIMIT 1`
    );
    return rows[0] || null;
  }

  async getCOTForDate(date: string): Promise<{ netPosition: number; openInterest: number } | null> {
    await priceTableReady;
    const { rows } = await queryWithRetry(
      `SELECT net_position::int as "netPosition", open_interest::int as "openInterest" FROM cot_data WHERE date <= $1 ORDER BY date DESC LIMIT 1`,
      [date]
    );
    return rows[0] || null;
  }

  async upsertSGEData(data: { date: string; sgePriceCny: number; usdcnyRate: number; sgePriceUsd: number; spotPriceUsd: number; premium: number }[]): Promise<number> {
    await priceTableReady;
    if (data.length === 0) return 0;
    let inserted = 0;
    for (const row of data) {
      try {
        await queryWithRetry(
          `INSERT INTO sge_data (date, sge_price_cny, usdcny_rate, sge_price_usd, spot_price_usd, premium)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (date) DO UPDATE SET sge_price_cny=$2, usdcny_rate=$3, sge_price_usd=$4, spot_price_usd=$5, premium=$6`,
          [row.date, row.sgePriceCny, row.usdcnyRate, row.sgePriceUsd, row.spotPriceUsd, row.premium]
        );
        inserted++;
      } catch (err: any) {
        if (!err.message?.includes("duplicate")) {
          console.error(`[SGE] Failed to insert ${row.date}: ${err.message}`);
        }
      }
    }
    return inserted;
  }

  async getSGEData(limit = 500): Promise<{ date: string; premium: number; sgePriceUsd: number; spotPriceUsd: number; usdcnyRate: number }[]> {
    await priceTableReady;
    const { rows } = await queryWithRetry(
      `SELECT date::text, premium::float, sge_price_usd::float as "sgePriceUsd", spot_price_usd::float as "spotPriceUsd", usdcny_rate::float as "usdcnyRate" FROM sge_data ORDER BY date DESC LIMIT $1`,
      [limit]
    );
    return rows.reverse();
  }

  async getLatestSGE(): Promise<{ date: string; premium: number; sgePriceUsd: number } | null> {
    await priceTableReady;
    const { rows } = await queryWithRetry(
      `SELECT date::text, premium::float, sge_price_usd::float as "sgePriceUsd" FROM sge_data ORDER BY date DESC LIMIT 1`
    );
    return rows[0] || null;
  }

  async getSGEForDate(date: string): Promise<number | null> {
    await priceTableReady;
    const { rows } = await queryWithRetry(
      `SELECT premium::float FROM sge_data WHERE date <= $1 ORDER BY date DESC LIMIT 1`,
      [date]
    );
    return rows[0]?.premium ?? null;
  }
}

export const storage = new DatabaseStorage();
