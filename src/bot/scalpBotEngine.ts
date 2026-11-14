// ============================================================================
// SCALPBOT ENGINE — 1:1 PORT OF maximpolak968-cyber/Treiding
// Modules ported:
//   • freqtrade/strategy/indicators.py (WaveTrend, Pivots, Clustering, Touch/Bounce/Break History, MTF 1D/4H/1H, Strongest DCA Level, Knife/Pump Guard)
//   • freqtrade/strategy/scalping_strategy.py (ScalpingStrategy Mode A Level Reversal + Mode B Trend Momentum + Exit Trend)
//   • freqtrade/core/btc_guard.py (BTCGuard 1H market dump protection)
//   • freqtrade/exchange/market_scanner.py (Market24hScanner + CandleVolatilityScanner)
//   • freqtrade/bot/freqtradebot.py (Smart Level & Martingale/Linear DCA, 6-point can_dca Risk Check, 4H Hedge Campaigns, Pullback TP Guard)
// ============================================================================

export interface OhlcvCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PivotPoint {
  index: number;
  price: number;
  type: 'high' | 'low';
}

export interface ClusteredLevelWithHistory {
  price: number;
  type: 'support' | 'resistance';
  touches: number;
  bounces: number;
  breaks: number;
  bounce_rate: number;
  last_touch_index: number;
  strength_score: number;
  source?: string;
  zone_low?: number;
  zone_high?: number;
  mirror_retests?: number;
  false_breakouts?: number;
  consolidation_bars?: number;
  reversals?: number;
  refined_from_1w?: boolean;
  timeframe_role?: 'GLOBAL_1W_1D' | 'LOCAL_1D' | 'STRUCT_4H' | 'STRUCT_1H';
}

export interface MarketStructureResult {
  current_price: number;
  range_low: number;
  range_high: number;
  range_position_pct: number;
  nearest_support: number;
  nearest_resistance: number;
  recommended_tp: number;
  recommended_sl: number;
  swing_highs: number[];
  swing_lows: number[];
  support_history: ClusteredLevelWithHistory | null;
  resistance_history: ClusteredLevelWithHistory | null;
  all_levels: ClusteredLevelWithHistory[];
}

export interface MultiTimeframeAnalysis {
  w1_trend?: 'BULLISH' | 'BEARISH' | 'MILD_BULLISH' | 'MILD_BEARISH' | 'NEUTRAL';
  d1_trend: 'BULLISH' | 'BEARISH' | 'MILD_BULLISH' | 'MILD_BEARISH' | 'NEUTRAL';
  h4_trend?: 'BULLISH' | 'BEARISH' | 'MILD_BULLISH' | 'MILD_BEARISH' | 'NEUTRAL';
  h1_trend?: 'BULLISH' | 'BEARISH' | 'MILD_BULLISH' | 'MILD_BEARISH' | 'NEUTRAL';
  market_trend?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  d1_high: number;
  d1_low: number;
  rsi_1w?: number;
  rsi_1d: number;
  rsi_4h: number;
  rsi_1h: number;
  key_4h_support: number;
  key_4h_resistance: number;
  pos_4h_pct: number;
  local_1h_support: number;
  local_1h_resistance: number;
  pos_1h_pct: number;
  dist_to_4h_res_pct: number;
  dist_to_4h_sup_pct: number;
  recommended_tp: number;
  recommended_tp_long: number;
  recommended_tp_short: number;
  recommended_sl: number;
  recommended_sl_long: number;
  recommended_sl_short: number;
  allow_long: boolean;
  allow_short: boolean;
  rejection_reason: string;
  rejection_reason_long: string;
  rejection_reason_short: string;
  level_map_summary: string;
  support_history: ClusteredLevelWithHistory | null;
  resistance_history: ClusteredLevelWithHistory | null;
  institutional_levels: ClusteredLevelWithHistory[];
  local_1d_levels?: ClusteredLevelWithHistory[];
  structural_4h_levels?: ClusteredLevelWithHistory[];
  mover_category?: string;
  change_24h_pct?: number;
  funding_rate_pct?: number;
}

export interface BotConfigData {
  max_open_trades: number;
  use_stoploss: boolean;
  use_takeprofit: boolean;
  stoploss: number;
  dca_enabled: boolean;
  max_dca_orders: number;
  max_position_multiplier: number;
  min_liquidation_distance_pct: number;
  max_margin_used_for_dca_pct: number;
  max_pair_margin_pct: number;
  dca_scale_mode: 'linear' | 'martingale';
  dca_pnl_step_pct: number;
  dca_min_level_distance_pct: number;
  hedge_range_min_pct: number;
  hedge_range_max_pct: number;
  hedge_min_range_width_pct: number;
  hedge_max_partial_loss_pct: number;
  stake_currency: string;
  trading_mode: 'futures' | 'spot';
  margin_mode: 'cross' | 'isolated';
  leverage: number;
  stake_amount: number;
  stake_percent: number;
  min_stake_amount: number;
  dry_run: boolean;
  dry_run_wallet: number;
  timeframe: string;
  strategy: string;
  volatility_scan_timeframe: string;
  volatility_scan_lookback: number;
  volatility_scan_min_candle_pct: number;
}

export const DEFAULT_SCALPBOT_CONFIG: BotConfigData = {
  max_open_trades: 30,
  use_stoploss: false,
  use_takeprofit: true,
  stoploss: -1.0,
  dca_enabled: true,
  max_dca_orders: 5,
  max_position_multiplier: 6.0,
  min_liquidation_distance_pct: 15.0,
  max_margin_used_for_dca_pct: 60.0,
  max_pair_margin_pct: 20.0,
  dca_scale_mode: 'linear',
  dca_pnl_step_pct: 25.0,
  dca_min_level_distance_pct: 20,
  hedge_range_min_pct: 35,
  hedge_range_max_pct: 65,
  hedge_min_range_width_pct: 3.0,
  hedge_max_partial_loss_pct: 50.0,
  stake_currency: 'USDT',
  trading_mode: 'futures',
  margin_mode: 'cross',
  leverage: 25,
  stake_amount: 25,
  stake_percent: 0.005,
  min_stake_amount: 5,
  dry_run: false,
  dry_run_wallet: 5000,
  timeframe: '1h',
  strategy: 'ScalpingStrategy',
  volatility_scan_timeframe: '1h',
  volatility_scan_lookback: 40,
  volatility_scan_min_candle_pct: 20,
};

// ============================================================================
// 1. TECHNICAL MATH & SERIES HELPERS
// ============================================================================

export function calcEmaSeries(values: number[], span: number): number[] {
  if (values.length === 0) return [];
  const alpha = 2 / (span + 1);
  const result = new Array<number>(values.length);
  result[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    result[i] = alpha * values[i] + (1 - alpha) * result[i - 1];
  }
  return result;
}

export function calcSmaSeries(values: number[], window: number): number[] {
  if (values.length === 0) return [];
  const result = new Array<number>(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) {
      sum -= values[i - window];
      result[i] = sum / window;
    } else {
      result[i] = sum / (i + 1);
    }
  }
  return result;
}

export function calcRsiSeries(closes: number[], period = 14): number[] {
  const n = closes.length;
  if (n === 0) return [];
  const rsi = new Array<number>(n).fill(50);
  if (n < period + 1) return rsi;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d;
    else if (d < 0) avgLoss += -d;
  }
  avgGain /= period;
  avgLoss /= period;

  const firstRs = avgGain / (avgLoss + 1e-9);
  rsi[period] = 100 - 100 / (1 + firstRs);

  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgGain / (avgLoss + 1e-9);
    rsi[i] = 100 - 100 / (1 + rs);
  }
  return rsi;
}

/**
 * WaveTrend Oscillator (LazyBear port from freqtrade/strategy/indicators.py)
 */
export function calculateWaveTrend(
  candles: OhlcvCandle[],
  n1 = 10,
  n2 = 21
): { wt1: number[]; wt2: number[] } {
  const n = candles.length;
  if (n === 0) return { wt1: [], wt2: [] };
  const ap = candles.map((c) => (c.high + c.low + c.close) / 3.0);
  const esa = calcEmaSeries(ap, n1);
  const absDiff = ap.map((v, i) => Math.abs(v - esa[i]));
  const d = calcEmaSeries(absDiff, n1);
  const ci = ap.map((v, i) => {
    const denom = 0.015 * d[i];
    return denom > 1e-12 ? (v - esa[i]) / denom : 0;
  });
  const wt1 = calcEmaSeries(ci, n2);
  const wt2 = calcSmaSeries(wt1, 4);
  return { wt1, wt2 };
}

/**
 * Average True Range (ATR) series for coin-specific volatility-adaptive S/R zone sizing
 */
export function calcAtrSeries(candles: OhlcvCandle[], period = 14): number[] {
  const n = candles.length;
  if (n === 0) return [];
  const tr = new Array<number>(n);
  tr[0] = Math.max(0, candles[0].high - candles[0].low);
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    );
  }
  const atr = new Array<number>(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (i < period) {
      sum += tr[i];
      atr[i] = sum / (i + 1);
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    }
  }
  return atr;
}

function getMedianAtrPct(candles: OhlcvCandle[], period = 14): number {
  if (!candles || candles.length === 0) return 2.5;
  const atr = calcAtrSeries(candles, Math.min(period, candles.length));
  const pcts: number[] = [];
  const start = Math.max(0, candles.length - 120);
  for (let i = start; i < candles.length; i++) {
    if (candles[i].close > 0 && atr[i] > 0) {
      pcts.push((atr[i] / candles[i].close) * 100);
    }
  }
  if (pcts.length === 0) return 2.5;
  pcts.sort((a, b) => a - b);
  return pcts[Math.floor(pcts.length / 2)];
}

export interface ConsolidationZone {
  startIndex: number;
  endIndex: number;
  bars: number;
  top: number;
  bottom: number;
  bodyTop: number;
  bodyBottom: number;
  mid: number;
  hasImpulseDeparture: boolean;
}

/**
 * Detects sideways consolidation boxes (боковики):
 * - 1W: 1-3+ weekly candles pause bases (with impulse) & multi-week accumulation boxes
 * - 1D: 3-5+ daily tight consolidations & sideways ranges
 * - 4H/1H: local accumulation/distribution ranges
 */
export function detectConsolidationZones(
  candles: OhlcvCandle[],
  minBars = 3,
  maxBars = 14,
  atrSeries?: number[]
): ConsolidationZone[] {
  const n = candles.length;
  if (n < Math.max(3, minBars + 1)) return [];
  const atr = atrSeries && atrSeries.length === n ? atrSeries : calcAtrSeries(candles, 14);
  const rawZones: ConsolidationZone[] = [];

  for (let start = 0; start <= n - minBars; start++) {
    const endLimit = Math.min(n - 1, start + maxBars - 1);
    let bestForStart: ConsolidationZone | null = null;

    let runningHigh = -Infinity;
    let runningLow = Infinity;
    let runningBodyHigh = -Infinity;
    let runningBodyLow = Infinity;
    let atrSum = 0;

    for (let end = start; end <= endLimit; end++) {
      const c = candles[end];
      if (c.high > runningHigh) runningHigh = c.high;
      if (c.low < runningLow) runningLow = c.low;
      const bHigh = Math.max(c.open, c.close);
      const bLow = Math.min(c.open, c.close);
      if (bHigh > runningBodyHigh) runningBodyHigh = bHigh;
      if (bLow < runningBodyLow) runningBodyLow = bLow;
      atrSum += atr[end] > 0 ? atr[end] : c.high - c.low;

      const bars = end - start + 1;
      if (bars < minBars) continue;

      const avgAtr = Math.max(1e-9, atrSum / bars);
      const boxWidth = runningHigh - runningLow;
      const bodySpan = runningBodyHigh - runningBodyLow;
      if (boxWidth <= 0 || runningLow <= 0) continue;

      const mid = (runningHigh + runningLow) / 2;
      const maxAllowedWidth = avgAtr * (1.05 + Math.sqrt(bars) * 0.85);
      if (boxWidth > maxAllowedWidth) break;

      const netDrift = Math.abs(candles[end].close - candles[start].open);
      const isSideways =
        netDrift <= boxWidth * 0.58 && bodySpan <= avgAtr * (0.9 + Math.sqrt(bars) * 0.6);
      if (!isSideways) continue;

      // Check impulse breakout / departure after the box
      let hasImpulseDeparture = false;
      const lookEnd = Math.min(n - 1, end + 3);
      for (let k = end + 1; k <= lookEnd; k++) {
        if (
          candles[k].close > runningHigh + avgAtr * 0.35 ||
          candles[k].close < runningLow - avgAtr * 0.35
        ) {
          hasImpulseDeparture = true;
          break;
        }
      }

      // 2-bar micro consolidations require strong impulse departure (like 1W pause base before vertical rally)
      if (bars <= 2 && !hasImpulseDeparture) continue;

      bestForStart = {
        startIndex: start,
        endIndex: end,
        bars,
        top: runningHigh,
        bottom: runningLow,
        bodyTop: runningBodyHigh,
        bodyBottom: runningBodyLow,
        mid,
        hasImpulseDeparture,
      };
    }

    if (bestForStart) {
      rawZones.push(bestForStart);
    }
  }

  if (rawZones.length === 0) return [];

  // Merge heavily overlapping boxes keeping wider/impulse-confirmed ones
  const sorted = [...rawZones].sort((a, b) => {
    const scoreA = a.bars + (a.hasImpulseDeparture ? 4 : 0);
    const scoreB = b.bars + (b.hasImpulseDeparture ? 4 : 0);
    return scoreB - scoreA;
  });

  const merged: ConsolidationZone[] = [];
  for (const z of sorted) {
    const overlaps = merged.some((m) => {
      const idxOverlap = Math.min(m.endIndex, z.endIndex) - Math.max(m.startIndex, z.startIndex);
      const priceDistPct = (Math.abs(m.mid - z.mid) / Math.max(1e-9, m.mid)) * 100;
      return idxOverlap >= 1 && priceDistPct <= 4.5;
    });
    if (!overlaps) {
      merged.push(z);
    }
  }

  return merged.sort((a, b) => a.startIndex - b.startIndex);
}

