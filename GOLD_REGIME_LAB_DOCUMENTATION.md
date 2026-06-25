# Gold Regime Lab v9 — Complete Platform Documentation

## Table of Contents
1. [Platform Overview](#platform-overview)
2. [Product Vision](#product-vision)
3. [System Architecture](#system-architecture)
4. [Pages & Features](#pages--features)
5. [Trading Strategy Engine](#trading-strategy-engine)
6. [AI Systems](#ai-systems)
7. [Risk Management](#risk-management)
8. [Live Trading Integration](#live-trading-integration)
9. [Database Schema](#database-schema)
10. [API Reference](#api-reference)
11. [Configuration & Environment](#configuration--environment)
12. [File Structure](#file-structure)
13. [Deployment & Operations](#deployment--operations)
14. [Strategy Evolution History](#strategy-evolution-history)

---

## 1. Platform Overview

Gold Regime Lab v9 is a full-stack algorithmic trading platform for XAUUSD (Spot Gold). It combines:

- **Regime Classification Engine** — Classifies market conditions as Trend, Range, or No-Trade using Bollinger Band width expansion/compression, ATR analysis, and multi-timeframe signals
- **Backtesting Engine** — Tests strategies against historical data with accurate cost modelling (spread, slippage, commission)
- **AI Advisor** — GPT-4o-powered conversational strategy analyst with tool-calling (run backtests, apply parameters, execute trades)
- **AI Continuous Learning** — Autonomous monitoring system that records market observations, trade decisions, and accumulates learnings
- **Cloud Live Trading** — Direct integration with cTrader broker via WebSocket Protobuf protocol
- **9 Pre-built Strategies** — Catalogue of tested configurations across 3 risk tiers
- **15 Trading Safeguards** — Comprehensive risk checks before every trade entry

### Key Stats
- **Active Champion Strategy**: "Full Throttle" (High Risk tier)
- **Account Balance**: $3,192.98 (cTrader demo account 46716462)
- **Real Trades to Date**: 3 (2 wins, 1 loss, +$192.98 P&L)
- **Backtest Performance (V9)**: 750% return, 88.9% win rate, 10% max drawdown over 3-month test

---

## 2. Product Vision

### Long-term Goal
Commercial product for Android/iOS (free, no adverts) and full desktop version (Windows/Mac).

### Revenue Model
10% commission on profits only — no subscription fees, no adverts. This stands out from competitors who charge subscriptions and use ads. Legal advice required before implementation (financial licensing in UK/EU/US).

### Target Users
- **Mobile App (Consumer)**: Simplified dashboard — P&L, regime status, on/off toggle, AI chat. User picks a risk level and lets the bot trade.
- **Desktop/Web (Power User)**: Full backtesting, parameter control, strategy development, activity logs — the current platform.

### Current Priority
Steady, consistent profits with safe drawdown. Everything else waits until the strategy has a proven live track record (3-6 months minimum).

---

## 3. System Architecture

### Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite, TailwindCSS, shadcn/ui |
| Routing | wouter |
| State/Data | TanStack Query v5, react-hook-form + zod |
| Charting | Recharts, lightweight-charts v4.2.2 |
| Backend | Express.js, TypeScript, Node.js |
| Database | PostgreSQL (Replit managed) |
| AI | OpenAI GPT-4o (via Replit integration) |
| Broker | cTrader Open API (WebSocket + Protobuf) |
| Auth | Replit OpenID Connect |
| Deployment | Replit Deployments |

### Architecture Diagram
```
┌─────────────────────────────────────────────────────────┐
│                    FRONTEND (React/Vite)                 │
│  Dashboard │ Backtest │ AI Advisor │ Live Trading │ ...  │
└─────────────────────┬───────────────────────────────────┘
                      │ HTTP/API
┌─────────────────────┴───────────────────────────────────┐
│                  BACKEND (Express.js)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐ │
│  │ Backtest  │ │ AI       │ │ Live     │ │ Data        │ │
│  │ Engine    │ │ Advisor  │ │ Trader   │ │ Fetcher     │ │
│  └──────────┘ └──────────┘ └────┬─────┘ └─────────────┘ │
│  ┌──────────┐ ┌──────────┐     │       ┌──────────────┐ │
│  │ Regime   │ │ AI       │     │       │ System       │ │
│  │ Engine   │ │ Monitor  │     │       │ Watchdog     │ │
│  └──────────┘ └──────────┘     │       └──────────────┘ │
└────────────┬───────────────────┼────────────────────────┘
             │                   │
     ┌───────┴───────┐   ┌──────┴──────┐
     │  PostgreSQL   │   │  cTrader    │
     │  Database     │   │  WebSocket  │
     └───────────────┘   └─────────────┘
```

### External Data Sources
| Source | Data | API Key Required |
|--------|------|-----------------|
| Twelve Data | XAUUSD candles (M1/M15/H1/H4/Daily), Asian market indices | Yes |
| FRED | GVZ (Gold Volatility Index) | Yes (free) |
| CFTC SODA | COT (Commitment of Traders) weekly positioning | No |
| Finnhub | Economic event calendar, earnings data | Optional |
| GoldViewFX/TradingView | Analyst ideas and chart analysis | Scraped |

---

## 4. Pages & Features

### Dashboard (`/`)
The main monitoring page showing live trading status:
- **Live P&L Cards** — Daily and total profit/loss
- **Market Regime Indicator** — Current classification (Trend/Range/No-Trade) with color coding
- **Open Positions Table** — Currently held positions with entry price, P&L, SL/TP
- **Trade Counts** — Today, this week, this month, all time (sourced from `live_trades` table)
- **Bot Status** — Connected/disconnected, consecutive losses, safety conditions
- **GVZ & COT Indicators** — Gold volatility index and institutional positioning data
- **Market Hours Clock** — Shows London/New York/Tokyo session times
- **Account Info** — cTrader account ID, balance, leverage, bid/ask spread
- **Interactive XAUUSD Chart** — Candlestick chart with SMA 50/200, Daily EMA50, key levels (support/resistance/midpoint), H1/H4 switching, volume overlay
- **Asian Markets Panel** — Real-time indices (Nikkei, Hang Seng, Shanghai, ASX)
- **GoldViewFX Analyst Ideas** — Latest analyst insights with chart images and YouTube embeds
- **Analyze Market Button** — Opens AI-powered daily market analysis overlay with Automated and Manual trading plans

### Run Backtest (`/backtest`)
Full backtesting configuration and results:
- **Active Strategy Banner** — Shows current locked parameters, who set them, and when
- **Data Source Selection** — Live Fetch (Twelve Data API) or CSV Upload
- **Manual Refresh** — Shows candle counts per timeframe (M1/M15/H1/H4/Daily)
- **Date Range** — Optional start/end date filtering
- **36 Parameter Sliders** — All configurable via LockedSlider component (read-only by default, tap to edit, auto-locks after 4s)
- **Parameter Groups**: Strategy Mode, Entry Conditions, Risk Management, Session Timing, Regime Classification, Advanced Filters, ATR Settings, Trailing Stop, Volume Profile, GVZ/COT/SGE/HMM/GARCH toggles
- **Results Display** (auto-loads latest on page visit):
  - KPI Cards: Final Balance, Net Return, Win Rate, Max Drawdown, Profit Factor, Total Trades, Regime breakdown
  - Equity Curve chart
  - Monthly P&L heatmap
  - Regime performance breakdown
  - Filter Diagnostics (shows where bars are blocked in decision chain)
  - Trade-by-trade table
- **Apply to Live Trading** — One-click applies results config as locked params
- **Export** — Download as cTrader .algo file or source code
- **Backtest History** — Table of all past backtests with view/implement/save/delete actions
- **Auto-Tuner** — AI-driven parameter optimization (maximizes Return/DD ratio)
- **Hill-Climb Optimizer** — Mutates parameters to beat current best
- **AI Deep Optimize** — Multi-round optimization with persistent learnings (1-10 rounds)
- **Archive System** — Backtests are never deleted, only archived with reason tracking

### Test Log (`/trades`)
Displays the trade list from the most recent backtest:
- Sortable table with Date, Side, Regime, Entry Reason, Exit Type, Entry/Exit Price
- Search and filter by regime, side, result
- Export to CSV
- Shows 13 trades from latest backtest result

### AI Advisor (`/advisor`)
Conversational AI strategy advisor:
- **Chat Interface** — Natural language conversation with GPT-4o
- **Tool-Calling** — AI can run backtests, apply parameters, execute live trades through function calling
- **File Upload** — Attach images (vision), CSV, text, JSON files to messages
- **Full Analysis Mode** — Comprehensive market analysis button
- **Saved Strategies** — View and manage saved strategy configurations
- **Top 5 Leaderboard** — Best strategies ranked by Return/DD ratio (sources from catalogue)
- **Data Status Bar** — Shows available candles, backtest count
- **Optimization Keywords** — Saying "optimize", "keep going", "find the best" triggers autonomous multi-iteration backtesting (minimum 5 rounds, max 12)

### Strategy (`/strategy`)
Shows the currently recommended strategy:
- Strategy name, category badge (Low/Medium/High Risk), notes
- Full parameter comparison with active (locked) params
- Diff highlights showing where recommended differs from active
- One-click "Apply" button

### Live Trading (`/live-trading`)
Real-time trading monitoring and control:
- **Connection Status** — cTrader WebSocket state, account details
- **Live Price Feed** — Real-time bid/ask with spread
- **Position Manager** — Open positions with live P&L
- **Trade History** — All recorded trades from `live_trades` table with Entry, Exit, P&L, Source (Bot/Manual), Regime
- **Manual Trade Entry Form** — "+ Add Trade" button to record historical trades (Side, Regime, Entry/Exit Price, P&L, Notes, Dates)
- **Win/Loss Stats** — Real-time W/L count and win rate
- **Bot Activity Log** — Live scrolling log of bot decisions, signals, fills, and errors
- **Safety Conditions Panel** — 15 trading safeguards with green/red status indicators
- **GARCH Volatility** — Real-time GARCH(1,1) volatility forecast

### Strategy Mind (`/strategy-mind`)
AI-powered strategy analysis and loss review:
- Recommended strategy comparison with active params
- **Trade Loss Analysis** — For each loss: what the AI expected, what went wrong, what was learned
- Entry decision reasoning with full context (regime, price levels, ATR, range boundaries)
- Apply recommended button

### Catalogue (`/catalogue`)
9 pre-built strategies in 3 risk tiers:

| Tier | Strategy | Risk % | RR | Session |
|------|----------|--------|-----|---------|
| Low Risk | Conservative Guardian | 2% | 4:1 | London |
| Low Risk | Steady Compounder | 3% | 4:1 | London |
| Low Risk | London Sniper | 2.5% | 5:1 | London |
| Medium Risk | Balanced Aggressor | 5% | 4:1 | London+NY |
| Medium Risk | Growth Engine | 6% | 3:1 | London |
| Medium Risk | Momentum Rider | 5% | 4:1 | London+NY |
| High Risk | Full Throttle | 10% | 4:1 | London |
| High Risk | Trailing Titan | 8% | 4:1 | London |
| High Risk | Risk-Adjusted King | 7% | 5:1 | London |

Each shows backtest stats (return, max DD, R/DD ratio, win rate, profit factor, trade count). One-click "Apply to Live" updates locked params.

### Activity Log (`/logs`)
Unified logging with 4 tabs:
- **Decisions** — Every entry/skip decision with expandable signal details and market context. Shows 19 entry signals, 174 skips. Searchable.
- **Observations** — Hourly market snapshots (price, regime, ATR, GVZ, COT)
- **AI Learnings** — Accumulated insights with confidence scores and reinforcement counts. Categories: regime_behavior, entry_timing, risk_management, market_structure, etc.
- **Parameter Changes** — Full audit trail of every param change with source badge (AI, user, backtest, champion)

### Settings (`/settings`)
Full parameter control:
- All trading parameters in collapsible groups
- Real-time editing with immediate save
- Change log showing who changed what and when
- Source badges: ai_advisor, backtest_apply, champion_apply, auto_tuner, user

### Data Sync (`/admin-sync`)
Admin page for data management:
- Manual data refresh triggers
- Database status and counts

---

## 5. Trading Strategy Engine

### Regime Classification (`regime-engine.ts`)
Classifies market conditions using H4 candle data:

1. **ATR Expansion Threshold** (default 1.06x) — If current ATR > threshold × average ATR → potential Trend
2. **Bollinger Band Width** — Measures volatility compression
3. **Range Detection** — Identifies support/resistance levels from recent price action
4. **Three States**:
   - **Trend** — ATR expanding, directional momentum
   - **Range** — Price contained within defined levels, low volatility
   - **No-Trade** — Uncertain conditions, both signals absent

### Entry Logic
- **Trend Entries**: Breakout above/below recent range with ATR confirmation, momentum alignment
- **Range Entries**: Reversal at support/resistance with mean-reversion setup
- **Position Sizing**: `lotSize = riskAmount / stopDistance` (risk-based, NO leverage multiplier)
- **Stop Loss**: ATR-based (`atrStopMultiplier × ATR`)
- **Take Profit**: Risk-reward ratio (`RR × stopDistance`)

### Technical Indicators (`regime-engine.ts`)
| Indicator | Calculation | Usage |
|-----------|------------|-------|
| SMA 50/200 | Simple Moving Average | Trend direction, Golden/Death Cross |
| MACD 12/26/9 | Moving Average Convergence Divergence | Momentum |
| ADX 14 | Average Directional Index | Trend strength |
| OBV | On-Balance Volume | Volume confirmation |
| VWAP | Volume-Weighted Average Price | Fair value |
| RSI 14 | Relative Strength Index | Overbought/oversold |
| ATR 14 | Average True Range | Volatility, stop sizing |
| Bollinger Bands | 20-period, 2 std dev | Regime classification |

### Backtest Engine (`backtest.ts`)
- Processes H1 candles with H4 regime classification
- Models real trading costs: spread ($0.30 default), slippage ($0.05), commission ($7/lot)
- Tracks equity curve, monthly returns, regime performance, filter diagnostics
- Returns comprehensive stats: Win Rate, Profit Factor, Max Drawdown, Return/DD Ratio, Sharpe Ratio

### RSI Strategy (`rsi-backtest.ts`)
Alternative mean-reversion strategy using RSI signals:
- RSI overbought/oversold entry
- ATR-based stops
- Can be run alongside the regime strategy

---

## 6. AI Systems

### AI Advisor (`ai-advisor.ts`)
- **Model**: GPT-4o via Replit OpenAI integration
- **System Prompt**: Includes current market snapshot, locked params, AI learnings, price structure analysis (GoldViewFX methodology)
- **Tool Functions**:
  - `run_backtest` — Execute backtest with specified parameters and date range
  - `apply_locked_params` — Update live trading parameters
  - `execute_trade` — Place manual trade via cTrader
- **Optimization Mode**: Keywords trigger autonomous multi-round backtesting (5-12 iterations)
- **File Upload**: Images → GPT-4o vision; CSV/text → message context
- **MAX_TOOL_ITERATIONS**: 12 rounds per request

### AI Continuous Learning (`ai-monitor.ts`)
Runs autonomously during market hours:
- **Every 5 minutes**: Quick market check, record trade decisions
- **Every hour**: Deep AI review → generates learnings
- **Market Observations**: Price, regime, ATR, GVZ, COT, spread, session info
- **Trade Decisions**: Every entry or skip with full reasoning
- **AI Learnings**: Persistent insights with confidence scores (0-100) and reinforcement counts
- **Learning Categories**: regime_behavior, entry_timing, risk_management, market_structure, spread_patterns, news_impact, session_patterns, price_action, gvz_volatility, cot_positioning
- **Feedback Loop**: Learnings feed back into AI advisor prompts, creating incremental intelligence

### AI Auto-Tuner (`auto-tuner.ts`)
- Automated parameter optimization
- Objective: Maximize Return/DD ratio while staying under 25% max drawdown
- Tests parameter variations systematically

### Hill-Climb Optimizer
- Starts from current best parameters
- Mutates one parameter at a time
- Keeps improvements, discards regressions
- Saves new best to backtest history

### AI Deep Optimize
- Multi-round optimization (1-10 configurable rounds)
- Each round: AI analyzes results → generates 8 configs with hypotheses → runs backtests → saves learnings
- Learnings persist across rounds and future sessions
- Real-time UI progress with live log

### Daily Market Analysis (`/api/ai/daily-analysis`)
Comprehensive AI-generated analysis:
- Market overview and regime assessment
- GoldViewFX analyst bias integration
- Automated trading plan (entry/SL/TP/warnings)
- Manual trading plan (bias/key levels/risk management)
- Technical indicator summary

---

## 7. Risk Management

### Hard Limits (Cannot Be Changed)
| Parameter | Value | Enforcement |
|-----------|-------|-------------|
| Max Leverage | 10x | Zod schema, form lock, server clamp, AI tools, auto-tuner |
| Max Drawdown | 25% | Same as above |
| Min Starting Balance | $3,000 | Form validation, server-side |

### 15 Trading Safeguards
1. **Market Open Check** — No trading on weekends
2. **Rollover Gap** — No trading 21:00-22:00 UTC (broker rollover)
3. **Session Filter** — Only trade during configured sessions (London, New York, etc.)
4. **Entry Window** — Max bars after signal to enter (default: 2)
5. **News Blackout** — No trading ±30 minutes around high-impact economic events
6. **Spread Anomaly** — Block if spread > 3x normal
7. **Max Trades/Day** — Daily trade limit
8. **Consecutive Loss Limit** — Pause after N consecutive losses
9. **Max Drawdown (25%)** — Hard stop if account drawdown reaches 25%
10. **Daily Loss Limit (2%)** — Max daily loss as percentage
11. **No Duplicate Positions** — Only one position at a time
12. **Regime Filter** — Must match expected regime
13. **Gap Filter** — Skip if gap between bars is too large
14. **Narrow Range Filter** — Skip if H1 range < minRangeATR × ATR
15. **Extreme ATR Filter** — Skip if ATR ratio > maxTrendATRRatio

### Position Sizing
```
lotSize = (balance × riskPercent) / stopDistanceInPrice
maxLots = (balance × leverage) / currentPrice
finalLots = min(lotSize, maxLots)
```
Leverage is MARGIN-ONLY — it limits max position size, does NOT multiply risk.

---

## 8. Live Trading Integration

### cTrader API (`ctrader-api.ts`)
- **Protocol**: WebSocket + binary Protobuf (cTrader Open API)
- **Connection**: `wss://demo.ctraderapi.com:5035`
- **Authentication**: App auth → Account auth → Trader login
- **Features**: Real-time spot prices, order execution, position management
- **Market Orders**: Uses `relativeStopLoss` and `relativeTakeProfit` (in pips)
- **XAUUSD**: pipPosition=2, distance in pips = |price_diff| × 100
- **Protobuf Fallback**: Manual byte-level decoder for deprecated "group" wire type

### Live Trader (`live-trader.ts`)
- Runs continuously in the cloud
- Uses locked parameters from database
- Applies all 15 trading safeguards before every entry
- Records trades to `live_trades` table on fill
- Closes trades by matching `ctrader_position_id` (deterministic)
- Exposes `manualTrade()` for AI-driven orders
- `testTrade()` for pipeline validation (minimum-volume BUY)
- Historical P&L survives restarts (balance reconciliation)

### Trade Recording
- **On Fill**: Inserts into `live_trades` with position ID, side, entry price, SL/TP, regime
- **On Close**: Updates via `closeLiveTradeByPositionId()` with exit price and P&L
- **Manual Entry**: POST `/api/live-trades` for historical imports
- **Trade Counts**: Sourced from `live_trades` table (not entry signals)

### cTrader Export (`ctrader-export.ts`)
- Generates C# cBot code from locked parameters
- Downloads as `.algo` or source code
- Includes full strategy logic, risk management, and regime classification

---

## 9. Database Schema

### Core Tables

#### `price_data`
```sql
id SERIAL PRIMARY KEY
timeframe TEXT NOT NULL          -- '1min', '15min', '1h', '4h', '1day'
timestamp TIMESTAMPTZ NOT NULL
open NUMERIC NOT NULL
high NUMERIC NOT NULL
low NUMERIC NOT NULL
close NUMERIC NOT NULL
volume NUMERIC DEFAULT 0
UNIQUE (timeframe, timestamp)
```

#### `backtest_results`
```sql
id TEXT PRIMARY KEY              -- UUID
config JSONB                     -- All strategy parameters
trades JSONB                     -- Trade-by-trade detail
stats JSONB                      -- Performance statistics
equity_curve JSONB               -- Balance over time
regime_counts JSONB              -- Trend/Range/NoTrade breakdown
monthly_returns JSONB            -- Monthly P&L data
diagnostics JSONB                -- Filter diagnostics
data_source TEXT                 -- 'live' or 'csv'
created_at TIMESTAMPTZ
archived BOOLEAN DEFAULT FALSE
archive_reason TEXT
label TEXT
```

#### `live_trades`
```sql
id SERIAL PRIMARY KEY
opened_at TIMESTAMPTZ NOT NULL
closed_at TIMESTAMPTZ
side TEXT NOT NULL                -- 'buy' or 'sell'
entry_price NUMERIC NOT NULL
exit_price NUMERIC
volume NUMERIC DEFAULT 100
stop_loss NUMERIC
take_profit NUMERIC
pnl NUMERIC
status TEXT DEFAULT 'open'       -- 'open' or 'closed'
regime TEXT
source TEXT DEFAULT 'bot'        -- 'bot', 'manual', 'ctrader'
ctrader_position_id TEXT
notes TEXT
```

#### `saved_strategies`
```sql
id TEXT PRIMARY KEY
name TEXT NOT NULL
config JSONB NOT NULL
stats JSONB
notes TEXT
category TEXT                    -- 'low_risk', 'medium_risk', 'high_risk'
created_at TIMESTAMPTZ
```

#### `locked_params`
```sql
key TEXT PRIMARY KEY             -- 'current'
value JSONB NOT NULL             -- All active trading parameters
updated_at TIMESTAMPTZ
```

#### `param_changelog`
```sql
id SERIAL PRIMARY KEY
source TEXT NOT NULL             -- 'ai_advisor', 'user', 'backtest_apply', etc.
changed_keys TEXT[]
old_values JSONB
new_values JSONB
rationale TEXT
full_params JSONB
created_at TIMESTAMPTZ
```

#### `trade_decisions`
```sql
id SERIAL PRIMARY KEY
timestamp TIMESTAMPTZ NOT NULL
decision TEXT NOT NULL           -- 'entry' or 'skip'
reason TEXT
signal_details JSONB
market_context JSONB
outcome TEXT                     -- 'filled', 'win', 'loss'
pnl NUMERIC
notes TEXT
```

#### `market_observations`
```sql
id SERIAL PRIMARY KEY
timestamp TIMESTAMPTZ NOT NULL
data JSONB NOT NULL              -- Price, regime, ATR, GVZ, COT, etc.
```

#### `ai_learnings`
```sql
id SERIAL PRIMARY KEY
timestamp TIMESTAMPTZ NOT NULL
category TEXT NOT NULL
insight TEXT NOT NULL
confidence NUMERIC DEFAULT 50
reinforcement_count INTEGER DEFAULT 1
last_reinforced TIMESTAMPTZ
source TEXT
```

#### `gvz_data`
```sql
id SERIAL PRIMARY KEY
date DATE NOT NULL UNIQUE
value NUMERIC NOT NULL
```

#### `cot_data`
```sql
id SERIAL PRIMARY KEY
report_date DATE NOT NULL UNIQUE
noncommercial_long INTEGER
noncommercial_short INTEGER
noncommercial_spread INTEGER
commercial_long INTEGER
commercial_short INTEGER
open_interest INTEGER
net_position INTEGER
```

#### `sge_premium_data`
```sql
id SERIAL PRIMARY KEY
date DATE NOT NULL UNIQUE
sge_price_cny NUMERIC
usdcny_rate NUMERIC
sge_price_usd NUMERIC
spot_price_usd NUMERIC
premium NUMERIC
```

### Auth Tables (Replit Auth)
- `users` — id, email, first_name, last_name, profile_image_url
- `sessions` — sid, sess, expire

### Other Tables
- `optimization_journal` — AI optimization history
- `locked_params_proposals` — AI-proposed parameter changes
- `analyst_ideas` — GoldViewFX TradingView ideas
- `economic_events` — News calendar events
- `strategy_changelog` — Strategy change history

---

## 10. API Reference

### Authentication
All `/api/*` endpoints require Replit Auth (except `/api/login`, `/api/logout`, `/api/callback`, `/api/auth/user`).

### Market Data
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/data/status` | GET | Price database status and counts |
| `/api/data/refresh` | POST | Trigger data refresh from APIs |
| `/api/technical-indicators` | GET | Current technical indicator values |
| `/api/gvz-data` | GET | Gold Volatility Index history |
| `/api/cot-data` | GET | COT positioning data |

### Backtesting
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/backtest` | POST | Run a new backtest |
| `/api/backtests` | GET | List all backtest results |
| `/api/backtest/:id` | GET | Get full backtest detail |
| `/api/backtest/:id/archive` | POST | Archive a backtest |
| `/api/backtest/:id/restore` | POST | Restore archived backtest |
| `/api/backtests/archived` | GET | List archived backtests |
| `/api/backtests/leaderboard` | GET | Top strategies by R/DD |
| `/api/auto-tune` | POST | Run AI auto-tuner |
| `/api/ai-optimize` | POST | Run AI deep optimize |

### Strategies
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/strategies` | GET | List all saved strategies |
| `/api/strategies` | POST | Save a new strategy |
| `/api/strategies/:id` | DELETE | Delete a strategy |
| `/api/strategies/recommended` | GET | Get recommended strategy |
| `/api/active-strategy-summary` | GET | Active strategy with changelog |

### Parameters
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/locked-params` | GET | Get current locked parameters |
| `/api/locked-params` | POST | Update locked parameters |
| `/api/locked-params/changelog` | GET | Parameter change history |
| `/api/locked-params/proposals` | GET | AI parameter proposals |

### Live Trading
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/live-trading/status` | GET | Full trading status |
| `/api/live-trading/connect` | POST | Connect to cTrader |
| `/api/live-trading/disconnect` | POST | Disconnect |
| `/api/live-trading/start` | POST | Start live trader |
| `/api/live-trading/stop` | POST | Stop live trader |
| `/api/live-trading/test-trade` | POST | Execute test trade |
| `/api/live-trading/ctrader-deals` | GET | Trade history from live_trades |
| `/api/live-trades` | GET/POST | List/create live trade records |
| `/api/live-trades/:id` | PATCH/DELETE | Update/delete trade record |

### AI
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ai/chat` | POST | Send message to AI advisor |
| `/api/ai/daily-analysis` | GET | AI daily market analysis |
| `/api/ai-monitor/status` | GET | AI monitor state |
| `/api/ai-monitor/decisions` | GET | Trade decisions log |
| `/api/ai-monitor/observations` | GET | Market observations |
| `/api/ai-monitor/learnings` | GET | AI learnings |

### System
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/system/health` | GET | System health status |
| `/api/auth/user` | GET | Current user info |

### Exports
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/export/recommended.algo` | GET | Download cTrader .algo file |
| `/api/export/recommended-source` | GET | Download cTrader source code |

---

## 11. Configuration & Environment

### Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string (auto-provided by Replit) |
| `FRED_API_KEY` | Yes | FRED API key for GVZ data (free) |
| `REPLIT_DOMAINS` | Auto | Used for auth callback URLs |
| `NODE_ENV` | Auto | `development` or `production` |

### OpenAI Integration
Uses Replit's built-in AI integration (`javascript_openai_ai_integrations==2.0.0`) — no API key needed.

### Key Configuration Parameters
All stored in `locked_params` table and editable via Settings page:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `riskPercent` | 10 | Risk per trade (%) |
| `rewardRiskRatio` | 4 | Take profit = RR × stop distance |
| `atrStopMultiplier` | 2 | Stop = multiplier × ATR |
| `sessionMode` | "London" | Trading session filter |
| `entryWindowBars` | 2 | Max bars after signal to enter |
| `expansionThreshold` | 1.06 | ATR ratio for trend detection |
| `compressionThreshold` | 0.008 | BB width for range detection |
| `leverage` | 10 | **LOCKED** — cannot change |
| `maxDrawdownPct` | 25 | **LOCKED** — cannot change |
| `startingBalance` | 3000 | Minimum $3,000 |

---

## 12. File Structure

```
gold-regime-lab/
├── server/
│   ├── index.ts                 # App entry point, startup orchestration
│   ├── routes.ts                # All API route definitions (~3100 lines)
│   ├── storage.ts               # PostgreSQL database layer with retry logic
│   ├── regime-engine.ts         # Regime classification + technical indicators
│   ├── backtest.ts              # Regime backtesting engine
│   ├── rsi-backtest.ts          # RSI strategy backtesting
│   ├── filters.ts               # Trade entry filter chain
│   ├── data-fetcher.ts          # External data acquisition + caching
│   ├── ai-advisor.ts            # GPT-4o advisor with tool-calling
│   ├── ai-monitor.ts            # Autonomous AI learning system
│   ├── auto-tuner.ts            # Automated parameter optimization
│   ├── live-trader.ts           # Cloud live trading engine (~1600 lines)
│   ├── ctrader-api.ts           # cTrader WebSocket Protobuf API
│   ├── ctrader-export.ts        # cTrader C# code generation
│   ├── ctrader-compiler.ts      # cBot compilation helper
│   ├── locked-params.ts         # Parameter management + migration
│   ├── system-watchdog.ts       # System health monitoring
│   ├── goldviewfx-fetcher.ts    # Analyst ideas scraper
│   ├── hmm-engine.ts            # Hidden Markov Model (3-state)
│   ├── mrs-garch.ts             # GARCH(1,1) volatility model
│   ├── risk-validator.ts        # Risk limit validation
│   ├── pdf-export.ts            # PDF report generation
│   ├── synthetic-data.ts        # Test data generation
│   ├── static.ts                # Static file serving
│   ├── vite.ts                  # Vite dev server integration
│   └── replit_integrations/     # Auth, AI, audio integrations
│       ├── auth/                # Replit OpenID auth
│       ├── chat/                # AI chat integration
│       ├── image/               # Image generation
│       ├── audio/               # Audio processing
│       └── batch/               # Batch utilities
├── client/
│   └── src/
│       ├── App.tsx              # Router + page layout
│       ├── main.tsx             # React entry point
│       ├── index.css            # Global styles + theme
│       ├── pages/
│       │   ├── dashboard-page.tsx         # Main dashboard
│       │   ├── backtest-page.tsx          # Backtesting (~2800 lines)
│       │   ├── trades-page.tsx            # Test log / trade list
│       │   ├── advisor-page.tsx           # AI advisor chat
│       │   ├── strategy-page.tsx          # Recommended strategy
│       │   ├── live-trading-page.tsx      # Live trading monitor
│       │   ├── strategy-mind-page.tsx     # AI strategy analysis
│       │   ├── strategy-catalogue-page.tsx # Strategy catalogue
│       │   ├── logs-page.tsx              # Activity log
│       │   ├── settings-page.tsx          # Parameter settings
│       │   ├── admin-sync-page.tsx        # Data sync admin
│       │   ├── auth-page.tsx              # Login page
│       │   └── not-found.tsx              # 404 page
│       ├── components/
│       │   ├── app-sidebar.tsx            # Navigation sidebar
│       │   ├── strategy-chart.tsx         # Interactive price chart
│       │   ├── market-analysis-panel.tsx  # AI analysis overlay
│       │   ├── export-menu.tsx            # Export options menu
│       │   ├── page-guide.tsx             # Help tooltips
│       │   └── ui/                        # shadcn/ui components (50+)
│       ├── hooks/
│       │   ├── use-auth.ts               # Auth hook
│       │   ├── use-toast.ts              # Toast notifications
│       │   └── use-mobile.tsx            # Mobile detection
│       └── lib/
│           ├── queryClient.ts            # TanStack Query setup
│           ├── auth-utils.ts             # Auth utilities
│           ├── csv-parser.ts             # CSV import parser
│           └── utils.ts                  # Utility functions
├── shared/
│   ├── schema.ts                # Drizzle ORM schema + types
│   └── models/
│       ├── auth.ts              # Auth models
│       └── chat.ts              # Chat models
├── package.json                 # Dependencies
├── tsconfig.json                # TypeScript config
├── vite.config.ts               # Vite build config
├── tailwind.config.ts           # Tailwind CSS config
├── drizzle.config.ts            # Drizzle ORM config
└── GOLD_REGIME_LAB_DOCUMENTATION.md  # This file
```

---

## 13. Deployment & Operations

### Development
```bash
npm run dev                      # Starts Express + Vite dev server on port 5000
```

### Production
```bash
npm run build                    # Builds frontend (Vite) + backend (esbuild)
npm run start                    # Runs dist/index.cjs in production mode
```

### Database
- PostgreSQL provided by Replit
- Tables auto-created on startup with retry logic
- All queries use `queryWithRetry()` with 3 attempts and exponential backoff
- Connection pool: 5 connections (production), 10 (development)
- TCP keepalive enabled to prevent managed DB connection drops

### System Watchdog (`system-watchdog.ts`)
- Health checks every 2 minutes
- Monitors: cTrader connection, live trader state, market data freshness, memory usage, error rate
- Auto-fixes: reconnects cTrader (up to 5 attempts), seeds price from cached spot, triggers data refresh
- Stderr interceptor captures all errors, categorizes by source, feeds to watchdog event bus
- Catches uncaughtException and unhandledRejection

### External Keepalive
Production deployment pings itself every 4 minutes at `/healthz` to prevent idle shutdown.

---

## 14. Strategy Evolution History

| Version | Key Changes |
|---------|------------|
| V1 | Basic regime classifier + RSI strategy |
| V2 | Percentile BB width, ADX filter, D1 EMA200, adaptive sizing, breakeven stops, ATR stops, news blackout |
| V3 | Session timing (avoid hours, peak hours) |
| V4 | Volume Profile integration |
| V5 | SGE Premium Filter |
| V6 | Hidden Markov Model (3-state Gaussian HMM) |
| V7 | MRS-GARCH volatility model |
| V8 | Champion parameter restoration |
| V9 | **Current** — Fixed 3 critical bugs (entry window, ATR scale, exit spread). 750% return, 88.9% WR, 10% DD |

### V9 Champion Parameters
```
Risk: 10% | RR: 4:1 | ATR Stop: 2x | Session: London
Entry Window: 2 bars | Expansion: 1.06x | Compression: 0.008
Leverage: 10x (LOCKED) | Max DD: 25% (LOCKED)
Starting Balance: $3,000
```

---

*Generated: April 2026*
*Gold Regime Lab v9 — XAUUSD Algorithmic Trading Platform*
