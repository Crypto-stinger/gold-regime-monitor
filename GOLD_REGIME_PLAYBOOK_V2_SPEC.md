# Gold Regime Playbook v2 — Complete Strategy Specification

**Purpose:** This document is the authoritative specification for building a cTrader cBot (or any automated trading bot) that replicates the Gold Regime Lab v2 strategy exactly. Every rule, formula, threshold, and filter is documented from the live backtesting engine code.

---

## 1. INSTRUMENT & TIMEFRAMES

| Property | Value |
|----------|-------|
| Symbol | XAUUSD (Spot Gold vs USD) |
| Regime Detection Timeframe | H4 (4-hour) |
| Execution Timeframe | H1 (1-hour) |
| Daily Bias Timeframe | D1 (Daily) |
| Bar Processing | On each H1 bar close |

---

## 2. CONFIGURABLE PARAMETERS (with defaults)

These are the tunable parameters. The AI Advisor in the Replit app can suggest changes to these.

| Parameter | Type | Default | Min | Max | Description |
|-----------|------|---------|-----|-----|-------------|
| `startingBalance` | number | 1500 | 100 | 1000000 | Initial account balance |
| `lotSize` | number | 1.0 | 0.01 | 100 | Position size in lots |
| `atrPeriod` | int | 14 | 5 | 50 | ATR lookback period (used for both H1 and H4) |
| `atrStopMultiplier` | number | 2.0 | 0.5 | 5.0 | Stop loss = atrStopMultiplier × H1_ATR |
| `rewardRatio` | number | 3.5 | 1 | 20 | Take profit = stopDistance × rewardRatio |
| `compressionThreshold` | number | 0.022 | 0.001 | 0.1 | H4 Bollinger Band width below this = compressed (range) |
| `expansionThreshold` | number | 1.2 | 1.01 | 3.0 | ATR_H4 > avgATR_H4 × this = expanding (trend) |
| `rangeWidthBars` | int | 8 | 5 | 50 | Number of H4 bars to compute range high/low |
| `midpointBandPct` | number | 0.10 | 0.01 | 0.5 | No-trade dead zone: 10% of range width on each side of midpoint |
| `retestBuffer` | number | 12.0 | 0.5 | 50 | Dollar tolerance for "near level" and acceptance retest |
| `wickRatio` | number | 0.6 | 0.3 | 5.0 | Minimum wick-to-body ratio for rejection candle validation |
| `sessionMode` | enum | "London+NewYork" | — | — | Which trading session(s) to allow entries |
| `maxTradesPerDay` | int | 2 | 1 | 10 | Maximum new entries per calendar day |
| `newsBeforeMin` | int | 30 | 0 | 240 | Minutes before a news event to block entries |
| `newsAfterMin` | int | 30 | 0 | 240 | Minutes after a news event to block entries |
| `gapFilterEnabled` | bool | true | — | — | Enable/disable gap detection filter |
| `gapThresholdAtr` | number | 0.5 | 0.1 | 5.0 | Gap size (in ATR multiples) to trigger cooldown |
| `gapCooldownBars` | int | 2 | 1 | 12 | Number of H1 bars to block after gap detection |
| `sessionORBEnabled` | bool | true | — | — | Enable/disable Session Opening Range Bias |

---

## 3. INDICATOR CALCULATIONS

### 3.1 ATR (Average True Range) — Wilder's smoothing

Applied independently to H1 and H4 candles.

```
For each bar i:
  if i == 0:
    TR[i] = High - Low
  else:
    TR[i] = max(High - Low, |High - PrevClose|, |Low - PrevClose|)

ATR[period-1] = mean(TR[0..period-1])

For i >= period:
  ATR[i] = (ATR[i-1] × (period - 1) + TR[i]) / period
```

- `atr_h1`: ATR(14) on H1 bars — used for stop loss sizing
- `atr_h4`: ATR(14) on H4 bars — used for regime classification

### 3.2 EMA (Exponential Moving Average) — Daily Close

```
k = 2 / (period + 1)    // period = 50
EMA[seed] = mean(first 50 valid daily closes)
EMA[i] = Close[i] × k + EMA[i-1] × (1 - k)
```