// ============================================================================
// 2. PIVOTS, CLUSTERING & HISTORICAL LEVEL INTERACTIONS (TOUCHES/BOUNCES/BREAKS)
// ============================================================================

export function findPivots(
  candles: OhlcvCandle[],
  leftBars = 3,
  rightBars = 3
): PivotPoint[] {
  const pivots: PivotPoint[] = [];
  const n = candles.length;
  if (n <= leftBars + rightBars) return pivots;

  for (let i = leftBars; i < n - rightBars; i++) {
    let maxHigh = -Infinity;
    let minLow = Infinity;
    for (let j = i - leftBars; j <= i + rightBars; j++) {
      if (candles[j].high > maxHigh) maxHigh = candles[j].high;
      if (candles[j].low < minLow) minLow = candles[j].low;
    }
    if (candles[i].high === maxHigh) {
      pivots.push({ index: i, price: candles[i].high, type: 'high' });
    }
    if (candles[i].low === minLow) {
      pivots.push({ index: i, price: candles[i].low, type: 'low' });
    }
  }
  return pivots;
}

export function clusterPivotsIntoLevels(
  pivots: PivotPoint[],
  tolerancePct = 0.5
): Array<{ price: number; type: 'high' | 'low'; indices: number[] }> {
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: Array<{ prices: number[]; type: 'high' | 'low'; indices: number[] }> = [];

  for (const pivot of sorted) {
    let found: { prices: number[]; type: 'high' | 'low'; indices: number[] } | null = null;
    for (const c of clusters) {
      if (c.type !== pivot.type) continue;
      const avgPrice = c.prices.reduce((acc, v) => acc + v, 0) / c.prices.length;
      if (avgPrice === 0) continue;
      if ((Math.abs(pivot.price - avgPrice) / avgPrice) * 100 <= tolerancePct) {
        found = c;
        break;
      }
    }
    if (found) {
      found.prices.push(pivot.price);
      found.indices.push(pivot.index);
    } else {
      clusters.push({
        prices: [pivot.price],
        type: pivot.type,
        indices: [pivot.index],
      });
    }
  }

  return clusters.map((c) => ({
    price: c.prices.reduce((acc, v) => acc + v, 0) / c.prices.length,
    type: c.type,
    indices: c.indices,
  }));
}

interface LevelCandidateSeed {
  price: number;
  type: 'high' | 'low';
  indices: number[];
  consolidationBars?: number;
}

function snapPriceToClusterDensity(
  candles: OhlcvCandle[],
  centerPrice: number,
  bandAbs: number,
  volMean: number[]
): number {
  if (!candles || candles.length === 0 || centerPrice <= 0 || bandAbs <= 0) {
    return centerPrice;
  }
  const lowBound = Math.max(centerPrice * 0.5, centerPrice - bandAbs * 1.15);
  const highBound = centerPrice + bandAbs * 1.15;
  const probes: number[] = [centerPrice];
  const steps = 24;
  for (let s = 0; s <= steps; s++) {
    const p = lowBound + ((highBound - lowBound) * s) / steps;
    if (p > 0) probes.push(p);
  }

  const touchBand = Math.max(centerPrice * 0.0025, bandAbs * 0.42);
  let bestPrice = centerPrice;
  let bestDensity = -Infinity;

  // Evaluate over closed/historical candles cleanly (exclude last forming candle beyond stable body if desired, keep deterministic)
  for (const probe of probes) {
    let density = 0;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const bHigh = Math.max(c.open, c.close);
      const bLow = Math.min(c.open, c.close);
      const volWeight = volMean[i] > 0 && c.volume >= volMean[i] * 1.15 ? 1.3 : 1.0;

      // Exact wick rejection or bounce near probe
      if (Math.abs(c.low - probe) <= touchBand || Math.abs(c.high - probe) <= touchBand) {
        density += 1.25 * volWeight;
      }
      // Body shelf (open/close aligning tightly along the zone)
      if (Math.abs(bLow - probe) <= touchBand * 0.85 || Math.abs(bHigh - probe) <= touchBand * 0.85) {
        density += 0.9 * volWeight;
      }
      // False-breakout recovery: wick swept beyond probe, body closed back across probe
      if (
        (c.low < probe - touchBand && bLow >= probe - touchBand * 0.5) ||
        (c.high > probe + touchBand && bHigh <= probe + touchBand * 0.5)
      ) {
        density += 1.1;
      }
    }
    // Slight preference to stay cohesive with original zone center when tied
    const centerPenalty = (Math.abs(probe - centerPrice) / Math.max(1e-9, bandAbs)) * 0.35;
    const net = density - centerPenalty;
    if (net > bestDensity) {
      bestDensity = net;
      bestPrice = probe;
    }
  }

  return bestPrice;
}

export function analyzeLevelInteractions(
  candles: OhlcvCandle[],
  rawLevels: LevelCandidateSeed[],
  touchTolerancePct = 0.5,
  minPivots = 1
): ClusteredLevelWithHistory[] {
  const n = candles.length;
  const levels: ClusteredLevelWithHistory[] = [];
  if (n === 0) return levels;

  const atr = calcAtrSeries(candles, Math.min(14, n));
  const volMean = calcSmaSeries(
    candles.map((c) => c.volume || 0),
    Math.min(20, n)
  );
  const currentPrice = candles[n - 1].close;

  for (const raw of rawLevels) {
    if (raw.indices.length < minPivots) continue;
    const seedPrice = raw.price;
    if (seedPrice <= 0) continue;

    const tolPct = Math.max(0.25, touchTolerancePct);
    const bandAbs = seedPrice * (tolPct / 100);
    // Snap seed onto exact max-touch & body-shelf density (ignores single deep false-breakout spike wicks)
    const price = snapPriceToClusterDensity(candles, seedPrice, bandAbs * 1.35, volMean);
    const tolAbs = price * (tolPct / 100);
    const zoneLow = price - tolAbs;
    const zoneHigh = price + tolAbs;

    let touches = 0;
    let bounces = 0;
    let breaks = 0;
    let supportBounces = 0;
    let resistanceRejections = 0;
    let mirrorRetests = 0;
    let falseBreakouts = 0;
    let reversals = 0;
    let strongVolumeEvents = 0;
    let lastTouchIndex = raw.indices[0] ?? 0;

    // Regime tracking for Mirror (Impulse Break + Inverse Retest) detection
    let activeRegime: 'ABOVE' | 'BELOW' | 'UNKNOWN' =
      candles[0].close > zoneHigh ? 'ABOVE' : candles[0].close < zoneLow ? 'BELOW' : 'UNKNOWN';
    let flippedFrom: 'ABOVE' | 'BELOW' | null = null;
    let lastEventIdx = -10;

    for (let i = 0; i < n; i++) {
      const c = candles[i];
      const localAtr = atr[i] > 0 ? atr[i] : tolAbs;
      const body = Math.abs(c.close - c.open);
      const range = Math.max(1e-9, c.high - c.low);
      const isStrongVol = volMean[i] > 0 && c.volume >= volMean[i] * 1.15;

      // Track decisive closes well outside the zone (impulse break)
      const decisiveAbove = c.close > price + Math.max(tolAbs * 0.9, localAtr * 0.45);
      const decisiveBelow = c.close < price - Math.max(tolAbs * 0.9, localAtr * 0.45);

      if (activeRegime === 'ABOVE' && decisiveBelow) {
        const isImpulsiveBreak = body >= localAtr * 0.55 || isStrongVol;
        if (isImpulsiveBreak && i - lastEventIdx >= 2) {
          breaks += 1;
          flippedFrom = 'ABOVE';
          lastEventIdx = i;
        }
        activeRegime = 'BELOW';
      } else if (activeRegime === 'BELOW' && decisiveAbove) {
        const isImpulsiveBreak = body >= localAtr * 0.55 || isStrongVol;
        if (isImpulsiveBreak && i - lastEventIdx >= 2) {
          breaks += 1;
          flippedFrom = 'BELOW';
          lastEventIdx = i;
        }
        activeRegime = 'ABOVE';
      } else if (activeRegime === 'UNKNOWN') {
        if (decisiveAbove) activeRegime = 'ABOVE';
        else if (decisiveBelow) activeRegime = 'BELOW';
      }

      const testsFromAbove =
        c.low <= zoneHigh &&
        c.low >= price - Math.max(tolAbs * 2.2, localAtr * 1.4) &&
        c.close >= price - tolAbs * 0.45 &&
        (activeRegime === 'ABOVE' || c.open >= price - tolAbs * 0.5 || c.close > c.open);

      const testsFromBelow =
        c.high >= zoneLow &&
        c.high <= price + Math.max(tolAbs * 2.2, localAtr * 1.4) &&
        c.close <= price + tolAbs * 0.45 &&
        (activeRegime === 'BELOW' || c.open <= price + tolAbs * 0.5 || c.close < c.open);

      if (!testsFromAbove && !testsFromBelow) continue;
      if (i - lastEventIdx < 2) continue;

      // Measure lookahead reaction (1..4 candles ahead)
      const lookahead = candles.slice(i + 1, Math.min(n, i + 5));
      const lookback = candles.slice(Math.max(0, i - 6), i);
      const maxPrevHigh = lookback.length > 0 ? Math.max(...lookback.map((b) => b.high)) : c.high;
      const minPrevLow = lookback.length > 0 ? Math.min(...lookback.map((b) => b.low)) : c.low;

      let confirmedBounce = false;
      let eventDetected = false;

      if (testsFromAbove) {
        const maxNextHigh =
          lookahead.length > 0 ? Math.max(...lookahead.map((b) => b.high)) : c.close;
        const minNextClose =
          lookahead.length > 0 ? Math.min(...lookahead.map((b) => b.close)) : c.close;
        const stayedSupported = minNextClose >= price - tolAbs * 1.1;
        const bouncedUp = maxNextHigh - price >= Math.max(tolAbs * 0.65, localAtr * 0.45);
        const falseSweep = c.low < zoneLow && c.close >= price - tolAbs * 0.35;

        if (falseSweep && stayedSupported) {
          falseBreakouts += 1;
        }
        if (bouncedUp && stayedSupported) {
          confirmedBounce = true;
          supportBounces += 1;
          if (flippedFrom === 'BELOW') {
            mirrorRetests += 1;
            flippedFrom = null;
          }
          if (maxPrevHigh - price >= localAtr * 1.8 && maxNextHigh - price >= localAtr * 1.6) {
            reversals += 1;
          }
        }
        eventDetected = true;
      } else if (testsFromBelow) {
        const minNextLow =
          lookahead.length > 0 ? Math.min(...lookahead.map((b) => b.low)) : c.close;
        const maxNextClose =
          lookahead.length > 0 ? Math.max(...lookahead.map((b) => b.close)) : c.close;
        const stayedResisted = maxNextClose <= price + tolAbs * 1.1;
        const rejectedDown = price - minNextLow >= Math.max(tolAbs * 0.65, localAtr * 0.45);
        const falseSweep = c.high > zoneHigh && c.close <= price + tolAbs * 0.35;

        if (falseSweep && stayedResisted) {
          falseBreakouts += 1;
        }
        if (rejectedDown && stayedResisted) {
          confirmedBounce = true;
          resistanceRejections += 1;
          if (flippedFrom === 'ABOVE') {
            mirrorRetests += 1;
            flippedFrom = null;
          }
          if (price - minPrevLow >= localAtr * 1.8 && price - minNextLow >= localAtr * 1.6) {
            reversals += 1;
          }
        }
        eventDetected = true;
      }

      if (eventDetected) {
        touches += 1;
        lastTouchIndex = i;
        lastEventIdx = i;
        if (confirmedBounce) {
          bounces += 1;
          if (isStrongVol || body / range >= 0.52) {
            strongVolumeEvents += 1;
          }
        }
      }
    }

    const consolidationBars = raw.consolidationBars || 0;
    if (touches === 0 && consolidationBars < 3) continue;

    // Mirror S/R flip verified whenever level held BOTH as support & resistance or had explicit inverse retest
    const isTwoSidedMirror =
      (supportBounces >= 1 && resistanceRejections >= 1) || mirrorRetests >= 1;
    const effectiveMirrorCount = Math.max(mirrorRetests, isTwoSidedMirror ? 1 : 0);

    const effTouches = Math.max(1, touches);
    const bounceRate = bounces / effTouches;
    const recencyWeight = 1 - (n - 1 - lastTouchIndex) / Math.max(1, n);
    const unconfirmedBreaks = Math.max(0, breaks - effectiveMirrorCount * 2);

    // Article-aligned scoring: consolidation + bounces/volume + reversals + mirror S/R flips + false breakout defense
    const strengthScore =
      Math.min(3.6, consolidationBars * 0.42) +
      Math.min(4.5, bounces * 0.55) +
      Math.min(2.0, strongVolumeEvents * 0.35) +
      effectiveMirrorCount * 1.45 +
      Math.min(2.4, reversals * 0.75) +
      Math.min(2.0, falseBreakouts * 0.65) +
      bounceRate * 1.2 +
      recencyWeight * 0.9 -
      unconfirmedBreaks * 0.25;

    const currentRole: 'support' | 'resistance' =
      currentPrice > 0
        ? price <= currentPrice
          ? 'support'
          : 'resistance'
        : raw.type === 'high'
        ? 'resistance'
        : 'support';

    levels.push({
      price: Number(price.toPrecision(7)),
      type: currentRole,
      touches: Math.max(touches, consolidationBars >= 3 ? 2 : touches),
      bounces: Math.max(bounces, consolidationBars >= 3 ? 1 : bounces),
      breaks,
      bounce_rate: Number(bounceRate.toFixed(3)),
      last_touch_index: lastTouchIndex,
      strength_score: Number(Math.max(0.5, strengthScore).toFixed(3)),
      zone_low: Number(zoneLow.toPrecision(7)),
      zone_high: Number(zoneHigh.toPrecision(7)),
      mirror_retests: effectiveMirrorCount,
      false_breakouts: falseBreakouts,
      consolidation_bars: consolidationBars,
      reversals,
    });
  }

  // Deduplicate levels within 1.5 * touchTolerancePct, keeping highest strength_score
  const sorted = levels.sort((a, b) => b.strength_score - a.strength_score);
  const deduped: ClusteredLevelWithHistory[] = [];
  const mergeDistPct = Math.max(0.85, touchTolerancePct * 1.45);
  for (const lvl of sorted) {
    const dup = deduped.some(
      (kept) =>
        (Math.abs(kept.price - lvl.price) / Math.max(1e-9, kept.price)) * 100 <= mergeDistPct
    );
    if (!dup) {
      deduped.push(lvl);
    }
  }
  return deduped;
}

