import type { EnrichedCandle, RegimeState } from "../shared/schema";

export type HMMState = "low_vol" | "medium_vol" | "high_vol";

export type HMMResult = {
  state: HMMState;
  confidence: number;
  probabilities: { low_vol: number; medium_vol: number; high_vol: number };
};

const STATE_NAMES: HMMState[] = ["low_vol", "medium_vol", "high_vol"];
const N_STATES = 3;
const N_FEATURES = 4;

interface GaussianParams {
  mean: number[];
  variance: number[];
}

interface HMMModel {
  pi: number[];
  A: number[][];
  emissions: GaussianParams[];
  trained: boolean;
  trainedAt: string;
  nSamples: number;
}

let currentModel: HMMModel | null = null;

function defaultModel(): HMMModel {
  return {
    pi: [0.4, 0.35, 0.25],
    A: [
      [0.80, 0.15, 0.05],
      [0.15, 0.70, 0.15],
      [0.05, 0.20, 0.75],
    ],
    emissions: [
      { mean: [0.7, 20, 15, 0.005], variance: [0.04, 100, 25, 0.00005] },
      { mean: [1.0, 50, 25, 0.012], variance: [0.04, 100, 25, 0.00008] },
      { mean: [1.5, 80, 40, 0.025], variance: [0.09, 100, 50, 0.0002] },
    ],
    trained: false,
    trainedAt: "",
    nSamples: 0,
  };
}

function extractFeatures(candles: EnrichedCandle[]): number[][] {
  const features: number[][] = [];
  if (candles.length < 20) return features;

  const atrH4Vals = candles.map(c => c.atr_h4).filter(v => !isNaN(v) && v > 0);
  const avgATR = atrH4Vals.length > 0 ? atrH4Vals.reduce((a, b) => a + b, 0) / atrH4Vals.length : 1;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];

    const atrRatio = avgATR > 0 && !isNaN(c.atr_h4) ? c.atr_h4 / avgATR : 1.0;
    const bbPct = c.bb_width_percentile ?? 50;
    const adx = !isNaN(c.adx_h4) ? c.adx_h4 : 20;
    const logReturn = prev.close > 0 ? Math.abs(Math.log(c.close / prev.close)) : 0;

    features.push([atrRatio, bbPct, adx, logReturn]);
  }

  return features;
}

function gaussianLogPdf(x: number, mean: number, variance: number): number {
  const v = Math.max(variance, 1e-10);
  return -0.5 * Math.log(2 * Math.PI * v) - ((x - mean) ** 2) / (2 * v);
}

function emissionLogProb(obs: number[], params: GaussianParams): number {
  let logP = 0;
  for (let f = 0; f < N_FEATURES; f++) {
    logP += gaussianLogPdf(obs[f], params.mean[f], params.variance[f]);
  }
  return logP;
}

function logSumExp(logVals: number[]): number {
  const maxVal = Math.max(...logVals);
  if (!isFinite(maxVal)) return -Infinity;
  let sum = 0;
  for (const v of logVals) {
    sum += Math.exp(v - maxVal);
  }
  return maxVal + Math.log(sum);
}

function forward(obs: number[][], model: HMMModel): { alpha: number[][]; logLikelihood: number } {
  const T = obs.length;
  const alpha: number[][] = new Array(T).fill(null).map(() => new Array(N_STATES).fill(-Infinity));

  for (let j = 0; j < N_STATES; j++) {
    alpha[0][j] = Math.log(Math.max(model.pi[j], 1e-10)) + emissionLogProb(obs[0], model.emissions[j]);
  }

  for (let t = 1; t < T; t++) {
    for (let j = 0; j < N_STATES; j++) {
      const logTerms: number[] = [];
      for (let i = 0; i < N_STATES; i++) {
        logTerms.push(alpha[t - 1][i] + Math.log(Math.max(model.A[i][j], 1e-10)));
      }
      alpha[t][j] = logSumExp(logTerms) + emissionLogProb(obs[t], model.emissions[j]);
    }
  }

  const logLikelihood = logSumExp(alpha[T - 1]);
  return { alpha, logLikelihood };
}