- Applied to D1 close prices
- Used for daily directional bias: `bullishBias = dailyClose > ema50`, `bearishBias = dailyClose < ema50`

### 3.3 Bollinger Band Width — H4

```
For each H4 bar at position i (lookback = 20):
  slice = H4_Close[i-19 .. i]
  mean = average(slice)
  std = population_std_dev(slice)
  BB_Width[i] = (2 × std) / mean
```

- Used in regime classification: if `BB_Width < compressionThreshold` → market is compressed (supports range regime)

### 3.4 Average H4 ATR (for regime comparison)

```
Look at the most recent 10 H4 bars
For each H4 bar j:
  TR = max(High-Low, |High-PrevClose|, |Low-PrevClose|)
avgAtrH4 = mean(all TR values from those 10 bars)
```

---

## 4. H4 RANGE CONTEXT (computed on every H1 bar)

On each H1 bar, look up the most recent `rangeWidthBars` (default 12) H4 bars that closed at or before the current H1 timestamp:

```
rangeHigh = max(H4_High) over last 12 H4 bars
rangeLow  = min(H4_Low) over last 12 H4 bars
rangeWidth = rangeHigh - rangeLow
midpoint = (rangeHigh + rangeLow) / 2
```

If fewer than `rangeWidthBars` H4 bars available → skip bar (no_trade).

---

## 5. THREE-STATE REGIME CLASSIFIER

Every H1 bar is classified into exactly one regime: `range`, `trend`, or `no_trade`.

**Decision tree (in order of precedence):**

```
INPUT:
  price        = H1 close
  atrH4        = current H4 ATR
  avgAtrH4     = average H4 ATR (last 10 bars)
  bbWidth      = current H4 BB Width
  rangeHigh    = H4 range high
  rangeLow     = H4 range low
  midpointBandPct = 0.08

STEP 1 — Data validation:
  if atrH4 is NaN OR avgAtrH4 <= 0 OR rangeWidth <= 0 → "no_trade"

STEP 2 — Check for TREND:
  atrExpanding = atrH4 > avgAtrH4 × expansionThreshold
  priceAboveRange = price > rangeHigh
  priceBelowRange = price < rangeLow
  
  if atrExpanding AND (priceAboveRange OR priceBelowRange) → "trend"

STEP 3 — Check midpoint dead zone:
  mid = (rangeHigh + rangeLow) / 2
  band = rangeWidth × midpointBandPct
  if price >= (mid - band) AND price <= (mid + band) → "no_trade"

STEP 4 — Check for RANGE:
  compressed = bbWidth < compressionThreshold
  atrFlat = NOT atrExpanding
  priceInsideRange = price >= rangeLow AND price <= rangeHigh
  
  if atrFlat AND priceInsideRange AND (compressed OR atrH4 <= avgAtrH4) → "range"

STEP 5 — Default:
  → "no_trade"
```

---

## 6. PRE-ENTRY FILTER CHAIN

Before checking for entry signals, these filters are applied **in this exact order**. If any filter blocks, skip to next H1 bar.

### 6.1 Open Trade Check
- Only 1 position at a time. If a trade is open, manage it (check SL/TP hit) but do not scan for new entries.

### 6.2 Gap Detection (if `gapFilterEnabled`)
```
gap = |currentBar.open - previousBar.close|
if gap >= atr_h1 × gapThresholdAtr:
    gapCooldownRemaining = gapCooldownBars
```
- Gap detection runs even when other filters would block — it's tracking state.

### 6.3 Session Opening Range Bias (if `sessionORBEnabled`)
```
if current H1 bar's UTC hour == session open hour:
    ORB = { high: bar.high, low: bar.low, bullish: bar.close > bar.open, dayKey: "YYYY-MM-DD" }

if ORB exists but dayKey != current day:
    ORB = null (expired)
```

Session open hours:
| Session | Open Hour (UTC) |
|---------|----------------|
| London | 07:00 |
| NewYork | 12:00 |
| London+NewYork | 07:00 |
| All | 00:00 |

