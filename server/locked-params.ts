import { storage } from "./storage";

const DEFAULT_LOCKED_PARAMS: Record<string, any> = {
  lotSize: 0.01,
  atrPeriod: 14,
  atrStopPeriod: 14,
  atrStopMultiplier: 2,
  rewardRatio: 4,
  compressionThreshold: 0.008,
  expansionThreshold: 1.06,
  rangeWidthBars: 6,
  midpointBandPct: 0.08,
  entryWindowBars: 2,
  wickRatio: 0.35,
  sessionMode: "London",
  sessionORBEnabled: true,
  riskPerTradePct: 10,
  leverage: 10,
  maxDrawdownPct: 25,
  maxDailyLossPct: 8,
  maxConsecutiveLosses: 6,
  maxTradesPerDay: 7,
  trailingStopEnabled: false,
  trailingStopTriggerR: 1,
  startingBalance: 3000,
  retestBuffer: 12,
  minRangeATR: 1.5,
  maxTrendATRRatio: 5.0,
  reduceSizeAfterLoss: true,
  reducedRiskPerTradePct: 5,
  gapFilterEnabled: true,
  gapThresholdAtr: 0.5,
  gapCooldownBars: 2,
  postLossCooldownBars: 2,
  atrRiskScaleEnabled: true,
  atrRiskScaleFactor: 0.65,
  atrRiskScaleThreshold: 1.25,
  regimeAdaptiveSizing: false,
  regimeAdaptiveSizingCap: 1.25,
  regimeAdaptiveAtrLookback: 60,
  secondTradeRiskFactor: 0.75,
  newsBeforeMin: 30,
  newsAfterMin: 30,
  ema200FilterEnabled: false,
  spreadPoints: 0.30,
  slippagePoints: 0.10,
  commissionPerLot: 0,
  gvzEnabled: false,
  gvzRangeThreshold: 15,
  gvzTrendThreshold: 90,
  cotEnabled: false,
  cotBullishThreshold: 75,
  cotBearishThreshold: 25,
  avoidHoursEnabled: false,
  avoidHoursUTC: [21, 22, 23, 0],
  peakHoursEnabled: false,
  peakHoursUTC: [],
  volumeProfileEnabled: false,
  volumeProfilePeriod: 50,
  volumeProfileBins: 24,
  volumeProfileValueAreaPct: 70,
  vpPocProximityPct: 0.15,
  sgeEnabled: false,
  sgeBullishThreshold: 20,
  sgeBearishThreshold: -15,
  hmmEnabled: false,
  hmmConfidenceThreshold: 0.85,
};

let cachedParams: Record<string, any> | null = null;

const V2_UPGRADES: Record<string, any> = {
  trailingStopEnabled: true,
  newsAfterMin: 90,
  atrStopPeriod: 10,
  regimeAdaptiveSizing: true,
  regimeAdaptiveSizingCap: 1.25,
  regimeAdaptiveAtrLookback: 60,
  ema200FilterEnabled: true,
};

const V3_UPGRADES: Record<string, any> = {
  expansionThreshold: 1.05,
  cotEnabled: false,
  cotBullishThreshold: 75,
  cotBearishThreshold: 25,
  avoidHoursEnabled: true,
  avoidHoursUTC: [21, 22, 23, 0],
};

const V4_UPGRADES: Record<string, any> = {
  volumeProfileEnabled: false,
  volumeProfilePeriod: 50,
  volumeProfileBins: 24,
  volumeProfileValueAreaPct: 70,
  vpPocProximityPct: 0.15,
};

const V5_UPGRADES: Record<string, any> = {
  sgeEnabled: false,
  sgeBullishThreshold: 20,
  sgeBearishThreshold: -15,
};

const V6_UPGRADES: Record<string, any> = {
  hmmEnabled: false,
  hmmConfidenceThreshold: 0.85,
};

const V7_UPGRADES: Record<string, any> = {
  mrsGarchEnabled: true,
  mrsGarchVolScaling: true,
  mrsGarchHighVolThreshold: 75,
  mrsGarchLowVolThreshold: 25,
};

const V8_CHAMPION: Record<string, any> = {
  expansionThreshold: 1.15,
  entryWindowBars: 0,
  trailingStopEnabled: false,
  startingBalance: 3000,
  maxConsecutiveLosses: 2,
  newsAfterMin: 30,
  ema200FilterEnabled: false,
  avoidHoursEnabled: false,
  regimeAdaptiveSizing: false,
  atrStopPeriod: 14,
  mrsGarchEnabled: false,
  mrsGarchVolScaling: false,
  atrRiskScaleFactor: 0.65,
};

const V9_CHAMPION_FIX: Record<string, any> = {
  entryWindowBars: 0,
  atrRiskScaleFactor: 0.65,
};