export function buildLevelsWithHistory(
  candles: OhlcvCandle[],
  leftBars = 3,
  rightBars = 3,
  tolerancePct?: number,
  minPivots = 1,
  options?: { minConsolBars?: number; maxConsolBars?: number }
): ClusteredLevelWithHistory[] {
  if (!candles || candles.length < 5) return [];

  const medianAtrPct = getMedianAtrPct(candles, 14);
  const adaptiveTolPct =
    tolerancePct !== undefined && tolerancePct > 0
      ? tolerancePct
      : Math.max(0.45, Math.min(4.2, medianAtrPct * 0.34));

  const pivots = findPivots(candles, leftBars, rightBars);
  const clusteredPivots = clusterPivotsIntoLevels(pivots, adaptiveTolPct * 1.2);
  const seeds: LevelCandidateSeed[] = clusteredPivots.map((c) => ({ ...c, consolidationBars: 0 }));

  // Add consolidation box tops/bottoms & tight pause shelves (article core!)
  const minCBars = options?.minConsolBars ?? (leftBars <= 2 ? 2 : 3);
  const maxCBars = options?.maxConsolBars ?? 14;
  const atr = calcAtrSeries(candles, Math.min(14, candles.length));
  const zones = detectConsolidationZones(candles, minCBars, maxCBars, atr);

  for (const z of zones) {
    const pushSeed = (p: number, t: 'high' | 'low') => {
      if (p <= 0) return;
      const existing = seeds.find(
        (s) => (Math.abs(s.price - p) / Math.max(1e-9, s.price)) * 100 <= adaptiveTolPct * 1.25
      );
      if (existing) {
        existing.consolidationBars = Math.max(existing.consolidationBars || 0, z.bars);
        if (!existing.indices.includes(z.endIndex)) existing.indices.push(z.endIndex);
      } else {
        seeds.push({
          price: p,
          type: t,
          indices: [z.startIndex, z.endIndex],
          consolidationBars: z.bars,
        });
      }
    };
    pushSeed(z.top, 'high');
    pushSeed(z.bottom, 'low');
    // Also add body bottom/top in case box had a deep outlier wick sweep (like DOT 3.55 vs 4.04)
    if ((Math.abs(z.bodyBottom - z.bottom) / Math.max(1e-9, z.bottom)) * 100 > adaptiveTolPct * 0.8) {
      pushSeed(z.bodyBottom, 'low');
    }
    if ((Math.abs(z.top - z.bodyTop) / Math.max(1e-9, z.top)) * 100 > adaptiveTolPct * 0.8) {
      pushSeed(z.bodyTop, 'high');
    }
  }

  return analyzeLevelInteractions(candles, seeds, adaptiveTolPct, minPivots);
}

/**
 * Step 2 from the DOT methodology:
 * Takes macro 1W zones and refines their exact price against 1D candle touches, bounces,
 * false-breakout sweeps, and mirror retests. Also extracts intermediate 1D local levels.
 */
export function refineHigherTimeframeLevels(
  macro1wLevels: ClusteredLevelWithHistory[],
  candles1d: OhlcvCandle[],
  currentPrice: number
): {
  refinedGlobal: ClusteredLevelWithHistory[];
  local1d: ClusteredLevelWithHistory[];
} {
  if (!candles1d || candles1d.length < 15) {
    return {
      refinedGlobal: macro1wLevels.map((l) => ({
        ...l,
        source: '1W',
        timeframe_role: 'GLOBAL_1W_1D',
      })),
      local1d: [],
    };
  }

  const atr1dPct = getMedianAtrPct(candles1d, 14);
  const dailyTolPct = Math.max(0.85, Math.min(2.6, atr1dPct * 0.35));
  const dailyVolMean = calcSmaSeries(
    candles1d.map((c) => c.volume || 0),
    Math.min(20, candles1d.length)
  );

  // Build rich 1D level catalog (consolidations 3-16 days + 1D swings + mirror S/R flips)
  const dailyAll = buildLevelsWithHistory(candles1d, 3, 3, dailyTolPct, 1, {
    minConsolBars: 3,
    maxConsolBars: 16,
  });

  const refinedGlobal: ClusteredLevelWithHistory[] = [];
  const searchRadiusPct = Math.max(3.5, Math.min(7.5, dailyTolPct * 3.0));

  for (const macro of macro1wLevels) {
    const bandAbs = macro.price * (searchRadiusPct / 100);
    // 1. Snap macro 1W price onto the exact 1D touch/retest/body density center
    const snapped1d = snapPriceToClusterDensity(candles1d, macro.price, bandAbs, dailyVolMean);
    const evaluated = analyzeLevelInteractions(
      candles1d,
      [
        {
          price: snapped1d,
          type: macro.type === 'resistance' ? 'high' : 'low',
          indices: [Math.max(0, candles1d.length - 1)],
          consolidationBars: macro.consolidation_bars || 0,
        },
      ],
      dailyTolPct,
      1
    );

    const bestDaily = evaluated[0];
    const finalPrice = bestDaily ? bestDaily.price : Number(snapped1d.toPrecision(7));
    const role: 'support' | 'resistance' =
      currentPrice > 0 ? (finalPrice <= currentPrice ? 'support' : 'resistance') : macro.type;

    const combinedScore = bestDaily
      ? Number((macro.strength_score * 0.75 + bestDaily.strength_score * 0.65).toFixed(3))
      : Number((macro.strength_score * 1.15).toFixed(3));

    const dup = refinedGlobal.some(
      (g) => (Math.abs(g.price - finalPrice) / Math.max(1e-9, g.price)) * 100 <= dailyTolPct * 1.6
    );
    if (!dup) {
      refinedGlobal.push({
        price: finalPrice,
        type: role,
        touches: Math.max(macro.touches, bestDaily?.touches || 0),
        bounces: Math.max(macro.bounces, bestDaily?.bounces || 0),
        breaks: bestDaily?.breaks ?? macro.breaks,
        bounce_rate: bestDaily?.bounce_rate ?? macro.bounce_rate,
        last_touch_index: bestDaily?.last_touch_index ?? macro.last_touch_index,
        strength_score: combinedScore,
        source: '1W->1D',
        zone_low: bestDaily?.zone_low ?? macro.zone_low,
        zone_high: bestDaily?.zone_high ?? macro.zone_high,
        mirror_retests: Math.max(macro.mirror_retests || 0, bestDaily?.mirror_retests || 0),
        false_breakouts: Math.max(macro.false_breakouts || 0, bestDaily?.false_breakouts || 0),
        consolidation_bars: Math.max(macro.consolidation_bars || 0, bestDaily?.consolidation_bars || 0),
        reversals: Math.max(macro.reversals || 0, bestDaily?.reversals || 0),
        refined_from_1w: true,
        timeframe_role: 'GLOBAL_1W_1D',
      });
    }
  }

  // Fallback if 1W had very few bars (e.g. recently listed coin): promote strongest 1D levels to GLOBAL
  if (refinedGlobal.length < 2) {
    for (const dLvl of dailyAll) {
      const exists = refinedGlobal.some(
        (g) => (Math.abs(g.price - dLvl.price) / Math.max(1e-9, g.price)) * 100 <= dailyTolPct * 1.8
      );
      if (!exists) {
        refinedGlobal.push({
          ...dLvl,
          type: currentPrice > 0 ? (dLvl.price <= currentPrice ? 'support' : 'resistance') : dLvl.type,
          source: '1D_GLOBAL',
          refined_from_1w: false,
          timeframe_role: 'GLOBAL_1W_1D',
        });
      }
      if (refinedGlobal.length >= 6) break;
    }
  }

  // Extract intermediate 1D local levels (3-5+ day consolidations, 1D mirror flips, local highs/lows)
  const local1d: ClusteredLevelWithHistory[] = [];
  for (const dLvl of dailyAll) {
    const nearGlobal = refinedGlobal.some(
      (g) => (Math.abs(g.price - dLvl.price) / Math.max(1e-9, g.price)) * 100 <= dailyTolPct * 1.9
    );
    if (!nearGlobal && dLvl.strength_score >= 2.2) {
      local1d.push({
        ...dLvl,
        type: currentPrice > 0 ? (dLvl.price <= currentPrice ? 'support' : 'resistance') : dLvl.type,
        source: '1D_LOCAL',
        timeframe_role: 'LOCAL_1D',
      });
    }
  }

  return {
    refinedGlobal: refinedGlobal.sort((a, b) => b.strength_score - a.strength_score),
    local1d: local1d.sort((a, b) => b.strength_score - a.strength_score),
  };
}

// ============================================================================
// 3. MARKET STRUCTURE & MULTI-TIMEFRAME (1W -> 1D -> 4H/1H) LEVEL ANALYSIS
// ============================================================================

export function detectMarketStructure(
  candles: OhlcvCandle[],
  lookback = 50,
  globalMode = false
): MarketStructureResult {
  if (!candles || candles.length < 15) {
    const cp = candles && candles.length > 0 ? candles[candles.length - 1].close : 100;
    return {
      current_price: cp,
      range_low: cp * 0.96,
      range_high: cp * 1.04,
      range_position_pct: 50,
      nearest_support: cp * 0.98,
      nearest_resistance: cp * 1.02,
      recommended_tp: cp * 1.02,
      recommended_sl: cp * 0.98,
      swing_highs: [],
      swing_lows: [],
      support_history: null,
      resistance_history: null,
      all_levels: [],
    };
  }

  const isGlobal = globalMode || lookback >= 80;
  const subset = candles.slice(-Math.max(15, lookback));
  const currentPrice = subset[subset.length - 1].close;

  let globalHigh = -Infinity;
  let globalLow = Infinity;
  for (const c of subset) {
    if (c.high > globalHigh) globalHigh = c.high;
    if (c.low < globalLow) globalLow = c.low;
  }

  const activeWindow = isGlobal ? subset : subset.slice(-Math.min(subset.length, 48));
  let rangeHigh = -Infinity;
  let rangeLow = Infinity;
  for (const c of activeWindow) {
    if (c.high > rangeHigh) rangeHigh = c.high;
    if (c.low < rangeLow) rangeLow = c.low;
  }
  const rangeSpan = rangeHigh - rangeLow > 0 ? rangeHigh - rangeLow : currentPrice * 0.01;
  let rangePosPct = ((currentPrice - rangeLow) / rangeSpan) * 100;
  rangePosPct = Math.max(0, Math.min(100, rangePosPct));

  const swingHighs: number[] = [];
  const swingLows: number[] = [];
  const windowSize = 3;
  for (let i = windowSize; i < subset.length - windowSize; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - windowSize; j <= i + windowSize; j++) {
      if (subset[j].high > subset[i].high) isHigh = false;
      if (subset[j].low < subset[i].low) isLow = false;
    }
    if (isHigh) swingHighs.push(subset[i].high);
    if (isLow) swingLows.push(subset[i].low);
  }

  const minDistPct = 0.8;
  const maxActiveLevelDistPct = isGlobal ? 95.0 : 15.0;
  const medianAtrPct = getMedianAtrPct(subset, 14);
  const tolPct = isGlobal
    ? Math.max(0.85, Math.min(3.8, medianAtrPct * 0.34))
    : Math.max(0.45, Math.min(1.6, medianAtrPct * 0.42));

  const levelsWithHistory = buildLevelsWithHistory(
    subset,
    isGlobal && subset.length < 250 ? 2 : 3,
    isGlobal && subset.length < 250 ? 2 : 3,
    tolPct,
    isGlobal ? 1 : 2,
    { minConsolBars: isGlobal ? 2 : 3, maxConsolBars: isGlobal ? 16 : 12 }
  );

  const supportsHistAll = levelsWithHistory.filter(
    (l) => l.type === 'support' && ((currentPrice - l.price) / currentPrice) * 100 >= minDistPct
  );
  const supportsHistNear = supportsHistAll.filter(
    (l) => ((currentPrice - l.price) / currentPrice) * 100 <= maxActiveLevelDistPct
  );
  const supportsPool = supportsHistNear.length > 0 ? supportsHistNear : supportsHistAll;

  const resistancesHistAll = levelsWithHistory.filter(
    (l) => l.type === 'resistance' && ((l.price - currentPrice) / currentPrice) * 100 >= minDistPct
  );
  const resistancesHistNear = resistancesHistAll.filter(
    (l) => ((l.price - currentPrice) / currentPrice) * 100 <= maxActiveLevelDistPct
  );
  const resistancesPool =
    resistancesHistNear.length > 0 ? resistancesHistNear : resistancesHistAll;

  const pickBestGlobalOrLocal = (pool: ClusteredLevelWithHistory[]) => {
    if (pool.length === 0) return null;
    if (!isGlobal) {
      return pool.reduce((best, cur) => {
        const distBest = (Math.abs(currentPrice - best.price) / Math.max(1e-9, currentPrice)) * 100;
        const distCur = (Math.abs(currentPrice - cur.price) / Math.max(1e-9, currentPrice)) * 100;
        const scoreBest = best.strength_score / (1 + distBest * 0.12);
        const scoreCur = cur.strength_score / (1 + distCur * 0.12);
        return scoreCur > scoreBest ? cur : best;
      });
    }
    // Global ranking: favor proven bounces/consolidations/mirror flips, lightly balance extreme unreachable outliers
    const multiTouch = pool.filter((l) => l.bounces >= 2 || (l.consolidation_bars || 0) >= 3);
    const targetPool = multiTouch.length > 0 ? multiTouch : pool;
    return targetPool.reduce((best, cur) => {
      const distBest = (Math.abs(currentPrice - best.price) / Math.max(1e-9, currentPrice)) * 100;
      const distCur = (Math.abs(currentPrice - cur.price) / Math.max(1e-9, currentPrice)) * 100;
      const rankBest = best.strength_score / (1 + Math.max(0, distBest - 18) * 0.012);
      const rankCur = cur.strength_score / (1 + Math.max(0, distCur - 18) * 0.012);
      return rankCur > rankBest ? cur : best;
    });
  };

  const supportHistory = pickBestGlobalOrLocal(supportsPool);
  const resistanceHistory = pickBestGlobalOrLocal(resistancesPool);

  let nearestSupport = rangeLow;
  if (supportHistory) {
    nearestSupport = supportHistory.price;
  } else if (isGlobal && globalLow > 0 && ((currentPrice - globalLow) / currentPrice) * 100 >= minDistPct) {
    const below = swingLows.filter((s) => ((currentPrice - s) / currentPrice) * 100 >= minDistPct);
    nearestSupport = below.length > 0 ? Math.max(...below) : globalLow;
  } else {
    const supportsBelow = swingLows.filter((s) => {
      const d = ((currentPrice - s) / currentPrice) * 100;
      return d >= minDistPct && d <= maxActiveLevelDistPct;
    });
    if (supportsBelow.length > 0) nearestSupport = Math.max(...supportsBelow);
    else if (rangeLow < currentPrice * 0.992) nearestSupport = rangeLow;
    else nearestSupport = currentPrice * 0.975;
  }

  let nearestResistance = rangeHigh;
  if (resistanceHistory) {
    nearestResistance = resistanceHistory.price;
  } else if (isGlobal && globalHigh > 0 && ((globalHigh - currentPrice) / currentPrice) * 100 >= minDistPct) {
    const above = swingHighs.filter((r) => ((r - currentPrice) / currentPrice) * 100 >= minDistPct);
    nearestResistance = above.length > 0 ? Math.min(...above) : globalHigh;
  } else {
    const resistancesAbove = swingHighs.filter((r) => {
      const d = ((r - currentPrice) / currentPrice) * 100;
      return d >= minDistPct && d <= maxActiveLevelDistPct;
    });
    if (resistancesAbove.length > 0) nearestResistance = Math.min(...resistancesAbove);
    else if (rangeHigh > currentPrice * 1.008) nearestResistance = rangeHigh;
    else nearestResistance = currentPrice * 1.025;
  }

  const rawTp = nearestResistance * 0.998;
  const recommendedTp = rawTp > currentPrice ? rawTp : currentPrice * 1.02;

  const rawSl = nearestSupport * 0.997;
  const recommendedSl = rawSl < currentPrice ? rawSl : currentPrice * 0.98;

  return {
    current_price: currentPrice,
    range_low: rangeLow,
    range_high: rangeHigh,
    range_position_pct: Number(rangePosPct.toFixed(1)),
    nearest_support: Number(nearestSupport.toPrecision(7)),
    nearest_resistance: Number(nearestResistance.toPrecision(7)),
    recommended_tp: Number(recommendedTp.toPrecision(7)),
    recommended_sl: Number(recommendedSl.toPrecision(7)),
    swing_highs: swingHighs,
    swing_lows: swingLows,
    support_history: supportHistory,
    resistance_history: resistanceHistory,
    all_levels: levelsWithHistory,
  };
}