### 6.4 Daily Trade Limit
```
if trades_today >= maxTradesPerDay → BLOCK
```

### 6.5 Session Filter
```
London:          UTC 07:00 – 15:59
NewYork:         UTC 12:00 – 20:59
London+NewYork:  UTC 07:00 – 20:59
All:             24 hours
```
- Outside session hours → BLOCK (count as no_trade)

### 6.6 Event Blackout
```
For each known economic event:
  blackout_start = event_time - newsBeforeMin minutes
  blackout_end   = event_time + newsAfterMin minutes
  if current_time is within [blackout_start, blackout_end] → BLOCK
```

**Events to track (high impact):**
- US Non-Farm Payrolls (NFP) — 1st Friday of each month, 13:30 UTC
- US CPI — Around 10th-15th of each month (first weekday in 10-15 range), 13:30 UTC
- FOMC — 3rd Wednesday of Jan, Mar, May, Jun, Jul, Sep, Nov, Dec, at 19:00 UTC
- US PPI — Around 11th-17th of each month (first weekday in 11-17 range), 13:30 UTC
- US Retail Sales — Around 13th-17th of each month (first weekday in 13-17 range), 13:30 UTC

### 6.7 Gap Cooldown Block
```
if gapFilterEnabled AND gapCooldownRemaining > 0:
    gapCooldownRemaining--
    → BLOCK (count as no_trade)
```
- Cooldown only decrements on bars that would have been tradeable (after session/event filters)

### 6.8 ORB Not Established
```
if sessionORBEnabled AND currentORB is null → BLOCK
```
- This means: until the session-opening candle closes, no trades.

### 6.9 Data Validation
```
if any of atr_h1, atr_h4, ema_daily, daily_close is NaN → BLOCK
```

### 6.10 Regime Classification
- Run the 3-state classifier (Section 5)
- If result is `no_trade` → BLOCK

### 6.11 Stop Distance Validation
```
stopDistance = atr_h1 × atrStopMultiplier
if stopDistance <= 0 → BLOCK
```

### 6.12 Hard Midpoint Block (double-check)
```
if midpointBlock(close, rangeHigh, rangeLow, midpointBandPct) → BLOCK
```
- This is a redundant safety check after regime classification.

---

## 7. ENTRY SIGNALS

After all filters pass, check for entry signals based on regime.

### 7.1 RANGE MODE — Rejection at Extremes

**Sell at Resistance:**
```
CONDITIONS (all must be true):
1. candle.high >= rangeHigh - retestBuffer     (near resistance)
2. bearishBias OR NOT bullishBias              (daily not bullish)
3. isBearishRejection(candle, wickRatio)       (rejection candle)
4. if ORB enabled: orbAligns(currentORB, "sell")  (ORB agrees)

BEARISH REJECTION CANDLE:
  body = |close - open|
  upperWick = high - max(open, close)
  VALID if: body > 0 AND upperWick/body >= wickRatio AND close < open

ENTRY:
  entry = candle.close
  stop  = entry + stopDistance
  target = entry - (stopDistance × rewardRatio)
  entryReason = "range_resistance_rejection"
```

**Buy at Support:**
```
CONDITIONS (all must be true):
1. candle.low <= rangeLow + retestBuffer       (near support)
2. bullishBias OR NOT bearishBias              (daily not bearish)
3. isBullishRejection(candle, wickRatio)       (rejection candle)
4. if ORB enabled: orbAligns(currentORB, "buy")   (ORB agrees)

BULLISH REJECTION CANDLE:
  body = |close - open|
  lowerWick = min(open, close) - low
  VALID if: body > 0 AND lowerWick/body >= wickRatio AND close > open

ENTRY:
  entry = candle.close
  stop  = entry - stopDistance
  target = entry + (stopDistance × rewardRatio)
  entryReason = "range_support_rejection"
```

### 7.2 TREND MODE — Breakout Acceptance

