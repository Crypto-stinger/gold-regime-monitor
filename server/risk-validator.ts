import type { BacktestConfig } from "../shared/schema";

export type RiskWarning = {
  param: string;
  label: string;
  value: number | string | boolean;
  safeValue: number | string | boolean;
  deviation: string;
  severity: "INFO" | "WARN" | "CRITICAL";
  message: string;
};

type ParamDef = {
  key: keyof BacktestConfig;
  label: string;
  safeDefault: number;
  safeMin?: number;
  safeMax?: number;
  higherIsDangerous?: boolean;
  unit?: string;
  group: string;
};

const PARAM_DEFINITIONS: ParamDef[] = [
  { key: "rewardRatio", label: "Reward:Risk Ratio", safeDefault: 2.0, safeMin: 1.5, safeMax: 4.0, higherIsDangerous: false, unit: ":1", group: "Entry" },
  { key: "atrStopMultiplier", label: "ATR Stop Multiplier", safeDefault: 2.0, safeMin: 1.0, safeMax: 3.0, higherIsDangerous: false, unit: "x", group: "Entry" },
  { key: "riskPerTradePct", label: "Risk Per Trade", safeDefault: 0.75, safeMin: 0.25, safeMax: 2.0, higherIsDangerous: true, unit: "%", group: "Risk" },
  { key: "leverage", label: "Leverage", safeDefault: 1, safeMin: 1, safeMax: 10, higherIsDangerous: true, unit: "x", group: "Risk" },
  { key: "maxDrawdownPct", label: "Max Drawdown", safeDefault: 25, safeMin: 10, safeMax: 30, higherIsDangerous: true, unit: "%", group: "Risk" },
  { key: "maxDailyLossPct", label: "Max Daily Loss", safeDefault: 2.0, safeMin: 1.0, safeMax: 3.0, higherIsDangerous: true, unit: "%", group: "Risk" },
  { key: "maxConsecutiveLosses", label: "Max Consecutive Losses", safeDefault: 2, safeMin: 1, safeMax: 3, higherIsDangerous: true, unit: "", group: "Risk" },
  { key: "maxTradesPerDay", label: "Max Trades Per Day", safeDefault: 5, safeMin: 1, safeMax: 5, higherIsDangerous: true, unit: "", group: "Session" },
  { key: "wickRatio", label: "Wick Ratio Filter", safeDefault: 0.6, safeMin: 0.4, safeMax: 1.5, higherIsDangerous: false, unit: "", group: "Entry" },
  { key: "retestBuffer", label: "Retest Buffer", safeDefault: 12.0, safeMin: 5.0, safeMax: 20.0, higherIsDangerous: true, unit: "pts", group: "Entry" },
  { key: "minRangeATR", label: "Min Range Width (ATR)", safeDefault: 1.5, safeMin: 0.5, safeMax: 5.0, unit: "x ATR", group: "Regime" },
  { key: "maxTrendATRRatio", label: "Max Trend ATR Ratio", safeDefault: 5.0, safeMin: 2.0, safeMax: 10.0, higherIsDangerous: true, unit: "x avg", group: "Regime" },
  { key: "midpointBandPct", label: "Midpoint Band", safeDefault: 0.10, safeMin: 0.05, safeMax: 0.20, higherIsDangerous: false, unit: "%", group: "Regime" },
  { key: "compressionThreshold", label: "Compression Threshold", safeDefault: 0.022, safeMin: 0.01, safeMax: 0.04, unit: "", group: "Regime" },
  { key: "expansionThreshold", label: "Expansion Threshold", safeDefault: 1.05, safeMin: 1.02, safeMax: 1.15, unit: "x", group: "Regime" },
  { key: "rangeWidthBars", label: "Range Width Bars", safeDefault: 8, safeMin: 5, safeMax: 15, unit: "bars", group: "Regime" },
  { key: "atrPeriod", label: "ATR Period", safeDefault: 14, safeMin: 10, safeMax: 20, unit: "", group: "Indicators" },
  { key: "postLossCooldownBars", label: "Post-Loss Cooldown", safeDefault: 2, safeMin: 1, safeMax: 5, unit: "bars", group: "Risk" },
  { key: "reducedRiskPerTradePct", label: "Reduced Risk After Loss", safeDefault: 0.50, safeMin: 0.25, safeMax: 1.0, higherIsDangerous: true, unit: "%", group: "Risk" },
  { key: "secondTradeRiskFactor", label: "2nd Trade Risk Factor", safeDefault: 0.75, safeMin: 0.5, safeMax: 1.0, higherIsDangerous: true, unit: "x", group: "Risk" },
  { key: "atrRiskScaleThreshold", label: "ATR Risk Scale Threshold", safeDefault: 1.25, safeMin: 1.1, safeMax: 1.5, unit: "x", group: "Risk" },
  { key: "atrRiskScaleFactor", label: "ATR Risk Scale Factor", safeDefault: 0.65, safeMin: 0.4, safeMax: 0.8, higherIsDangerous: true, unit: "x", group: "Risk" },
  { key: "gapThresholdAtr", label: "Gap Threshold ATR", safeDefault: 0.5, safeMin: 0.3, safeMax: 1.0, unit: "x ATR", group: "Filters" },
  { key: "gapCooldownBars", label: "Gap Cooldown Bars", safeDefault: 2, safeMin: 1, safeMax: 4, unit: "bars", group: "Filters" },
  { key: "trailingStopTriggerR", label: "Trailing Stop Trigger", safeDefault: 1.0, safeMin: 0.5, safeMax: 2.0, unit: "R", group: "Stop Mgmt" },
  { key: "newsBeforeMin", label: "News Blackout Before", safeDefault: 30, safeMin: 15, safeMax: 60, unit: "min", group: "News" },
  { key: "newsAfterMin", label: "News Blackout After", safeDefault: 30, safeMin: 15, safeMax: 60, unit: "min", group: "News" },
];