function classifyTimeframeTrend(
  candles: OhlcvCandle[]
): 'BULLISH' | 'BEARISH' | 'MILD_BULLISH' | 'MILD_BEARISH' | 'NEUTRAL' {
  if (!candles || candles.length < 15) return 'NEUTRAL';
  const closes = candles.map((c) => c.close);
  const emaFastSeries = calcEmaSeries(closes, Math.min(20, closes.length));
  const emaSlowSeries = calcEmaSeries(closes, Math.min(50, closes.length));
  const lastClose = closes[closes.length - 1];
  const ema20 = emaFastSeries[emaFastSeries.length - 1];
  const ema50 = emaSlowSeries[emaSlowSeries.length - 1];

  if (lastClose > ema20 && ema20 > ema50) return 'BULLISH';
  if (lastClose < ema20 && ema20 < ema50) return 'BEARISH';
  if (lastClose > ema20) return 'MILD_BULLISH';
  return 'MILD_BEARISH';
}

export function analyzeMultiTimeframe(
  pair: string,
  candles1h: OhlcvCandle[],
  candles4h: OhlcvCandle[],
  candles1d: OhlcvCandle[],
  customLevels?: { support?: number; resistance?: number },
  candles1w?: OhlcvCandle[]
): MultiTimeframeAnalysis {
  const currentPrice =
    candles1h.length > 0
      ? candles1h[candles1h.length - 1].close
      : candles4h.length > 0
      ? candles4h[candles4h.length - 1].close
      : candles1d.length > 0
      ? candles1d[candles1d.length - 1].close
      : 100;

  let w1Trend: MultiTimeframeAnalysis['w1_trend'] = 'NEUTRAL';
  if (candles1w && candles1w.length >= 15) {
    w1Trend = classifyTimeframeTrend(candles1w);
  }

  let d1Trend: MultiTimeframeAnalysis['d1_trend'] = 'NEUTRAL';
  let d1High = currentPrice * 1.1;
  let d1Low = currentPrice * 0.9;

  if (candles1d.length >= 15) {
    d1Trend = classifyTimeframeTrend(candles1d);
    d1High = Math.max(...candles1d.map((c) => c.high));
    d1Low = Math.min(...candles1d.map((c) => c.low));
  }

  const h4Trend = classifyTimeframeTrend(candles4h);
  const h1Trend = classifyTimeframeTrend(candles1h);

  // Compute composite market trend from 1D, 4H, and 1H (plus 1W context)
  let trendScore = 0;
  if (w1Trend === 'BULLISH') trendScore += 1;
  else if (w1Trend === 'MILD_BULLISH') trendScore += 0.5;
  else if (w1Trend === 'BEARISH') trendScore -= 1;
  else if (w1Trend === 'MILD_BEARISH') trendScore -= 0.5;

  if (d1Trend === 'BULLISH') trendScore += 2;
  else if (d1Trend === 'MILD_BULLISH') trendScore += 1;
  else if (d1Trend === 'BEARISH') trendScore -= 2;
  else if (d1Trend === 'MILD_BEARISH') trendScore -= 1;

  if (h4Trend === 'BULLISH') trendScore += 2;
  else if (h4Trend === 'MILD_BULLISH') trendScore += 1;
  else if (h4Trend === 'BEARISH') trendScore -= 2;
  else if (h4Trend === 'MILD_BEARISH') trendScore -= 1;

  if (h1Trend === 'BULLISH') trendScore += 1.5;
  else if (h1Trend === 'MILD_BULLISH') trendScore += 0.5;
  else if (h1Trend === 'BEARISH') trendScore -= 1.5;
  else if (h1Trend === 'MILD_BEARISH') trendScore -= 0.5;

  const isBullish4h = h4Trend === 'BULLISH' || h4Trend === 'MILD_BULLISH';
  const isBearish4h = h4Trend === 'BEARISH' || h4Trend === 'MILD_BEARISH';
  const isBullish1h = h1Trend === 'BULLISH' || h1Trend === 'MILD_BULLISH';
  const isBearish1h = h1Trend === 'BEARISH' || h1Trend === 'MILD_BEARISH';

  const marketTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
    isBearish4h && isBearish1h
      ? 'BEARISH'
      : isBullish4h && isBullish1h
      ? 'BULLISH'
      : trendScore >= 1.5
      ? 'BULLISH'
      : trendScore <= -1.5
      ? 'BEARISH'
      : 'NEUTRAL';

  // Calculate Wilder's RSI (14) on 1W, 1D, 4H, and 1H
  const rsi1wSeries =
    candles1w && candles1w.length >= 15 ? calcRsiSeries(candles1w.map((c) => c.close), 14) : [];
  const rsi1dSeries =
    candles1d.length >= 15 ? calcRsiSeries(candles1d.map((c) => c.close), 14) : [];
  const rsi4hSeries =
    candles4h.length >= 15 ? calcRsiSeries(candles4h.map((c) => c.close), 14) : [];
  const rsi1hSeries =
    candles1h.length >= 15 ? calcRsiSeries(candles1h.map((c) => c.close), 14) : [];

  const rsi1w = Number(
    (rsi1wSeries.length > 0 ? rsi1wSeries[rsi1wSeries.length - 1] : 50).toFixed(2)
  );
  const rsi1d = Number(
    (rsi1dSeries.length > 0 ? rsi1dSeries[rsi1dSeries.length - 1] : 50).toFixed(2)
  );
  const rsi4h = Number(
    (rsi4hSeries.length > 0 ? rsi4hSeries[rsi4hSeries.length - 1] : 50).toFixed(2)
  );
  const rsi1h = Number(
    (rsi1hSeries.length > 0 ? rsi1hSeries[rsi1hSeries.length - 1] : 50).toFixed(2)
  );

  // STEP 1 (1W MACRO): Consolidations (1-3+ bars & accumulation ranges), bounces, reversals, mirror flips
  const structure1w =
    candles1w && candles1w.length >= 12
      ? detectMarketStructure(candles1w, candles1w.length, true)
      : null;

  // STEP 2 (1D REFINEMENT + 1D LOCAL): Refine 1W macro levels onto 1D dense reactions + find 1D local levels
  const macro1wList = structure1w?.all_levels || [];
  const { refinedGlobal, local1d } = refineHigherTimeframeLevels(
    macro1wList,
    candles1d,
    currentPrice
  );

  // STEP 3 (4H & 1H STRUCTURAL POINTS — not global levels!)
  const structure4h =
    candles4h.length >= 15
      ? detectMarketStructure(candles4h, Math.min(240, candles4h.length), false)
      : detectMarketStructure(candles1h, candles1h.length, false);
  const structure1h = detectMarketStructure(candles1h, Math.min(72, candles1h.length), false);

  const structural4hLevels: ClusteredLevelWithHistory[] = structure4h.all_levels
    .slice(0, 6)
    .map((l) => ({
      ...l,
      source: '4H_STRUCT',
      timeframe_role: 'STRUCT_4H' as const,
    }));

  const hasCustomSup = Boolean(customLevels?.support && customLevels.support > 0);
  const hasCustomRes = Boolean(customLevels?.resistance && customLevels.resistance > 0);

  // Primary Global Support & Resistance from 1W->1D refined levels (or high-conviction 1D shelf if distant outlier exists)
  const minGlobalRoomPct = 0.8;
  const globalSupports = [
    ...refinedGlobal,
    ...local1d.filter((l) => l.strength_score >= 10),
  ].filter((l) => ((currentPrice - l.price) / currentPrice) * 100 >= minGlobalRoomPct);
  const globalResistances = [
    ...refinedGlobal,
    ...local1d.filter((l) => l.strength_score >= 10),
  ].filter((l) => ((l.price - currentPrice) / currentPrice) * 100 >= minGlobalRoomPct);

  const pickNearestStrongGlobal = (cands: ClusteredLevelWithHistory[]) => {
    if (cands.length === 0) return null;
    return cands.reduce((best, cur) => {
      const distBest = (Math.abs(currentPrice - best.price) / Math.max(1e-9, currentPrice)) * 100;
      const distCur = (Math.abs(currentPrice - cur.price) / Math.max(1e-9, currentPrice)) * 100;
      const multBest = best.timeframe_role === 'GLOBAL_1W_1D' ? 1.15 : 0.9;
      const multCur = cur.timeframe_role === 'GLOBAL_1W_1D' ? 1.15 : 0.9;
      const scoreBest = (best.strength_score * multBest) / (1 + distBest * 0.025);
      const scoreCur = (cur.strength_score * multCur) / (1 + distCur * 0.025);
      return scoreCur > scoreBest ? cur : best;
    });
  };

  const primaryGlobalSup = pickNearestStrongGlobal(globalSupports);
  const primaryGlobalRes = pickNearestStrongGlobal(globalResistances);

  const sup1dFallback = local1d.find(
    (l) => ((currentPrice - l.price) / currentPrice) * 100 >= minGlobalRoomPct
  );
  const res1dFallback = local1d.find(
    (l) => ((l.price - currentPrice) / currentPrice) * 100 >= minGlobalRoomPct
  );

  const globalSupportCandidate =
    primaryGlobalSup?.price ||
    sup1dFallback?.price ||
    (structure4h.nearest_support > 0 && structure4h.nearest_support < currentPrice * 0.992
      ? structure4h.nearest_support
      : currentPrice * 0.965);

  const globalResistanceCandidate =
    primaryGlobalRes?.price ||
    res1dFallback?.price ||
    (structure4h.nearest_resistance > currentPrice * 1.008
      ? structure4h.nearest_resistance
      : currentPrice * 1.035);

  const key4hSupport = hasCustomSup ? Number(customLevels!.support) : globalSupportCandidate;
  const key4hResistance = hasCustomRes
    ? Number(customLevels!.resistance)
    : globalResistanceCandidate;

  const pos4hPct =
    key4hResistance > key4hSupport
      ? Math.max(
          0,
          Math.min(100, ((currentPrice - key4hSupport) / (key4hResistance - key4hSupport)) * 100)
        )
      : (structure4h.range_position_pct ?? 50.0);

  const local1hSupport = structure1h.nearest_support || currentPrice * 0.985;
  const local1hResistance = structure1h.nearest_resistance || currentPrice * 1.015;
  const pos1hPct = structure1h.range_position_pct ?? 50.0;

  const distTo4hResPct =
    currentPrice > 0 ? ((key4hResistance - currentPrice) / currentPrice) * 100.0 : 0;
  const distTo4hSupPct =
    currentPrice > 0 ? ((currentPrice - key4hSupport) / currentPrice) * 100.0 : 0;

  let allowLong = true;
  let rejectionReasonLong = '';

  const maxAllowedRsiForLong = 80.0;
  if (
    rsi1d > maxAllowedRsiForLong ||
    rsi4h > maxAllowedRsiForLong ||
    rsi1h > maxAllowedRsiForLong
  ) {
    allowLong = false;
    rejectionReasonLong = `MTF RSI фильтр блокирует LONG: 1D RSI=${rsi1d}, 4H RSI=${rsi4h}, 1H RSI=${rsi1h} (макс ${maxAllowedRsiForLong})`;
  } else if ((marketTrend !== 'BULLISH' || hasCustomRes) && distTo4hResPct < 0.85) {
    allowLong = false;
    rejectionReasonLong = `Close to 1W/1D Resistance (${key4hResistance}, only +${distTo4hResPct.toFixed(2)}% room)`;
  } else if (marketTrend !== 'BULLISH' && pos4hPct > 82.0) {
    allowLong = false;
    rejectionReasonLong = `Top of 1W/1D range (${pos4hPct.toFixed(1)}%) — overbought zone`;
  } else if (isPumpExhaustion(candles1h)) {
    allowLong = false;
    rejectionReasonLong = `Parabolic pump exhaustion detected on 1H`;
  } else if (isKnifeDrop(candles1h)) {
    allowLong = false;
    rejectionReasonLong = `Falling knife detected on 1H — waiting for reversal`;
  } else if (marketTrend === 'BEARISH') {
    allowLong = false;
    rejectionReasonLong = `Медвежий тренд рынка (1D=${d1Trend}, 4H=${h4Trend}, 1H=${h1Trend}) — вход в LONG против тренда заблокирован`;
  }

  let allowShort = true;
  let rejectionReasonShort = '';

  const minAllowedRsiForShort = 20.0;

  if (
    rsi1d < minAllowedRsiForShort ||
    rsi4h < minAllowedRsiForShort ||
    rsi1h < minAllowedRsiForShort
  ) {
    allowShort = false;
    rejectionReasonShort = `MTF RSI фильтр блокирует SHORT: 1D RSI=${rsi1d}, 4H RSI=${rsi4h}, 1H RSI=${rsi1h} (мин ${minAllowedRsiForShort})`;
  } else if (marketTrend !== 'BEARISH' && distTo4hSupPct < 0.85) {
    allowShort = false;
    rejectionReasonShort = `Close to 1W/1D Support (${key4hSupport}, only -${distTo4hSupPct.toFixed(2)}% room)`;
  } else if (marketTrend !== 'BEARISH' && pos4hPct < 20.0) {
    allowShort = false;
    rejectionReasonShort = `Bottom of 1W/1D range (${pos4hPct.toFixed(1)}%) — oversold zone`;
  } else if (isKnifeDrop(candles1h)) {
    allowShort = false;
    rejectionReasonShort = `Cascade knife drop detected on 1H`;
  } else if (marketTrend === 'BULLISH') {
    allowShort = false;
    rejectionReasonShort = `Бычий тренд рынка (1D=${d1Trend}, 4H=${h4Trend}, 1H=${h1Trend}) — вход в SHORT против тренда заблокирован`;
  }

  // Long TP: aim for nearest confirmed S/R or consolidation zone edge within +0.8%..+3.5%, fallback +1.2%
  const minTpDistLong = currentPrice * 1.008;
  const maxTpDistLong = currentPrice * 1.035;
  const defaultScalpTpLong = currentPrice * 1.012;
  const longTargetCandidates = [
    local1hResistance * 0.998,
    key4hResistance * 0.998,
    ...local1d.map((l) => (l.zone_low && l.zone_low > currentPrice ? l.zone_low * 0.999 : l.price * 0.998)),
    ...structural4hLevels.map((l) => (l.zone_low && l.zone_low > currentPrice ? l.zone_low * 0.999 : l.price * 0.998)),
    ...refinedGlobal.map((l) => (l.zone_low && l.zone_low > currentPrice ? l.zone_low * 0.999 : l.price * 0.998)),
  ]
    .filter((p) => Number.isFinite(p) && p >= minTpDistLong && p <= maxTpDistLong)
    .sort((a, b) => a - b);
  const recTpLong = longTargetCandidates.length > 0 ? longTargetCandidates[0] : defaultScalpTpLong;

  const safeSupport = Math.min(key4hSupport, local1hSupport);
  let recSlLong = safeSupport * 0.996;
  const slDistPctLong = currentPrice > 0 ? ((currentPrice - recSlLong) / currentPrice) * 100.0 : 0;
  if (slDistPctLong < 0.8) recSlLong = currentPrice * 0.985;
  else if (slDistPctLong > 4.5) recSlLong = currentPrice * 0.96;

  // Short TP: aim for nearest confirmed S/R or consolidation zone edge within -0.8%..-3.5%, fallback -1.2%
  const minTpDistShort = currentPrice * 0.992;
  const maxTpDistShort = currentPrice * 0.965;
  const defaultScalpTpShort = currentPrice * 0.988;
  const shortTargetCandidates = [
    local1hSupport * 1.002,
    key4hSupport * 1.002,
    ...local1d.map((l) => (l.zone_high && l.zone_high < currentPrice ? l.zone_high * 1.001 : l.price * 1.002)),
    ...structural4hLevels.map((l) => (l.zone_high && l.zone_high < currentPrice ? l.zone_high * 1.001 : l.price * 1.002)),
    ...refinedGlobal.map((l) => (l.zone_high && l.zone_high < currentPrice ? l.zone_high * 1.001 : l.price * 1.002)),
  ]
    .filter((p) => Number.isFinite(p) && p <= minTpDistShort && p >= maxTpDistShort)
    .sort((a, b) => b - a);
  const recTpShort = shortTargetCandidates.length > 0 ? shortTargetCandidates[0] : defaultScalpTpShort;

  const safeResistance = Math.max(key4hResistance, local1hResistance);
  let recSlShort = safeResistance * 1.004;
  const slDistPctShort =
    currentPrice > 0 ? ((recSlShort - currentPrice) / currentPrice) * 100.0 : 0;
  if (slDistPctShort < 0.8) recSlShort = currentPrice * 1.015;
  else if (slDistPctShort > 4.5) recSlShort = currentPrice * 1.04;

  const supportHistory = primaryGlobalSup || sup1dFallback || structure4h.support_history || null;
  const resistanceHistory = primaryGlobalRes || res1dFallback || structure4h.resistance_history || null;

  // Enforce hold discipline if pure unconfirmed breaks exceed bounces & no mirror retests
  if (
    !hasCustomSup &&
    marketTrend !== 'BULLISH' &&
    supportHistory &&
    (supportHistory.mirror_retests || 0) === 0 &&
    supportHistory.breaks > supportHistory.bounces + 1
  ) {
    allowLong = false;
    rejectionReasonLong =
      rejectionReasonLong ||
      `Support at ${supportHistory.price} has weak history: ${supportHistory.bounces} bounces vs ${supportHistory.breaks} breaks`;
  }
  if (
    !hasCustomRes &&
    marketTrend !== 'BEARISH' &&
    resistanceHistory &&
    (resistanceHistory.mirror_retests || 0) === 0 &&
    resistanceHistory.breaks > resistanceHistory.bounces + 1
  ) {
    allowShort = false;
    rejectionReasonShort =
      rejectionReasonShort ||
      `Resistance at ${resistanceHistory.price} has weak history: ${resistanceHistory.bounces} bounces vs ${resistanceHistory.breaks} breaks`;
  }

  const mergedInstitutional: ClusteredLevelWithHistory[] = [
    ...refinedGlobal.slice(0, 5),
    ...local1d.slice(0, 4),
    ...structural4hLevels.slice(0, 3),
  ].sort((a, b) => b.strength_score - a.strength_score);

  const levelMapSummary =
    `Trend: ${marketTrend} (1W=${w1Trend} RSI ${rsi1w}, 1D=${d1Trend} RSI ${rsi1d}, 4H=${h4Trend} RSI ${rsi4h}, 1H=${h1Trend} RSI ${rsi1h}) | ` +
    `Global 1W->1D: Sup=${key4hSupport.toPrecision(6)} / Res=${key4hResistance.toPrecision(6)} (Pos: ${pos4hPct.toFixed(0)}%) | ` +
    `1D Local: ${local1d.length} | 4H Struct: ${structural4hLevels.length} | 1H: Sup=${local1hSupport.toPrecision(6)} / Res=${local1hResistance.toPrecision(6)}`;

  return {
    w1_trend: w1Trend,
    d1_trend: d1Trend,
    h4_trend: h4Trend,
    h1_trend: h1Trend,
    market_trend: marketTrend,
    d1_high: d1High,
    d1_low: d1Low,
    rsi_1w: rsi1w,
    rsi_1d: rsi1d,
    rsi_4h: rsi4h,
    rsi_1h: rsi1h,
    key_4h_support: Number(key4hSupport.toPrecision(7)),
    key_4h_resistance: Number(key4hResistance.toPrecision(7)),
    pos_4h_pct: Number(pos4hPct.toFixed(1)),
    local_1h_support: Number(local1hSupport.toPrecision(7)),
    local_1h_resistance: Number(local1hResistance.toPrecision(7)),
    pos_1h_pct: Number(pos1hPct.toFixed(1)),
    dist_to_4h_res_pct: Number(distTo4hResPct.toFixed(2)),
    dist_to_4h_sup_pct: Number(distTo4hSupPct.toFixed(2)),
    recommended_tp: Number(recTpLong.toPrecision(7)),
    recommended_tp_long: Number(recTpLong.toPrecision(7)),
    recommended_tp_short: Number(recTpShort.toPrecision(7)),
    recommended_sl: Number(recSlLong.toPrecision(7)),
    recommended_sl_long: Number(recSlLong.toPrecision(7)),
    recommended_sl_short: Number(recSlShort.toPrecision(7)),
    allow_long: allowLong,
    allow_short: allowShort,
    rejection_reason: rejectionReasonLong || rejectionReasonShort,
    rejection_reason_long: rejectionReasonLong,
    rejection_reason_short: rejectionReasonShort,
    level_map_summary: levelMapSummary,
    support_history: supportHistory,
    resistance_history: resistanceHistory,
    institutional_levels: mergedInstitutional.slice(0, 10),
    local_1d_levels: local1d.slice(0, 6),
    structural_4h_levels: structural4hLevels.slice(0, 4),
  };
}

