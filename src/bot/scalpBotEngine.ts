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
  trend_strength_score?: number;
  trend_regime?: 'STRONG_TREND' | 'MODERATE_TREND' | 'RANGE_CHOP';
  tp_horizon_long?: '1H' | '4H' | '1D' | '1W';
  tp_horizon_short?: '1H' | '4H' | '1D' | '1W';
  tp_reason_long?: string;
  tp_reason_short?: string;
  chart_targets_long?: Array<{
    price: number;
    level_price: number;
    horizon: '1H' | '4H' | '1D' | '1W';
    label: string;
    strength: number;
    zone_low?: number;
    zone_high?: number;
  }>;
  chart_targets_short?: Array<{
    price: number;
    level_price: number;
    horizon: '1H' | '4H' | '1D' | '1W';
    label: string;
    strength: number;
    zone_low?: number;
    zone_high?: number;
  }>;
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
  max_dca_orders: 2,
  max_position_multiplier: 6.0,
  min_liquidation_distance_pct: 15.0,
  max_margin_used_for_dca_pct: 60.0,
  max_pair_margin_pct: 20.0,
  dca_scale_mode: 'linear',
  dca_pnl_step_pct: 25.0,
  dca_min_level_distance_pct: 20,
  hedge_range_min_pct: 30,
  hedge_range_max_pct: 70,
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
  const maxSnapShift = bandAbs * 0.65;
  const lowBound = Math.max(centerPrice * 0.5, centerPrice - maxSnapShift);
  const highBound = centerPrice + maxSnapShift;
  const probes: number[] = [centerPrice];
  const steps = 20;
  for (let s = 0; s <= steps; s++) {
    const p = lowBound + ((highBound - lowBound) * s) / steps;
    if (p > 0) probes.push(p);
  }

  const touchBand = Math.max(centerPrice * 0.002, bandAbs * 0.35);
  let bestPrice = centerPrice;
  let bestDensity = -Infinity;

  for (const probe of probes) {
    let density = 0;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const bHigh = Math.max(c.open, c.close);
      const bLow = Math.min(c.open, c.close);
      const volWeight = volMean[i] > 0 && c.volume >= volMean[i] * 1.15 ? 1.3 : 1.0;

      // Penalize probes that cut straight through candle bodies (mid-range chop / распил)
      if (bLow < probe - touchBand * 0.35 && bHigh > probe + touchBand * 0.35) {
        density -= 1.45 * volWeight;
        continue;
      }

      // Exact wick rejection or bounce near probe
      if (Math.abs(c.low - probe) <= touchBand || Math.abs(c.high - probe) <= touchBand) {
        density += 1.35 * volWeight;
      }
      // Body shelf (open/close stopping tightly at the boundary)
      if (Math.abs(bLow - probe) <= touchBand * 0.75 || Math.abs(bHigh - probe) <= touchBand * 0.75) {
        density += 0.85 * volWeight;
      }
      // False-breakout recovery: wick swept beyond probe, body closed back inside
      if (
        (c.low < probe - touchBand && bLow >= probe - touchBand * 0.4) ||
        (c.high > probe + touchBand && bHigh <= probe + touchBand * 0.4)
      ) {
        density += 1.15;
      }
    }
    const centerPenalty = (Math.abs(probe - centerPrice) / Math.max(1e-9, bandAbs)) * 0.85;
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
    // Snap seed onto exact max-touch & body-shelf density without dragging into mid-range chop
    const price = snapPriceToClusterDensity(candles, seedPrice, bandAbs * 0.9, volMean);
    const tolAbs = price * (tolPct / 100);
    const zoneLow = price - tolAbs;
    const zoneHigh = price + tolAbs;

    let touches = 0;
    let bounces = 0;
    let breaks = 0;
    let recentCloseCrossings = 0;
    let recentStraddles = 0;
    let recentPivotBounces = 0;
    let supportBounces = 0;
    let resistanceRejections = 0;
    let mirrorRetests = 0;
    let falseBreakouts = 0;
    let reversals = 0;
    let majorSwingReversals = 0;
    let strongVolumeEvents = 0;
    let lastTouchIndex = raw.indices[0] ?? 0;

    let activeRegime: 'ABOVE' | 'BELOW' | 'UNKNOWN' =
      candles[0].close > zoneHigh ? 'ABOVE' : candles[0].close < zoneLow ? 'BELOW' : 'UNKNOWN';
    let flippedFrom: 'ABOVE' | 'BELOW' | null = null;
    let lastEventIdx = -10;
    const recentStartIdx = Math.max(0, n - Math.min(190, Math.max(60, Math.floor(n * 0.45))));
    const pivotStartIdx = Math.max(0, n - Math.min(340, Math.max(90, Math.floor(n * 0.7))));
    let supportViolatingCloses = 0;

    for (let i = 0; i < n; i++) {
      const c = candles[i];
      const localAtr = atr[i] > 0 ? atr[i] : tolAbs;
      const body = Math.abs(c.close - c.open);
      const range = Math.max(1e-9, c.high - c.low);
      const isStrongVol = volMean[i] > 0 && c.volume >= volMean[i] * 1.15;

      if (i >= pivotStartIdx && c.close < zoneLow) {
        supportViolatingCloses += 1;
      }
      if (i >= recentStartIdx) {
        const straddleMargin = Math.max(tolAbs * 0.25, localAtr * 0.18);
        if (c.low < price - straddleMargin && c.high > price + straddleMargin) {
          recentStraddles += 1;
        }
        if (i > recentStartIdx) {
          const prevClose = candles[i - 1].close;
          if ((prevClose < price && c.close >= price) || (prevClose >= price && c.close < price)) {
            recentCloseCrossings += 1;
          }
        }
      }

      // Track decisive closes outside the zone
      const decisiveAbove = c.close > price + Math.max(tolAbs * 0.75, localAtr * 0.38);
      const decisiveBelow = c.close < price - Math.max(tolAbs * 0.75, localAtr * 0.38);

      if (activeRegime === 'ABOVE' && decisiveBelow) {
        const isImpulsiveBreak = body >= localAtr * 0.5 || isStrongVol;
        if (isImpulsiveBreak && i - lastEventIdx >= 2) {
          breaks += 1;
          flippedFrom = 'ABOVE';
          lastEventIdx = i;
        }
        activeRegime = 'BELOW';
      } else if (activeRegime === 'BELOW' && decisiveAbove) {
        const isImpulsiveBreak = body >= localAtr * 0.5 || isStrongVol;
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
        c.low >= price - Math.max(tolAbs * 2.0, localAtr * 1.3) &&
        c.close >= price - tolAbs * 0.4 &&
        (activeRegime === 'ABOVE' || c.open >= price - tolAbs * 0.45 || c.close > c.open);

      const testsFromBelow =
        c.high >= zoneLow &&
        c.high <= price + Math.max(tolAbs * 2.0, localAtr * 1.3) &&
        c.close <= price + tolAbs * 0.4 &&
        (activeRegime === 'BELOW' || c.open <= price + tolAbs * 0.45 || c.close < c.open);

      if (!testsFromAbove && !testsFromBelow) continue;
      if (i - lastEventIdx < 3) continue;

      // Measure lookahead reaction (1..5 candles ahead) and lookback (1..8 candles back)
      const lookahead = candles.slice(i + 1, Math.min(n, i + 6));
      const lookback = candles.slice(Math.max(0, i - 8), i);
      const maxPrevHigh = lookback.length > 0 ? Math.max(...lookback.map((b) => b.high)) : c.high;
      const minPrevLow = lookback.length > 0 ? Math.min(...lookback.map((b) => b.low)) : c.low;

      // Check if candle i is a local 2-bar extremum so passing drift candles don't inflate bounces
      const localWin = candles.slice(Math.max(0, i - 2), Math.min(n, i + 3));
      const isLocalLow = localWin.every((b) => b.low >= c.low - tolAbs * 0.15);
      const isLocalHigh = localWin.every((b) => b.high <= c.high + tolAbs * 0.15);

      let confirmedBounce = false;
      let eventDetected = false;

      if (testsFromAbove) {
        const maxNextHigh =
          lookahead.length > 0 ? Math.max(...lookahead.map((b) => b.high)) : c.close;
        const minNextClose =
          lookahead.length > 0 ? Math.min(...lookahead.map((b) => b.close)) : c.close;
        const stayedSupported = minNextClose >= price - tolAbs * 1.0;
        const bouncedUp = maxNextHigh - price >= Math.max(tolAbs * 0.75, localAtr * 0.65);
        const falseSweep = c.low < zoneLow && c.close >= price - tolAbs * 0.35;

        if (falseSweep && stayedSupported) {
          falseBreakouts += 1;
        }
        if (bouncedUp && stayedSupported && (isLocalLow || maxNextHigh - price >= localAtr * 1.25)) {
          confirmedBounce = true;
          supportBounces += 1;
          if (i >= pivotStartIdx && isLocalLow) {
            recentPivotBounces += 1;
          }
          if (flippedFrom === 'BELOW') {
            mirrorRetests += 1;
            flippedFrom = null;
          }
          if (maxPrevHigh - price >= localAtr * 1.8 && maxNextHigh - price >= localAtr * 1.6) {
            reversals += 1;
            if (maxPrevHigh - price >= localAtr * 2.6 && maxNextHigh - price >= localAtr * 2.4) {
              majorSwingReversals += 1;
            }
          }
        }
        eventDetected = true;
      } else if (testsFromBelow) {
        const minNextLow =
          lookahead.length > 0 ? Math.min(...lookahead.map((b) => b.low)) : c.close;
        const maxNextClose =
          lookahead.length > 0 ? Math.max(...lookahead.map((b) => b.close)) : c.close;
        const stayedResisted = maxNextClose <= price + tolAbs * 1.0;
        const rejectedDown = price - minNextLow >= Math.max(tolAbs * 0.75, localAtr * 0.65);
        const falseSweep = c.high > zoneHigh && c.close <= price + tolAbs * 0.35;

        if (falseSweep && stayedResisted) {
          falseBreakouts += 1;
        }
        if (rejectedDown && stayedResisted && (isLocalHigh || price - minNextLow >= localAtr * 1.25)) {
          confirmedBounce = true;
          resistanceRejections += 1;
          if (i >= pivotStartIdx && isLocalHigh) {
            recentPivotBounces += 1;
          }
          if (flippedFrom === 'ABOVE') {
            mirrorRetests += 1;
            flippedFrom = null;
          }
          if (price - minPrevLow >= localAtr * 1.8 && price - minNextLow >= localAtr * 1.6) {
            reversals += 1;
            if (price - minPrevLow >= localAtr * 2.6 && price - minNextLow >= localAtr * 2.4) {
              majorSwingReversals += 1;
            }
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

    // A level crossed >= 6 times or straddled >= 10 times in the active window is a mid-range chop axis (ось распила)!
    const isChopAxis = recentCloseCrossings >= 6 || recentStraddles >= 10 || breaks >= 4;
    const isTwoSidedMirror =
      !isChopAxis &&
      ((supportBounces >= 1 && resistanceRejections >= 1) || mirrorRetests >= 1);
    const effectiveMirrorCount = isTwoSidedMirror
      ? Math.min(2, Math.max(mirrorRetests, 1))
      : 0;

    const effTouches = Math.max(1, touches);
    const bounceRate = bounces / effTouches;
    const recencyWeight = 1 - (n - 1 - lastTouchIndex) / Math.max(1, n);

    // Reward true outer wave boundaries (clean active-window containment + real pivot bounces)
    const outerBoundaryBonus =
      !isChopAxis && recentPivotBounces >= 2 && recentCloseCrossings <= 3 && recentStraddles <= 6
        ? 6.5
        : !isChopAxis && recentPivotBounces >= 1 && recentCloseCrossings <= 2 && majorSwingReversals >= 1
        ? 4.5
        : !isChopAxis && recentCloseCrossings === 0 && bounces >= 2
        ? 3.2
        : 0;

    // Penalize mid-range chop where price crosses back and forth or slices through the level repeatedly
    const chopPenalty =
      (recentCloseCrossings >= 5 ? (recentCloseCrossings - 4) * 1.65 : 0) +
      (recentStraddles >= 8 ? (recentStraddles - 7) * 0.9 : 0) +
      breaks * 0.85 +
      (currentPrice > 0 && price < currentPrice && supportViolatingCloses >= 8 ? Math.min(8.0, (supportViolatingCloses - 7) * 0.22) : 0);

    const cleanReversals = isChopAxis ? Math.min(2, reversals) : reversals;
    const cleanMajorReversals = isChopAxis ? Math.min(1, majorSwingReversals) : majorSwingReversals;

    const strengthScore =
      Math.min(2.2, consolidationBars * 0.22) +
      Math.min(4.5, bounces * 0.65) +
      Math.min(3.6, recentPivotBounces * 1.2) +
      Math.min(4.0, cleanReversals * 0.9) +
      Math.min(4.5, cleanMajorReversals * 1.5) +
      outerBoundaryBonus +
      Math.min(1.8, strongVolumeEvents * 0.35) +
      effectiveMirrorCount * 1.25 +
      Math.min(1.8, falseBreakouts * 0.6) +
      bounceRate * 1.4 +
      recencyWeight * 0.9 -
      chopPenalty;

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

  // Deduplicate levels within 1.8 * touchTolerancePct, keeping highest strength_score
  const sorted = levels.sort((a, b) => b.strength_score - a.strength_score);
  const deduped: ClusteredLevelWithHistory[] = [];
  const mergeDistPct = Math.max(1.2, touchTolerancePct * 1.8);
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
      : Math.max(0.45, Math.min(3.5, medianAtrPct * 0.34));

  const pivotsBase = findPivots(candles, leftBars, rightBars);
  const majorLeft = Math.max(leftBars + 2, 6);
  const pivotsMajor =
    candles.length >= majorLeft * 2 + 5 ? findPivots(candles, majorLeft, majorLeft) : [];
  const clusteredPivots = clusterPivotsIntoLevels(
    [...pivotsMajor, ...pivotsBase],
    adaptiveTolPct * 1.15
  );
  const seeds: LevelCandidateSeed[] = clusteredPivots.map((c) => ({ ...c, consolidationBars: 0 }));

  const minCBars = options?.minConsolBars ?? (leftBars <= 2 ? 3 : 4);
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
  }

  return analyzeLevelInteractions(candles, seeds, adaptiveTolPct, minPivots);
}

/**
 * Step 2:
 * Takes macro 1W zones and refines their exact price against 1D swing peaks/troughs
 * without dragging them into mid-range daily chop. Also extracts strong 1D levels.
 */
export function refineHigherTimeframeLevels(
  macro1wLevels: ClusteredLevelWithHistory[],
  rawCandles1d: OhlcvCandle[],
  currentPrice: number
): {
  refinedGlobal: ClusteredLevelWithHistory[];
  local1d: ClusteredLevelWithHistory[];
} {
  const candles1d = rawCandles1d ? rawCandles1d.slice(-500) : [];
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
  const dailyTolPct = Math.max(0.85, Math.min(2.4, atr1dPct * 0.34));

  const dailyAll = buildLevelsWithHistory(candles1d, 4, 4, dailyTolPct, 1, {
    minConsolBars: 4,
    maxConsolBars: 14,
  });

  const refinedGlobal: ClusteredLevelWithHistory[] = [];
  const matchRadiusPct = Math.max(2.0, Math.min(3.8, dailyTolPct * 1.7));

  for (const macro of macro1wLevels) {
    const matchedDaily = dailyAll
      .filter(
        (d) =>
          (Math.abs(d.price - macro.price) / Math.max(1e-9, d.price)) * 100 <= matchRadiusPct
      )
      .sort((a, b) => b.strength_score - a.strength_score)[0];

    const distFromCurrentPct =
      currentPrice > 0
        ? (Math.abs(macro.price - currentPrice) / Math.max(1e-9, currentPrice)) * 100
        : 50;

    // Inside the active daily range (<= 25% from currentPrice), require a real 1D structural match
    // so 1W body edges from years ago never invent phantom mid-range levels on 1D!
    if (!matchedDaily && distFromCurrentPct <= 25.0) {
      continue;
    }

    const finalPrice = matchedDaily ? matchedDaily.price : Number(macro.price.toPrecision(7));
    const role: 'support' | 'resistance' =
      currentPrice > 0 ? (finalPrice <= currentPrice ? 'support' : 'resistance') : macro.type;

    const combinedScore = matchedDaily
      ? Number((matchedDaily.strength_score * 0.85 + macro.strength_score * 0.35).toFixed(3))
      : Number((macro.strength_score * 0.95).toFixed(3));

    const dup = refinedGlobal.some(
      (g) => (Math.abs(g.price - finalPrice) / Math.max(1e-9, g.price)) * 100 <= Math.max(3.0, dailyTolPct * 2.0)
    );
    if (!dup) {
      refinedGlobal.push({
        price: finalPrice,
        type: role,
        touches: Math.max(macro.touches, matchedDaily?.touches || 0),
        bounces: Math.max(macro.bounces, matchedDaily?.bounces || 0),
        breaks: matchedDaily?.breaks ?? macro.breaks,
        bounce_rate: matchedDaily?.bounce_rate ?? macro.bounce_rate,
        last_touch_index: matchedDaily?.last_touch_index ?? macro.last_touch_index,
        strength_score: combinedScore,
        source: '1W->1D',
        zone_low: matchedDaily?.zone_low ?? macro.zone_low,
        zone_high: matchedDaily?.zone_high ?? macro.zone_high,
        mirror_retests: Math.max(macro.mirror_retests || 0, matchedDaily?.mirror_retests || 0),
        false_breakouts: Math.max(macro.false_breakouts || 0, matchedDaily?.false_breakouts || 0),
        consolidation_bars: Math.max(macro.consolidation_bars || 0, matchedDaily?.consolidation_bars || 0),
        reversals: Math.max(macro.reversals || 0, matchedDaily?.reversals || 0),
        refined_from_1w: true,
        timeframe_role: 'GLOBAL_1W_1D',
      });
    }
  }

  for (const dLvl of dailyAll) {
    if (dLvl.bounces < 2) continue;
    const exists = refinedGlobal.some(
      (g) => (Math.abs(g.price - dLvl.price) / Math.max(1e-9, g.price)) * 100 <= Math.max(3.2, dailyTolPct * 2.2)
    );
    if (!exists && dLvl.strength_score >= 8.0) {
      refinedGlobal.push({
        ...dLvl,
        type: currentPrice > 0 ? (dLvl.price <= currentPrice ? 'support' : 'resistance') : dLvl.type,
        source: '1D_GLOBAL',
        refined_from_1w: false,
        timeframe_role: 'GLOBAL_1W_1D',
      });
    }
  }

  const local1d: ClusteredLevelWithHistory[] = [];
  for (const dLvl of dailyAll) {
    if (dLvl.bounces < 2) continue;
    const nearGlobal = refinedGlobal.some(
      (g) => (Math.abs(g.price - dLvl.price) / Math.max(1e-9, g.price)) * 100 <= Math.max(3.5, dailyTolPct * 2.2)
    );
    if (!nearGlobal && dLvl.strength_score >= 6.5) {
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

  const activeWindow = isGlobal ? subset : subset.slice(-Math.min(subset.length, 160));
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

  const minDistPct = isGlobal ? 1.8 : 1.3;
  const maxActiveLevelDistPct = isGlobal ? 95.0 : 25.0;
  const medianAtrPct = getMedianAtrPct(subset, 14);
  const tolPct = isGlobal
    ? Math.max(0.85, Math.min(3.2, medianAtrPct * 0.34))
    : Math.max(0.45, Math.min(1.6, medianAtrPct * 0.4));

  const levelsWithHistory = buildLevelsWithHistory(
    subset,
    isGlobal && subset.length < 150 ? 2 : 4,
    isGlobal && subset.length < 150 ? 2 : 4,
    tolPct,
    1,
    { minConsolBars: isGlobal ? 3 : 4, maxConsolBars: isGlobal ? 14 : 12 }
  );

  // Strong reliable boundary: confirmed bounces and NOT sawed through (bounces > breaks)
  const isStrongReliableLevel = (l: ClusteredLevelWithHistory) =>
    l.bounces >= 2 &&
    l.bounces > l.breaks &&
    l.strength_score >= (isGlobal ? 6.0 : 4.5);

  const supportsHistAll = levelsWithHistory.filter(
    (l) => l.type === 'support' && ((currentPrice - l.price) / currentPrice) * 100 >= minDistPct
  );
  const supportsStrong = supportsHistAll.filter(isStrongReliableLevel);
  const supportsBase = supportsStrong.length > 0 ? supportsStrong : supportsHistAll;
  const supportsHistNear = supportsBase.filter(
    (l) => ((currentPrice - l.price) / currentPrice) * 100 <= maxActiveLevelDistPct
  );
  const supportsPool = supportsHistNear.length > 0 ? supportsHistNear : supportsBase;

  const resistancesHistAll = levelsWithHistory.filter(
    (l) => l.type === 'resistance' && ((l.price - currentPrice) / currentPrice) * 100 >= minDistPct
  );
  const resistancesStrong = resistancesHistAll.filter(isStrongReliableLevel);
  const resistancesBase = resistancesStrong.length > 0 ? resistancesStrong : resistancesHistAll;
  const resistancesHistNear = resistancesBase.filter(
    (l) => ((l.price - currentPrice) / currentPrice) * 100 <= maxActiveLevelDistPct
  );
  const resistancesPool =
    resistancesHistNear.length > 0 ? resistancesHistNear : resistancesBase;

  const pickBestGlobalOrLocal = (pool: ClusteredLevelWithHistory[]) => {
    if (pool.length === 0) return null;
    const multiTouch = pool.filter(isStrongReliableLevel);
    const targetPool = multiTouch.length > 0 ? multiTouch : pool;
    if (!isGlobal) {
      return targetPool.reduce((best, cur) => {
        const distBest = (Math.abs(currentPrice - best.price) / Math.max(1e-9, currentPrice)) * 100;
        const distCur = (Math.abs(currentPrice - cur.price) / Math.max(1e-9, currentPrice)) * 100;
        const scoreBest = best.strength_score / (1 + Math.max(0, distBest - 6.0) * 0.035);
        const scoreCur = cur.strength_score / (1 + Math.max(0, distCur - 6.0) * 0.035);
        return scoreCur > scoreBest ? cur : best;
      });
    }
    return targetPool.reduce((best, cur) => {
      const distBest = (Math.abs(currentPrice - best.price) / Math.max(1e-9, currentPrice)) * 100;
      const distCur = (Math.abs(currentPrice - cur.price) / Math.max(1e-9, currentPrice)) * 100;
      const rankBest = best.strength_score / (1 + Math.max(0, distBest - 24) * 0.015);
      const rankCur = cur.strength_score / (1 + Math.max(0, distCur - 24) * 0.015);
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
    else if (rangeLow < currentPrice * 0.985) nearestSupport = rangeLow;
    else nearestSupport = currentPrice * 0.97;
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
    else if (rangeHigh > currentPrice * 1.015) nearestResistance = rangeHigh;
    else nearestResistance = currentPrice * 1.03;
  }

  const rawTp = nearestResistance * 0.9975;
  const recommendedTp = rawTp > currentPrice * 1.015 ? rawTp : currentPrice * 1.022;

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

/**
 * Извлекает ТОЛЬКО самые сильные, нераспиленные уровни поддержки и сопротивления для конкретного таймфрейма (15m, 1h, 4h, 1d, 1w),
 * отсекая уровни внутри бокового распила и уровни вплотную к текущей цене.
 */
export function extractStrongTimeframeLevels(
  candles: OhlcvCandle[],
  timeframe: string,
  currentPrice: number,
  maxPerSide = 1
): {
  supports: ClusteredLevelWithHistory[];
  resistances: ClusteredLevelWithHistory[];
} {
  if (!candles || candles.length < 20 || currentPrice <= 0) {
    return { supports: [], resistances: [] };
  }
  const tf = String(timeframe || '1h').toLowerCase();
  const isHigherTf = tf === '1d' || tf === '1w';
  const isMedTf = tf === '4h' || tf === '6h' || tf === '8h' || tf === '12h';
  const minDistFromPricePct = isHigherTf ? 2.2 : isMedTf ? 1.5 : 1.1;
  const minSeparationPct = isHigherTf ? 6.0 : isMedTf ? 3.5 : 2.2;

  const struct = detectMarketStructure(
    candles,
    Math.min(candles.length, isHigherTf ? 500 : 320),
    isHigherTf
  );
  const strongPool = (struct.all_levels || []).filter(
    (l) =>
      l.bounces >= 2 &&
      l.bounces > l.breaks &&
      l.strength_score >= (isHigherTf ? 6.5 : 4.5)
  );
  const fallbackPool = (struct.all_levels || []).filter(
    (l) =>
      l.bounces >= 1 &&
      l.breaks === 0 &&
      l.strength_score >= (isHigherTf ? 5.0 : 3.5)
  );

  const pickTopSide = (role: 'support' | 'resistance'): ClusteredLevelWithHistory[] => {
    const filterBySide = (pool: ClusteredLevelWithHistory[]) =>
      pool
        .filter((l) => {
          const distPct =
            role === 'support'
              ? ((currentPrice - l.price) / currentPrice) * 100
              : ((l.price - currentPrice) / currentPrice) * 100;
          return distPct >= minDistFromPricePct && distPct <= (isHigherTf ? 65 : 28);
        })
        .sort((a, b) => b.strength_score - a.strength_score);

    let sideCands = filterBySide(strongPool);
    if (sideCands.length === 0) {
      sideCands = filterBySide(fallbackPool);
    }

    const chosen: ClusteredLevelWithHistory[] = [];
    for (const c of sideCands) {
      if (chosen.length >= maxPerSide) break;
      const tooClose = chosen.some(
        (ex) => (Math.abs(ex.price - c.price) / Math.max(1e-9, ex.price)) * 100 < minSeparationPct
      );
      if (!tooClose) {
        chosen.push({
          ...c,
          type: role,
          source: `${tf.toUpperCase()}_STRONG`,
          timeframe_role: isHigherTf ? 'LOCAL_1D' : isMedTf ? 'STRUCT_4H' : 'STRUCT_1H',
        });
      }
    }
    return chosen;
  };

  return {
    supports: pickTopSide('support'),
    resistances: pickTopSide('resistance'),
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

interface ChartTpCandidate {
  price: number;
  level_price: number;
  horizon: '1H' | '4H' | '1D' | '1W';
  label: string;
  strength: number;
  bounces: number;
  breaks: number;
  zone_low?: number;
  zone_high?: number;
}

function computeDirectionalTrendStrength(params: {
  direction: 'long' | 'short';
  w1Trend: string;
  d1Trend: string;
  h4Trend: string;
  h1Trend: string;
  candles1h: OhlcvCandle[];
  candles4h: OhlcvCandle[];
  rsi1h: number;
  rsi4h: number;
  rsi1d: number;
}): { score: number; regime: 'STRONG_TREND' | 'MODERATE_TREND' | 'RANGE_CHOP' } {
  const { direction, w1Trend, d1Trend, h4Trend, h1Trend, candles1h, candles4h, rsi1h, rsi4h, rsi1d } =
    params;
  const isLong = direction === 'long';
  const isStrongMatch = (t: string) => (isLong ? t === 'BULLISH' : t === 'BEARISH');
  const isMildMatch = (t: string) => (isLong ? t === 'MILD_BULLISH' : t === 'MILD_BEARISH');
  const isCounter = (t: string) =>
    isLong
      ? t === 'BEARISH' || t === 'MILD_BEARISH'
      : t === 'BULLISH' || t === 'MILD_BULLISH';

  let score = 30;
  if (isStrongMatch(w1Trend)) score += 12;
  else if (isMildMatch(w1Trend)) score += 6;
  else if (isCounter(w1Trend)) score -= 8;

  if (isStrongMatch(d1Trend)) score += 20;
  else if (isMildMatch(d1Trend)) score += 10;
  else if (isCounter(d1Trend)) score -= 18;

  if (isStrongMatch(h4Trend)) score += 20;
  else if (isMildMatch(h4Trend)) score += 10;
  else if (isCounter(h4Trend)) score -= 15;

  if (isStrongMatch(h1Trend)) score += 14;
  else if (isMildMatch(h1Trend)) score += 7;
  else if (isCounter(h1Trend)) score -= 10;

  // 4H EMA separation & slope confirmation
  if (candles4h.length >= 25) {
    const c4 = candles4h.map((c) => c.close);
    const ema20 = calcEmaSeries(c4, 20);
    const ema50 = calcEmaSeries(c4, Math.min(50, c4.length));
    const cur20 = ema20[ema20.length - 1];
    const prev20 = ema20[Math.max(0, ema20.length - 4)];
    const cur50 = ema50[ema50.length - 1];
    const spreadPct = cur50 > 0 ? ((cur20 - cur50) / cur50) * 100 : 0;
    const slopePct = prev20 > 0 ? ((cur20 - prev20) / prev20) * 100 : 0;
    const directionalSpread = isLong ? spreadPct : -spreadPct;
    const directionalSlope = isLong ? slopePct : -slopePct;
    if (directionalSpread > 0.8 && directionalSlope > 0.25) score += 10;
    else if (directionalSpread > 0.2 && directionalSlope > 0) score += 5;
    else if (directionalSpread < -0.5) score -= 8;
  }

  // RSI momentum runway
  if (isLong) {
    if (rsi4h >= 45 && rsi4h <= 66 && rsi1h <= 70 && rsi1d <= 72) score += 6;
    else if (rsi4h > 72 || rsi1h > 75) score -= 12;
  } else {
    if (rsi4h <= 55 && rsi4h >= 34 && rsi1h >= 30 && rsi1d >= 28) score += 6;
    else if (rsi4h < 28 || rsi1h < 25) score -= 12;
  }

  // 1H recent expansion / impulse
  if (candles1h.length >= 10) {
    const closes1h = candles1h.map((c) => c.close);
    const ema20h = calcEmaSeries(closes1h, 20);
    const curClose = closes1h[closes1h.length - 1];
    const curEma = ema20h[ema20h.length - 1];
    if ((isLong && curClose > curEma) || (!isLong && curClose < curEma)) {
      score += 4;
    }
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const regime: 'STRONG_TREND' | 'MODERATE_TREND' | 'RANGE_CHOP' =
    clamped >= 68 ? 'STRONG_TREND' : clamped >= 45 ? 'MODERATE_TREND' : 'RANGE_CHOP';
  return { score: clamped, regime };
}

function selectChartDrivenTakeProfit(params: {
  direction: 'long' | 'short';
  currentPrice: number;
  regime: 'STRONG_TREND' | 'MODERATE_TREND' | 'RANGE_CHOP';
  trendScore: number;
  candles4h: OhlcvCandle[];
  candles1h: OhlcvCandle[];
  local1hTarget: number;
  keyGlobalTarget: number;
  customLevelTarget?: number;
  structure1hLevels: ClusteredLevelWithHistory[];
  swing1hExtremes: number[];
  structural4hLevels: ClusteredLevelWithHistory[];
  swing4hExtremes: number[];
  local1d: ClusteredLevelWithHistory[];
  refinedGlobal: ClusteredLevelWithHistory[];
}): {
  tp: number;
  horizon: '1H' | '4H' | '1D' | '1W';
  reason: string;
  targets: ChartTpCandidate[];
} {
  const {
    direction,
    currentPrice,
    regime,
    candles4h,
    candles1h,
    local1hTarget,
    keyGlobalTarget,
    customLevelTarget,
    structure1hLevels,
    swing1hExtremes,
    structural4hLevels,
    swing4hExtremes,
    local1d,
    refinedGlobal,
  } = params;

  const isLong = direction === 'long';
  const atr4hPct = candles4h.length >= 14 ? getMedianAtrPct(candles4h, 14) : 0;
  const atr1hPct = candles1h.length >= 14 ? getMedianAtrPct(candles1h, 14) : 0;
  const effectiveAtrPct = Math.max(1.2, atr4hPct || atr1hPct * 1.8 || 1.6);

  // Минимальная структурная дистанция до TP (>= 1.5%..3.0% в зависимости от волатильности монеты),
  // чтобы бот НИКОГДА не ставил тейк-профит вплотную к точке входа (+0.6%..+0.9%)
  const minStructuralDistPct = Math.max(1.5, Math.min(3.0, effectiveAtrPct * 0.78));
  const minCandidateDistPct = 1.25;
  const minSafePrice = isLong
    ? currentPrice * (1 + minCandidateDistPct / 100)
    : currentPrice * (1 - minCandidateDistPct / 100);

  const horizonRank: Record<'1H' | '4H' | '1D' | '1W', number> = {
    '1W': 4,
    '1D': 3,
    '4H': 2,
    '1H': 1,
  };

  // Выставляем TP непосредственно перед самим сильным уровнем (отступ 0.20%..0.35% от ядра уровня),
  // не позволяя широкой зоне 1D/1W (zoneLow/zoneHigh в 2% от уровня) сдвигать TP вплотную к цене входа!
  const toExecPrice = (
    rawLevel: number,
    zoneLow?: number,
    zoneHigh?: number
  ): number => {
    if (isLong) {
      const tightFrontRun = rawLevel * 0.9975;
      if (zoneLow && zoneLow > currentPrice * 1.012) {
        const clampedZoneLow = Math.max(zoneLow, rawLevel * 0.9955);
        return Math.min(tightFrontRun, clampedZoneLow);
      }
      return tightFrontRun;
    } else {
      const tightFrontRun = rawLevel * 1.0025;
      if (zoneHigh && zoneHigh < currentPrice * 0.988) {
        const clampedZoneHigh = Math.min(zoneHigh, rawLevel * 1.0045);
        return Math.max(tightFrontRun, clampedZoneHigh);
      }
      return tightFrontRun;
    }
  };

  const rawCandidates: ChartTpCandidate[] = [];

  const pushLevel = (
    levelPrice: number,
    horizon: '1H' | '4H' | '1D' | '1W',
    label: string,
    strength: number,
    bounces = 2,
    breaks = 0,
    zoneLow?: number,
    zoneHigh?: number
  ) => {
    if (!Number.isFinite(levelPrice) || levelPrice <= 0) return;
    const execPrice = toExecPrice(levelPrice, zoneLow, zoneHigh);
    if (isLong ? execPrice < minSafePrice : execPrice > minSafePrice) return;
    rawCandidates.push({
      price: Number(execPrice.toPrecision(7)),
      level_price: Number(levelPrice.toPrecision(7)),
      horizon,
      label,
      strength,
      bounces,
      breaks,
      zone_low: zoneLow,
      zone_high: zoneHigh,
    });
  };

  if (customLevelTarget && customLevelTarget > 0) {
    pushLevel(customLevelTarget, '1D', 'Ручной уровень графика', 30, 4, 0);
  }
  if (keyGlobalTarget > 0) {
    pushLevel(keyGlobalTarget, '1D', '1W->1D глобальный уровень', 18, 3, 0);
  }

  // Из 1H берём ТОЛЬКО сильные подтверждённые уровни (минимум 2 отбоя или боковик >= 3 свечей, отбоев >= пробоев)
  for (const l of structure1hLevels) {
    const isStrong1h =
      (l.bounces >= 2 || (l.consolidation_bars || 0) >= 3) &&
      (l.bounces >= l.breaks || (l.mirror_retests || 0) >= 1) &&
      (l.strength_score || 0) >= 5.5;
    if (!isStrong1h) continue;
    pushLevel(
      l.price,
      '1H',
      l.consolidation_bars && l.consolidation_bars >= 3 ? '1H сильная зона консолидации' : '1H сильный уровень',
      l.strength_score || 6,
      l.bounces || 2,
      l.breaks || 0,
      l.zone_low,
      l.zone_high
    );
  }

  // Из 4H берём подтверждённые структурные уровни (без случайных одиночных экстремумов возле входа)
  for (const l of structural4hLevels) {
    const isStrong4h =
      (l.bounces >= 2 || (l.consolidation_bars || 0) >= 3) &&
      (l.bounces >= l.breaks || (l.mirror_retests || 0) >= 1) &&
      (l.strength_score || 0) >= 5.0;
    if (!isStrong4h) continue;
    pushLevel(
      l.price,
      '4H',
      l.consolidation_bars && l.consolidation_bars >= 3 ? '4H зона консолидации' : '4H сильный структурный уровень',
      (l.strength_score || 6.5) * 1.35,
      l.bounces || 2,
      l.breaks || 0,
      l.zone_low,
      l.zone_high
    );
  }

  for (const l of local1d) {
    if (l.breaks > l.bounces + 1 && (l.mirror_retests || 0) === 0) continue;
    pushLevel(
      l.price,
      '1D',
      l.consolidation_bars && l.consolidation_bars >= 3 ? '1D зона консолидации' : '1D сильный уровень',
      (l.strength_score || 8) * 1.5,
      l.bounces || 2,
      l.breaks || 0,
      l.zone_low,
      l.zone_high
    );
  }
  for (const l of refinedGlobal) {
    const h: '1D' | '1W' = l.refined_from_1w ? '1W' : '1D';
    pushLevel(
      l.price,
      h,
      l.refined_from_1w ? '1W->1D глобальный уровень' : '1D глобальный уровень',
      (l.strength_score || 10) * 1.75,
      l.bounces || 3,
      l.breaks || 0,
      l.zone_low,
      l.zone_high
    );
  }

  // Дедупликация близких кандидатов в пределах 0.55% (оставляем самый старший и сильный уровень)
  const deduped: ChartTpCandidate[] = [];
  const sortedByAuth = [...rawCandidates].sort((a, b) => {
    if (horizonRank[b.horizon] !== horizonRank[a.horizon]) {
      return horizonRank[b.horizon] - horizonRank[a.horizon];
    }
    return b.strength - a.strength;
  });
  for (const cand of sortedByAuth) {
    const tooClose = deduped.some(
      (ex) => (Math.abs(ex.price - cand.price) / Math.max(1e-9, cand.price)) * 100 < 0.55
    );
    if (!tooClose) deduped.push(cand);
  }

  // Сортируем по траектории движения цены от точки входа
  const ordered = deduped.sort((a, b) => (isLong ? a.price - b.price : b.price - a.price));

  const getDistPct = (p: number) =>
    (Math.abs(p - currentPrice) / Math.max(1e-9, currentPrice)) * 100;

  if (ordered.length === 0) {
    const mult = regime === 'STRONG_TREND' ? 2.6 : regime === 'MODERATE_TREND' ? 1.85 : 1.35;
    const movePct = Math.max(minStructuralDistPct, effectiveAtrPct * mult) / 100;
    const projPrice = Number(
      (isLong ? currentPrice * (1 + movePct) : currentPrice * (1 - movePct)).toPrecision(7)
    );
    return {
      tp: projPrice,
      horizon: regime === 'STRONG_TREND' ? '4H' : '1H',
      reason: `Проекция волатильности (ATR×${mult}) — ход к расчётной зоне сопротивления/поддержки`,
      targets: [],
    };
  }

  // Первая непробиваемая глобальная стена 1D/1W на пути цены (чтобы не ставить TP за железобетонной преградой)
  const firstMajorHtfWall = ordered.find(
    (c) =>
      (c.horizon === '1D' || c.horizon === '1W') &&
      c.bounces >= Math.max(2, c.breaks) &&
      c.strength >= 12 &&
      getDistPct(c.price) >= minStructuralDistPct
  );

  // Отбираем уровни на рабочей структурной дистанции (>= minStructuralDistPct) и не дальше первой капитальной стены 1D/1W
  const structuralPool = ordered.filter((c) => {
    const d = getDistPct(c.price);
    if (d < minStructuralDistPct) return false;
    if (firstMajorHtfWall) {
      if (isLong && c.price > firstMajorHtfWall.price * 1.003) return false;
      if (!isLong && c.price < firstMajorHtfWall.price * 0.997) return false;
    }
    return true;
  });

  const activePool = structuralPool.length > 0 ? structuralPool : ordered;

  // Функция ранжирования цели: выбирает САМЫЙ СИЛЬНЫЙ уровень в целевом диапазоне движения цены
  const pickStrongestTarget = (
    pool: ChartTpCandidate[],
    preferredMaxDistPct: number
  ): ChartTpCandidate => {
    const inRange = pool.filter((c) => getDistPct(c.price) <= preferredMaxDistPct);
    const working = inRange.length > 0 ? inRange : pool;
    return working.reduce((best, cur) => {
      const dBest = getDistPct(best.price);
      const dCur = getDistPct(cur.price);
      const hMultBest = best.horizon === '1W' ? 1.35 : best.horizon === '1D' ? 1.25 : best.horizon === '4H' ? 1.15 : 1.0;
      const hMultCur = cur.horizon === '1W' ? 1.35 : cur.horizon === '1D' ? 1.25 : cur.horizon === '4H' ? 1.15 : 1.0;
      const rankBest =
        (best.strength * hMultBest * (1 + Math.min(0.6, best.bounces * 0.1))) /
        (1 + Math.max(0, dBest - 6.0) * 0.05);
      const rankCur =
        (cur.strength * hMultCur * (1 + Math.min(0.6, cur.bounces * 0.1))) /
        (1 + Math.max(0, dCur - 6.0) * 0.05);
      return rankCur > rankBest ? cur : best;
    });
  };

  let chosen: ChartTpCandidate | undefined;

  if (regime === 'STRONG_TREND') {
    // Сильный тренд: цена идёт к ключевому уровню 1D / 1W / 4H (пробивая мелкие локальные преграды)
    const htfPool = activePool.filter(
      (c) =>
        (c.horizon === '1D' || c.horizon === '1W' || c.horizon === '4H') &&
        getDistPct(c.price) >= Math.max(2.0, minStructuralDistPct)
    );
    chosen =
      firstMajorHtfWall ||
      (htfPool.length > 0 ? pickStrongestTarget(htfPool, 14.0) : pickStrongestTarget(activePool, 12.0));
  } else if (regime === 'MODERATE_TREND') {
    // Умеренный тренд: целимся в самый сильный уровень 4H или 1D в рабочем коридоре (до 9%)
    const medPool = activePool.filter(
      (c) => c.horizon === '4H' || c.horizon === '1D' || c.horizon === '1W'
    );
    chosen =
      medPool.length > 0
        ? pickStrongestTarget(medPool, 9.0)
        : pickStrongestTarget(activePool, 7.5);
  } else {
    // Боковик или контртрендовый отбой от сильного уровня: цена идёт к противоположному сильному уровню 4H/1D/1H канала (до 6.5%)
    const reversalPool = activePool.filter(
      (c) => c.horizon === '4H' || c.horizon === '1D' || c.strength >= 7.0
    );
    chosen =
      reversalPool.length > 0
        ? pickStrongestTarget(reversalPool, 6.5)
        : pickStrongestTarget(activePool, 6.0);
  }

  if (!chosen) chosen = activePool[0] || ordered[0];

  const distPct = getDistPct(chosen.price).toFixed(2);
  const regimeLabel =
    regime === 'STRONG_TREND'
      ? 'сильный тренд'
      : regime === 'MODERATE_TREND'
      ? 'умеренный тренд'
      : 'движение в канале от уровня к уровню';

  return {
    tp: chosen.price,
    horizon: chosen.horizon,
    reason: `${chosen.label} [${chosen.horizon}] @ ${chosen.level_price} (${isLong ? '+' : '-'}${distPct}%, режим: ${regimeLabel})`,
    targets: ordered.slice(0, 12),
  };
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
      ? detectMarketStructure(candles1w.slice(-200), Math.min(200, candles1w.length), true)
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

  // Primary Global Support & Resistance from 1W->1D refined levels within the active trading channel (1.8%..25%)
  const atr1dForGlobal = candles1d.length >= 15 ? getMedianAtrPct(candles1d, 14) : 2.5;
  const minGlobalRoomPct = Math.max(3.5, Math.min(5.8, atr1dForGlobal * 1.35));
  const globalSupports = [
    ...refinedGlobal,
    ...local1d.filter((l) => l.strength_score >= 8.0),
  ].filter((l) => ((currentPrice - l.price) / currentPrice) * 100 >= minGlobalRoomPct);
  const globalResistances = [
    ...refinedGlobal,
    ...local1d.filter((l) => l.strength_score >= 8.0),
  ].filter((l) => ((l.price - currentPrice) / currentPrice) * 100 >= minGlobalRoomPct);

  const pickNearestStrongGlobal = (cands: ClusteredLevelWithHistory[]) => {
    if (cands.length === 0) return null;
    const inActiveChannel = cands.filter((c) => {
      const d = (Math.abs(currentPrice - c.price) / Math.max(1e-9, currentPrice)) * 100;
      return d <= 25.0 && c.strength_score >= 5.0 && c.breaks <= 3;
    });
    const pool = inActiveChannel.length > 0 ? inActiveChannel : cands;
    return pool.reduce((best, cur) => {
      const distBest = (Math.abs(currentPrice - best.price) / Math.max(1e-9, currentPrice)) * 100;
      const distCur = (Math.abs(currentPrice - cur.price) / Math.max(1e-9, currentPrice)) * 100;
      const multBest = best.timeframe_role === 'GLOBAL_1W_1D' ? 1.05 : 1.0;
      const multCur = cur.timeframe_role === 'GLOBAL_1W_1D' ? 1.05 : 1.0;
      const scoreBest = (best.strength_score * multBest) / (1 + Math.max(0, distBest - 22) * 0.03);
      const scoreCur = (cur.strength_score * multCur) / (1 + Math.max(0, distCur - 22) * 0.03);
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
  const nearGlobalSupportForBounce = distTo4hSupPct <= 2.5 || pos4hPct <= 25.0;
  const nearGlobalResistanceForRejection = distTo4hResPct <= 2.5 || pos4hPct >= 75.0;

  if (
    rsi1h > 85.0 ||
    (rsi4h > maxAllowedRsiForLong && rsi1d > 75.0) ||
    (rsi1d > maxAllowedRsiForLong && rsi1h > 75.0)
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
  } else if (marketTrend === 'BEARISH' && !nearGlobalSupportForBounce) {
    allowLong = false;
    rejectionReasonLong = `Медвежий тренд рынка (1D=${d1Trend}, 4H=${h4Trend}, 1H=${h1Trend}) — вход в LONG вне сильной поддержки заблокирован`;
  }

  let allowShort = true;
  let rejectionReasonShort = '';

  const minAllowedRsiForShort = 20.0;

  if (
    rsi1h < 15.0 ||
    (rsi4h < minAllowedRsiForShort && rsi1d < 25.0) ||
    (rsi1d < minAllowedRsiForShort && rsi1h < 25.0)
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
  } else if (marketTrend === 'BULLISH' && !nearGlobalResistanceForRejection) {
    allowShort = false;
    rejectionReasonShort = `Бычий тренд рынка (1D=${d1Trend}, 4H=${h4Trend}, 1H=${h1Trend}) — вход в SHORT вне сильного сопротивления заблокирован`;
  }

  // Chart-Driven TP selection based on trend strength (1H/4H locally in chop/moderate trend, 1D/1W globally in strong trend)
  const longStrength = computeDirectionalTrendStrength({
    direction: 'long',
    w1Trend,
    d1Trend,
    h4Trend,
    h1Trend,
    candles1h,
    candles4h,
    rsi1h,
    rsi4h,
    rsi1d,
  });
  const shortStrength = computeDirectionalTrendStrength({
    direction: 'short',
    w1Trend,
    d1Trend,
    h4Trend,
    h1Trend,
    candles1h,
    candles4h,
    rsi1h,
    rsi4h,
    rsi1d,
  });

  const longTpPlan = selectChartDrivenTakeProfit({
    direction: 'long',
    currentPrice,
    regime: longStrength.regime,
    trendScore: longStrength.score,
    candles4h,
    candles1h,
    local1hTarget: local1hResistance,
    keyGlobalTarget: key4hResistance,
    customLevelTarget: hasCustomRes ? Number(customLevels!.resistance) : undefined,
    structure1hLevels: structure1h.all_levels || [],
    swing1hExtremes: structure1h.swing_highs || [],
    structural4hLevels,
    swing4hExtremes: structure4h.swing_highs || [],
    local1d,
    refinedGlobal,
  });
  const recTpLong = longTpPlan.tp;

  const safeSupport = Math.min(key4hSupport, local1hSupport);
  let recSlLong = safeSupport * 0.996;
  const slDistPctLong = currentPrice > 0 ? ((currentPrice - recSlLong) / currentPrice) * 100.0 : 0;
  if (slDistPctLong < 0.8) recSlLong = currentPrice * 0.985;
  else if (slDistPctLong > 4.5) recSlLong = currentPrice * 0.96;

  const shortTpPlan = selectChartDrivenTakeProfit({
    direction: 'short',
    currentPrice,
    regime: shortStrength.regime,
    trendScore: shortStrength.score,
    candles4h,
    candles1h,
    local1hTarget: local1hSupport,
    keyGlobalTarget: key4hSupport,
    customLevelTarget: hasCustomSup ? Number(customLevels!.support) : undefined,
    structure1hLevels: structure1h.all_levels || [],
    swing1hExtremes: structure1h.swing_lows || [],
    structural4hLevels,
    swing4hExtremes: structure4h.swing_lows || [],
    local1d,
    refinedGlobal,
  });
  const recTpShort = shortTpPlan.tp;

  const dominantTrendStrength =
    marketTrend === 'BEARISH'
      ? shortStrength
      : marketTrend === 'BULLISH'
      ? longStrength
      : longStrength.score >= shortStrength.score
      ? longStrength
      : shortStrength;

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
    trend_strength_score: dominantTrendStrength.score,
    trend_regime: dominantTrendStrength.regime,
    tp_horizon_long: longTpPlan.horizon,
    tp_horizon_short: shortTpPlan.horizon,
    tp_reason_long: longTpPlan.reason,
    tp_reason_short: shortTpPlan.reason,
    chart_targets_long: longTpPlan.targets,
    chart_targets_short: shortTpPlan.targets,
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
  candles1w?: OhlcvCandle[],
  previousDcaExtremePrice?: number
): {
  price: number;
  second_price: number;
  strength_score: number;
  bounces: number;
  breaks: number;
  source: string;
  type: 'support' | 'resistance';
} {
  const hasPrevExtreme =
    typeof previousDcaExtremePrice === 'number' &&
    Number.isFinite(previousDcaExtremePrice) &&
    previousDcaExtremePrice > 0;
  const anchorPrice = hasPrevExtreme
    ? isShort
      ? Math.max(referencePrice, previousDcaExtremePrice!)
      : Math.min(referencePrice, previousDcaExtremePrice!)
    : referencePrice;
  const effectiveMinDistPct = Math.max(hasPrevExtreme ? 3.4 : 3.0, minDistPct);
  if (anchorPrice <= 0) {
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
      anchorPrice
    );
    for (const g of refinedGlobal) {
      allCandidates.push({
        ...g,
        strength_score: Number((g.strength_score * 1.35).toFixed(3)),
        source: g.refined_from_1w ? '1W_1D_GLOBAL' : '1D_GLOBAL',
      });
    }
    for (const l of local1d) {
      allCandidates.push({
        ...l,
        strength_score: Number((l.strength_score * 1.1).toFixed(3)),
        source: '1D_LOCAL',
      });
    }
  } else if (macro1wLevels.length > 0) {
    for (const g of macro1wLevels) {
      allCandidates.push({
        ...g,
        strength_score: Number((g.strength_score * 1.35).toFixed(3)),
        source: '1W_GLOBAL',
      });
    }
  }

  // 2. Сильные структурные уровни 4H (только с подтверждёнными отбоями >= 2 или консолидацией >= 3 свечей)
  if (candles4h && candles4h.length >= 20) {
    const struct4h = detectMarketStructure(candles4h, Math.min(320, candles4h.length), false);
    for (const lvl of struct4h.all_levels) {
      if ((lvl.bounces || 0) < 2 && (lvl.consolidation_bars || 0) < 3) continue;
      allCandidates.push({
        ...lvl,
        strength_score: Number((lvl.strength_score * 0.85).toFixed(3)),
        source: '4H_STRUCT',
      });
    }
  }

  // Фильтруем кандидатов для DCA: строго >= effectiveMinDistPct дальше от anchorPrice (и от цены входа, и от предыдущего DCA!), <= maxDistPct
  const targetRole: 'support' | 'resistance' = isShort ? 'resistance' : 'support';
  const allDirectionalLevels = allCandidates
    .filter((lvl) => {
      const distPct = !isShort
        ? ((anchorPrice - lvl.price) / anchorPrice) * 100.0
        : ((lvl.price - anchorPrice) / anchorPrice) * 100.0;
      return distPct >= effectiveMinDistPct && distPct <= maxDistPct;
    })
    .map((lvl) => ({ ...lvl, type: targetRole }));

  const strongReliableLevels = allDirectionalLevels.filter(
    (lvl) =>
      lvl.strength_score >= 5.5 &&
      (lvl.bounces >= 2 || (lvl.consolidation_bars || 0) >= 3) &&
      (lvl.bounces >= lvl.breaks || (lvl.mirror_retests || 0) >= 1)
  );
  const validLevels = strongReliableLevels.length > 0 ? strongReliableLevels : allDirectionalLevels;

  if (validLevels.length > 0) {
    // Для следующего DCA ищем САМЫЙ СИЛЬНЫЙ уровень поддержки/сопротивления в рабочем коридоре от anchorPrice
    const reachableLevels = validLevels.filter((l) => {
      const dist = (Math.abs(anchorPrice - l.price) / anchorPrice) * 100;
      return dist >= effectiveMinDistPct && dist <= 18.0;
    });
    const candidateLevels = reachableLevels.length > 0 ? reachableLevels : validLevels;
    const primaryPool = candidateLevels.filter(
      (l) =>
        (l.source?.includes('GLOBAL') && l.strength_score >= 6.0) ||
        (l.source === '1D_LOCAL' &&
          l.strength_score >= 6.5 &&
          (l.bounces >= 2 || (l.mirror_retests || 0) > 0)) ||
        (l.source === '4H_STRUCT' && l.strength_score >= 6.5 && l.bounces >= 3)
    );
    const poolToRank = primaryPool.length > 0 ? primaryPool : candidateLevels;

    const scoreDcaLevel = (l: ClusteredLevelWithHistory, refPx: number) => {
      const dist = (Math.abs(refPx - l.price) / Math.max(1e-9, refPx)) * 100;
      const bounceBoost = 1 + Math.min(0.7, (l.bounces || 1) * 0.1);
      const mirrorBoost = (l.mirror_retests || 0) > 0 ? 1.15 : 1.0;
      // Выбираем самый сильный уровень без искусственного штрафа за дистанцию внутри 3%..8% зоны
      return (
        (l.strength_score * bounceBoost * mirrorBoost) /
        (1 + Math.max(0, dist - 8.0) * 0.05)
      );
    };

    const bestFirst = poolToRank.reduce((best, cur) =>
      scoreDcaLevel(cur, anchorPrice) > scoreDcaLevel(best, anchorPrice) ? cur : best
    );

    // Для DCA 2 ищем следующий самый сильный уровень 1W/1D/4H дальше DCA 1 (минимум на 3.2% дальше DCA 1), либо исторический экстремум
    const absExtreme = isShort ? absHighest : absLowest;
    let secondPrice = 0;

    const furtherCandidates = validLevels
      .filter((l) => {
        const distFromFirst = isShort
          ? ((l.price - bestFirst.price) / bestFirst.price) * 100
          : ((bestFirst.price - l.price) / bestFirst.price) * 100;
        return distFromFirst >= Math.max(3.2, effectiveMinDistPct) && distFromFirst <= 28.0;
      })
      .sort((a, b) => scoreDcaLevel(b, bestFirst.price) - scoreDcaLevel(a, bestFirst.price));

    if (furtherCandidates.length > 0) {
      secondPrice = Number(furtherCandidates[0].price.toPrecision(7));
    } else if (
      Number.isFinite(absExtreme) &&
      absExtreme > 0 &&
      (isShort
        ? absExtreme > bestFirst.price * 1.02 && absExtreme <= bestFirst.price * 1.3
        : absExtreme < bestFirst.price * 0.98 && absExtreme >= bestFirst.price * 0.7)
    ) {
      secondPrice = Number(absExtreme.toPrecision(7));
    } else {
      secondPrice = Number(
        (
          bestFirst.price *
          (isShort ? 1 + Math.max(0.04, effectiveMinDistPct / 100) : 1 - Math.max(0.04, effectiveMinDistPct / 100))
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
    (anchorPrice * (isShort ? 1 + fallbackStepPct : 1 - fallbackStepPct)).toPrecision(7)
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
  dominant_trend: 'BULLISH' | 'BEARISH';
  primary_side: 'long' | 'short';
  insurance_side: 'long' | 'short';
  primary_stake_multiplier: number;
  insurance_stake_multiplier: number;
  long_stake_multiplier: number;
  short_stake_multiplier: number;
  air_to_support_pct: number;
  air_to_resistance_pct: number;
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
      dominant_trend: 'BULLISH',
      primary_side: 'long',
      insurance_side: 'short',
      primary_stake_multiplier: 1.0,
      insurance_stake_multiplier: 0.5,
      long_stake_multiplier: 1.0,
      short_stake_multiplier: 0.5,
      air_to_support_pct: 0,
      air_to_resistance_pct: 0,
      reason: 'Недостаточно истории 4H/1D для среднесрочного 2-стороннего входа',
    };
  }

  const globalSup = mtf.key_4h_support;
  const globalRes = mtf.key_4h_resistance;
  const channelWidthPct =
    globalRes > globalSup ? ((globalRes - globalSup) / currentPrice) * 100.0 : 0;

  const airToSupPct =
    currentPrice > 0 && globalSup > 0
      ? Math.max(0, ((currentPrice - globalSup) / currentPrice) * 100.0)
      : Math.max(0, mtf.dist_to_4h_sup_pct || 0);
  const airToResPct =
    currentPrice > 0 && globalRes > currentPrice
      ? Math.max(0, ((globalRes - currentPrice) / currentPrice) * 100.0)
      : Math.max(0, mtf.dist_to_4h_res_pct || 0);

  // Определение доминирующего тренда на старшем ТФ (Раздел 1.2 и 2.2):
  // Основная нога (1.0x V) открывается по тренду, Страховочная нога (0.5x V) — против тренда (перевес 2:1)
  const isBearishDominant =
    mtf.market_trend === 'BEARISH' ||
    (mtf.market_trend === 'NEUTRAL' &&
      (mtf.d1_trend === 'BEARISH' ||
        mtf.d1_trend === 'MILD_BEARISH' ||
        mtf.h4_trend === 'BEARISH' ||
        (mtf.h4_trend === 'MILD_BEARISH' && mtf.rsi_4h < 48)));
  const dominantTrend: 'BULLISH' | 'BEARISH' = isBearishDominant ? 'BEARISH' : 'BULLISH';
  const primarySide: 'long' | 'short' = dominantTrend === 'BEARISH' ? 'short' : 'long';
  const insuranceSide: 'long' | 'short' = primarySide === 'long' ? 'short' : 'long';
  const primaryStakeMult = 1.0;
  const insuranceStakeMult = 0.5;

  // Раздел 2.2 — Правило «Запаса хода» (Фильтр середины диапазона):
  // Категорически запрещено открывать замок вплотную к сильному уровню (Лонг под сопротивлением или Шорт над поддержкой).
  // Вход разрешён только в середине диапазона (25%..75%) при наличии «воздуха» >= 1.4% в обе стороны и ширине коридора >= 3.0%.
  const posPct = Number.isFinite(mtf.pos_4h_pct) ? mtf.pos_4h_pct : 50;
  const inMidRangeCorridor = posPct >= 25.0 && posPct <= 75.0;
  const hasEnoughAirBothSides = airToSupPct >= 1.4 && airToResPct >= 1.4;
  const safeRsiZone =
    mtf.rsi_1d >= 18.0 &&
    mtf.rsi_1d <= 82.0 &&
    mtf.rsi_4h >= 18.0 &&
    mtf.rsi_4h <= 82.0 &&
    mtf.rsi_1h >= 18.0 &&
    mtf.rsi_1h <= 82.0;
  const noExtremeImpulse = btcIsSafe && !isKnifeDrop(candles1h) && !isPumpExhaustion(candles1h);

  const shouldEnter =
    channelWidthPct >= 3.0 &&
    inMidRangeCorridor &&
    hasEnoughAirBothSides &&
    safeRsiZone &&
    noExtremeImpulse;

  // Цели TP для хеджа по сильным уровням канала 4H/1D (уровни $L_1$ по тренду и против тренда)
  const minSafeLongHedgeTp = currentPrice * 1.012;
  const minSafeShortHedgeTp = currentPrice * 0.988;
  const htfLongTarget = mtf.chart_targets_long?.find(
    (c) => (c.horizon === '4H' || c.horizon === '1D' || c.horizon === '1W') && c.price >= minSafeLongHedgeTp
  )?.price;
  const htfShortTarget = mtf.chart_targets_short?.find(
    (c) => (c.horizon === '4H' || c.horizon === '1D' || c.horizon === '1W') && c.price <= minSafeShortHedgeTp
  )?.price;
  const rawLongTarget = globalRes > currentPrice ? globalRes * 0.997 : mtf.recommended_tp_long;
  const rawShortTarget = globalSup > 0 && globalSup < currentPrice ? globalSup * 1.003 : mtf.recommended_tp_short;
  const chosenLongHedgeTp = htfLongTarget && htfLongTarget < rawLongTarget ? htfLongTarget : rawLongTarget;
  const chosenShortHedgeTp = htfShortTarget && htfShortTarget > rawShortTarget ? htfShortTarget : rawShortTarget;
  const longTpPrice = Number(Math.max(minSafeLongHedgeTp, chosenLongHedgeTp).toPrecision(7));
  const shortTpPrice = Number(Math.min(minSafeShortHedgeTp, chosenShortHedgeTp).toPrecision(7));

  const longDca = findStrongestDcaLevel(candles4h, candles1d, currentPrice, false, 3.0, 95.0, candles1w);
  const shortDca = findStrongestDcaLevel(candles4h, candles1d, currentPrice, true, 3.0, 95.0, candles1w);
  const horizonLabel: 'MEDIUM_TERM_4H' | 'LONG_TERM_1D' =
    channelWidthPct >= 6.0 ? 'LONG_TERM_1D' : 'MEDIUM_TERM_4H';

  let rejectDetail = '';
  if (!shouldEnter) {
    if (channelWidthPct < 3.0) {
      rejectDetail = `узкий коридор ${channelWidthPct.toFixed(1)}% (< 3.0%)`;
    } else if (!inMidRangeCorridor || !hasEnoughAirBothSides) {
      rejectDetail = `нарушено правило запаса хода (поз. ${posPct.toFixed(0)}%, воздух до SUP=${airToSupPct.toFixed(2)}%, до RES=${airToResPct.toFixed(2)}%)`;
    } else if (!noExtremeImpulse) {
      rejectDetail = `импульсный пролив/памп или фильтр BTC`;
    } else {
      rejectDetail = `экстремальный RSI вне рабочей зоны`;
    }
  }

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
    dominant_trend: dominantTrend,
    primary_side: primarySide,
    insurance_side: insuranceSide,
    primary_stake_multiplier: primaryStakeMult,
    insurance_stake_multiplier: insuranceStakeMult,
    long_stake_multiplier: primarySide === 'long' ? primaryStakeMult : insuranceStakeMult,
    short_stake_multiplier: primarySide === 'short' ? primaryStakeMult : insuranceStakeMult,
    air_to_support_pct: Number(airToSupPct.toFixed(2)),
    air_to_resistance_pct: Number(airToResPct.toFixed(2)),
    reason: shouldEnter
      ? `Асимметричный 2:1 Хедж (${dominantTrend}: основная ${primarySide.toUpperCase()} 1.0x + страховочная ${insuranceSide.toUpperCase()} 0.5x): коридор [${globalSup} .. ${globalRes}] (${channelWidthPct.toFixed(1)}%), поз. ${posPct.toFixed(0)}% (запас хода -${airToSupPct.toFixed(1)}% / +${airToResPct.toFixed(1)}%)`
      : `Вход в хедж отклонён: ${rejectDetail}`,
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
// 7. ASYMMETRIC LEVEL HEDGE WITH REVERSAL AVERAGING:
//    • 3-Phase Level Reversal Detector (Section 3: Sweep -> Pin-Bar/Engulfing -> ChoCH)
//    • Basket Convergence Breakeven & Unloading Hierarchy (Section 5A, 5B, 5C)
//    • Tail-Biting Partial Unloading ("Откусывание хвоста", Section 5C)
//    • 6-Point DCA Risk & Taboo Guard (Section 6)
// ============================================================================

export interface ThreePhaseReversalResult {
  confirmed: boolean;
  phase1Sweep: boolean;
  phase2Braking: boolean;
  phase3StructureBreak: boolean;
  wickExtremePrice: number;
  rehedgeStopPrice: number;
  whipsawStopPrice: number;
  reason: string;
}

/**
 * Раздел 3 регламента: Трёхфазное подтверждение разворота на сильном уровне (S/R).
 * Касание уровня НЕ является сигналом. Действие (фиксация страховочной ноги + усреднение основной ноги)
 * разрешено ТОЛЬКО после прохождения 3 фаз:
 *   Фаза 1 (Sweep / Захват ликвидности): тень свечи заходит в зону уровня или прокалывает его (на повышенном объёме / сборе стопов).
 *   Фаза 2 (Возврат и торможение — Пин-бар / Поглощение): тело закрывается обратно внутри уровня с отвергающей тенью, либо формируется поглощение.
 *   Фаза 3 (Локальный слом структуры / ChoCH): закрытая свеча подтверждает импульс отскока, пробивая экстремум/тело тормозящей свечи, при отсутствии вертикального «ножа» (Сценарий 5).
 */
export function detectThreePhaseLevelReversal(
  candles: OhlcvCandle[],
  level: number,
  isBounceFromSupport: boolean,
  tolerancePct = 0.85,
  zoneBounds?: { zoneLow?: number; zoneHigh?: number }
): ThreePhaseReversalResult {
  const emptyRes = (reason: string): ThreePhaseReversalResult => ({
    confirmed: false,
    phase1Sweep: false,
    phase2Braking: false,
    phase3StructureBreak: false,
    wickExtremePrice: level,
    rehedgeStopPrice: isBounceFromSupport ? level * 0.995 : level * 1.005,
    whipsawStopPrice: isBounceFromSupport ? level * 1.003 : level * 0.997,
    reason,
  });

  if (!candles || candles.length < 4 || !(level > 0)) {
    return emptyRes('Недостаточно свечей для 3-фазного подтверждения разворота');
  }

  // Сценарий 5 (Новостной сквиз / пролёт уровня без торможения):
  // если прямо сейчас летит вертикальный нож или безоткатная палка — уровень пропускается!
  if (isBounceFromSupport && isKnifeDrop(candles)) {
    return emptyRes('Сценарий 5 (Анти-нож): вертикальный пролив без торможения — уровень пропускается');
  }
  if (!isBounceFromSupport && isPumpExhaustion(candles)) {
    return emptyRes('Сценарий 5 (Анти-памп): вертикальный памп без торможения — уровень пропускается');
  }

  const n = candles.length;
  const cNow = candles[n - 1];
  const cPrev = candles[n - 2];
  const cPrev2 = candles[n - 3];
  const recentWindow = [cPrev2, cPrev, cNow];

  const volumes = candles.slice(-20).map((c) => c.volume || 0);
  const avgVol =
    volumes.length > 0 ? volumes.reduce((s, v) => s + v, 0) / volumes.length : 0;

  if (isBounceFromSupport) {
    const zoneTop =
      zoneBounds?.zoneHigh && zoneBounds.zoneHigh > level
        ? zoneBounds.zoneHigh
        : level * (1 + tolerancePct / 100.0);
    const zoneBot =
      zoneBounds?.zoneLow && zoneBounds.zoneLow > 0 && zoneBounds.zoneLow < level
        ? zoneBounds.zoneLow
        : level * (1 - tolerancePct / 100.0);

    const lowestWick = Math.min(...recentWindow.map((c) => c.low));
    const maxRecentVol = Math.max(...recentWindow.map((c) => c.volume || 0));

    // Фаза 1: Захват ликвидности (Sweep) — цена зашла в зону поддержки или кольнула тенью под уровень
    const touchedZone = lowestWick <= zoneTop;
    const sweptLiquidity =
      lowestWick <= level * 1.003 ||
      lowestWick <= zoneBot * 1.005 ||
      (touchedZone && (avgVol <= 0 || maxRecentVol >= avgVol * 0.8));
    const phase1Sweep = touchedZone && sweptLiquidity;

    // Фаза 2: Возврат и торможение (Пин-бар с нижней тенью или бычье поглощение, закрытие тела выше/внутри уровня)
    const hasPinBarRejection = recentWindow.some((c) => {
      const range = Math.max(1e-9, c.high - c.low);
      const body = Math.abs(c.close - c.open);
      const lowerWick = Math.min(c.open, c.close) - c.low;
      return (
        c.low <= zoneTop &&
        c.close >= zoneBot * 0.998 &&
        (lowerWick / range >= 0.25 || lowerWick >= body * 0.6)
      );
    });
    const hasBullishEngulfing =
      (cNow.close > cNow.open &&
        cPrev.close < cPrev.open &&
        cNow.close >= cPrev.open &&
        cPrev.low <= zoneTop) ||
      (cPrev.close > cPrev.open &&
        cPrev2.close < cPrev2.open &&
        cPrev.close >= cPrev2.open &&
        cPrev2.low <= zoneTop);
    const returnedAboveLevel = cNow.close >= level * 0.9975 && cNow.close >= zoneBot;
    const phase2Braking =
      phase1Sweep && returnedAboveLevel && (hasPinBarRejection || hasBullishEngulfing);

    // Фаза 3: Локальный слом структуры (ChoCH / подтверждающая закрытая бычья свеча вверх от уровня)
    const brokePrevHighOrBody =
      cNow.close > cNow.open &&
      (cNow.close > cPrev.high ||
        cNow.close > Math.max(cPrev.open, cPrev.close) ||
        (cPrev.close > cPrev.open && cNow.close > cPrev.close && cNow.low >= cPrev.low));
    const phase3StructureBreak = phase2Braking && brokePrevHighOrBody;

    // Защитный стоп-ордер (Re-Hedge) ставится за тень разворотной свечи (-0.25% под экстремум тени)
    const rehedgeStopPrice = Number((lowestWick * (1 - 0.0025)).toPrecision(7));
    // Короткий стоп от распила для новой страховочной ноги (если уровень пробили, но цена резко вернулась выше уровня)
    const whipsawStopPrice = Number((Math.max(level, zoneTop) * (1 + 0.0025)).toPrecision(7));

    const confirmed = phase1Sweep && phase2Braking && phase3StructureBreak;
    return {
      confirmed,
      phase1Sweep,
      phase2Braking,
      phase3StructureBreak,
      wickExtremePrice: Number(lowestWick.toPrecision(7)),
      rehedgeStopPrice,
      whipsawStopPrice,
      reason: confirmed
        ? `3-фазный разворот от поддержки ${level}$ подтверждён (Sweep до ${lowestWick.toPrecision(6)}$ -> Пин-бар/Поглощение -> Слом структуры ChoCH @ ${cNow.close}$)`
        : `Ожидание 3 фаз разворота у поддержки ${level}$ (Фаза1=${phase1Sweep}, Фаза2=${phase2Braking}, Фаза3=${phase3StructureBreak})`,
    };
  } else {
    const zoneBot =
      zoneBounds?.zoneLow && zoneBounds.zoneLow > 0 && zoneBounds.zoneLow < level
        ? zoneBounds.zoneLow
        : level * (1 - tolerancePct / 100.0);
    const zoneTop =
      zoneBounds?.zoneHigh && zoneBounds.zoneHigh > level
        ? zoneBounds.zoneHigh
        : level * (1 + tolerancePct / 100.0);

    const highestWick = Math.max(...recentWindow.map((c) => c.high));
    const maxRecentVol = Math.max(...recentWindow.map((c) => c.volume || 0));

    // Фаза 1: Захват ликвидности (Sweep) — цена зашла в зону сопротивления или кольнула тенью над уровнем
    const touchedZone = highestWick >= zoneBot;
    const sweptLiquidity =
      highestWick >= level * 0.997 ||
      highestWick >= zoneTop * 0.995 ||
      (touchedZone && (avgVol <= 0 || maxRecentVol >= avgVol * 0.8));
    const phase1Sweep = touchedZone && sweptLiquidity;

    // Фаза 2: Возврат и торможение (Пин-бар с верхней тенью или медвежье поглощение, закрытие тела под уровнем)
    const hasPinBarRejection = recentWindow.some((c) => {
      const range = Math.max(1e-9, c.high - c.low);
      const body = Math.abs(c.close - c.open);
      const upperWick = c.high - Math.max(c.open, c.close);
      return (
        c.high >= zoneBot &&
        c.close <= zoneTop * 1.002 &&
        (upperWick / range >= 0.25 || upperWick >= body * 0.6)
      );
    });
    const hasBearishEngulfing =
      (cNow.close < cNow.open &&
        cPrev.close > cPrev.open &&
        cNow.close <= cPrev.open &&
        cPrev.high >= zoneBot) ||
      (cPrev.close < cPrev.open &&
        cPrev2.close > cPrev2.open &&
        cPrev.close <= cPrev2.open &&
        cPrev2.high >= zoneBot);
    const returnedBelowLevel = cNow.close <= level * 1.0025 && cNow.close <= zoneTop;
    const phase2Braking =
      phase1Sweep && returnedBelowLevel && (hasPinBarRejection || hasBearishEngulfing);

    // Фаза 3: Локальный слом структуры вниз (ChoCH / подтверждающая закрытая медвежья свеча вниз от уровня)
    const brokePrevLowOrBody =
      cNow.close < cNow.open &&
      (cNow.close < cPrev.low ||
        cNow.close < Math.min(cPrev.open, cPrev.close) ||
        (cPrev.close < cPrev.open && cNow.close < cPrev.close && cNow.high <= cPrev.high));
    const phase3StructureBreak = phase2Braking && brokePrevLowOrBody;

    // Защитный стоп-ордер (Re-Hedge) ставится за верхнюю тень разворотной свечи (+0.25% над экстремумом тени)
    const rehedgeStopPrice = Number((highestWick * (1 + 0.0025)).toPrecision(7));
    // Короткий стоп от распила для новой страховочной ноги (если уровень пробили вверх, но цена резко вернулась под уровень)
    const whipsawStopPrice = Number((Math.min(level, zoneBot) * (1 - 0.0025)).toPrecision(7));

    const confirmed = phase1Sweep && phase2Braking && phase3StructureBreak;
    return {
      confirmed,
      phase1Sweep,
      phase2Braking,
      phase3StructureBreak,
      wickExtremePrice: Number(highestWick.toPrecision(7)),
      rehedgeStopPrice,
      whipsawStopPrice,
      reason: confirmed
        ? `3-фазный разворот от сопротивления ${level}$ подтверждён (Sweep до ${highestWick.toPrecision(6)}$ -> Пин-бар/Поглощение -> Слом структуры ChoCH @ ${cNow.close}$)`
        : `Ожидание 3 фаз разворота у сопротивления ${level}$ (Фаза1=${phase1Sweep}, Фаза2=${phase2Braking}, Фаза3=${phase3StructureBreak})`,
    };
  }
}

export interface BasketConvergenceResult {
  exactZeroCyclePrice: number;
  targetCycleExitPrice: number;
  unloadingFloorPrice: number;
  totalCostsUsdt: number;
  targetNetProfitUsdt: number;
  bankedProfitUsdt: number;
  netRequiredFromPrimaryUsdt: number;
  priceShiftFromBankedProfit: number;
  exitPriorityMode: 'PURE_PROFIT_L0' | 'CONVERGENCE_PROFIT_L1' | 'UNLOADING_PRIORITY_L2';
}

/**
 * Раздел 5А, 5Б, 5В регламента:
 * Формула расчёта единого безубытка корзины (Basket Convergence Breakeven) с учётом накопленного банка P_bank,
 * всех комиссий (открытие + усреднения + закрытие + буфер фандинга/проскальзывания) и иерархии целей выхода.
 *
 * P_exit = P_avg - (P_bank - F_total - T_net) / Q_main   (для LONG основной ноги)
 * P_exit = P_avg + (P_bank - F_total - T_net) / Q_main   (для SHORT основной ноги)
 */
export function calculateBasketConvergenceBreakeven(params: {
  openRate: number;
  amount: number;
  isShort: boolean;
  bankedProfitUsdt?: number;
  feeOpenUsdt?: number;
  feeRate?: number;
  dcaCount?: number;
  stakeAmount?: number;
  slippageBufferPct?: number;
}): BasketConvergenceResult {
  const pAvg = Math.max(1e-8, Number(params.openRate || 0));
  const qMain = Math.max(1e-8, Number(params.amount || 0));
  const isShort = Boolean(params.isShort);
  const pBank = Math.max(0, Number(params.bankedProfitUsdt || 0));
  const feeRate = Math.max(0.0002, Number(params.feeRate ?? 0.0006));
  const dcaCount = Math.max(0, Number(params.dcaCount || 0));
  const stakeAmount = Math.max(1, Number(params.stakeAmount || (pAvg * qMain) / 25));
  const slippagePct = Math.max(0.0012, Number(params.slippageBufferPct ?? 0.0018));

  const notional = pAvg * qMain;
  const fOpen =
    typeof params.feeOpenUsdt === 'number' && params.feeOpenUsdt > 0
      ? params.feeOpenUsdt
      : notional * feeRate;
  const fCloseEst = notional * feeRate;
  const fSlippageAndFunding = notional * slippagePct;
  const fTotal = Number((fOpen + fCloseEst + fSlippageAndFunding).toFixed(4));

  // Иерархия целей выхода (Раздел 5В):
  // • 0 усреднений (L0): чистый профит
  // • 1 усреднение (L1): безубыток цикла + небольшой чистый профит (+0.18% от объёма)
  // • 2+ усреднений (L2/L3): приоритет разгрузки тяжёлой позиции (допускается выход в 0 или малый контролируемый минус до -10% от маржи сделки)
  let exitPriorityMode: BasketConvergenceResult['exitPriorityMode'] = 'PURE_PROFIT_L0';
  let tNetTarget = notional * 0.0035;
  let unloadingAllowedLoss = 0;

  if (dcaCount === 1) {
    exitPriorityMode = 'CONVERGENCE_PROFIT_L1';
    tNetTarget = Math.max(0.05, notional * 0.0018);
    unloadingAllowedLoss = 0;
  } else if (dcaCount >= 2) {
    exitPriorityMode = 'UNLOADING_PRIORITY_L2';
    tNetTarget = 0;
    // Допускается контролируемый малый убыток до 10% от задействованной маржи позиции (эквивалентно ~0.1%..0.3% от депозита, строго < лимита 1.5% из Раздела 5В)
    unloadingAllowedLoss = stakeAmount * 0.1;
  }

  // Точка чистого нуля всего цикла (T_net = 0):
  const netDeltaZero = pBank - fTotal;
  const exactZeroCyclePrice = isShort
    ? pAvg + netDeltaZero / qMain
    : pAvg - netDeltaZero / qMain;

  // Целевая цена выхода с учётом T_net:
  const netDeltaTarget = pBank - fTotal - tNetTarget;
  const targetCycleExitPrice = isShort
    ? pAvg + netDeltaTarget / qMain
    : pAvg - netDeltaTarget / qMain;

  // Порог приоритетной разгрузки на 2-м/3-м уровне (с допуском малого контролируемого минус-выхода):
  const netDeltaUnloading = pBank - fTotal + unloadingAllowedLoss;
  const unloadingFloorPrice = isShort
    ? pAvg + netDeltaUnloading / qMain
    : pAvg - netDeltaUnloading / qMain;

  const priceShiftFromBankedProfit = Number((pBank / qMain).toPrecision(7));

  return {
    exactZeroCyclePrice: Number(Math.max(1e-8, exactZeroCyclePrice).toPrecision(7)),
    targetCycleExitPrice: Number(Math.max(1e-8, targetCycleExitPrice).toPrecision(7)),
    unloadingFloorPrice: Number(Math.max(1e-8, unloadingFloorPrice).toPrecision(7)),
    totalCostsUsdt: fTotal,
    targetNetProfitUsdt: Number(tNetTarget.toFixed(4)),
    bankedProfitUsdt: Number(pBank.toFixed(4)),
    netRequiredFromPrimaryUsdt: Number((fTotal + tNetTarget - pBank).toFixed(4)),
    priceShiftFromBankedProfit,
    exitPriorityMode,
  };
}

export interface TailBiteCalculationResult {
  canBite: boolean;
  closeQty: number;
  consumedBankProfit: number;
  remainingBankProfit: number;
  newAvgEntryPrice: number;
  remainingQty: number;
  reason: string;
}

/**
 * Раздел 5В регламента — Механика частичной разгрузки («Откусывание хвоста»):
 * Если после усреднения (dcaCount >= 1) и накопления профита в P_bank импульс отскока затухает на полпути,
 * бот использует P_bank, чтобы частично закрыть («откусить») самый дальний/убыточный кусок позиции (orders[0]).
 * Убыток по закрываемой части полностью перекрывается накопленным P_bank (в ноль),
 * а средняя цена входа оставшегося объёма смещается ещё ближе к текущей рыночной цене!
 */
export function calculateTailBitePartialClose(params: {
  orders: Array<{ price: number; amount: number; stake_amount: number }>;
  currentPrice: number;
  isShort: boolean;
  bankedProfitUsdt: number;
  feeRate?: number;
}): TailBiteCalculationResult {
  const noBite = (reason: string): TailBiteCalculationResult => ({
    canBite: false,
    closeQty: 0,
    consumedBankProfit: 0,
    remainingBankProfit: Number((params.bankedProfitUsdt || 0).toFixed(4)),
    newAvgEntryPrice: 0,
    remainingQty: 0,
    reason,
  });

  const orders = Array.isArray(params.orders) ? params.orders : [];
  if (orders.length < 2) {
    return noBite('Откусывание хвоста применяется только к усреднённым позициям (минимум 2 ордера в сетке)');
  }
  const currentPrice = Number(params.currentPrice || 0);
  const banked = Number(params.bankedProfitUsdt || 0);
  const feeRate = Math.max(0.0002, Number(params.feeRate ?? 0.0006));
  if (!(currentPrice > 0) || !(banked > 0.05)) {
    return noBite('Недостаточно накопленного профита P_bank для откусывания хвоста');
  }

  // Самый старый и далёкий от текущей цены ордер (хвост позиции)
  const tailOrd = orders[0];
  const tailPrice = Number(tailOrd?.price || 0);
  const tailQty = Number(tailOrd?.amount || 0);
  if (!(tailPrice > 0) || !(tailQty > 0)) {
    return noBite('Некорректные параметры хвостового ордера');
  }

  // Проверяем, что хвост действительно находится в убытке относительно текущей цены
  const tailLossPerUnitRaw = params.isShort
    ? currentPrice - tailPrice
    : tailPrice - currentPrice;
  if (tailLossPerUnitRaw <= 0) {
    return noBite('Хвостовой ордер уже в плюсе — частичное перекрытие убытка не требуется');
  }

  // Полный расход из P_bank на закрытие 1 единицы хвоста = курсовой убыток + комиссия открытия + комиссия закрытия + микро-резерв
  const unitCostUsdt =
    tailLossPerUnitRaw + (tailPrice + currentPrice) * feeRate + currentPrice * 0.0005;
  const maxAffordableQty = banked / Math.max(1e-8, unitCostUsdt);

  // Откусываем хвост, если накопленного профита хватает хотя бы на 35% от объёма первого входа
  if (maxAffordableQty < tailQty * 0.35) {
    return noBite(
      `Банка P_bank (${banked.toFixed(2)}$) пока недостаточно для гашения ≥35% хвоста (доступно ${((maxAffordableQty / tailQty) * 100).toFixed(1)}%)`
    );
  }

  const closeQty = Number(Math.min(tailQty, maxAffordableQty).toFixed(6));
  if (!(closeQty > 0)) {
    return noBite('Расчётный объём откусывания хвоста равен 0');
  }

  const consumedBankProfit = Number(Math.min(banked, closeQty * unitCostUsdt).toFixed(4));
  const remainingBankProfit = Number(Math.max(0, banked - consumedBankProfit).toFixed(4));

  // Пересчитываем новую среднюю цену входа и остаток позиции после откусывания хвоста
  let remNotional = 0;
  let remQty = 0;
  const leftInTail = Math.max(0, tailQty - closeQty);
  if (leftInTail > 1e-8) {
    remNotional += leftInTail * tailPrice;
    remQty += leftInTail;
  }
  for (let i = 1; i < orders.length; i++) {
    const q = Math.max(0, Number(orders[i].amount || 0));
    const p = Math.max(0, Number(orders[i].price || 0));
    remNotional += q * p;
    remQty += q;
  }

  if (remQty <= 1e-8) {
    return noBite('После откусывания хвоста не остаётся рабочего объёма');
  }

  const newAvgEntryPrice = Number((remNotional / remQty).toPrecision(7));
  return {
    canBite: true,
    closeQty,
    consumedBankProfit,
    remainingBankProfit,
    newAvgEntryPrice,
    remainingQty: Number(remQty.toFixed(6)),
    reason: `Откусывание хвоста: закрытие ${closeQty} @ ${currentPrice}$ за счёт P_bank (-${consumedBankProfit}$), средняя цена смещается до ${newAvgEntryPrice}$`,
  };
}

/**
 * Раздел 6 регламента — 6-точечный риск-фильтр и жёсткие табу усреднения (canExecuteDca):
 * 1. Лимит уровней усреднения: максимум 2–3 глобальных уровня (Табу №1).
 * 2. Запрет на усреднение страховочной ноги при открытой основной ноге (Табу №2).
 * 3. Проверка максимального множителя объёма позиции.
 * 4. Проверка загрузки маржи счёта.
 * 5. Проверка доли маржи одной торговой пары.
 * 6. Проверка безопасной дистанции до ликвидации после усреднения.
 */
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
    otherActiveCoinsCount?: number;
    campaignRole?: 'primary' | 'insurance';
    hasOpenPrimarySibling?: boolean;
  },
  config: BotConfigData = DEFAULT_SCALPBOT_CONFIG
): {
  allowed: boolean;
  reason: string;
  multiplier: number;
  liquidationDistancePct: number;
  postDcaLiquidationDistancePct: number;
  maxAllowedDca: number;
} {
  const baseAmt = params.initialAmount > 0 ? params.initialAmount : params.currentAmount;
  const currentMultiplier =
    baseAmt > 0 ? Number((params.currentAmount / baseAmt).toFixed(2)) : 1.0;
  const maxAllowedDca = Math.min(3, Math.max(0, Number(config.max_dca_orders ?? 2)));

  if (!config.dca_enabled || maxAllowedDca <= 0) {
    return {
      allowed: false,
      reason: 'Усреднение (DCA) отключено в конфигурации',
      multiplier: currentMultiplier,
      liquidationDistancePct: 100,
      postDcaLiquidationDistancePct: 100,
      maxAllowedDca: 0,
    };
  }

  // Табу №2 (Раздел 6.2): Запрещено усреднять страховочную ногу, пока открыта основная нога!
  if (params.campaignRole === 'insurance' && params.hasOpenPrimarySibling) {
    return {
      allowed: false,
      reason:
        'Табу №2 (Раздел 6.2): Категорически запрещено усреднять страховочную ногу при активной основной ноге',
      multiplier: currentMultiplier,
      liquidationDistancePct: 100,
      postDcaLiquidationDistancePct: 100,
      maxAllowedDca,
    };
  }

  // Табу №1 (Раздел 6.1): Лимит уровней усреднения (максимум 2–3 глобальных уровня)
  if (params.dcaCount >= maxAllowedDca) {
    return {
      allowed: false,
      reason: `Табу №1 (Раздел 6.1): Достигнут лимит глобальных уровней усреднения (${params.dcaCount}/${maxAllowedDca}) — приоритет разгрузки на отскоке`,
      multiplier: currentMultiplier,
      liquidationDistancePct: 100,
      postDcaLiquidationDistancePct: 100,
      maxAllowedDca,
    };
  }

  const maxMult = Math.max(2.0, Number(config.max_position_multiplier || 6.0));
  if (currentMultiplier >= maxMult) {
    return {
      allowed: false,
      reason: `Превышен максимальный множитель объёма позиции (${currentMultiplier}x >= ${maxMult}x)`,
      multiplier: currentMultiplier,
      liquidationDistancePct: 100,
      postDcaLiquidationDistancePct: 100,
      maxAllowedDca,
    };
  }

  const totalBal = Math.max(1, Number(params.totalBalanceUsdt || 0));
  const usedMarginPct = (Math.max(0, Number(params.usedMarginUsdt || 0)) / totalBal) * 100.0;
  const maxMarginPct = Math.max(20, Number(config.max_margin_used_for_dca_pct || 60.0));
  if (usedMarginPct >= maxMarginPct) {
    return {
      allowed: false,
      reason: `Загрузка маржи счёта (${usedMarginPct.toFixed(1)}%) выше лимита безопасности для усреднения (${maxMarginPct}%)`,
      multiplier: currentMultiplier,
      liquidationDistancePct: 100,
      postDcaLiquidationDistancePct: 100,
      maxAllowedDca,
    };
  }

  const lev = Math.max(1, Number(params.leverage || 25));
  const currentPosMargin = (params.currentAmount * params.openRate) / lev;
  const pairMarginPct = (currentPosMargin / totalBal) * 100.0;
  const maxPairMarginPct = Math.max(5, Number(config.max_pair_margin_pct || 20.0));
  if (pairMarginPct >= maxPairMarginPct) {
    return {
      allowed: false,
      reason: `Маржа по паре ${params.pair} (${pairMarginPct.toFixed(1)}%) достигла лимита на одну монету (${maxPairMarginPct}%)`,
      multiplier: currentMultiplier,
      liquidationDistancePct: 100,
      postDcaLiquidationDistancePct: 100,
      maxAllowedDca,
    };
  }

  // Оценка дистанции до ликвидации до и после добавления рабочего объёма
  const addQty = Math.max(baseAmt, params.currentAmount);
  const newTotalQty = params.currentAmount + addQty;
  const newAvgRate =
    (params.currentAmount * params.openRate + addQty * params.currentPrice) /
    Math.max(1e-8, newTotalQty);
  const newPosNotional = newTotalQty * newAvgRate;
  const freeCollateral = Math.max(0, totalBal - Math.max(0, params.usedMarginUsdt - currentPosMargin));
  const liqBufferPct =
    newPosNotional > 0 ? Math.min(95, (freeCollateral / newPosNotional) * 100.0) : 100;
  const minLiqDist = Math.max(5, Number(config.min_liquidation_distance_pct || 15.0));

  if (liqBufferPct < minLiqDist) {
    return {
      allowed: false,
      reason: `Запас до ликвидации после усреднения (${liqBufferPct.toFixed(1)}%) меньше безопасного порога (${minLiqDist}%)`,
      multiplier: currentMultiplier,
      liquidationDistancePct: Number(liqBufferPct.toFixed(2)),
      postDcaLiquidationDistancePct: Number(liqBufferPct.toFixed(2)),
      maxAllowedDca,
    };
  }

  return {
    allowed: true,
    reason: `Разворотное усреднение разрешено (уровень #${params.dcaCount + 1}/${maxAllowedDca}, маржа=${usedMarginPct.toFixed(1)}%, запас до ликв.=${liqBufferPct.toFixed(1)}%)`,
    multiplier: currentMultiplier,
    liquidationDistancePct: Number(liqBufferPct.toFixed(2)),
    postDcaLiquidationDistancePct: Number(liqBufferPct.toFixed(2)),
    maxAllowedDca,
  };
}

/**
 * Рассчитывает рабочий объём разворотного усреднения основной ноги на сильном уровне S/R
 * так, чтобы подтянуть среднюю цену входа P_avg максимально близко к уровню разворота
 * без нарушения лимитов маржи и ликвидации.
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
  const curAmt = Math.max(0, Number(params.currentAmount || 0));
  const openRate = Math.max(0, Number(params.openRate || 0));
  const curPrice = Math.max(0, Number(params.currentPrice || 0));
  const lev = Math.max(1, Number(params.leverage || 25));
  const totalBal = Math.max(0, Number(params.totalBalanceUsdt || 0));
  const usedMargin = Math.max(0, Number(params.usedMarginUsdt || 0));
  const maxPairPct = Math.max(5, Number(params.maxPairMarginPct || 20.0));
  const minStake = Math.max(2, Number(params.minStakeUsdt || 5));

  if (curAmt <= 0 || openRate <= 0 || curPrice <= 0 || totalBal <= 0) {
    return {
      addAmount: 0,
      addStake: 0,
      targetAvgPrice: Number(openRate.toPrecision(7)),
      pullDistancePct: 0,
    };
  }

  const curStake = (curAmt * openRate) / lev;
  const maxAllowedPairStake = totalBal * (maxPairPct / 100.0);
  const availableAccountMargin = Math.max(0, totalBal * 0.6 - usedMargin);
  const maxAddStake = Math.min(
    Math.max(0, maxAllowedPairStake - curStake),
    availableAccountMargin
  );

  // Базовый рабочий шаг разворотного усреднения: 1.0x от текущего объёма позиции (подтягивает P_avg ровно на 50% к уровню,
  // а с учётом накопленного профита P_bank со страховочной ноги сдвигает безубыток цикла P_BE_cycle прямо к уровню отскока)
  const desiredStake = Math.max(minStake, curStake * 1.0);
  const finalAddStake = Number(Math.min(desiredStake, maxAddStake).toFixed(2));
  if (finalAddStake < minStake * 0.5) {
    return {
      addAmount: 0,
      addStake: 0,
      targetAvgPrice: Number(openRate.toPrecision(7)),
      pullDistancePct: 0,
    };
  }

  const addAmount = Number(((finalAddStake * lev) / curPrice).toFixed(6));
  const totalNewAmt = curAmt + addAmount;
  const targetAvgPrice =
    totalNewAmt > 0
      ? Number(((curAmt * openRate + addAmount * curPrice) / totalNewAmt).toPrecision(7))
      : openRate;
  const rawDist = Math.abs(openRate - curPrice);
  const newDist = Math.abs(targetAvgPrice - curPrice);
  const pullDistancePct =
    rawDist > 1e-8 ? Number((((rawDist - newDist) / rawDist) * 100.0).toFixed(1)) : 50.0;

  return {
    addAmount,
    addStake: finalAddStake,
    targetAvgPrice,
    pullDistancePct,
  };
}


