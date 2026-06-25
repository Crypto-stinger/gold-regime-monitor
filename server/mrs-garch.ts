import type { EnrichedCandle } from "../shared/schema";
import { getLastHMMClassification, isHMMTrained, type HMMState, type HMMResult } from "./hmm-engine";

export type GARCHParams = {
  omega: number;
  alpha: number;
  beta: number;
  mu: number;
};

export type MRSGARCHState = {
  regime: HMMState;
  garchVolatility: number;
  annualizedVol: number;
  volForecast: number;
  volPercentile: number;
  confidence: number;
  regimeStability: number;
  positionSizeMultiplier: number;
};

export type MRSGARCHModel = {
  garchParams: Record<HMMState, GARCHParams>;
  trained: boolean;
  trainedAt: string;
  nSamples: number;
  historicalVols: number[];
};

let currentMRSModel: MRSGARCHModel | null = null;
let lastMRSState: MRSGARCHState | null = null;

function defaultGARCHParams(): Record<HMMState, GARCHParams> {
  return {
    low_vol: { omega: 0.000001, alpha: 0.05, beta: 0.90, mu: 0.0001 },
    medium_vol: { omega: 0.000005, alpha: 0.10, beta: 0.85, mu: 0.0003 },
    high_vol: { omega: 0.00002, alpha: 0.15, beta: 0.80, mu: 0.0008 },
  };
}

function computeLogReturns(candles: EnrichedCandle[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > 0 && candles[i - 1].close > 0) {
      returns.push(Math.log(candles[i].close / candles[i - 1].close));
    } else {
      returns.push(0);
    }
  }
  return returns;
}

function fitGARCH11(returns: number[], maxIter: number = 100): GARCHParams {
  const n = returns.length;
  if (n < 20) return { omega: 0.000005, alpha: 0.1, beta: 0.85, mu: 0 };

  const mu = returns.reduce((a, b) => a + b, 0) / n;
  const residuals = returns.map(r => r - mu);
  const sampleVar = residuals.reduce((a, r) => a + r * r, 0) / n;

  let omega = sampleVar * 0.05;
  let alpha = 0.10;
  let beta = 0.85;

  for (let iter = 0; iter < maxIter; iter++) {
    const sigmas2: number[] = [sampleVar];
    let logLik = 0;

    for (let t = 1; t < n; t++) {
      const s2 = omega + alpha * residuals[t - 1] * residuals[t - 1] + beta * sigmas2[t - 1];
      sigmas2.push(Math.max(s2, 1e-12));
      logLik += -0.5 * (Math.log(2 * Math.PI) + Math.log(sigmas2[t]) + (residuals[t] * residuals[t]) / sigmas2[t]);
    }

    const dOmega = computeGradient(residuals, sigmas2, 'omega', omega, alpha, beta);
    const dAlpha = computeGradient(residuals, sigmas2, 'alpha', omega, alpha, beta);
    const dBeta = computeGradient(residuals, sigmas2, 'beta', omega, alpha, beta);

    const lr = 0.0001 / (1 + iter * 0.01);
    omega = Math.max(1e-10, omega + lr * dOmega);
    alpha = Math.max(0.001, Math.min(0.5, alpha + lr * dAlpha));
    beta = Math.max(0.3, Math.min(0.998 - alpha, beta + lr * dBeta));

    if (alpha + beta >= 0.999) {
      const scale = 0.998 / (alpha + beta);
      alpha *= scale;
      beta *= scale;
    }
  }

  return { omega, alpha, beta, mu };
}

function computeGradient(
  residuals: number[], sigmas2: number[],
  param: 'omega' | 'alpha' | 'beta',
  omega: number, alpha: number, beta: number
): number {
  const n = residuals.length;
  let grad = 0;
  const dSigma2: number[] = [0];

  for (let t = 1; t < n; t++) {
    let dS2: number;
    if (param === 'omega') {
      dS2 = 1 + beta * dSigma2[t - 1];
    } else if (param === 'alpha') {
      dS2 = residuals[t - 1] * residuals[t - 1] + beta * dSigma2[t - 1];
    } else {
      dS2 = sigmas2[t - 1] + beta * dSigma2[t - 1];
    }
    dSigma2.push(dS2);

    const e2 = residuals[t] * residuals[t];
    grad += 0.5 * dS2 * (e2 / (sigmas2[t] * sigmas2[t]) - 1 / sigmas2[t]);
  }

  return grad;
}

