// Dhan-Grade On-Device Black-Scholes Greeks & Implied Volatility (IV) Engine
// Ultra-fast sub-millisecond computations on mobile Hermes JavaScript engine

export interface OptionGreeks {
  /** Implied Volatility in percentage terms (e.g. 14.5 for 14.5%) */
  iv: number;
  /** Delta: Rate of change of option price per point move in underlying spot */
  delta: number;
  /** Gamma: Rate of change of Delta per point move in underlying spot */
  gamma: number;
  /** Theta: 1-day time decay in points (per calendar day) */
  theta: number;
  /** Vega: Change in option price per 1% change in implied volatility */
  vega: number;
}

const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);

/**
 * Standard Normal Probability Density Function: N'(x)
 */
export function normalPdf(x: number): number {
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x);
}

/**
 * Cumulative Standard Normal Distribution: N(x)
 * Accurate within 1.5e-7 using Abramowitz & Stegun approximation 26.2.17
 */
export function normalCdf(x: number): number {
  if (x >= 8) return 1;
  if (x <= -8) return 0;

  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly =
    k *
    (0.31938153 +
      k *
        (-0.356563782 +
          k * (1.781477937 + k * (-1.821255978 + k * 1.330274429))));

  const cdf = 1 - normalPdf(Math.abs(x)) * poly;
  return x >= 0 ? cdf : 1 - cdf;
}

/**
 * Black-Scholes theoretical option price
 * @param S Current spot price of underlying
 * @param K Option strike price
 * @param T Time to expiry in years
 * @param r Annualized risk-free interest rate (e.g. 0.07 for 7%)
 * @param sigma Annualized volatility in decimal (e.g. 0.15 for 15%)
 * @param isCall True for Call (CE), False for Put (PE)
 */
export function blackScholesPrice(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  isCall: boolean
): number {
  if (T <= 0) {
    return isCall ? Math.max(0, S - K) : Math.max(0, K - S);
  }
  if (sigma <= 0.0001) {
    const discountedK = K * Math.exp(-r * T);
    return isCall ? Math.max(0, S - discountedK) : Math.max(0, discountedK - S);
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  if (isCall) {
    return S * normalCdf(d1) - K * Math.exp(-r * T) * normalCdf(d2);
  } else {
    return K * Math.exp(-r * T) * normalCdf(-d2) - S * normalCdf(-d1);
  }
}

/**
 * Solves for Implied Volatility (IV) given market option price using Newton-Raphson iteration
 * Returns IV as a percentage (e.g. 15.2 for 15.2%)
 */
export function calculateImpliedVolatility(
  S: number,
  K: number,
  T: number,
  r: number,
  marketPrice: number,
  isCall: boolean
): number {
  if (S <= 0 || K <= 0 || marketPrice <= 0 || T <= 0) {
    return 0;
  }

  const intrinsic = isCall ? Math.max(0, S - K) : Math.max(0, K - S);
  if (marketPrice < intrinsic) {
    return 1.0; // Lower bound if slightly violated
  }

  // Initial estimate
  let sigma = 0.25; // 25% starting guess
  const maxIterations = 50;
  const tolerance = 1e-4;

  for (let i = 0; i < maxIterations; i++) {
    const price = blackScholesPrice(S, K, T, r, sigma, isCall);
    const diff = price - marketPrice;

    if (Math.abs(diff) < tolerance) {
      break;
    }

    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    const rawVega = S * sqrtT * normalPdf(d1); // ∂Price/∂sigma

    if (rawVega < 1e-6) {
      break;
    }

    const step = diff / rawVega;
    sigma -= step;

    // Constrain sigma to reasonable bounds [0.01, 5.0] (1% to 500%)
    if (sigma <= 0.01) {
      sigma = 0.01;
      break;
    }
    if (sigma >= 5.0) {
      sigma = 5.0;
      break;
    }
  }

  return Number((sigma * 100).toFixed(2));
}

/**
 * Calculates complete Option Greeks (Delta, Gamma, Theta, Vega) and IV
 */
export function calculateGreeks(
  spot: number,
  strike: number,
  timeToExpiryYears: number,
  riskFreeRate: number = 0.07,
  marketPrice: number,
  isCall: boolean
): OptionGreeks {
  if (spot <= 0 || strike <= 0 || timeToExpiryYears <= 0 || marketPrice <= 0) {
    return {
      iv: 0,
      delta: isCall ? (spot > strike ? 1 : 0) : spot < strike ? -1 : 0,
      gamma: 0,
      theta: 0,
      vega: 0,
    };
  }

  // 1. Solve for IV
  const ivPct = calculateImpliedVolatility(
    spot,
    strike,
    timeToExpiryYears,
    riskFreeRate,
    marketPrice,
    isCall
  );
  const sigma = Math.max(0.01, ivPct / 100);

  // 2. Compute closed-form Greeks
  const sqrtT = Math.sqrt(timeToExpiryYears);
  const d1 = (Math.log(spot / strike) + (riskFreeRate + 0.5 * sigma * sigma) * timeToExpiryYears) /
    (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const pdfD1 = normalPdf(d1);
  const cdfD1 = normalCdf(d1);
  const cdfD2 = normalCdf(d2);
  const expRT = Math.exp(-riskFreeRate * timeToExpiryYears);

  // Delta
  const delta = isCall ? cdfD1 : cdfD1 - 1;

  // Gamma (same for Call and Put)
  const gamma = pdfD1 / (spot * sigma * sqrtT);

  // Theta: 1-day time decay (divided by 365)
  const term1 = -(spot * pdfD1 * sigma) / (2 * sqrtT);
  let thetaAnnual = 0;
  if (isCall) {
    thetaAnnual = term1 - riskFreeRate * strike * expRT * cdfD2;
  } else {
    thetaAnnual = term1 + riskFreeRate * strike * expRT * normalCdf(-d2);
  }
  const theta = thetaAnnual / 365;

  // Vega: Change in price per 1% change in vol (divided by 100)
  const vega = (spot * sqrtT * pdfD1) / 100;

  return {
    iv: ivPct,
    delta: Number(delta.toFixed(4)),
    gamma: Number(gamma.toFixed(6)),
    theta: Number(theta.toFixed(2)),
    vega: Number(vega.toFixed(2)),
  };
}