// ============================================================================
// 4. ANTI-KNIFE / ANTI-PUMP, CANDLE REJECTION, RSI & STRONGEST DCA LEVEL
// ============================================================================

export function isKnifeDrop(candles: OhlcvCandle[]): boolean {
  if (!candles || candles.length < 3) return false;
  const row = candles[candles.length - 1];
  const openP = row.open;
  const closeP = row.close;
  const highP = row.high;
  const lowP = row.low;
  if (openP <= 0) return false;

  const candleRange = Math.max(highP - lowP, 1e-9);
  const body = Math.abs(closeP - openP);
  const changePct = ((closeP - openP) / openP) * 100.0;
  const lowerWick = Math.min(openP, closeP) - lowP;

  const isMarubozuDump =
    changePct <= -1.8 && body / candleRange >= 0.72 && lowerWick / candleRange < 0.15;

  const last3 = candles.slice(-3);
  const threeRedStreak = last3.every((r) => r.close < r.open);
  const total3DropPct =
    last3[0].open > 0 ? ((last3[2].close - last3[0].open) / last3[0].open) * 100.0 : 0.0;
  const isCascadeDump =
    threeRedStreak && total3DropPct <= -2.5 && lowerWick / candleRange < 0.25;

  return Boolean(isMarubozuDump || isCascadeDump);
}

export function isPumpExhaustion(candles: OhlcvCandle[]): boolean {
  if (!candles || candles.length < 3) return false;
  const row = candles[candles.length - 1];
  const openP = row.open;
  const closeP = row.close;
  const highP = row.high;
  const lowP = row.low;
  if (openP <= 0) return false;

  const candleRange = Math.max(highP - lowP, 1e-9);
  const body = Math.abs(closeP - openP);
  const changePct = ((closeP - openP) / openP) * 100.0;
  const upperWick = highP - Math.max(openP, closeP);

  const isMarubozuPump =
    changePct >= 1.8 && body / candleRange >= 0.72 && upperWick / candleRange < 0.15;

  const last3 = candles.slice(-3);
  const threeGreenStreak = last3.every((r) => r.close > r.open);
  const total3PumpPct =
    last3[0].open > 0 ? ((last3[2].close - last3[0].open) / last3[0].open) * 100.0 : 0.0;
  const isCascadePump =
    threeGreenStreak && total3PumpPct >= 2.5 && upperWick / candleRange < 0.25;

  return Boolean(isMarubozuPump || isCascadePump);
}