function backward(obs: number[][], model: HMMModel): number[][] {
  const T = obs.length;
  const beta: number[][] = new Array(T).fill(null).map(() => new Array(N_STATES).fill(-Infinity));

  for (let j = 0; j < N_STATES; j++) {
    beta[T - 1][j] = 0;
  }

  for (let t = T - 2; t >= 0; t--) {
    for (let i = 0; i < N_STATES; i++) {
      const logTerms: number[] = [];
      for (let j = 0; j < N_STATES; j++) {
        logTerms.push(
          Math.log(Math.max(model.A[i][j], 1e-10)) +
          emissionLogProb(obs[t + 1], model.emissions[j]) +
          beta[t + 1][j]
        );
      }
      beta[t][i] = logSumExp(logTerms);
    }
  }

  return beta;
}

function baumWelch(obs: number[][], model: HMMModel, maxIter: number = 20, tol: number = 1e-4): HMMModel {
  const T = obs.length;
  if (T < 10) return model;

  let currentLL = -Infinity;
  let m = JSON.parse(JSON.stringify(model)) as HMMModel;

  for (let iter = 0; iter < maxIter; iter++) {
    const { alpha, logLikelihood } = forward(obs, m);
    const beta = backward(obs, m);

    if (Math.abs(logLikelihood - currentLL) < tol && iter > 0) break;
    currentLL = logLikelihood;

    const gamma: number[][] = new Array(T).fill(null).map(() => new Array(N_STATES).fill(0));
    for (let t = 0; t < T; t++) {
      const logDenom = logSumExp(alpha[t].map((a, j) => a + beta[t][j]));
      for (let j = 0; j < N_STATES; j++) {
        gamma[t][j] = Math.exp(alpha[t][j] + beta[t][j] - logDenom);
      }
    }

    const xi: number[][][] = new Array(T - 1).fill(null).map(() =>
      new Array(N_STATES).fill(null).map(() => new Array(N_STATES).fill(0))
    );

    for (let t = 0; t < T - 1; t++) {
      const logTerms: number[] = [];
      for (let i = 0; i < N_STATES; i++) {
        for (let j = 0; j < N_STATES; j++) {
          logTerms.push(
            alpha[t][i] +
            Math.log(Math.max(m.A[i][j], 1e-10)) +
            emissionLogProb(obs[t + 1], m.emissions[j]) +
            beta[t + 1][j]
          );
        }
      }
      const logDenom = logSumExp(logTerms);

      for (let i = 0; i < N_STATES; i++) {
        for (let j = 0; j < N_STATES; j++) {
          xi[t][i][j] = Math.exp(
            alpha[t][i] +
            Math.log(Math.max(m.A[i][j], 1e-10)) +
            emissionLogProb(obs[t + 1], m.emissions[j]) +
            beta[t + 1][j] -
            logDenom
          );
        }
      }
    }

    for (let j = 0; j < N_STATES; j++) {
      m.pi[j] = Math.max(gamma[0][j], 1e-10);
    }
    const piSum = m.pi.reduce((a, b) => a + b, 0);
    for (let j = 0; j < N_STATES; j++) m.pi[j] /= piSum;

    for (let i = 0; i < N_STATES; i++) {
      let gammaSum = 0;
      for (let t = 0; t < T - 1; t++) gammaSum += gamma[t][i];
      for (let j = 0; j < N_STATES; j++) {
        let xiSum = 0;
        for (let t = 0; t < T - 1; t++) xiSum += xi[t][i][j];
        m.A[i][j] = gammaSum > 1e-10 ? xiSum / gammaSum : 1.0 / N_STATES;
      }
      const rowSum = m.A[i].reduce((a, b) => a + b, 0);
      for (let j = 0; j < N_STATES; j++) m.A[i][j] /= rowSum;
    }

    for (let j = 0; j < N_STATES; j++) {
      let gammaSum = 0;
      for (let t = 0; t < T; t++) gammaSum += gamma[t][j];

      for (let f = 0; f < N_FEATURES; f++) {
        let meanNum = 0;
        for (let t = 0; t < T; t++) meanNum += gamma[t][j] * obs[t][f];
        m.emissions[j].mean[f] = gammaSum > 1e-10 ? meanNum / gammaSum : m.emissions[j].mean[f];

        let varNum = 0;
        for (let t = 0; t < T; t++) {
          varNum += gamma[t][j] * (obs[t][f] - m.emissions[j].mean[f]) ** 2;
        }
        m.emissions[j].variance[f] = gammaSum > 1e-10 ? Math.max(varNum / gammaSum, 1e-6) : m.emissions[j].variance[f];
      }
    }
  }

  return m;
}

