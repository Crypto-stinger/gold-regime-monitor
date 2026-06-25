import { getLockedParams } from "./server/locked-params";
import { runBacktest } from "./server/backtest";
import { getCachedData } from "./server/data-fetcher";
import { storage } from "./server/storage";

async function main() {
  const params = await getLockedParams();
  const data = getCachedData();
  console.log(`Data: ${data.h1.length} H1, ${data.h4.length} H4, ${data.daily.length} Daily bars`);
  
  const baseConfig: any = {
    startDate: "2026-01-01", endDate: "2026-04-02", executionTimeframe: "H1", dataSource: "api",
    startingBalance: 3000, lotSize: params.lotSize || 1,
    atrPeriod: params.atrPeriod || 14, atrStopPeriod: params.atrStopPeriod || 14,
    atrStopMultiplier: params.atrStopMultiplier || 1.8, rewardRatio: params.rewardRatio || 3.5,
    compressionThreshold: params.compressionThreshold || 0.01, expansionThreshold: params.expansionThreshold || 1.1,
    rangeWidthBars: params.rangeWidthBars || 6, midpointBandPct: params.midpointBandPct || 0.08,
    retestBuffer: params.retestBuffer || 12, minRangeATR: params.minRangeATR || 1.5,
    maxTrendATRRatio: params.maxTrendATRRatio || 5, wickRatio: params.wickRatio || 0.35,
    sessionMode: params.sessionMode || "London", entryWindowBars: params.entryWindowBars || 0,
    maxTradesPerDay: params.maxTradesPerDay || 7, newsBeforeMin: params.newsBeforeMin || 30,
    newsAfterMin: params.newsAfterMin || 30, gapFilterEnabled: params.gapFilterEnabled ?? true,
    gapThresholdAtr: params.gapThresholdAtr || 0.5, gapCooldownBars: params.gapCooldownBars || 2,
    sessionORBEnabled: params.sessionORBEnabled ?? true, trailingStopEnabled: params.trailingStopEnabled ?? false,
    trailingStopTriggerR: params.trailingStopTriggerR || 1, riskPerTradePct: params.riskPerTradePct || 2.75,
    leverage: 10, maxDrawdownPct: 25, maxDailyLossPct: params.maxDailyLossPct || 2,
    maxConsecutiveLosses: params.maxConsecutiveLosses || 4, postLossCooldownBars: params.postLossCooldownBars || 2,
    reduceSizeAfterLoss: params.reduceSizeAfterLoss ?? true, reducedRiskPerTradePct: params.reducedRiskPerTradePct || 0.5,
    atrRiskScaleEnabled: params.atrRiskScaleEnabled ?? true, atrRiskScaleThreshold: params.atrRiskScaleThreshold || 1.25,
    atrRiskScaleFactor: params.atrRiskScaleFactor || 0.65, secondTradeRiskFactor: params.secondTradeRiskFactor || 0.75,
    spreadPoints: params.spreadPoints || 0.30, slippagePoints: params.slippagePoints || 0.10,
    commissionPerLot: params.commissionPerLot || 0,
  };
  
  console.log("\n=== CHAMPION BASE CONFIG (corrected position sizing) ===");
  console.log(`RR: ${baseConfig.rewardRatio}:1, ATR Stop: ${baseConfig.atrStopMultiplier}x, Risk: ${baseConfig.riskPerTradePct}%`);
  console.log(`Session: ${baseConfig.sessionMode}, Expansion: ${baseConfig.expansionThreshold}, Compression: ${baseConfig.compressionThreshold}`);
  console.log(`Balance: $${baseConfig.startingBalance}, Leverage: ${baseConfig.leverage}x (margin only)\n`);

  const dataPayload = {
    m1: data.m1, m15: data.m15, h1: data.h1, h4: data.h4, daily: data.daily,
    events: data.events.map((e: any) => ({ timestamp: e.timestamp })),
    gvz: data.gvz.map((g: any) => ({ date: g.date, value: Number(g.value) })),
    cot: data.cot.map((c: any) => ({ date: c.date, noncommLong: c.noncommLong, noncommShort: c.noncommShort, netPosition: c.netPosition, openInterest: c.openInterest })),
    sge: data.sge?.map((s: any) => ({ date: s.date, premium: Number(s.premium) })),
  };

  const variations = [
    [ { label: "R1-A: Champion base (2.75% risk)", changes: {} },
      { label: "R1-B: Higher risk (3.5%)", changes: { riskPerTradePct: 3.5 } },
      { label: "R1-C: Lower risk (2.0%)", changes: { riskPerTradePct: 2.0 } } ],
    [ { label: "R2-A: ATR Stop 1.5x (tighter)", changes: { atrStopMultiplier: 1.5 } },
      { label: "R2-B: ATR Stop 2.0x (wider)", changes: { atrStopMultiplier: 2.0 } },
      { label: "R2-C: ATR Stop 2.5x + RR 4:1", changes: { atrStopMultiplier: 2.5, rewardRatio: 4 } } ],
    [ { label: "R3-A: RR 3:1", changes: { rewardRatio: 3 } },
      { label: "R3-B: RR 4:1", changes: { rewardRatio: 4 } },
      { label: "R3-C: RR 5:1", changes: { rewardRatio: 5 } } ],
    [ { label: "R4-A: London+NewYork", changes: { sessionMode: "London+NewYork" } },
      { label: "R4-B: London, entry window 3h", changes: { entryWindowBars: 3 } },
      { label: "R4-C: London+NY, max 5 trades", changes: { sessionMode: "London+NewYork", maxTradesPerDay: 5 } } ],
    [ { label: "R5-A: Comp 0.008 + Exp 1.05", changes: { compressionThreshold: 0.008, expansionThreshold: 1.05 } },
      { label: "R5-B: Comp 0.015 + Exp 1.15", changes: { compressionThreshold: 0.015, expansionThreshold: 1.15 } },
      { label: "R5-C: Wick 0.3 + minRangeATR 1.2", changes: { wickRatio: 0.3, minRangeATR: 1.2 } } ],
  ];

  const allResults: any[] = [];
  
  for (let round = 0; round < variations.length; round++) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`ROUND ${round + 1} of 5`);
    console.log(`${"=".repeat(60)}`);
    
    for (const variant of variations[round]) {
      const config = { ...baseConfig, ...variant.changes };
      try {
        const result = runBacktest(config, dataPayload);
        const s = result.stats;
        const rdd = Number(s.maxDrawdownPct) > 0 ? (Number(s.returnPct) / Number(s.maxDrawdownPct)).toFixed(2) : "Inf";
        
        console.log(`\n  ${variant.label}`);
        console.log(`    Return: ${s.returnPct}% | DD: ${s.maxDrawdownPct}% | R/DD: ${rdd}`);
        console.log(`    Trades: ${s.totalTrades} | WR: ${s.winRate}% | PF: ${s.profitFactor}`);
        console.log(`    Final: $${s.finalBalance} | P&L: $${Number(s.netPnl).toFixed(2)}`);
        
        allResults.push({ label: variant.label, config, stats: s, rdd: parseFloat(rdd as string) || 0 });
        await storage.saveBacktestResult(result);
      } catch (err: any) {
        console.log(`  ${variant.label}: ERROR - ${err.message}`);
      }
    }
  }
  
  console.log(`\n\n${"=".repeat(60)}`);
  console.log("SUMMARY — ALL 15 BACKTESTS (sorted by Return/DD ratio)");
  console.log(`${"=".repeat(60)}`);
  allResults.sort((a, b) => b.rdd - a.rdd);
  for (const r of allResults) {
    const flag = Number(r.stats.maxDrawdownPct) <= 25 ? "OK" : "!!";
    console.log(`${flag} ${r.label.padEnd(42)} Ret:${String(r.stats.returnPct).padStart(7)}%  DD:${String(r.stats.maxDrawdownPct).padStart(6)}%  R/DD:${String(r.rdd).padStart(6)}  T:${r.stats.totalTrades}  WR:${r.stats.winRate}%  PF:${r.stats.profitFactor}`);
  }
  
  const safe = allResults.filter(r => Number(r.stats.maxDrawdownPct) <= 25);
  if (safe.length > 0) {
    const best = safe[0];
    console.log(`\nBEST (under 25% DD): ${best.label}`);
    console.log(`   Return: ${best.stats.returnPct}% | DD: ${best.stats.maxDrawdownPct}% | R/DD: ${best.rdd} | Trades: ${best.stats.totalTrades}`);
  } else {
    console.log(`\nNo strategies under 25% DD. Best overall:`);
    const best = allResults[0];
    console.log(`   ${best.label}: ${best.stats.returnPct}% ret, ${best.stats.maxDrawdownPct}% DD`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