export function checkCandleRejection(
  candles: OhlcvCandle[],
  level: number,
  isShort = false,
  tolerancePct = 0.8,
  zoneBounds?: { zoneLow?: number; zoneHigh?: number }
): { confirmed: boolean; reason: string } {
  if (!candles || candles.length < 2 || level <= 0) {
    return { confirmed: false, reason: 'Insufficient data or invalid level' };
  }
  const row = candles[candles.length - 1];
  const prevRow = candles[candles.length - 2];
  const openP = row.open;
  const closeP = row.close;
  const highP = row.high;
  const lowP = row.low;
  const candleRange = Math.max(highP - lowP, 1e-9);
  const body = Math.abs(closeP - openP);

  if (!isShort) {
    const zoneTop = zoneBounds?.zoneHigh && zoneBounds.zoneHigh > level ? zoneBounds.zoneHigh : level;
    const nearLevel =
      lowP <= zoneTop * (1 + tolerancePct / 100.0) || closeP <= zoneTop * (1 + tolerancePct / 100.0);
    if (!nearLevel) {
      return { confirmed: false, reason: `Price ${lowP} not testing support ${level}` };
    }
    if (isKnifeDrop(candles)) {
      return { confirmed: false, reason: 'Knife drop detected (no lower wick, strong dump candle)' };
    }
    const lowerWick = Math.min(openP, closeP) - lowP;
    const hasRejectionWick = lowerWick / candleRange >= 0.22 || lowerWick >= body * 0.55;
    const reachedLevelZone = closeP <= zoneTop * 1.003 || lowP <= zoneTop;
    const isGreen = closeP > openP;
    const bullishEngulfing = isGreen && closeP > prevRow.open && prevRow.close < prevRow.open;
    const confirmed = reachedLevelZone && (hasRejectionWick || isGreen || bullishEngulfing);
    return {
      confirmed,
      reason: confirmed
        ? 'Support / DCA level reached and confirmed by bounce candle'
        : 'Waiting for support bounce / wick rejection confirmation',
    };
  } else {
    const zoneBot = zoneBounds?.zoneLow && zoneBounds.zoneLow > 0 && zoneBounds.zoneLow < level ? zoneBounds.zoneLow : level;
    const nearLevel =
      highP >= zoneBot * (1 - tolerancePct / 100.0) || closeP >= zoneBot * (1 - tolerancePct / 100.0);
    if (!nearLevel) {
      return { confirmed: false, reason: `Price ${highP} not testing resistance ${level}` };
    }
    if (isPumpExhaustion(candles)) {
      return { confirmed: false, reason: 'Rocket pump detected (no upper wick, strong pump candle)' };
    }
    const upperWick = highP - Math.max(openP, closeP);
    const hasRejectionWick = upperWick / candleRange >= 0.22 || upperWick >= body * 0.55;
    const reachedLevelZone = closeP >= zoneBot * 0.997 || highP >= zoneBot;
    const isRed = closeP < openP;
    const bearishEngulfing = isRed && closeP < prevRow.open && prevRow.close > prevRow.open;
    const confirmed = reachedLevelZone && (hasRejectionWick || isRed || bearishEngulfing);
    return {
      confirmed,
      reason: confirmed
        ? 'Resistance / DCA level reached and confirmed by rejection candle'
        : 'Waiting for resistance rejection / upper wick confirmation',
    };
  }
}

export function checkRsiCondition(
  candles: OhlcvCandle[],
  isShort = false,
  period = 14
): { confirmed: boolean; rsi: number; reason: string } {
  if (!candles || candles.length < period + 2) {
    return { confirmed: false, rsi: 50, reason: 'Not enough candles for RSI' };
  }
  const closes = candles.map((c) => c.close);
  const rsiSeries = calcRsiSeries(closes, period);
  const rsiNow = rsiSeries[rsiSeries.length - 1];
  const rsiPrev = rsiSeries[rsiSeries.length - 2];

  if (!isShort) {
    const isOversold = rsiNow <= 45.0;
    const reversal = isOversold && (rsiNow > rsiPrev || rsiNow <= 20.0);
    return {
      confirmed: reversal,
      rsi: Number(rsiNow.toFixed(2)),
      reason: reversal
        ? `RSI ${rsiNow.toFixed(1)} oversold (<=20 or turning up)`
        : `RSI ${rsiNow.toFixed(1)} not in reversal setup for Long (must be <= 45 turning up or <= 20)`,
    };
  } else {
    const isOverbought = rsiNow >= 55.0;
    const reversal = isOverbought && (rsiNow < rsiPrev || rsiNow >= 80.0);
    return {
      confirmed: reversal,
      rsi: Number(rsiNow.toFixed(2)),
      reason: reversal
        ? `RSI ${rsiNow.toFixed(1)} overbought (>=80 or turning down)`
        : `RSI ${rsiNow.toFixed(1)} not in reversal setup for Short (must be >= 55 turning down or >= 80)`,
    };
  }
}

/**
 * Находит уровни усреднения (Smart DCA):
 * - DCA 1: сильнейший 1W->1D GLOBAL или подтверждённый 1D LOCAL уровень (минимум 2.8% от входа);
 * - DCA 2: абсолютный исторический максимум (SHORT) / минимум (LONG) по всей истории 1D+4H.
 */
export function findStrongestDcaLevel(
  candles4h: OhlcvCandle[],
  candles1d: OhlcvCandle[],
  referencePrice: number,
  isShort: boolean,
  minDistPct = 2.8,
  maxDistPct = 95.0,
  candles1w?: OhlcvCandle[]
): {
  price: number;
  second_price: number;
  strength_score: number;
  bounces: number;
  breaks: number;
  source: string;
  type: 'support' | 'resistance';
} {
  const effectiveMinDistPct = Math.max(2.8, minDistPct);
  if (referencePrice <= 0) {
    return {
      price: 0,
      second_price: 0,
      strength_score: 0,
      bounces: 0,
      breaks: 0,
      source: 'fallback',
      type: isShort ? 'resistance' : 'support',
    };
  }

  const allCandidates: ClusteredLevelWithHistory[] = [];
  let absHighest1d4h = -Infinity;
  let absLowest1d4h = Infinity;

  // Абсолютный пик/дно для DCA 2 берем по всей доступной истории 1D и 4H (резерв 1W только если 1D/4H пусты)
  for (const series of [candles1d, candles4h]) {
    if (!series || series.length === 0) continue;
    for (const c of series) {
      if (c.high > absHighest1d4h) absHighest1d4h = c.high;
      if (c.low > 0 && c.low < absLowest1d4h) absLowest1d4h = c.low;
    }
  }
  if (!Number.isFinite(absHighest1d4h) || !Number.isFinite(absLowest1d4h)) {
    for (const c of candles1w || []) {
      if (c.high > absHighest1d4h) absHighest1d4h = c.high;
      if (c.low > 0 && c.low < absLowest1d4h) absLowest1d4h = c.low;
    }
  }
  const absHighest = absHighest1d4h;
  const absLowest = absLowest1d4h;

  // 1. Top-Down 1W -> 1D уточнённые глобальные уровни и подтверждённые локальные 1D уровни (главный ориентир для DCA 1)
  const macro1wLevels =
    candles1w && candles1w.length >= 12
      ? detectMarketStructure(candles1w, candles1w.length, true).all_levels
      : [];
  if (candles1d && candles1d.length >= 15) {
    const { refinedGlobal, local1d } = refineHigherTimeframeLevels(
      macro1wLevels,
      candles1d,
      referencePrice
    );
    for (const g of refinedGlobal) {
      allCandidates.push({
        ...g,
        strength_score: Number((g.strength_score * 1.2).toFixed(3)),
        source: g.refined_from_1w ? '1W_1D_GLOBAL' : '1D_GLOBAL',
      });
    }
    for (const l of local1d) {
      allCandidates.push({
        ...l,
        strength_score: Number((l.strength_score * 0.95).toFixed(3)),
        source: '1D_LOCAL',
      });
    }
  } else if (macro1wLevels.length > 0) {
    for (const g of macro1wLevels) {
      allCandidates.push({
        ...g,
        strength_score: Number((g.strength_score * 1.2).toFixed(3)),
        source: '1W_GLOBAL',
      });
    }
  }

  // 2. Структурные точки 4H (как ориентир при отсутствии ближних 1W/1D уровней)
  if (candles4h && candles4h.length >= 20) {
    const struct4h = detectMarketStructure(candles4h, Math.min(240, candles4h.length), false);
    for (const lvl of struct4h.all_levels) {
      allCandidates.push({
        ...lvl,
        strength_score: Number((lvl.strength_score * 0.6).toFixed(3)),
        source: '4H_STRUCT',
      });
    }
  }

  // Фильтруем кандидатов для DCA 1 по дистанции >= effectiveMinDistPct и <= maxDistPct
  const targetRole: 'support' | 'resistance' = isShort ? 'resistance' : 'support';
  const validLevels = allCandidates
    .filter((lvl) => {
      const distPct = !isShort
        ? ((referencePrice - lvl.price) / referencePrice) * 100.0
        : ((lvl.price - referencePrice) / referencePrice) * 100.0;
      return distPct >= effectiveMinDistPct && distPct <= maxDistPct;
    })
    .map((lvl) => ({ ...lvl, type: targetRole }));

  if (validLevels.length > 0) {
    // Для DCA 1 балансируем 1W->1D GLOBAL и сильные 1D LOCAL уровни (не перепрыгиваем рабочий 1D уровень ради -55% дальнего)
    const primaryPool = validLevels.filter(
      (l) =>
        l.source?.includes('GLOBAL') ||
        (l.source === '1D_LOCAL' && (l.strength_score >= 8 || l.bounces >= 2 || (l.mirror_retests || 0) > 0))
    );
    const poolToRank = primaryPool.length > 0 ? primaryPool : validLevels;
    const bestFirst = poolToRank.reduce((best, cur) => {
      const distBest = (Math.abs(referencePrice - best.price) / referencePrice) * 100;
      const distCur = (Math.abs(referencePrice - cur.price) / referencePrice) * 100;
      const rankBest = best.strength_score / (1 + distBest * 0.03);
      const rankCur = cur.strength_score / (1 + distCur * 0.03);
      return rankCur > rankBest ? cur : best;
    });

    // Для DCA 2 берем АБСОЛЮТНЫЙ исторический пик (для SHORT) или АБСОЛЮТНОЕ дно (для LONG) за всю доступную историю 1D+4H
    const absExtreme = isShort ? absHighest : absLowest;
    let secondPrice = 0;

    if (
      Number.isFinite(absExtreme) &&
      absExtreme > 0 &&
      (isShort
        ? absExtreme > bestFirst.price * 1.005
        : absExtreme < bestFirst.price * 0.995)
    ) {
      secondPrice = Number(absExtreme.toPrecision(7));
    } else {
      const furtherCandidates = validLevels
        .filter((l) => {
          const distFromFirst = isShort
            ? ((l.price - bestFirst.price) / bestFirst.price) * 100
            : ((bestFirst.price - l.price) / bestFirst.price) * 100;
          return distFromFirst >= effectiveMinDistPct;
        })
        .sort((a, b) => (isShort ? b.price - a.price : a.price - b.price));

      secondPrice =
        furtherCandidates.length > 0
          ? Number(furtherCandidates[0].price.toPrecision(7))
          : Number(
              (
                bestFirst.price *
                (isShort ? 1 + effectiveMinDistPct / 100 : 1 - effectiveMinDistPct / 100)
              ).toPrecision(7)
            );
    }

    return {
      price: Number(bestFirst.price.toPrecision(7)),
      second_price: secondPrice,
      strength_score: bestFirst.strength_score,
      bounces: bestFirst.bounces,
      breaks: bestFirst.breaks,
      source: bestFirst.source || (isShort ? '1D_GLOBAL_RES' : '1D_GLOBAL_SUP'),
      type: bestFirst.type,
    };
  }

  // Fallback если цена уже на самом историческом экстремуме
  const fallbackStepPct = Math.max(0.035, effectiveMinDistPct / 100);
  const fallbackPrice1 = Number(
    (referencePrice * (isShort ? 1 + fallbackStepPct : 1 - fallbackStepPct)).toPrecision(7)
  );
  const absExtreme = isShort ? absHighest : absLowest;
  const fallbackPrice2 =
    Number.isFinite(absExtreme) &&
    absExtreme > 0 &&
    (isShort ? absExtreme > fallbackPrice1 * 1.005 : absExtreme < fallbackPrice1 * 0.995)
      ? Number(absExtreme.toPrecision(7))
      : Number(
          (fallbackPrice1 * (isShort ? 1 + fallbackStepPct : 1 - fallbackStepPct)).toPrecision(7)
        );
  return {
    price: fallbackPrice1,
    second_price: fallbackPrice2,
    strength_score: 0,
    bounces: 0,
    breaks: 0,
    source: isShort ? 'PREV_HIGH_STEP' : 'PREV_LOW_STEP',
    type: isShort ? 'resistance' : 'support',
  };
}

/**
 * ОТДЕЛЬНАЯ СТРАТЕГИЯ #2: GlobalHedgeStrategy (2-сторонние сделки LONG + SHORT в среднесрок и долгосрок)
 * Работает независимо от быстрого скальпинга (ScalpingStrategy):
 * - Анализирует глобальный канал 1D и 4H за всю историю
 * - Открывает парную 2-стороннюю позицию только тогда, когда на 1D и 4H сформирован широкий среднесрочный/долгосрочный коридор
 *   между глобальной поддержкой и глобальным сопротивлением (ширина коридора >= 3.5%), а цена находится внутри рабочего ядра канала (25%–75%).
 */
export interface GlobalHedgeEvaluation {
  strategy_name: 'GlobalHedgeStrategy';
  should_enter_hedge: boolean;
  should_open_hedge: boolean;
  channel_width_pct: number;
  long_tp_price: number;
  short_tp_price: number;
  long_dca_price: number;
  short_dca_price: number;
  horizon: 'MEDIUM_TERM_4H' | 'LONG_TERM_1D';
  horizon_label: 'MEDIUM_TERM_4H' | 'LONG_TERM_1D';
  reason: string;
}