const V10_FULL_THROTTLE: Record<string, any> = {
  atrStopMultiplier: 2,
  compressionThreshold: 0.008,
  expansionThreshold: 1.06,
  rangeWidthBars: 6,
  midpointBandPct: 0.08,
  entryWindowBars: 2,
  wickRatio: 0.35,
  sessionMode: "London",
  riskPerTradePct: 10,
  maxDailyLossPct: 8,
  maxConsecutiveLosses: 6,
  maxTradesPerDay: 7,
  reducedRiskPerTradePct: 5,
  secondTradeRiskFactor: 0.75,
};

export async function getLockedParams(): Promise<Record<string, any>> {
  if (cachedParams) return { ...cachedParams };
  const dbParams = await storage.getLockedParams();
  if (dbParams) {
    let needsSave = false;
    const merged = { ...DEFAULT_LOCKED_PARAMS, ...dbParams };
    for (const [key, val] of Object.entries(V2_UPGRADES)) {
      if (!(key in dbParams)) {
        merged[key] = val;
        needsSave = true;
      }
    }
    if (!dbParams._v2Applied) {
      for (const [key, val] of Object.entries(V2_UPGRADES)) {
        merged[key] = val;
      }
      merged._v2Applied = true;
      needsSave = true;
    }
    if (!dbParams._v3Applied) {
      for (const [key, val] of Object.entries(V3_UPGRADES)) {
        merged[key] = val;
      }
      merged._v3Applied = true;
      needsSave = true;
    }
    if (!dbParams._v4Applied) {
      for (const [key, val] of Object.entries(V4_UPGRADES)) {
        merged[key] = val;
      }
      merged._v4Applied = true;
      needsSave = true;
    }
    if (!dbParams._v5Applied) {
      for (const [key, val] of Object.entries(V5_UPGRADES)) {
        merged[key] = val;
      }
      merged._v5Applied = true;
      needsSave = true;
    }
    if (!dbParams._v6Applied) {
      for (const [key, val] of Object.entries(V6_UPGRADES)) {
        merged[key] = val;
      }
      merged._v6Applied = true;
      needsSave = true;
    }
    if (!dbParams._v7Applied) {
      for (const [key, val] of Object.entries(V7_UPGRADES)) {
        merged[key] = val;
      }
      merged._v7Applied = true;
      needsSave = true;
    }
    if (!dbParams._v8Applied) {
      for (const [key, val] of Object.entries(V8_CHAMPION)) {
        merged[key] = val;
      }
      merged._v8Applied = true;
      needsSave = true;
    }
    if (!dbParams._v9Applied) {
      for (const [key, val] of Object.entries(V9_CHAMPION_FIX)) {
        merged[key] = val;
      }
      merged._v9Applied = true;
      needsSave = true;
      try {
        await storage.logStrategyChange({
          action: "params_changed",
          description: "V9 Champion Fix: entryWindowBars=0 (was 3), atrRiskScaleFactor=0.65 (was 0.5). Fixed to match original champion that produced 13,042% return.",
          configSnapshot: V9_CHAMPION_FIX,
        });
      } catch (e) {}
    }
    if (!dbParams._v10Applied) {
      for (const [key, val] of Object.entries(V10_FULL_THROTTLE)) {
        merged[key] = val;
      }
      merged._v10Applied = true;
      needsSave = true;
      try {
        await storage.logStrategyChange({
          action: "params_changed",
          description: "V10 Full Throttle: Reset to champion strategy — 10% risk, London session, entryWindowBars=2, ATR Stop 2x, expansion 1.06, compression 0.008. 750% return, 88.9% WR, 10% DD.",
          configSnapshot: V10_FULL_THROTTLE,
        });
      } catch (e) {}
    }
    merged.leverage = 10;
    merged.maxDrawdownPct = 25;
    if (!merged.startingBalance || merged.startingBalance < 3000) merged.startingBalance = 3000;
    cachedParams = merged;
    if (needsSave) {
      await storage.setLockedParams(cachedParams);
    }
  } else {
    cachedParams = { ...DEFAULT_LOCKED_PARAMS, _v2Applied: true, _v3Applied: true, _v4Applied: true, _v5Applied: true, _v6Applied: true, _v7Applied: true, _v8Applied: true, _v9Applied: true, _v10Applied: true };
    cachedParams.leverage = 10;
    cachedParams.maxDrawdownPct = 25;
    cachedParams.startingBalance = 3000;
    await storage.setLockedParams(cachedParams);
  }
  return { ...cachedParams };
}

export async function updateLockedParams(newParams: Record<string, any>): Promise<Record<string, any>> {
  const current = await getLockedParams();
  const merged = { ...current, ...newParams };
  merged.leverage = 10;
  merged.maxDrawdownPct = 25;
  if (!merged.startingBalance || merged.startingBalance < 3000) merged.startingBalance = 3000;
  await storage.setLockedParams(merged);
  cachedParams = { ...merged };
  return { ...merged };
}

export function getDefaultLockedParams(): Record<string, any> {
  return { ...DEFAULT_LOCKED_PARAMS };
}

export function invalidateLockedParamsCache(): void {
  cachedParams = null;
}