**Long Breakout:**
```
CONDITIONS (all must be true):
1. bullishBias                                 (daily EMA confirms)
2. previousH1.close <= rangeHigh               (was below range)
3. currentH1.close > rangeHigh                 (now above range)
4. currentH1.close > rangeHigh                 (acceptance)
5. currentH1.low >= rangeHigh - retestBuffer   (retest holds)
6. if ORB enabled: orbAligns(currentORB, "buy")

ENTRY:
  entry = candle.close
  stop  = entry - stopDistance
  target = entry + (stopDistance × rewardRatio)
  entryReason = "trend_breakout_acceptance_long"
```

**Short Breakout:**
```
CONDITIONS (all must be true):
1. bearishBias                                 (daily EMA confirms)
2. previousH1.close >= rangeLow                (was above range)
3. currentH1.close < rangeLow                  (now below range)
4. currentH1.close < rangeLow                  (acceptance)
5. currentH1.high <= rangeLow + retestBuffer   (retest fails)
6. if ORB enabled: orbAligns(currentORB, "sell")

ENTRY:
  entry = candle.close
  stop  = entry + stopDistance
  target = entry - (stopDistance × rewardRatio)
  entryReason = "trend_breakout_acceptance_short"
```

---

## 8. ORB ALIGNMENT LOGIC

```
orbAligns(orb, side):
  if orb is null → return FALSE (strict: blocks ALL trades)
  if side == "buy"  → return orb.bullish   (ORB candle closed green)
  if side == "sell" → return !orb.bullish   (ORB candle closed red)
```

ORB resets daily. Until the session-opening candle closes, no ORB exists → all entries blocked.

---

## 9. TRADE MANAGEMENT

### 9.1 Position Monitoring (on every H1 bar while trade is open)

**For BUY trades:**
```
if candle.low <= stopLoss:
  EXIT at stopLoss price, reason = "stop"
else if candle.high >= takeProfit:
  EXIT at takeProfit price, reason = "target"
```

**For SELL trades:**
```
if candle.high >= stopLoss:
  EXIT at stopLoss price, reason = "stop"
else if candle.low <= takeProfit:
  EXIT at takeProfit price, reason = "target"
```

### 9.2 P&L Calculation
```
For BUY:  pnl = (exitPrice - entryPrice) × lotSize
For SELL: pnl = (entryPrice - exitPrice) × lotSize

riskDollars = |entryPrice - stopLoss| × lotSize
resultR = pnl / riskDollars
```

### 9.3 Hard Rules
- **NO** moving stop loss to breakeven
- **NO** partial profit taking
- **NO** trailing stops
- Full target or full stop, always
- Max 1 open position at any time
- Max N trades per calendar day (default 2)

---

## 10. DAILY BIAS DETERMINATION

```
bullishBias = latest_daily_close > EMA_50_daily
bearishBias = latest_daily_close < EMA_50_daily
```

- Uses the most recent D1 bar that closed at or before the current H1 bar
- Neutral when close == EMA (neither bullish nor bearish)

---

## 11. ECONOMIC EVENT CALENDAR

The bot should maintain a list of high-impact US economic events and block entries within the configurable blackout window. The following events recur predictably:

| Event | Schedule | UTC Time | Impact |
|-------|----------|----------|--------|
| NFP | 1st Friday of month | 13:30 | High |
| CPI | ~10th-15th, first weekday | 13:30 | High |
| FOMC | 3rd Wednesday, 8 months/year (Jan,Mar,May,Jun,Jul,Sep,Nov,Dec) | 19:00 | High |
| PPI | ~11th-17th, first weekday | 13:30 | Medium |
| Retail Sales | ~13th-17th, first weekday | 13:30 | Medium |

**Default blackout: 30 minutes before, 30 minutes after event time.**

---

## 12. EXECUTION ORDER FOR EACH H1 BAR

This is the exact order of operations on each new H1 bar close:

```
1. If open trade exists:
   a. Check if SL or TP hit on this bar
   b. If hit → close trade, record P&L
   c. If still open → skip to next bar (no new entries while in a trade)

2. Gap detection (track cooldown, even if other filters would block)

3. ORB update (check if this is a session-opening candle)

4. Check daily trade limit → block if exceeded

5. Session filter → block if outside session hours

6. Event blackout → block if within news window

7. Gap cooldown → block if cooldown active (decrement counter)

8. ORB check → block if ORB not yet established

9. Data validation → block if any indicator is NaN

10. Compute H4 range context (rangeHigh, rangeLow, avgAtrH4)

11. Classify regime → block if no_trade

12. Compute stopDistance → block if <= 0

13. Hard midpoint block → block if in dead zone

14. Check entry signals based on regime:
    - Range: sell at resistance OR buy at support
    - Trend: long breakout OR short breakout
    
15. If signal fires → open trade, increment daily counter
```

---

## 13. WARM-UP PERIOD

The bot needs historical data to compute indicators before trading:

- Minimum warm-up: `max(100, rangeWidthBars)` H1 bars
- ATR needs `atrPeriod` bars (14)
- EMA needs `emaPeriod` bars (50) on daily
- BB Width needs 20 H4 bars
- H4 range needs `rangeWidthBars` (12) H4 bars

**Recommendation:** Skip the first 100 H1 bars before taking any trades.

---

## 14. CTRADER IMPLEMENTATION NOTES

### Data feeds needed:
1. **H1 XAUUSD** — primary execution timeframe, process on each bar close
2. **H4 XAUUSD** — for regime detection, range high/low, ATR, BB width
3. **D1 XAUUSD** — for daily bias (close vs EMA50)

### Position management:
- Use limit/stop orders for SL and TP (set at entry, never modify)
- Or monitor on each bar and execute market orders when levels are breached

### Clock synchronization:
- All times are UTC
- Session hours, event times, and ORB reset use UTC

### Logging recommendations:
- Log each regime classification with bar timestamp
- Log each filter that blocks an entry (for debugging)
- Log entry signals with all conditions met
- Log trade open/close with full details

### Differences from backtest to live:
- **Slippage:** Live execution may fill at slightly different prices. Consider adding 0.1-0.5 point buffer to SL/TP
- **Spread:** XAUUSD spread varies. Entry at close price in backtest; in live, you'll get the ask (buy) or bid (sell)
- **Weekend gaps:** The gap filter handles this, but verify behavior on Sunday open
- **Partial fills:** Should not be an issue with standard lot sizes on gold

---

## 15. PERFORMANCE EXPECTATIONS

With default parameters on synthetic data (2023-2024):
- Win rate: ~15-25% (this is by design — the 4:1 R:R compensates)
- Profit factor target: > 1.0 (break even requires ~20% win rate at 4:1)
- Max drawdown: typically 10-15% of starting balance
- Average holding time: ~3-5 days (75 H1 bars)
- Trade frequency: ~1-2 trades per month

**Key insight:** This is a low-frequency, high-R:R strategy. Long losing streaks (5-9 consecutive) are normal. The math works because each win returns 4R while each loss costs 1R.

---

## 16. PARAMETER TUNING WORKFLOW

1. Run backtest in Gold Regime Lab with current parameters
2. Navigate to AI Advisor page → click "Run Full Analysis"
3. Review suggested parameter changes
4. Apply changes in backtest config → re-run
5. Compare equity curves and stats
6. When satisfied, update cTrader bot parameters to match

The AI Advisor can be asked specific questions like:
- "Should I widen the midpoint band?"
- "Is my ATR multiplier too tight?"
- "What do Asian markets suggest for today?"

---

## 17. COMPLETE PARAMETER DEFAULTS SUMMARY

```json
{
  "startingBalance": 1500,
  "lotSize": 1,
  "atrPeriod": 14,
  "atrStopMultiplier": 2.0,
  "rewardRatio": 4.0,
  "compressionThreshold": 0.022,
  "expansionThreshold": 1.2,
  "rangeWidthBars": 12,
  "midpointBandPct": 0.08,
  "retestBuffer": 12.0,
  "wickRatio": 0.6,
  "sessionMode": "London+NewYork",
  "maxTradesPerDay": 2,
  "newsBeforeMin": 30,
  "newsAfterMin": 30,
  "gapFilterEnabled": true,
  "gapThresholdAtr": 0.5,
  "gapCooldownBars": 2,
  "sessionORBEnabled": true
}
```