export function evaluateGlobalHedgeStrategy(
  candles1h: OhlcvCandle[],
  candles4h: OhlcvCandle[],
  candles1d: OhlcvCandle[],
  mtf: MultiTimeframeAnalysis,
  btcIsSafe = true,
  candles1w?: OhlcvCandle[]
): GlobalHedgeEvaluation {
  const currentPrice =
    candles1h.length > 0
      ? candles1h[candles1h.length - 1].close
      : candles4h.length > 0
      ? candles4h[candles4h.length - 1].close
      : 0;

  if (currentPrice <= 0 || candles4h.length < 30 || !mtf) {
    return {
      strategy_name: 'GlobalHedgeStrategy',
      should_enter_hedge: false,
      should_open_hedge: false,
      channel_width_pct: 0,
      long_tp_price: currentPrice * 1.025,
      short_tp_price: currentPrice * 0.975,
      long_dca_price: currentPrice * 0.965,
      short_dca_price: currentPrice * 1.035,
      horizon: 'MEDIUM_TERM_4H',
      horizon_label: 'MEDIUM_TERM_4H',
      reason: 'Недостаточно истории 4H/1D для среднесрочного 2-стороннего входа',
    };
  }

  const globalSup = mtf.key_4h_support;
  const globalRes = mtf.key_4h_resistance;
  const channelWidthPct =
    globalRes > globalSup ? ((globalRes - globalSup) / currentPrice) * 100.0 : 0;

  // 2-сторонние сделки открываются в среднесрок и долгосрок в широком глобальном коридоре (>= 3.2%)
  const posPct = Number.isFinite(mtf.pos_4h_pct) ? mtf.pos_4h_pct : 50;
  const inEquilibriumZone = posPct >= 25.0 && posPct <= 75.0;
  const safeRsiZone =
    mtf.rsi_1d >= 20.0 &&
    mtf.rsi_1d <= 80.0 &&
    mtf.rsi_4h >= 20.0 &&
    mtf.rsi_4h <= 80.0 &&
    mtf.rsi_1h >= 20.0 &&
    mtf.rsi_1h <= 80.0;
  const noExtremeImpulse = btcIsSafe && !isKnifeDrop(candles1h) && !isPumpExhaustion(candles1h);

  const shouldEnter =
    channelWidthPct >= 3.2 && inEquilibriumZone && safeRsiZone && noExtremeImpulse;

  // Среднесрочные / долгосрочные цели TP для каждой ноги внутри глобального канала 4H / 1D (от 1.8% до 4.5% движения цены)
  const rawLongTarget = globalRes * 0.995;
  const rawShortTarget = globalSup * 1.005;
  const longTpPrice = Number(
    Math.max(currentPrice * 1.018, Math.min(currentPrice * 1.045, rawLongTarget)).toPrecision(7)
  );
  const shortTpPrice = Number(
    Math.min(currentPrice * 0.982, Math.max(currentPrice * 0.955, rawShortTarget)).toPrecision(7)
  );

  const longDca = findStrongestDcaLevel(candles4h, candles1d, currentPrice, false, 3.0, 95.0, candles1w);
  const shortDca = findStrongestDcaLevel(candles4h, candles1d, currentPrice, true, 3.0, 95.0, candles1w);
  const horizonLabel: 'MEDIUM_TERM_4H' | 'LONG_TERM_1D' =
    channelWidthPct >= 6.0 ? 'LONG_TERM_1D' : 'MEDIUM_TERM_4H';

  return {
    strategy_name: 'GlobalHedgeStrategy',
    should_enter_hedge: shouldEnter,
    should_open_hedge: shouldEnter,
    channel_width_pct: Number(channelWidthPct.toFixed(2)),
    long_tp_price: longTpPrice,
    short_tp_price: shortTpPrice,
    long_dca_price: longDca.price,
    short_dca_price: shortDca.price,
    horizon: horizonLabel,
    horizon_label: horizonLabel,
    reason: shouldEnter
      ? `GlobalHedgeStrategy (${horizonLabel === 'LONG_TERM_1D' ? 'Долгосрок 1D' : 'Среднесрок 4H'}): глобальный коридор [${globalSup} .. ${globalRes}] (${channelWidthPct.toFixed(1)}%), позиция в канале ${posPct.toFixed(0)}%`
      : `Коридор ${channelWidthPct.toFixed(1)}% (поз. ${posPct.toFixed(0)}%) вне зоны среднесрочного 2-стороннего входа`,
  };
}

export function isHedgeEntryCandidate(
  structure: MarketStructureResult,
  minRangePct = 35.0,
  maxRangePct = 65.0,
  minRangeWidthPct = 3.0
): boolean {
  const pos = structure.range_position_pct;
  const rangeHigh = structure.range_high;
  const rangeLow = structure.range_low;
  const currentPrice = structure.current_price;
  if (
    pos === undefined ||
    !rangeHigh ||
    !rangeLow ||
    !currentPrice ||
    currentPrice <= 0
  ) {
    return false;
  }
  if (pos < minRangePct || pos > maxRangePct) return false;
  const rangeWidthPct = ((rangeHigh - rangeLow) / currentPrice) * 100.0;
  return rangeWidthPct >= minRangeWidthPct;
}

// ============================================================================
// 5. BTC GUARD (freqtrade/core/btc_guard.py)
// ============================================================================

export function checkBtcMarketHealth(btc1hCandles: OhlcvCandle[]): {
  isSafe: boolean;
  btcTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  reason: string;
  btcPrice?: number;
  candleChangePct?: number;
} {
  if (!btc1hCandles || btc1hCandles.length < 20) {
    return {
      isSafe: true,
      btcTrend: 'NEUTRAL',
      reason: 'Insufficient BTC data, proceeding with caution',
    };
  }
  const closes = btc1hCandles.map((c) => c.close);
  const ema20Series = calcEmaSeries(closes, 20);
  const ema50Series = calcEmaSeries(closes, 50);
  const rsiSeries = calcRsiSeries(closes, 14);
  const last = btc1hCandles[btc1hCandles.length - 1];
  const prev = btc1hCandles[btc1hCandles.length - 2];
  const ema20 = ema20Series[ema20Series.length - 1];
  const ema50 = ema50Series[ema50Series.length - 1];
  const btcRsi = rsiSeries[rsiSeries.length - 1];

  const btcTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
    last.close > ema20 && ema20 >= ema50 * 0.998
      ? 'BULLISH'
      : last.close < ema20 && ema20 <= ema50 * 1.002
      ? 'BEARISH'
      : 'NEUTRAL';

  const candleChangePct =
    last.open > 0 ? ((last.close - last.open) / last.open) * 100.0 : 0;
  const prevChangePct =
    prev.open > 0 ? ((prev.close - prev.open) / prev.open) * 100.0 : 0;

  if (candleChangePct < -2.0) {
    return {
      isSafe: false,
      btcTrend: 'BEARISH',
      reason: `BTC flash dumping: ${candleChangePct.toFixed(2)}% in current 1h candle`,
      btcPrice: last.close,
      candleChangePct,
    };
  }
  if (last.close < ema50 * 0.985 && candleChangePct < -0.8) {
    return {
      isSafe: false,
      btcTrend: 'BEARISH',
      reason: `BTC breakdown below EMA 50 (${last.close.toFixed(1)} vs EMA50 ${ema50.toFixed(1)})`,
      btcPrice: last.close,
      candleChangePct,
    };
  }
  if (candleChangePct < -1.0 && prevChangePct < -1.0) {
    return {
      isSafe: false,
      btcTrend: 'BEARISH',
      reason: 'BTC consecutive sell-off: 2 hours of heavy selling',
      btcPrice: last.close,
      candleChangePct,
    };
  }

  return {
    isSafe: true,
    btcTrend,
    reason:
      btcTrend === 'BEARISH'
        ? `BTC в нисходящем тренде (RSI 1H=${btcRsi.toFixed(1)}, ниже EMA20/EMA50)`
        : btcTrend === 'BULLISH'
        ? `BTC в восходящем тренде (RSI 1H=${btcRsi.toFixed(1)}, выше EMA20/EMA50)`
        : 'BTC нейтрален / в боковике',
    btcPrice: last.close,
    candleChangePct,
  };
}

// ============================================================================
// 6. SCALPING STRATEGY SIGNAL EVALUATION (freqtrade/strategy/scalping_strategy.py)
// ============================================================================

export interface ScalpingSignalEvaluation {
  enter_long: boolean;
  enter_short: boolean;
  exit_long: boolean;
  exit_short: boolean;
  enter_tag: string;
  exit_tag: string;
  rsi: number;
  wt1: number;
  wt2: number;
  ema_fast: number;
  ema_slow: number;
  ema_trend: number;
}

export function evaluateScalpingStrategy(
  candles: OhlcvCandle[],
  smartSupport: number,
  smartResistance: number,
  extraLevels?: ClusteredLevelWithHistory[]
): ScalpingSignalEvaluation {
  const n = candles.length;
  if (n < 30) {
    return {
      enter_long: false,
      enter_short: false,
      exit_long: false,
      exit_short: false,
      enter_tag: '',
      exit_tag: '',
      rsi: 50,
      wt1: 0,
      wt2: 0,
      ema_fast: 0,
      ema_slow: 0,
      ema_trend: 0,
    };
  }

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const emaFast = calcEmaSeries(closes, 9);
  const emaSlow = calcEmaSeries(closes, 21);
  const emaTrend = calcEmaSeries(closes, 50);
  const rsiSeries = calcRsiSeries(closes, 14);
  const volMean = calcSmaSeries(volumes, 20);
  const { wt1, wt2 } = calculateWaveTrend(candles, 10, 21);

  const idx = n - 1;
  const prev = n - 2;
  const c = candles[idx];
  const p = candles[prev];

  const greenCandle = c.close > c.open;
  const redCandle = c.close < c.open;

  const volumeOk =
    c.volume >= volMean[idx] * 0.65 || p.volume >= volMean[prev] * 0.85;
  const volumeTrendOk =
    c.volume >= volMean[idx] * 0.7 || p.volume >= volMean[prev] * 0.9;

  // Support bounce / Resistance rejection
  const body = Math.abs(c.close - c.open);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  const hasLowerWick = lowerWick >= body * 0.5 || lowerWick >= c.close * 0.0025;
  const hasUpperWick = upperWick >= body * 0.5 || upperWick >= c.close * 0.0025;

  const trendBullish =
    c.close > emaTrend[idx] * 0.996 && emaSlow[idx] >= emaTrend[idx] * 0.996;
  const trendBearish =
    c.close < emaTrend[idx] * 1.004 && emaSlow[idx] <= emaTrend[idx] * 1.004;

  // Собираем подтвержденные 1W->1D GLOBAL / 1D LOCAL зоны для проверки касания и отбоя
  const levelZones = (extraLevels || []).filter(
    (l) => l.timeframe_role === 'GLOBAL_1W_1D' || l.timeframe_role === 'LOCAL_1D'
  );
  const inZoneSupport = levelZones.some((l) => {
    const zHigh = l.zone_high && l.zone_high > l.price ? l.zone_high : l.price * 1.008;
    const zLow = l.zone_low && l.zone_low < l.price ? l.zone_low : l.price * 0.988;
    return l.price <= c.close * 1.01 && c.low <= zHigh * 1.004 && c.close >= zLow * 0.995;
  });
  const inZoneResistance = levelZones.some((l) => {
    const zLow = l.zone_low && l.zone_low < l.price ? l.zone_low : l.price * 0.992;
    const zHigh = l.zone_high && l.zone_high > l.price ? l.zone_high : l.price * 1.012;
    return l.price >= c.close * 0.99 && c.high >= zLow * 0.996 && c.close <= zHigh * 1.005;
  });

  // --- LONG SIGNALS ---
  // Mode A: Level Reversal Long (bounce from support/1D zone)
  const supportBounce =
    c.low <= smartSupport * 1.008 &&
    c.close >= smartSupport * 0.995 &&
    (greenCandle || hasLowerWick);
  const nearSupport =
    c.low <= smartSupport * 1.012 && c.close >= smartSupport * 0.985;
  const supportSignal = supportBounce || nearSupport || (inZoneSupport && (greenCandle || hasLowerWick));

  const waveOversoldCross =
    (wt1[idx] > wt2[idx] && (wt1[prev] <= wt2[prev] || wt2[idx] <= -25)) ||
    (wt2[idx] <= -42 && wt1[idx] > wt1[prev]);
  const rsiOversoldOk =
    rsiSeries[idx] <= 45.0 && (rsiSeries[idx] <= 20.0 || rsiSeries[idx] > rsiSeries[prev]);

  const levelReversalEntryLong =
    supportSignal &&
    waveOversoldCross &&
    rsiOversoldOk &&
    (greenCandle || hasLowerWick) &&
    volumeOk &&
    !trendBearish &&
    !isKnifeDrop(candles) &&
    !isPumpExhaustion(candles);

  // Mode B: Trend Momentum / Pullback Long (trading along an active bullish trend, RSI up to 80)
  const emaCrossoverUp =
    emaFast[idx] > emaSlow[idx] && emaFast[prev] <= emaSlow[prev];
  const emaBounceUp =
    c.low <= emaSlow[idx] * 1.008 &&
    c.close > emaSlow[idx] &&
    emaFast[idx] >= emaSlow[idx] * 0.998;
  const momentumSignalUp =
    emaCrossoverUp ||
    emaBounceUp ||
    (c.close > emaFast[idx] && emaFast[idx] >= emaSlow[idx] * 0.999);
  const momentumRsiUp =
    rsiSeries[idx] >= 35.0 &&
    rsiSeries[idx] <= 80.0 &&
    (rsiSeries[idx] >= rsiSeries[prev] - 1.5 || wt1[idx] >= wt2[idx]);
  const trendMomentumEntryLong =
    trendBullish &&
    momentumSignalUp &&
    momentumRsiUp &&
    volumeTrendOk &&
    (greenCandle || hasLowerWick) &&
    !isPumpExhaustion(candles) &&
    !isKnifeDrop(candles);

  // --- SHORT SIGNALS ---
  // Mode A: Level Reversal Short (rejection from resistance/1D zone)
  const resistanceRejection =
    c.high >= smartResistance * 0.992 &&
    c.close <= smartResistance * 1.005 &&
    (redCandle || hasUpperWick);
  const nearResistance =
    c.high >= smartResistance * 0.988 && c.close <= smartResistance * 1.015;
  const resistanceSignal =
    resistanceRejection || nearResistance || (inZoneResistance && (redCandle || hasUpperWick));

  const waveOverboughtCross =
    (wt1[idx] < wt2[idx] && (wt1[prev] >= wt2[prev] || wt2[idx] >= 25)) ||
    (wt2[idx] >= 42 && wt1[idx] < wt1[prev]);
  const rsiOverboughtOk =
    rsiSeries[idx] >= 55.0 && (rsiSeries[idx] >= 80.0 || rsiSeries[idx] < rsiSeries[prev]);

  const levelReversalEntryShort =
    resistanceSignal &&
    waveOverboughtCross &&
    rsiOverboughtOk &&
    (redCandle || hasUpperWick) &&
    volumeOk &&
    !trendBullish &&
    !isPumpExhaustion(candles) &&
    !isKnifeDrop(candles);

  // Mode B: Trend Momentum / Pullback Short (trading along an active bearish trend, RSI >= 20)
  const emaCrossoverDown =
    emaFast[idx] < emaSlow[idx] && emaFast[prev] >= emaSlow[prev];
  const emaBounceDown =
    c.high >= emaFast[idx] * 0.995 &&
    c.close < emaSlow[idx] &&
    emaFast[idx] <= emaSlow[idx] * 1.002;
  const momentumSignalDown =
    emaCrossoverDown ||
    emaBounceDown ||
    (c.close < emaFast[idx] && emaFast[idx] <= emaSlow[idx] * 1.001);
  const momentumRsiDown =
    rsiSeries[idx] >= 20.0 &&
    rsiSeries[idx] <= 65.0 &&
    (rsiSeries[idx] <= rsiSeries[prev] + 1.5 || wt1[idx] <= wt2[idx]);
  const trendMomentumEntryShort =
    trendBearish &&
    momentumSignalDown &&
    momentumRsiDown &&
    volumeTrendOk &&
    (redCandle || hasUpperWick) &&
    !isPumpExhaustion(candles) &&
    !isKnifeDrop(candles);

  const enterLong =
    (levelReversalEntryLong || trendMomentumEntryLong) && !trendMomentumEntryShort;
  const enterShort =
    (levelReversalEntryShort || trendMomentumEntryShort) && !trendMomentumEntryLong;

  // Exits (RSI 80 / 20)
  const resistanceTested = c.high >= smartResistance * 0.998;
  const waveTopReversal =
    wt1[idx] < wt2[idx] && wt1[prev] >= wt2[prev] && wt2[idx] >= 45;
  const levelTargetExitLong =
    resistanceTested && (rsiSeries[idx] >= 80 || waveTopReversal);
  const rsiExhaustionLong = rsiSeries[idx] >= 80 && redCandle;
  const trendBreakLong =
    c.close < emaTrend[idx] && emaFast[idx] < emaSlow[idx] && rsiSeries[idx] < 40;
  const exitLong = levelTargetExitLong || rsiExhaustionLong || trendBreakLong;

  const supportTested = c.low <= smartSupport * 1.002;
  const waveBottomReversal =
    wt1[idx] > wt2[idx] && wt1[prev] <= wt2[prev] && wt2[idx] <= -45;
  const levelTargetExitShort =
    supportTested && (rsiSeries[idx] <= 20 || waveBottomReversal);
  const rsiExhaustionShort = rsiSeries[idx] <= 20 && greenCandle;
  const trendBreakShort =
    c.close > emaTrend[idx] && emaFast[idx] > emaSlow[idx] && rsiSeries[idx] > 60;
  const exitShort = levelTargetExitShort || rsiExhaustionShort || trendBreakShort;

  let enterTag = '';
  if (enterShort && (!enterLong || trendBearish)) {
    enterTag = levelReversalEntryShort ? 'MTF_Resistance_Reject' : 'EMA_Trend_Momentum_Short';
  } else if (enterLong) {
    enterTag = levelReversalEntryLong ? 'MTF_Support_Bounce' : 'EMA_Trend_Momentum_Long';
  }

  let exitTag = '';
  if (exitLong) {
    exitTag = levelTargetExitLong
      ? 'resistance_target_hit'
      : rsiExhaustionLong
      ? 'rsi_exhaustion'
      : 'trend_break';
  } else if (exitShort) {
    exitTag = levelTargetExitShort
      ? 'support_target_hit'
      : rsiExhaustionShort
      ? 'rsi_exhaustion'
      : 'trend_break';
  }

  return {
    enter_long: enterLong && !enterShort,
    enter_short: enterShort,
    exit_long: exitLong,
    exit_short: exitShort,
    enter_tag: enterTag,
    exit_tag: exitTag,
    rsi: Number(rsiSeries[idx].toFixed(2)),
    wt1: Number(wt1[idx].toFixed(2)),
    wt2: Number(wt2[idx].toFixed(2)),
    ema_fast: emaFast[idx],
    ema_slow: emaSlow[idx],
    ema_trend: emaTrend[idx],
  };
}