function viterbi(obs: number[][], model: HMMModel): number[] {
  const T = obs.length;
  if (T === 0) return [];

  const delta: number[][] = new Array(T).fill(null).map(() => new Array(N_STATES).fill(-Infinity));
  const psi: number[][] = new Array(T).fill(null).map(() => new Array(N_STATES).fill(0));

  for (let j = 0; j < N_STATES; j++) {
    delta[0][j] = Math.log(Math.max(model.pi[j], 1e-10)) + emissionLogProb(obs[0], model.emissions[j]);
    psi[0][j] = 0;
  }

  for (let t = 1; t < T; t++) {
    for (let j = 0; j < N_STATES; j++) {
      let bestLogProb = -Infinity;
      let bestState = 0;
      for (let i = 0; i < N_STATES; i++) {
        const logP = delta[t - 1][i] + Math.log(Math.max(model.A[i][j], 1e-10));
        if (logP > bestLogProb) {
          bestLogProb = logP;
          bestState = i;
        }
      }
      delta[t][j] = bestLogProb + emissionLogProb(obs[t], model.emissions[j]);
      psi[t][j] = bestState;
    }
  }

  const path: number[] = new Array(T).fill(0);
  let bestFinalState = 0;
  let bestFinalProb = -Infinity;
  for (let j = 0; j < N_STATES; j++) {
    if (delta[T - 1][j] > bestFinalProb) {
      bestFinalProb = delta[T - 1][j];
      bestFinalState = j;
    }
  }
  path[T - 1] = bestFinalState;

  for (let t = T - 2; t >= 0; t--) {
    path[t] = psi[t + 1][path[t + 1]];
  }

  return path;
}

function getStateProbabilities(obs: number[], model: HMMModel): { low_vol: number; medium_vol: number; high_vol: number } {
  const logProbs: number[] = [];
  for (let j = 0; j < N_STATES; j++) {
    logProbs.push(Math.log(Math.max(model.pi[j], 1e-10)) + emissionLogProb(obs, model.emissions[j]));
  }
  const logTotal = logSumExp(logProbs);
  const probs = logProbs.map(lp => Math.exp(lp - logTotal));
  return { low_vol: probs[0], medium_vol: probs[1], high_vol: probs[2] };
}

export function trainHMM(candles: EnrichedCandle[]): boolean {
  try {
    const features = extractFeatures(candles);
    if (features.length < 50) {
      console.warn(`[HMM] Insufficient data for training: ${features.length} samples (need 50+)`);
      return false;
    }

    const model = defaultModel();
    const trained = baumWelch(features, model, 30, 1e-5);
    trained.trained = true;
    trained.trainedAt = new Date().toISOString();
    trained.nSamples = features.length;

    const emMeans = trained.emissions.map((e, i) => `S${i}:[atr=${e.mean[0].toFixed(2)},bb=${e.mean[1].toFixed(0)},adx=${e.mean[2].toFixed(0)},ret=${(e.mean[3]*100).toFixed(2)}%]`);

    const sortOrder = trained.emissions.map((e, i) => ({ idx: i, vol: e.mean[0] + e.mean[3] * 100 })).sort((a, b) => a.vol - b.vol);

    if (sortOrder[0].idx !== 0 || sortOrder[1].idx !== 1 || sortOrder[2].idx !== 2) {
      const reordered = sortOrder.map(s => s.idx);
      const newEmissions = reordered.map(i => trained.emissions[i]);
      const newPi = reordered.map(i => trained.pi[i]);
      const newA = reordered.map(i => reordered.map(j => trained.A[i][j]));
      trained.emissions = newEmissions;
      trained.pi = newPi;
      trained.A = newA;
    }

    currentModel = trained;
    console.log(`[HMM] Trained on ${features.length} samples. Emissions: ${emMeans.join(' | ')}`);
    return true;
  } catch (err: any) {
    console.error(`[HMM] Training error: ${err.message}`);
    return false;
  }
}

let lastClassification: HMMResult | null = null;