function garchForecast(params: GARCHParams, lastResidual: number, lastSigma2: number, steps: number = 1): number {
  let sigma2 = lastSigma2;
  let e2 = lastResidual * lastResidual;

  for (let s = 0; s < steps; s++) {
    sigma2 = params.omega + params.alpha * e2 + params.beta * sigma2;
    e2 = sigma2;
  }

  return Math.sqrt(Math.max(sigma2, 1e-12));
}

function computeRegimeStability(candles: EnrichedCandle[], lookback: number = 20): number {
  if (candles.length < lookback) return 0.5;
  const recent = candles.slice(-lookback);
  const states = recent.map(c => c.hmm_state).filter(Boolean);
  if (states.length < 5) return 0.5;

  const currentState = states[states.length - 1];
  const sameStateCount = states.filter(s => s === currentState).length;
  return sameStateCount / states.length;
}

function volToPercentile(vol: number, historicalVols: number[]): number {
  if (historicalVols.length < 10) return 50;
  const sorted = [...historicalVols].sort((a, b) => a - b);
  let count = 0;
  for (const v of sorted) {
    if (v <= vol) count++;
  }
  return Math.round((count / sorted.length) * 100);
}

function computePositionSizeMultiplier(volPercentile: number, regimeStability: number): number {
  let volMultiplier: number;
  if (volPercentile > 80) {
    volMultiplier = 0.6;
  } else if (volPercentile > 60) {
    volMultiplier = 0.8;
  } else if (volPercentile < 20) {
    volMultiplier = 1.15;
  } else {
    volMultiplier = 1.0;
  }

  const stabilityMultiplier = 0.7 + 0.3 * regimeStability;
  return Math.max(0.5, Math.min(1.25, volMultiplier * stabilityMultiplier));
}

export function trainMRSGARCH(candles: EnrichedCandle[]): boolean {
  try {
    if (candles.length < 100) {
      console.warn(`[MRS-GARCH] Insufficient data: ${candles.length} candles (need 100+)`);
      return false;
    }

    const returns = computeLogReturns(candles);
    if (returns.length < 50) return false;

    const stateGroups: Record<HMMState, number[]> = {
      low_vol: [], medium_vol: [], high_vol: [],
    };

    for (let i = 0; i < returns.length; i++) {
      const candle = candles[i + 1];
      const state = (candle?.hmm_state as HMMState) || "medium_vol";
      stateGroups[state].push(returns[i]);
    }

    const garchParams: Record<HMMState, GARCHParams> = defaultGARCHParams();

    for (const state of ["low_vol", "medium_vol", "high_vol"] as HMMState[]) {
      const stateReturns = stateGroups[state];
      if (stateReturns.length >= 20) {
        garchParams[state] = fitGARCH11(stateReturns);
        console.log(`[MRS-GARCH] Fitted ${state}: omega=${garchParams[state].omega.toExponential(3)}, alpha=${garchParams[state].alpha.toFixed(4)}, beta=${garchParams[state].beta.toFixed(4)} (${stateReturns.length} samples)`);
      } else {
        console.log(`[MRS-GARCH] Using defaults for ${state} (only ${stateReturns.length} samples)`);
      }
    }

    const allSigmas: number[] = [];
    let sigma2 = returns.reduce((a, r) => a + r * r, 0) / returns.length;
    for (let i = 0; i < returns.length; i++) {
      const state = (candles[i + 1]?.hmm_state as HMMState) || "medium_vol";
      const p = garchParams[state];
      const residual = returns[i] - p.mu;
      sigma2 = p.omega + p.alpha * residual * residual + p.beta * sigma2;
      allSigmas.push(Math.sqrt(Math.max(sigma2, 1e-12)));
    }

    currentMRSModel = {
      garchParams,
      trained: true,
      trainedAt: new Date().toISOString(),
      nSamples: returns.length,
      historicalVols: allSigmas.slice(-500),
    };

    console.log(`[MRS-GARCH] Training complete: ${returns.length} samples, 3 regime GARCH models fitted`);
    return true;
  } catch (err: any) {
    console.error(`[MRS-GARCH] Training error: ${err.message}`);
    return false;
  }
}

