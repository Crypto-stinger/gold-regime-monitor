import PDFDocument from "pdfkit";
import type { SavedStrategy } from "../shared/schema";
import { validateStrategy, getRiskRating, getParamDefinitions, type RiskWarning } from "./risk-validator";

export function generateStrategyPDF(strategy: SavedStrategy): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const c = strategy.config;
    const s = strategy.stats;
    const warnings = validateStrategy(c);
    const riskRating = getRiskRating(c, warnings);
    const rdr = s.maxDrawdownPct > 0 ? (s.returnPct / s.maxDrawdownPct).toFixed(2) : "N/A";

    const gold = "#B8860B";
    const darkGold = "#8B6914";
    const red = "#DC2626";
    const amber = "#D97706";
    const green = "#16A34A";
    const grey = "#6B7280";
    const black = "#111827";

    doc.rect(0, 0, doc.page.width, 120).fill("#1F2937");
    doc.fontSize(24).fillColor("#F59E0B").text("GOLD REGIME LAB v3", 50, 30);
    doc.fontSize(11).fillColor("#D1D5DB").text("XAUUSD 3-State Regime Strategy Report", 50, 58);
    doc.fontSize(9).fillColor("#9CA3AF").text(`Generated: ${new Date().toISOString().substring(0, 10)}  |  Platform: cTrader  |  Timeframe: H1`, 50, 76);
    doc.fontSize(9).fillColor("#9CA3AF").text(`Strategy ID: ${strategy.id}`, 50, 90);

    doc.moveDown(3);
    const y1 = 140;

    doc.fontSize(18).fillColor(black).text(strategy.name, 50, y1);
    const catColor = strategy.category === "HIGH" || strategy.category === "EXTREME" ? red : strategy.category === "MED" ? amber : green;
    doc.fontSize(10).fillColor(catColor).text(`Risk Category: ${strategy.category}`, 50, y1 + 24);

    const riskColor = riskRating === "EXTREME" || riskRating === "HIGH" ? red : riskRating === "MED" ? amber : green;
    doc.fillColor(riskColor).text(`Computed Risk Rating: ${riskRating}`, 200, y1 + 24);

    if (strategy.notes) {
      doc.fontSize(9).fillColor(grey).text(strategy.notes, 50, y1 + 42, { width: 500 });
    }

    let y = strategy.notes ? y1 + 62 : y1 + 50;
    doc.moveTo(50, y).lineTo(545, y).strokeColor("#E5E7EB").stroke();
    y += 12;

    doc.fontSize(13).fillColor(darkGold).text("PERFORMANCE SUMMARY", 50, y);
    y += 22;

    const statRows = [
      ["Total Trades", `${s.totalTrades}`, "Win Rate", `${s.winRate}%`],
      ["Wins / Losses", `${s.wins}W / ${s.losses}L`, "Profit Factor", `${s.profitFactor}`],
      ["Net Return", `${s.returnPct}%`, "Max Drawdown", `${s.maxDrawdownPct}%`],
      ["Final Balance", `$${s.finalBalance.toLocaleString()}`, "Return / DD Ratio", rdr],
      ["Avg R", `${s.avgR}R`, "Avg Holding", `${s.avgHoldingBars} bars`],
      ["Consec. Wins", `${s.consecutiveWins}`, "Consec. Losses", `${s.consecutiveLosses}`],
      ["Range Trades", `${s.rangeTrades} (${s.rangeWinRate}% WR, $${s.rangePnl})`, "Trend Trades", `${s.trendTrades} (${s.trendWinRate}% WR, $${s.trendPnl})`],
    ];

    for (const row of statRows) {
      doc.fontSize(8).fillColor(grey).text(row[0], 50, y, { width: 120 });
      doc.fontSize(9).fillColor(black).text(row[1], 170, y, { width: 120 });
      doc.fontSize(8).fillColor(grey).text(row[2], 310, y, { width: 120 });
      doc.fontSize(9).fillColor(black).text(row[3], 430, y, { width: 120 });
      y += 16;
    }

    y += 8;
    doc.moveTo(50, y).lineTo(545, y).strokeColor("#E5E7EB").stroke();
    y += 12;

    if (warnings.length > 0) {
      doc.fontSize(13).fillColor(red).text("RISK WARNINGS", 50, y);
      y += 20;

      doc.fontSize(8).fillColor("#991B1B")
        .text(`Running Reward:Risk Ratio = ${c.rewardRatio}:1  |  Risk Per Trade = ${c.riskPerTradePct}%  |  Leverage = ${c.leverage}x  |  Computed Risk = ${riskRating}`, 50, y, { width: 495 });
      y += 16;

      for (const w of warnings) {
        if (y > 720) {
          doc.addPage();
          y = 50;
        }
        const icon = w.severity === "CRITICAL" ? "▲ CRITICAL" : w.severity === "WARN" ? "● WARNING" : "○ INFO";
        const wColor = w.severity === "CRITICAL" ? red : w.severity === "WARN" ? amber : grey;
        doc.fontSize(8).fillColor(wColor).text(icon, 50, y, { width: 70 });
        doc.fontSize(8).fillColor(black).text(w.message, 120, y, { width: 425 });
        y += 14;
      }

      y += 8;
      doc.moveTo(50, y).lineTo(545, y).strokeColor("#E5E7EB").stroke();
      y += 12;
    } else {
      doc.fontSize(10).fillColor(green).text("✓ All parameters within safe definitions — no risk warnings", 50, y);
      y += 22;
      doc.moveTo(50, y).lineTo(545, y).strokeColor("#E5E7EB").stroke();
      y += 12;
    }

    if (y > 580) {
      doc.addPage();
      y = 50;
    }

    doc.fontSize(13).fillColor(darkGold).text("COMPLETE PARAMETER LIST", 50, y);
    y += 22;

    const groups: Record<string, { key: string; label: string; value: string; exceeded: boolean }[]> = {};
    const paramDefs = getParamDefinitions();
    const warningKeys = new Set(warnings.map(w => w.param));

    const allParams: { key: string; label: string; value: string; group: string }[] = [
      { key: "startingBalance", label: "Starting Balance", value: `$${c.startingBalance}`, group: "Account" },
      { key: "lotSize", label: "Lot Size (fallback)", value: `${c.lotSize}`, group: "Account" },
      { key: "atrPeriod", label: "ATR Period", value: `${c.atrPeriod}`, group: "Indicators" },
      { key: "atrStopMultiplier", label: "ATR Stop Multiplier", value: `${c.atrStopMultiplier}x`, group: "Entry" },
      { key: "rewardRatio", label: "Reward:Risk Ratio", value: `${c.rewardRatio}:1`, group: "Entry" },
      { key: "retestBuffer", label: "Retest Buffer", value: `${c.retestBuffer} pts`, group: "Entry" },
      { key: "wickRatio", label: "Wick Ratio", value: `${c.wickRatio}`, group: "Entry" },
      { key: "compressionThreshold", label: "Compression Threshold", value: `${c.compressionThreshold}`, group: "Regime" },
      { key: "expansionThreshold", label: "Expansion Threshold", value: `${c.expansionThreshold}x`, group: "Regime" },
      { key: "rangeWidthBars", label: "Range Width Bars", value: `${c.rangeWidthBars}`, group: "Regime" },
      { key: "midpointBandPct", label: "Midpoint Band", value: `${c.midpointBandPct}`, group: "Regime" },
      { key: "sessionMode", label: "Session Mode", value: c.sessionMode, group: "Session" },
      { key: "maxTradesPerDay", label: "Max Trades/Day", value: `${c.maxTradesPerDay}`, group: "Session" },
      { key: "newsBeforeMin", label: "News Blackout Before", value: `${c.newsBeforeMin} min`, group: "News" },
      { key: "newsAfterMin", label: "News Blackout After", value: `${c.newsAfterMin} min`, group: "News" },
      { key: "gapFilterEnabled", label: "Gap Filter", value: c.gapFilterEnabled ? "Enabled" : "Disabled", group: "Filters" },
      { key: "gapThresholdAtr", label: "Gap Threshold ATR", value: `${c.gapThresholdAtr}x`, group: "Filters" },
      { key: "gapCooldownBars", label: "Gap Cooldown", value: `${c.gapCooldownBars} bars`, group: "Filters" },
      { key: "sessionORBEnabled", label: "Session ORB", value: c.sessionORBEnabled ? "Enabled" : "Disabled", group: "Filters" },
      { key: "trailingStopEnabled", label: "Trailing Stop", value: c.trailingStopEnabled ? "Enabled" : "Disabled", group: "Stop Mgmt" },
      { key: "trailingStopTriggerR", label: "Trailing Trigger", value: `${c.trailingStopTriggerR}R`, group: "Stop Mgmt" },
      { key: "riskPerTradePct", label: "Risk Per Trade", value: `${c.riskPerTradePct}%`, group: "Risk" },
      { key: "leverage", label: "Leverage", value: `${c.leverage}x`, group: "Risk" },
      { key: "maxDrawdownPct", label: "Max Drawdown", value: `${c.maxDrawdownPct}%`, group: "Risk" },
      { key: "maxDailyLossPct", label: "Max Daily Loss", value: `${c.maxDailyLossPct}%`, group: "Risk" },
      { key: "maxConsecutiveLosses", label: "Max Consec. Losses", value: `${c.maxConsecutiveLosses}`, group: "Risk" },
      { key: "postLossCooldownBars", label: "Post-Loss Cooldown", value: `${c.postLossCooldownBars} bars`, group: "Risk" },
      { key: "reduceSizeAfterLoss", label: "Reduce After Loss", value: c.reduceSizeAfterLoss ? "Enabled" : "Disabled", group: "Risk" },
      { key: "reducedRiskPerTradePct", label: "Reduced Risk", value: `${c.reducedRiskPerTradePct}%`, group: "Risk" },
      { key: "atrRiskScaleEnabled", label: "ATR Risk Scale", value: c.atrRiskScaleEnabled ? "Enabled" : "Disabled", group: "Risk" },
      { key: "atrRiskScaleThreshold", label: "ATR Scale Threshold", value: `${c.atrRiskScaleThreshold}x`, group: "Risk" },
      { key: "atrRiskScaleFactor", label: "ATR Scale Factor", value: `${c.atrRiskScaleFactor}x`, group: "Risk" },
      { key: "secondTradeRiskFactor", label: "2nd Trade Factor", value: `${c.secondTradeRiskFactor}x`, group: "Risk" },
    ];

    for (const p of allParams) {
      if (!groups[p.group]) groups[p.group] = [];
      groups[p.group].push({ key: p.key, label: p.label, value: p.value, exceeded: warningKeys.has(p.key) });
    }

    for (const [groupName, params] of Object.entries(groups)) {
      if (y > 700) {
        doc.addPage();
        y = 50;
      }

      doc.fontSize(9).fillColor(gold).text(groupName.toUpperCase(), 50, y);
      y += 14;

      for (const p of params) {
        if (y > 740) {
          doc.addPage();
          y = 50;
        }
        const valColor = p.exceeded ? red : black;
        const marker = p.exceeded ? " ⚠" : "";
        doc.fontSize(8).fillColor(grey).text(p.label, 70, y, { width: 150 });
        doc.fontSize(8).fillColor(valColor).text(p.value + marker, 220, y, { width: 150 });
        y += 13;
      }
      y += 6;
    }

    if (strategy.diagnostics) {
      if (y > 580) {
        doc.addPage();
        y = 50;
      }

      y += 4;
      doc.moveTo(50, y).lineTo(545, y).strokeColor("#E5E7EB").stroke();
      y += 12;

      doc.fontSize(13).fillColor(darkGold).text("DIAGNOSTICS (19 Counters)", 50, y);
      y += 22;

      const d = strategy.diagnostics;
      const diagRows = [
        ["Blocked by Session", d.blockedBySession, "Blocked by News", d.blockedByNews],
        ["Blocked by Gap", d.blockedByGap, "Blocked by Midpoint", d.blockedByMidpointBand],
        ["Blocked by Retest Distance", d.blockedByRetestDistance, "Blocked by Wick Ratio", d.blockedByWickRatio],
        ["Blocked by Compression", d.blockedByCompression, "Blocked by Expansion", d.blockedByExpansion],
        ["Blocked by Max Trades/Day", d.blockedByMaxTradesPerDay, "Blocked by Max Drawdown", d.blockedByMaxDrawdown],
        ["Blocked by Daily Loss", d.blockedByDailyLossLimit, "Blocked by Consec. Losses", d.blockedByConsecutiveLossLimit],
        ["Reduced Size After Loss", d.reducedSizeAfterLossCount, "ATR Scaled Risk", d.atrScaledRiskCount],
        ["2nd Trade Reduced", d.secondTradeReducedRiskCount, "", ""],
        ["Buy Candidates", d.buyCandidates, "Sell Candidates", d.sellCandidates],
        ["Accepted Buys", d.acceptedBuyTrades, "Accepted Sells", d.acceptedSellTrades],
      ];

      for (const row of diagRows) {
        if (y > 740) { doc.addPage(); y = 50; }
        doc.fontSize(8).fillColor(grey).text(String(row[0]), 70, y, { width: 150 });
        doc.fontSize(8).fillColor(black).text(String(row[1]), 220, y, { width: 60 });
        if (row[2]) {
          doc.fontSize(8).fillColor(grey).text(String(row[2]), 310, y, { width: 150 });
          doc.fontSize(8).fillColor(black).text(String(row[3]), 460, y, { width: 60 });
        }
        y += 14;
      }
    }

    y += 16;
    if (y > 740) { doc.addPage(); y = 50; }
    doc.moveTo(50, y).lineTo(545, y).strokeColor("#E5E7EB").stroke();
    y += 10;
    doc.fontSize(7).fillColor(grey)
      .text("Gold Regime Lab v3 — Strategy Report. This document is for informational purposes only. Past backtest performance does not guarantee future results. Trading involves substantial risk of loss.", 50, y, { width: 495, align: "center" });

    doc.end();
  });
}