export function classifyHMMPerBar(candles: EnrichedCandle[]): HMMResult[] {
  const model = currentModel || defaultModel();
  const features = extractFeatures(candles);
  if (features.length < 5) {
    return features.map(() => ({
      state: "medium_vol" as HMMState,
      confidence: 0,
      probabilities: { low_vol: 0.33, medium_vol: 0.34, high_vol: 0.33 },
    }));
  }

  const results: HMMResult[] = [];
  let prevProbs = [...model.pi];

  for (let t = 0; t < features.length; t++) {
    const obs = features[t];
    const logProbs: number[] = [];
    for (let j = 0; j < N_STATES; j++) {
      let logPrior: number;
      if (t === 0) {
        logPrior = Math.log(Math.max(prevProbs[j], 1e-10));
      } else {
        let sumTrans = 0;
        for (let i = 0; i < N_STATES; i++) {
          sumTrans += prevProbs[i] * model.A[i][j];
        }
        logPrior = Math.log(Math.max(sumTrans, 1e-10));
      }
      logProbs.push(logPrior + emissionLogProb(obs, model.emissions[j]));
    }
    const logTotal = logSumExp(logProbs);
    const probs = logProbs.map(lp => Math.exp(lp - logTotal));
    prevProbs = probs;

    let bestState: HMMState = "medium_vol";
    let bestProb = 0;
    const stateProbs = { low_vol: probs[0], medium_vol: probs[1], high_vol: probs[2] };
    for (const [state, prob] of Object.entries(stateProbs) as [HMMState, number][]) {
      if (prob > bestProb) {
        bestProb = prob;
        bestState = state;
      }
    }
    results.push({ state: bestState, confidence: bestProb, probabilities: stateProbs });
  }

  if (results.length > 0) {
    lastClassification = results[results.length - 1];
  }
  return results;
}

export function classifyHMMRegime(candles: EnrichedCandle[]): HMMResult {
  const defaultResult: HMMResult = {
    state: "medium_vol",
    confidence: 0,
    probabilities: { low_vol: 0.33, medium_vol: 0.34, high_vol: 0.33 },
  };

  const model = currentModel || defaultModel();
  const features = extractFeatures(candles);
  if (features.length < 5) return defaultResult;

  const lastObs = features[features.length - 1];
  const probs = getStateProbabilities(lastObs, model);

  let bestState: HMMState = "medium_vol";
  let bestProb = 0;
  for (const [state, prob] of Object.entries(probs) as [HMMState, number][]) {
    if (prob > bestProb) {
      bestProb = prob;
      bestState = state;
    }
  }

  const result: HMMResult = {
    state: bestState,
    confidence: bestProb,
    probabilities: probs,
  };
  lastClassification = result;
  return result;
}

export function getLastHMMClassification(): HMMResult | null {
  return lastClassification;
}

export function hmmToRegimeSignal(hmmResult: HMMResult): { confirmsRange: boolean; confirmsTrend: boolean; signal: string } {
  const { state, confidence } = hmmResult;
  const threshold = 0.5;

  if (confidence < threshold) {
    return { confirmsRange: false, confirmsTrend: false, signal: "uncertain" };
  }

  if (state === "low_vol") {
    return { confirmsRange: true, confirmsTrend: false, signal: "range_confirmed" };
  } else if (state === "high_vol") {
    return { confirmsRange: false, confirmsTrend: true, signal: "trend_confirmed" };
  } else {
    return { confirmsRange: false, confirmsTrend: false, signal: "transitional" };
  }
}

export function getHMMState(): { model: boolean; trained: boolean; trainedAt: string; nSamples: number; emissions: string[] } | null {
  if (!currentModel) return null;
  return {
    model: true,
    trained: currentModel.trained,
    trainedAt: currentModel.trainedAt,
    nSamples: currentModel.nSamples,
    emissions: currentModel.emissions.map((e, i) =>
      `${STATE_NAMES[i]}: atr_ratio=${e.mean[0].toFixed(2)} bb_pct=${e.mean[1].toFixed(0)} adx=${e.mean[2].toFixed(0)} ret_vol=${(e.mean[3]*100).toFixed(2)}%`
    ),
  };
}

export function isHMMTrained(): boolean {
  return currentModel !== null && currentModel.trained;
}