export function classifyMRSGARCH(candles: EnrichedCandle[]): MRSGARCHState | null {
  if (!currentMRSModel?.trained) return null;
  if (candles.length < 20) return null;

  const hmmResult = getLastHMMClassification();
  if (!hmmResult) return null;

  const returns = computeLogReturns(candles.slice(-50));
  if (returns.length < 5) return null;

  const regime = hmmResult.state;
  const params = currentMRSModel.garchParams[regime];

  let sigma2 = returns.reduce((a, r) => a + r * r, 0) / returns.length;
  for (let i = 0; i < returns.length; i++) {
    const residual = returns[i] - params.mu;
    sigma2 = params.omega + params.alpha * residual * residual + params.beta * sigma2;
  }

  const currentVol = Math.sqrt(Math.max(sigma2, 1e-12));
  const lastResidual = returns[returns.length - 1] - params.mu;
  const forecastVol = garchForecast(params, lastResidual, sigma2, 1);
  const annualizedVol = currentVol * Math.sqrt(252 * 6);
  const volPercentile = volToPercentile(currentVol, currentMRSModel.historicalVols);
  const regimeStability = computeRegimeStability(candles);
  const positionSizeMultiplier = computePositionSizeMultiplier(volPercentile, regimeStability);

  const state: MRSGARCHState = {
    regime,
    garchVolatility: currentVol,
    annualizedVol,
    volForecast: forecastVol,
    volPercentile,
    confidence: hmmResult.confidence,
    regimeStability,
    positionSizeMultiplier,
  };

  lastMRSState = state;
  return state;
}

export function classifyMRSGARCHPerBar(candles: EnrichedCandle[]): MRSGARCHState[] {
  if (!currentMRSModel?.trained) return [];
  if (candles.length < 20) return [];

  const allReturns = computeLogReturns(candles);
  if (allReturns.length < 5) return [];

  const results: MRSGARCHState[] = [];
  const sampleVar = allReturns.slice(0, 20).reduce((a, r) => a + r * r, 0) / 20;
  let sigma2 = sampleVar;

  for (let i = 0; i < allReturns.length; i++) {
    const candle = candles[i + 1];
    const regime = (candle?.hmm_state as HMMState) || "medium_vol";
    const params = currentMRSModel.garchParams[regime];

    const residual = allReturns[i] - params.mu;
    sigma2 = params.omega + params.alpha * residual * residual + params.beta * sigma2;
    sigma2 = Math.max(sigma2, 1e-12);

    const currentVol = Math.sqrt(sigma2);
    const forecastVol = garchForecast(params, residual, sigma2, 1);
    const annualizedVol = currentVol * Math.sqrt(252 * 6);
    const volPercentile = volToPercentile(currentVol, currentMRSModel.historicalVols);

    const recentStates = candles.slice(Math.max(0, i - 18), i + 2);
    const regimeStability = computeRegimeStability(recentStates);
    const positionSizeMultiplier = computePositionSizeMultiplier(volPercentile, regimeStability);

    const hmmConf = candle?.hmm_confidence ?? 0.5;

    results.push({
      regime,
      garchVolatility: currentVol,
      annualizedVol,
      volForecast: forecastVol,
      volPercentile,
      confidence: hmmConf,
      regimeStability,
      positionSizeMultiplier,
    });
  }

  if (results.length > 0) {
    lastMRSState = results[results.length - 1];
  }

  return results;
}

export function getLastMRSGARCHState(): MRSGARCHState | null {
  return lastMRSState;
}

export function isMRSGARCHTrained(): boolean {
  return currentMRSModel !== null && currentMRSModel.trained;
}

export function getMRSGARCHModel(): { trained: boolean; trainedAt: string; nSamples: number; garchParams: Record<string, GARCHParams> } | null {
  if (!currentMRSModel) return null;
  return {
    trained: currentMRSModel.trained,
    trainedAt: currentMRSModel.trainedAt,
    nSamples: currentMRSModel.nSamples,
    garchParams: currentMRSModel.garchParams,
  };
}