export function validateStrategy(config: BacktestConfig): RiskWarning[] {
  const warnings: RiskWarning[] = [];

  for (const def of PARAM_DEFINITIONS) {
    const val = config[def.key] as number;
    if (val === undefined || val === null) continue;

    const safeMin = def.safeMin ?? def.safeDefault;
    const safeMax = def.safeMax ?? def.safeDefault;

    if (val < safeMin || val > safeMax) {
      let deviation: string;
      let severity: "INFO" | "WARN" | "CRITICAL";

      if (val < safeMin) {
        const pct = safeMin > 0 ? Math.abs(((safeMin - val) / safeMin) * 100).toFixed(0) : "N/A";
        deviation = `${pct}% below safe minimum (${safeMin}${def.unit || ""})`;
      } else {
        const pct = safeMax > 0 ? Math.abs(((val - safeMax) / safeMax) * 100).toFixed(0) : "N/A";
        deviation = `${pct}% above safe maximum (${safeMax}${def.unit || ""})`;
      }

      if (def.higherIsDangerous && val > safeMax) {
        const ratio = safeMax > 0 ? val / safeMax : 2;
        severity = ratio > 2 ? "CRITICAL" : ratio > 1.3 ? "WARN" : "INFO";
      } else if (!def.higherIsDangerous && val < safeMin) {
        const ratio = val > 0 ? safeMin / val : 2;
        severity = ratio > 2 ? "CRITICAL" : ratio > 1.3 ? "WARN" : "INFO";
      } else {
        severity = "INFO";
      }

      warnings.push({
        param: def.key,
        label: def.label,
        value: val,
        safeValue: val < safeMin ? safeMin : safeMax,
        deviation,
        severity,
        message: `${def.label}: current ${val}${def.unit || ""}, safe range ${safeMin}–${safeMax}${def.unit || ""} (${deviation})`,
      });
    }
  }

  const boolChecks: { key: keyof BacktestConfig; label: string; safeValue: boolean; message: string }[] = [
    { key: "reduceSizeAfterLoss", label: "Reduce Size After Loss", safeValue: true, message: "Risk reduction after loss is DISABLED — increases exposure after losing trades" },
    { key: "atrRiskScaleEnabled", label: "ATR Risk Scaling", safeValue: true, message: "ATR risk scaling is DISABLED — no volatility-based position reduction" },
    { key: "gapFilterEnabled", label: "Gap Filter", safeValue: true, message: "Gap filter is DISABLED — may enter on gap bars with unreliable price action" },
  ];

  for (const bc of boolChecks) {
    const val = config[bc.key] as boolean;
    if (val !== bc.safeValue) {
      warnings.push({
        param: bc.key,
        label: bc.label,
        value: val,
        safeValue: bc.safeValue,
        deviation: `Expected ${bc.safeValue}, got ${val}`,
        severity: "WARN",
        message: bc.message,
      });
    }
  }

  return warnings.sort((a, b) => {
    const order = { CRITICAL: 0, WARN: 1, INFO: 2 };
    return order[a.severity] - order[b.severity];
  });
}

export function getRiskRating(config: BacktestConfig, warnings: RiskWarning[]): string {
  const criticals = warnings.filter(w => w.severity === "CRITICAL").length;
  const warns = warnings.filter(w => w.severity === "WARN").length;
  const lev = (config.leverage ?? 1);
  const risk = config.riskPerTradePct;

  if (criticals >= 2 || lev > 50 || risk > 5) return "EXTREME";
  if (criticals >= 1 || warns >= 3 || lev > 20 || risk > 3) return "HIGH";
  if (warns >= 2 || lev > 5 || risk > 1.5) return "MED";
  if (warns >= 1) return "LOW";
  return "V-LOW";
}

export function getParamDefinitions() {
  return PARAM_DEFINITIONS;
}