// ============================================================================
// 7. 6-POINT CAN_DCA RISK GUARD (freqtrade/bot/freqtradebot.py::can_dca)
// ============================================================================

export function canExecuteDca(
  params: {
    pair: string;
    dcaCount: number;
    initialAmount: number;
    currentAmount: number;
    currentPrice: number;
    openRate: number;
    isShort: boolean;
    leverage: number;
    totalBalanceUsdt: number;
    usedMarginUsdt: number;
  },
  config: BotConfigData = DEFAULT_SCALPBOT_CONFIG
): { allowed: boolean; reason: string; multiplier: number; liquidationDistancePct: number } {
  const maxDca = config.max_dca_orders;
  const maxMultiplier = config.max_position_multiplier;
  const minLiqDistPct = config.min_liquidation_distance_pct;
  const maxMarginForDcaPct = config.max_margin_used_for_dca_pct;
  const maxPairMarginPct = config.max_pair_margin_pct;

  const baseAmt = params.initialAmount > 0 ? params.initialAmount : params.currentAmount;
  const currentMultiplier = baseAmt > 0 ? Number((params.currentAmount / baseAmt).toFixed(2)) : 1.0;

  // 1. Step count limit
  if (params.dcaCount >= maxDca) {
    return {
      allowed: false,
      reason: `Достигнут лимит шагов усреднения (${params.dcaCount}/${maxDca})`,
      multiplier: currentMultiplier,
      liquidationDistancePct: 100,
    };
  }

  // 2. Position multiplier limit
  if (currentMultiplier >= maxMultiplier) {
    return {
      allowed: false,
      reason: `Позиция уже в ${currentMultiplier}x от начальной (лимит ${maxMultiplier}x)`,
      multiplier: currentMultiplier,
      liquidationDistancePct: 100,
    };
  }

  // 3. Account margin utilization
  const totalBalance = params.totalBalanceUsdt > 0 ? params.totalBalanceUsdt : config.dry_run_wallet;
  const usedPct = (params.usedMarginUsdt / totalBalance) * 100.0;
  if (usedPct >= maxMarginForDcaPct) {
    return {
      allowed: false,
      reason: `Занято ${usedPct.toFixed(1)}% маржи аккаунта (лимит ${maxMarginForDcaPct}%)`,
      multiplier: currentMultiplier,
      liquidationDistancePct: 100,
    };
  }

  // 4. Portfolio Margin Guard: max margin share on a single coin (<= 20%)
  const lev = Math.max(1, params.leverage || config.leverage);
  const minDcaStake = Math.max(5, config.min_stake_amount || 5);
  const currentPairNotional = params.currentAmount * params.currentPrice;
  const currentPairMargin = currentPairNotional / lev;
  const maxPairMarginLimit = (maxPairMarginPct / 100.0) * totalBalance;
  const remainingPairMargin = Math.max(0, maxPairMarginLimit - currentPairMargin);

  const nextAddAmount =
    config.dca_scale_mode === 'linear' ? baseAmt : params.currentAmount;
  const nextAddNotional = nextAddAmount * params.currentPrice;
  const rawNextAddMargin = nextAddNotional / lev;
  const effectiveNextMargin = Math.max(minDcaStake, Math.min(rawNextAddMargin, remainingPairMargin));

  if (remainingPairMargin < minDcaStake) {
    const curSharePct = (currentPairMargin / totalBalance) * 100.0;
    return {
      allowed: false,
      reason: `Portfolio Guard: монета ${params.pair} уже занимает ${curSharePct.toFixed(1)}% маржи депозита (лимит ${maxPairMarginPct}%)`,
      multiplier: currentMultiplier,
      liquidationDistancePct: 100,
    };
  }

  // 5. Free balance check
  const availableBalance = Math.max(0, totalBalance - params.usedMarginUsdt);
  if (availableBalance < effectiveNextMargin) {
    return {
      allowed: false,
      reason: `Не хватает свободной маржи: нужно ~${effectiveNextMargin.toFixed(2)} USDT, доступно ${availableBalance.toFixed(2)} USDT`,
      multiplier: currentMultiplier,
      liquidationDistancePct: 100,
    };
  }

  // 6. Liquidation distance check (Cross-Margin aware + scaled for high leverage like 25x)
  const crossMarginBuffer = Math.min(
    0.85,
    Math.max(
      0.92 / lev,
      (currentPairMargin + availableBalance * 0.35) / Math.max(1, currentPairNotional)
    )
  );
  const approxLiqPrice = params.isShort
    ? params.openRate * (1 + crossMarginBuffer)
    : params.openRate * (1 - crossMarginBuffer);
  const liqDistancePct =
    params.currentPrice > 0
      ? (Math.abs(params.currentPrice - approxLiqPrice) / params.currentPrice) * 100.0
      : 100;
  const effectiveMinLiqPct = Math.min(minLiqDistPct, Number((25.0 / lev).toFixed(2)));

  if (liqDistancePct < effectiveMinLiqPct) {
    return {
      allowed: false,
      reason: `Слишком близко к ликвидации: ${liqDistancePct.toFixed(1)}% (лимит ${effectiveMinLiqPct}%)`,
      multiplier: currentMultiplier,
      liquidationDistancePct: Number(liqDistancePct.toFixed(2)),
    };
  }

  return {
    allowed: true,
    reason: 'OK',
    multiplier: currentMultiplier,
    liquidationDistancePct: Number(liqDistancePct.toFixed(2)),
  };
}

/**
 * Calculates the optimal DCA coin volume to pull the average entry price as close
 * to the current market price as possible (within ~0.8%), strictly respecting:
 * - remaining single-pair margin quota (max 20% of deposit)
 * - available free margin & fair share across active coins
 * - minimum order stake (default $5, never forcing $25 over quota)
 */
export function calculateDynamicDcaAmount(params: {
  currentAmount: number;
  openRate: number;
  currentPrice: number;
  isShort: boolean;
  leverage: number;
  totalBalanceUsdt: number;
  usedMarginUsdt: number;
  otherActiveCoinsCount: number;
  maxPairMarginPct?: number;
  minStakeUsdt?: number;
}): { addAmount: number; addStake: number; targetAvgPrice: number; pullDistancePct: number } {
  const lev = Math.max(1, params.leverage);
  const minStake = Math.max(5, params.minStakeUsdt || 5);
  const totalBalance = Math.max(minStake, params.totalBalanceUsdt);
  const freeMargin = Math.max(0, totalBalance - params.usedMarginUsdt);
  const maxPairMarginLimit = ((params.maxPairMarginPct || 20.0) / 100) * totalBalance;

  const currentPairNotional = params.currentAmount * params.currentPrice;
  const currentPairMargin = currentPairNotional / lev;
  const remainingPairMargin = Math.max(0, maxPairMarginLimit - currentPairMargin);

  // Reserve margin for other coins: allocate at most 50% of free margin or fair share, never exceeding remainingPairMargin
  const fairShareMargin = freeMargin / Math.max(1, params.otherActiveCoinsCount + 1);
  const budgetPool = Math.min(freeMargin * 0.6, Math.max(minStake, fairShareMargin * 1.5));
  const maxSafeMarginForThisStep = Math.min(remainingPairMargin, budgetPool, freeMargin);

  if (maxSafeMarginForThisStep < minStake || params.currentPrice <= 0) {
    return {
      addAmount: 0,
      addStake: 0,
      targetAvgPrice: Number(params.openRate.toPrecision(7)),
      pullDistancePct: 0,
    };
  }

  // Desired average entry price: pull within 0.8% towards current reversal price
  const targetAvgPrice = params.isShort
    ? Math.max(params.openRate, params.currentPrice * 0.992)
    : Math.min(params.openRate, params.currentPrice * 1.008);

  const priceDiffOld = Math.abs(params.openRate - targetAvgPrice);
  const priceDiffNew = Math.abs(targetAvgPrice - params.currentPrice);

  let desiredAddAmount = params.currentAmount;
  if (priceDiffNew > 1e-8 && priceDiffOld > 1e-8) {
    desiredAddAmount = Math.min(params.currentAmount * 2.5, params.currentAmount * (priceDiffOld / priceDiffNew));
  }

  const desiredMargin = (desiredAddAmount * params.currentPrice) / lev;
  const finalStake = Math.min(
    maxSafeMarginForThisStep,
    Math.max(minStake, desiredMargin)
  );
  const finalAddAmount = Number(
    ((finalStake * lev) / Math.max(1e-8, params.currentPrice)).toFixed(4)
  );

  const newTotalAmt = params.currentAmount + finalAddAmount;
  const simulatedNewAvg =
    (params.openRate * params.currentAmount + params.currentPrice * finalAddAmount) /
    Math.max(1e-8, newTotalAmt);
  const pullDistancePct =
    params.currentPrice > 0
      ? (Math.abs(simulatedNewAvg - params.currentPrice) / params.currentPrice) * 100
      : 0;

  return {
    addAmount: finalAddAmount,
    addStake: Number(finalStake.toFixed(2)),
    targetAvgPrice: Number(simulatedNewAvg.toPrecision(7)),
    pullDistancePct: Number(pullDistancePct.toFixed(2)),
  };
}
