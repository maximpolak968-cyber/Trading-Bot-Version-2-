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
  source?: '1D' | '4H' | '1H';
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
  d1_trend: 'BULLISH' | 'BEARISH' | 'MILD_BULLISH' | 'MILD_BEARISH' | 'NEUTRAL';
  d1_high: number;
  d1_low: number;
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

export function analyzeLevelInteractions(
  candles: OhlcvCandle[],
  rawLevels: Array<{ price: number; type: 'high' | 'low'; indices: number[] }>,
  touchTolerancePct = 0.35
): ClusteredLevelWithHistory[] {
  const n = candles.length;
  const levels: ClusteredLevelWithHistory[] = [];
  if (n === 0) return levels;

  for (const raw of rawLevels) {
    // Require at least 2 pivots so single random wicks are ignored
    if (raw.indices.length < 2) continue;
    const price = raw.price;
    if (price <= 0) continue;

    let touches = 0;
    let bounces = 0;
    let breaks = 0;
    let lastTouchIndex = raw.indices[0];

    for (let i = 0; i < n; i++) {
      const distHigh = (Math.abs(candles[i].high - price) / price) * 100;
      const distLow = (Math.abs(candles[i].low - price) / price) * 100;
      if (distHigh > touchTolerancePct && distLow > touchTolerancePct) continue;

      lastTouchIndex = i;
      const lookahead = candles.slice(i + 1, i + 4).map((c) => c.close);
      if (lookahead.length === 0) {
        touches += 1;
        bounces += 1;
        continue;
      }

      touches += 1;
      const isResistance = raw.type === 'high';
      const broke = isResistance
        ? lookahead.some((c) => c > price * (1 + touchTolerancePct / 100))
        : lookahead.some((c) => c < price * (1 - touchTolerancePct / 100));

      if (broke) breaks += 1;
      else bounces += 1;
    }

    if (touches === 0) continue;

    const bounceRate = bounces / touches;
    const recencyWeight = 1 - (n - 1 - lastTouchIndex) / n;
    const strengthScore = touches * 0.3 + bounceRate * 2 + recencyWeight;

    levels.push({
      price: Number(price.toPrecision(7)),
      type: raw.type === 'high' ? 'resistance' : 'support',
      touches,
      bounces,
      breaks,
      bounce_rate: Number(bounceRate.toFixed(3)),
      last_touch_index: lastTouchIndex,
      strength_score: Number(strengthScore.toFixed(3)),
    });
  }

  return levels.sort((a, b) => b.strength_score - a.strength_score);
}

export function buildLevelsWithHistory(
  candles: OhlcvCandle[],
  leftBars = 3,
  rightBars = 3,
  tolerancePct = 0.5
): ClusteredLevelWithHistory[] {
  const pivots = findPivots(candles, leftBars, rightBars);
  const rawLevels = clusterPivotsIntoLevels(pivots, tolerancePct);
  return analyzeLevelInteractions(candles, rawLevels, tolerancePct);
}

// ============================================================================
// 3. MARKET STRUCTURE & MULTI-TIMEFRAME (1D + 4H + 1H) LEVEL ANALYSIS
// ============================================================================

export function detectMarketStructure(
  candles: OhlcvCandle[],
  lookback = 50
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

  const subset = candles.slice(-Math.max(15, lookback));
  const currentPrice = subset[subset.length - 1].close;

  let rangeHigh = -Infinity;
  let rangeLow = Infinity;
  for (const c of subset) {
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
  const levelsWithHistory = buildLevelsWithHistory(subset, 3, 3, 0.6);

  const supportsHist = levelsWithHistory.filter(
    (l) => l.type === 'support' && ((currentPrice - l.price) / currentPrice) * 100 >= minDistPct
  );
  const resistancesHist = levelsWithHistory.filter(
    (l) => l.type === 'resistance' && ((l.price - currentPrice) / currentPrice) * 100 >= minDistPct
  );

  const supportHistory =
    supportsHist.length > 0
      ? supportsHist.reduce((best, cur) => (cur.strength_score > best.strength_score ? cur : best))
      : null;

  const resistanceHistory =
    resistancesHist.length > 0
      ? resistancesHist.reduce((best, cur) =>
          cur.strength_score > best.strength_score ? cur : best
        )
      : null;

  let nearestSupport = rangeLow;
  if (supportHistory) {
    nearestSupport = supportHistory.price;
  } else {
    const supportsBelow = swingLows.filter(
      (s) => ((currentPrice - s) / currentPrice) * 100 >= minDistPct
    );
    if (supportsBelow.length > 0) nearestSupport = Math.max(...supportsBelow);
  }

  let nearestResistance = rangeHigh;
  if (resistanceHistory) {
    nearestResistance = resistanceHistory.price;
  } else {
    const resistancesAbove = swingHighs.filter(
      (r) => ((r - currentPrice) / currentPrice) * 100 >= minDistPct
    );
    if (resistancesAbove.length > 0) nearestResistance = Math.min(...resistancesAbove);
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

export function analyzeMultiTimeframe(
  pair: string,
  candles1h: OhlcvCandle[],
  candles4h: OhlcvCandle[],
  candles1d: OhlcvCandle[],
  customLevels?: { support?: number; resistance?: number }
): MultiTimeframeAnalysis {
  const currentPrice = candles1h.length > 0 ? candles1h[candles1h.length - 1].close : 100;

  let d1Trend: MultiTimeframeAnalysis['d1_trend'] = 'NEUTRAL';
  let d1High = currentPrice * 1.1;
  let d1Low = currentPrice * 0.9;

  if (candles1d.length >= 15) {
    const closes1d = candles1d.map((c) => c.close);
    const ema20Series = calcEmaSeries(closes1d, 20);
    const ema50Series = calcEmaSeries(closes1d, Math.min(50, closes1d.length));
    const d1Ema20 = ema20Series[ema20Series.length - 1];
    const d1Ema50 = ema50Series[ema50Series.length - 1];
    d1High = Math.max(...candles1d.map((c) => c.high));
    d1Low = Math.min(...candles1d.map((c) => c.low));
    const last1dClose = closes1d[closes1d.length - 1];

    if (last1dClose > d1Ema20 && d1Ema20 > d1Ema50) d1Trend = 'BULLISH';
    else if (last1dClose < d1Ema20 && d1Ema20 < d1Ema50) d1Trend = 'BEARISH';
    else if (last1dClose > d1Ema20) d1Trend = 'MILD_BULLISH';
    else d1Trend = 'MILD_BEARISH';
  }

  // Calculate Wilder's RSI (14) on 1D, 4H, and 1H timeframes
  const rsi1dSeries =
    candles1d.length >= 15 ? calcRsiSeries(candles1d.map((c) => c.close), 14) : [];
  const rsi4hSeries =
    candles4h.length >= 15 ? calcRsiSeries(candles4h.map((c) => c.close), 14) : [];
  const rsi1hSeries =
    candles1h.length >= 15 ? calcRsiSeries(candles1h.map((c) => c.close), 14) : [];

  const rsi1d = Number(
    (rsi1dSeries.length > 0 ? rsi1dSeries[rsi1dSeries.length - 1] : 50).toFixed(2)
  );
  const rsi4h = Number(
    (rsi4hSeries.length > 0 ? rsi4hSeries[rsi4hSeries.length - 1] : 50).toFixed(2)
  );
  const rsi1h = Number(
    (rsi1hSeries.length > 0 ? rsi1hSeries[rsi1hSeries.length - 1] : 50).toFixed(2)
  );

  const structure4h =
    candles4h.length >= 15
      ? detectMarketStructure(candles4h, candles4h.length)
      : detectMarketStructure(candles1h, 40);

  const structure1d =
    candles1d.length >= 30 ? detectMarketStructure(candles1d, candles1d.length) : null;

  const structure1h = detectMarketStructure(candles1h, 30);

  const hasCustomSup = Boolean(customLevels?.support && customLevels.support > 0);
  const hasCustomRes = Boolean(customLevels?.resistance && customLevels.resistance > 0);

  const key4hSupport = hasCustomSup
    ? Number(customLevels!.support)
    : structure4h.nearest_support || currentPrice * 0.97;
  const key4hResistance = hasCustomRes
    ? Number(customLevels!.resistance)
    : structure4h.nearest_resistance || currentPrice * 1.03;
  const pos4hPct =
    hasCustomSup || hasCustomRes
      ? key4hResistance > key4hSupport
        ? Math.max(
            0,
            Math.min(100, ((currentPrice - key4hSupport) / (key4hResistance - key4hSupport)) * 100)
          )
        : 50.0
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

  // Strict MTF RSI Filter for LONG: forbid Long if 1D RSI > 68 OR 4H RSI > 60 OR 1H RSI > 45
  if (rsi1d > 68.0 || rsi4h > 60.0 || rsi1h > 45.0) {
    allowLong = false;
    rejectionReasonLong = `MTF RSI фильтр блокирует LONG: 1D RSI=${rsi1d} (макс 68), 4H RSI=${rsi4h} (макс 60), 1H RSI=${rsi1h} (макс 45)`;
  } else if (distTo4hResPct < 0.85) {
    allowLong = false;
    rejectionReasonLong = `Close to 4H Resistance (${key4hResistance}, only +${distTo4hResPct.toFixed(2)}% room)`;
  } else if (pos4hPct > 80.0) {
    allowLong = false;
    rejectionReasonLong = `Top of 4H range (${pos4hPct.toFixed(1)}%) — overbought zone`;
  } else if (isPumpExhaustion(candles1h)) {
    allowLong = false;
    rejectionReasonLong = `Parabolic pump exhaustion detected on 1H`;
  }

  let allowShort = true;
  let rejectionReasonShort = '';

  // Strict MTF RSI Filter for SHORT: forbid Short if 1D RSI < 32 OR 4H RSI < 40 OR 1H RSI < 55
  if (rsi1d < 32.0 || rsi4h < 40.0 || rsi1h < 55.0) {
    allowShort = false;
    rejectionReasonShort = `MTF RSI фильтр блокирует SHORT: 1D RSI=${rsi1d} (мин 32), 4H RSI=${rsi4h} (мин 40), 1H RSI=${rsi1h} (мин 55)`;
  } else if (distTo4hSupPct < 0.85) {
    allowShort = false;
    rejectionReasonShort = `Close to 4H Support (${key4hSupport}, only -${distTo4hSupPct.toFixed(2)}% room)`;
  } else if (pos4hPct < 20.0) {
    allowShort = false;
    rejectionReasonShort = `Bottom of 4H range (${pos4hPct.toFixed(1)}%) — oversold zone`;
  } else if (isKnifeDrop(candles1h)) {
    allowShort = false;
    rejectionReasonShort = `Cascade knife drop detected on 1H`;
  }

  // Long Fast Scalp TP: 0.8% to 1.5% price move (+20% to +37.5% gross / ~17%-34% net ROI on 25x after 0.06% fees)
  const minTpDistLong = currentPrice * 1.008; // +0.8%
  const maxTpDistLong = currentPrice * 1.015; // +1.5%
  const defaultScalpTpLong = currentPrice * 1.012; // +1.2% (+30% gross / +27% net ROI on 25x)
  const localResTarget = local1hResistance * 0.998;
  const keyResTarget = key4hResistance * 0.998;
  let recTpLong = defaultScalpTpLong;
  if (localResTarget >= minTpDistLong && localResTarget <= maxTpDistLong) {
    recTpLong = localResTarget;
  } else if (keyResTarget >= minTpDistLong && keyResTarget <= maxTpDistLong) {
    recTpLong = keyResTarget;
  }
  const safeSupport = Math.min(key4hSupport, local1hSupport);
  let recSlLong = safeSupport * 0.996;
  const slDistPctLong = currentPrice > 0 ? ((currentPrice - recSlLong) / currentPrice) * 100.0 : 0;
  if (slDistPctLong < 0.8) recSlLong = currentPrice * 0.985;
  else if (slDistPctLong > 4.5) recSlLong = currentPrice * 0.96;

  // Short Fast Scalp TP: 0.8% to 1.5% price move (-0.8% to -1.5% price = +20% to +37.5% gross / ~17%-34% net ROI on 25x)
  const minTpDistShort = currentPrice * 0.992; // -0.8%
  const maxTpDistShort = currentPrice * 0.985; // -1.5%
  const defaultScalpTpShort = currentPrice * 0.988; // -1.2% (+30% gross / +27% net ROI on 25x)
  const localSupTarget = local1hSupport * 1.002;
  const keySupTarget = key4hSupport * 1.002;
  let recTpShort = defaultScalpTpShort;
  if (localSupTarget <= minTpDistShort && localSupTarget >= maxTpDistShort) {
    recTpShort = localSupTarget;
  } else if (keySupTarget <= minTpDistShort && keySupTarget >= maxTpDistShort) {
    recTpShort = keySupTarget;
  }
  const safeResistance = Math.max(key4hResistance, local1hResistance);
  let recSlShort = safeResistance * 1.004;
  const slDistPctShort =
    currentPrice > 0 ? ((recSlShort - currentPrice) / currentPrice) * 100.0 : 0;
  if (slDistPctShort < 0.8) recSlShort = currentPrice * 1.015;
  else if (slDistPctShort > 4.5) recSlShort = currentPrice * 1.04;

  // Merge 4H and 1D histories
  const supportCandidates: ClusteredLevelWithHistory[] = [];
  const resistanceCandidates: ClusteredLevelWithHistory[] = [];
  if (structure4h.support_history) {
    supportCandidates.push({ ...structure4h.support_history, source: '4H' });
  }
  if (structure1d?.support_history) {
    supportCandidates.push({
      ...structure1d.support_history,
      strength_score: Number((structure1d.support_history.strength_score * 1.5).toFixed(3)),
      source: '1D',
    });
  }
  if (structure4h.resistance_history) {
    resistanceCandidates.push({ ...structure4h.resistance_history, source: '4H' });
  }
  if (structure1d?.resistance_history) {
    resistanceCandidates.push({
      ...structure1d.resistance_history,
      strength_score: Number((structure1d.resistance_history.strength_score * 1.5).toFixed(3)),
      source: '1D',
    });
  }

  const supportHistory =
    supportCandidates.length > 0
      ? supportCandidates.reduce((best, cur) =>
          cur.strength_score > best.strength_score ? cur : best
        )
      : null;

  const resistanceHistory =
    resistanceCandidates.length > 0
      ? resistanceCandidates.reduce((best, cur) =>
          cur.strength_score > best.strength_score ? cur : best
        )
      : null;

  if (!hasCustomSup && supportHistory && supportHistory.breaks > supportHistory.bounces) {
    allowLong = false;
    rejectionReasonLong =
      rejectionReasonLong ||
      `Support at ${supportHistory.price} has weak history: ${supportHistory.bounces} bounces vs ${supportHistory.breaks} breaks`;
  }
  if (!hasCustomRes && resistanceHistory && resistanceHistory.breaks > resistanceHistory.bounces) {
    allowShort = false;
    rejectionReasonShort =
      rejectionReasonShort ||
      `Resistance at ${resistanceHistory.price} has weak history: ${resistanceHistory.bounces} bounces vs ${resistanceHistory.breaks} breaks`;
  }

  // Collect top institutional levels (4H + 1D) for chart visualization
  const mergedInstitutional: ClusteredLevelWithHistory[] = [
    ...structure4h.all_levels.slice(0, 4).map((l) => ({ ...l, source: '4H' as const })),
    ...(structure1d?.all_levels.slice(0, 4).map((l) => ({
      ...l,
      strength_score: Number((l.strength_score * 1.5).toFixed(3)),
      source: '1D' as const,
    })) || []),
  ].sort((a, b) => b.strength_score - a.strength_score);

  const levelMapSummary =
    `1D: ${d1Trend} (RSI ${rsi1d}) [${d1Low.toPrecision(5)} - ${d1High.toPrecision(5)}] | ` +
    `4H: Sup=${key4hSupport.toPrecision(6)} / Res=${key4hResistance.toPrecision(6)} (Pos: ${pos4hPct.toFixed(0)}%, RSI ${rsi4h}) | ` +
    `1H: Sup=${local1hSupport.toPrecision(6)} / Res=${local1hResistance.toPrecision(6)} (Pos: ${pos1hPct.toFixed(0)}%, RSI ${rsi1h})`;

  return {
    d1_trend: d1Trend,
    d1_high: d1High,
    d1_low: d1Low,
    rsi_1d: rsi1d,
    rsi_4h: rsi4h,
    rsi_1h: rsi1h,
    key_4h_support: key4hSupport,
    key_4h_resistance: key4hResistance,
    pos_4h_pct: pos4hPct,
    local_1h_support: local1hSupport,
    local_1h_resistance: local1hResistance,
    pos_1h_pct: pos1hPct,
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
    institutional_levels: mergedInstitutional.slice(0, 6),
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
  tolerancePct = 0.8
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
    const nearLevel = lowP <= level * (1 + tolerancePct / 100.0);
    if (!nearLevel) {
      return { confirmed: false, reason: `Price ${lowP} not testing support ${level}` };
    }
    if (isKnifeDrop(candles)) {
      return { confirmed: false, reason: 'Knife drop detected (no lower wick, strong dump candle)' };
    }
    const lowerWick = Math.min(openP, closeP) - lowP;
    const hasRejectionWick = lowerWick / candleRange >= 0.35 || lowerWick >= body * 0.8;
    const closedAboveLevel = closeP >= level * 0.998;
    const isGreen = closeP > openP;
    const bullishEngulfing = isGreen && closeP > prevRow.open && prevRow.close < prevRow.open;
    const confirmed = closedAboveLevel && (hasRejectionWick || isGreen || bullishEngulfing);
    return {
      confirmed,
      reason: confirmed
        ? 'Support bounce confirmed by price action'
        : 'Waiting for support bounce confirmation',
    };
  } else {
    const nearLevel = highP >= level * (1 - tolerancePct / 100.0);
    if (!nearLevel) {
      return { confirmed: false, reason: `Price ${highP} not testing resistance ${level}` };
    }
    if (isPumpExhaustion(candles)) {
      return { confirmed: false, reason: 'Rocket pump detected (no upper wick, strong pump candle)' };
    }
    const upperWick = highP - Math.max(openP, closeP);
    const hasRejectionWick = upperWick / candleRange >= 0.35 || upperWick >= body * 0.8;
    const closedBelowLevel = closeP <= level * 1.002;
    const isRed = closeP < openP;
    const bearishEngulfing = isRed && closeP < prevRow.open && prevRow.close > prevRow.open;
    const confirmed = closedBelowLevel && (hasRejectionWick || isRed || bearishEngulfing);
    return {
      confirmed,
      reason: confirmed
        ? 'Resistance rejection confirmed by price action'
        : 'Waiting for resistance rejection confirmation',
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
    const reversal = isOversold && (rsiNow > rsiPrev || rsiNow <= 32.0);
    return {
      confirmed: reversal,
      rsi: Number(rsiNow.toFixed(2)),
      reason: reversal
        ? `RSI ${rsiNow.toFixed(1)} oversold and turning up`
        : `RSI ${rsiNow.toFixed(1)} not in reversal setup for Long (must be <= 45)`,
    };
  } else {
    const isOverbought = rsiNow >= 55.0;
    const reversal = isOverbought && (rsiNow < rsiPrev || rsiNow >= 68.0);
    return {
      confirmed: reversal,
      rsi: Number(rsiNow.toFixed(2)),
      reason: reversal
        ? `RSI ${rsiNow.toFixed(1)} overbought and turning down`
        : `RSI ${rsiNow.toFixed(1)} not in reversal setup for Short (must be >= 55)`,
    };
  }
}

export function findStrongestDcaLevel(
  candles4h: OhlcvCandle[],
  candles1d: OhlcvCandle[],
  currentPrice: number,
  isShort: boolean,
  minDistPct = 1.5,
  maxDistPct = 12.0
): {
  price: number;
  strength_score: number;
  bounces: number;
  breaks: number;
  source: string;
  type: 'support' | 'resistance';
} {
  if (currentPrice <= 0) {
    return {
      price: 0,
      strength_score: 0,
      bounces: 0,
      breaks: 0,
      source: 'fallback',
      type: isShort ? 'resistance' : 'support',
    };
  }

  const allCandidates: ClusteredLevelWithHistory[] = [];
  if (candles4h && candles4h.length >= 30) {
    const levels4h = buildLevelsWithHistory(candles4h, 3, 3, 0.6);
    for (const lvl of levels4h) {
      allCandidates.push({ ...lvl, source: '4H' });
    }
  }
  if (candles1d && candles1d.length >= 30) {
    const levels1d = buildLevelsWithHistory(candles1d, 3, 3, 0.8);
    for (const lvl of levels1d) {
      allCandidates.push({
        ...lvl,
        strength_score: Number((lvl.strength_score * 1.5).toFixed(3)),
        source: '1D',
      });
    }
  }

  // Filter levels strictly within [minDistPct, maxDistPct] so parabolic pumps never pick ancient levels 80% away
  const validLevels = allCandidates.filter((lvl) => {
    if (!isShort) {
      const distPct = ((currentPrice - lvl.price) / currentPrice) * 100.0;
      return lvl.type === 'support' && distPct >= minDistPct && distPct <= maxDistPct;
    } else {
      const distPct = ((lvl.price - currentPrice) / currentPrice) * 100.0;
      return lvl.type === 'resistance' && distPct >= minDistPct && distPct <= maxDistPct;
    }
  });

  if (validLevels.length > 0) {
    const best = validLevels.reduce((prev, cur) => {
      if (cur.strength_score !== prev.strength_score) {
        return cur.strength_score > prev.strength_score ? cur : prev;
      }
      return cur.bounces > prev.bounces ? cur : prev;
    });
    return {
      price: Number(best.price.toPrecision(7)),
      strength_score: best.strength_score,
      bounces: best.bounces,
      breaks: best.breaks,
      source: best.source || '4H/1D',
      type: best.type,
    };
  }

  const fallbackPrice = Number(
    (currentPrice * (isShort ? 1.025 : 0.975)).toPrecision(7)
  );
  return {
    price: fallbackPrice,
    strength_score: 0,
    bounces: 0,
    breaks: 0,
    source: 'default_step',
    type: isShort ? 'resistance' : 'support',
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
  reason: string;
  btcPrice?: number;
  candleChangePct?: number;
} {
  if (!btc1hCandles || btc1hCandles.length < 20) {
    return { isSafe: true, reason: 'Insufficient BTC data, proceeding with caution' };
  }
  const closes = btc1hCandles.map((c) => c.close);
  const ema50Series = calcEmaSeries(closes, 50);
  const last = btc1hCandles[btc1hCandles.length - 1];
  const prev = btc1hCandles[btc1hCandles.length - 2];
  const ema50 = ema50Series[ema50Series.length - 1];

  const candleChangePct =
    last.open > 0 ? ((last.close - last.open) / last.open) * 100.0 : 0;
  const prevChangePct =
    prev.open > 0 ? ((prev.close - prev.open) / prev.open) * 100.0 : 0;

  if (candleChangePct < -2.0) {
    return {
      isSafe: false,
      reason: `BTC flash dumping: ${candleChangePct.toFixed(2)}% in current 1h candle`,
      btcPrice: last.close,
      candleChangePct,
    };
  }
  if (last.close < ema50 * 0.985 && candleChangePct < -0.8) {
    return {
      isSafe: false,
      reason: `BTC breakdown below EMA 50 (${last.close.toFixed(1)} vs EMA50 ${ema50.toFixed(1)})`,
      btcPrice: last.close,
      candleChangePct,
    };
  }
  if (candleChangePct < -1.0 && prevChangePct < -1.0) {
    return {
      isSafe: false,
      reason: 'BTC consecutive sell-off: 2 hours of heavy selling',
      btcPrice: last.close,
      candleChangePct,
    };
  }

  return {
    isSafe: true,
    reason: 'BTC is stable / bullish',
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
  smartResistance: number
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
    c.volume >= volMean[idx] * 0.7 || p.volume >= volMean[prev] * 0.95;
  const volumeTrendOk =
    c.volume >= volMean[idx] * 0.8 || p.volume >= volMean[prev] * 1.05;

  // Support bounce / Resistance rejection (detect_reversal_patterns / detect_bearish_reversal_patterns)
  const body = Math.abs(c.close - c.open);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  const hasLowerWick = lowerWick >= body * 0.5 || lowerWick >= c.close * 0.003;
  const hasUpperWick = upperWick >= body * 0.5 || upperWick >= c.close * 0.003;

  const supportBounce =
    c.low <= smartSupport * 1.008 &&
    c.close >= smartSupport * 0.995 &&
    (greenCandle || hasLowerWick);
  const nearSupport =
    c.low <= smartSupport * 1.012 && c.close >= smartSupport * 0.985;
  const supportSignal = supportBounce || nearSupport;

  const waveOversoldCross =
    wt1[idx] > wt2[idx] && (wt1[prev] <= wt2[prev] || wt2[idx] <= -25);
  // Strict 1H RSI rule for LONG: RSI must be <= 45 (never enter Long when 1H RSI > 45)
  const rsiOversoldOk =
    rsiSeries[idx] <= 45.0 && (rsiSeries[idx] <= 38.0 || rsiSeries[idx] > rsiSeries[prev]);

  const levelReversalEntryLong =
    supportSignal &&
    waveOversoldCross &&
    rsiOversoldOk &&
    (greenCandle || c.close > c.low) &&
    volumeOk &&
    !isKnifeDrop(candles) &&
    !isPumpExhaustion(candles);

  const trendBullish =
    c.close > emaTrend[idx] * 0.995 && emaSlow[idx] >= emaTrend[idx] * 0.995;
  const emaCrossoverUp =
    emaFast[idx] > emaSlow[idx] && emaFast[prev] <= emaSlow[prev];
  const emaBounceUp =
    c.low <= emaSlow[idx] * 1.008 &&
    c.close > emaSlow[idx] &&
    emaFast[idx] >= emaSlow[idx];
  const momentumSignalUp =
    emaCrossoverUp ||
    emaBounceUp ||
    (c.close > emaFast[idx] && emaFast[idx] > emaSlow[idx]);
  // Strict 1H RSI rule for Trend Pullback LONG: RSI must be in [32, 45] (pullback in uptrend, never chasing overbought > 45)
  const momentumRsiUp = rsiSeries[idx] >= 32.0 && rsiSeries[idx] <= 45.0;
  const trendMomentumEntryLong =
    trendBullish &&
    momentumSignalUp &&
    momentumRsiUp &&
    volumeTrendOk &&
    greenCandle &&
    !isPumpExhaustion(candles) &&
    !isKnifeDrop(candles);

  const enterLong = levelReversalEntryLong || trendMomentumEntryLong;

  // Short Entry
  const resistanceRejection =
    c.high >= smartResistance * 0.992 &&
    c.close <= smartResistance * 1.005 &&
    (redCandle || hasUpperWick);
  const nearResistance =
    c.high >= smartResistance * 0.988 && c.close <= smartResistance * 1.015;
  const resistanceSignal = resistanceRejection || nearResistance;

  const waveOverboughtCross =
    wt1[idx] < wt2[idx] && (wt1[prev] >= wt2[prev] || wt2[idx] >= 25);
  // Strict 1H RSI rule for SHORT: RSI must be >= 55 (never enter Short when 1H RSI < 55)
  const rsiOverboughtOk =
    rsiSeries[idx] >= 55.0 && (rsiSeries[idx] >= 62.0 || rsiSeries[idx] < rsiSeries[prev]);

  const levelReversalEntryShort =
    resistanceSignal &&
    waveOverboughtCross &&
    rsiOverboughtOk &&
    (redCandle || c.close < c.high) &&
    volumeOk &&
    !isPumpExhaustion(candles) &&
    !isKnifeDrop(candles);

  const trendBearish =
    c.close < emaTrend[idx] * 1.005 && emaSlow[idx] <= emaTrend[idx] * 1.005;
  const emaCrossoverDown =
    emaFast[idx] < emaSlow[idx] && emaFast[prev] >= emaSlow[prev];
  const emaBounceDown =
    c.high >= emaSlow[idx] * 0.992 &&
    c.close < emaSlow[idx] &&
    emaFast[idx] <= emaSlow[idx];
  const momentumSignalDown =
    emaCrossoverDown ||
    emaBounceDown ||
    (c.close < emaFast[idx] && emaFast[idx] < emaSlow[idx]);
  // Strict 1H RSI rule for Trend Rally SHORT: RSI must be in [55, 68]
  const momentumRsiDown = rsiSeries[idx] >= 55.0 && rsiSeries[idx] <= 68.0;
  const trendMomentumEntryShort =
    trendBearish &&
    momentumSignalDown &&
    momentumRsiDown &&
    volumeTrendOk &&
    redCandle &&
    !isPumpExhaustion(candles) &&
    !isKnifeDrop(candles);

  const enterShort = levelReversalEntryShort || trendMomentumEntryShort;

  // Exits
  const resistanceTested = c.high >= smartResistance * 0.998;
  const waveTopReversal =
    wt1[idx] < wt2[idx] && wt1[prev] >= wt2[prev] && wt2[idx] >= 45;
  const levelTargetExitLong =
    resistanceTested && (rsiSeries[idx] >= 68 || waveTopReversal);
  const rsiExhaustionLong = rsiSeries[idx] >= 78 && redCandle;
  const trendBreakLong =
    c.close < emaTrend[idx] && emaFast[idx] < emaSlow[idx] && rsiSeries[idx] < 40;
  const exitLong = levelTargetExitLong || rsiExhaustionLong || trendBreakLong;

  const supportTested = c.low <= smartSupport * 1.002;
  const waveBottomReversal =
    wt1[idx] > wt2[idx] && wt1[prev] <= wt2[prev] && wt2[idx] <= -45;
  const levelTargetExitShort =
    supportTested && (rsiSeries[idx] <= 32 || waveBottomReversal);
  const rsiExhaustionShort = rsiSeries[idx] <= 22 && greenCandle;
  const trendBreakShort =
    c.close > emaTrend[idx] && emaFast[idx] > emaSlow[idx] && rsiSeries[idx] > 60;
  const exitShort = levelTargetExitShort || rsiExhaustionShort || trendBreakShort;

  let enterTag = '';
  if (enterLong) {
    enterTag = levelReversalEntryLong ? 'MTF_Support_Bounce' : 'EMA_Trend_Momentum_Long';
  } else if (enterShort) {
    enterTag = levelReversalEntryShort ? 'MTF_Resistance_Reject' : 'EMA_Trend_Momentum_Short';
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
    enter_long: enterLong,
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
  const currentPairNotional = params.currentAmount * params.currentPrice;
  const currentPairMargin = currentPairNotional / lev;
  const nextAddAmount =
    config.dca_scale_mode === 'linear' ? baseAmt : params.currentAmount;
  const nextAddNotional = nextAddAmount * params.currentPrice;
  const nextAddMargin = nextAddNotional / lev;
  const totalPairMarginAfter = currentPairMargin + nextAddMargin;
  const pairMarginSharePct = (totalPairMarginAfter / totalBalance) * 100.0;

  if (pairMarginSharePct > maxPairMarginPct) {
    return {
      allowed: false,
      reason: `Portfolio Guard: монета ${params.pair} займет ${pairMarginSharePct.toFixed(1)}% маржи депозита (лимит ${maxPairMarginPct}%)`,
      multiplier: currentMultiplier,
      liquidationDistancePct: 100,
    };
  }

  // 5. Free balance check
  const availableBalance = Math.max(0, totalBalance - params.usedMarginUsdt);
  if (availableBalance < nextAddMargin) {
    return {
      allowed: false,
      reason: `Не хватает свободной маржи: нужно ~${nextAddMargin.toFixed(2)} USDT, доступно ${availableBalance.toFixed(2)} USDT`,
      multiplier: currentMultiplier,
      liquidationDistancePct: 100,
    };
  }

  // 6. Liquidation distance check
  const approxLiqPrice = params.isShort
    ? params.openRate * (1 + 0.92 / lev)
    : params.openRate * (1 - 0.92 / lev);
  const liqDistancePct =
    params.currentPrice > 0
      ? (Math.abs(params.currentPrice - approxLiqPrice) / params.currentPrice) * 100.0
      : 100;

  if (liqDistancePct < minLiqDistPct) {
    return {
      allowed: false,
      reason: `Слишком близко к ликвидации: ${liqDistancePct.toFixed(1)}% (лимит ${minLiqDistPct}%)`,
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
 * to the current market price as possible (within ~0.8%), taking into account:
 * - existing coin count in trade (amount)
 * - total account deposit
 * - available free margin
 * - number of other active coins that may also need margin
 * - single-pair margin cap (max 20% of deposit)
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
}): { addAmount: number; addStake: number; targetAvgPrice: number; pullDistancePct: number } {
  const lev = Math.max(1, params.leverage);
  const totalBalance = Math.max(100, params.totalBalanceUsdt);
  const freeMargin = Math.max(0, totalBalance - params.usedMarginUsdt);
  const maxPairMarginLimit = ((params.maxPairMarginPct || 20.0) / 100) * totalBalance;

  const currentPairNotional = params.currentAmount * params.currentPrice;
  const currentPairMargin = currentPairNotional / lev;
  const remainingPairMargin = Math.max(0, maxPairMarginLimit - currentPairMargin);

  // Reserve margin for other coins: allocate at most 50% of free margin or fair share
  const fairShareMargin = freeMargin / Math.max(1, params.otherActiveCoinsCount + 1);
  const maxSafeMarginForThisStep = Math.min(
    remainingPairMargin,
    Math.max(25, Math.min(freeMargin * 0.5, fairShareMargin * 1.5))
  );

  // Desired average entry price: pull within 0.8% of current reversal price
  const targetAvgPrice = params.isShort
    ? params.currentPrice * 1.008
    : params.currentPrice * 0.992;

  // Q_add = Q_old * (P_old - P_target) / (P_target - P_current)
  const priceDiffOld = Math.abs(params.openRate - targetAvgPrice);
  const priceDiffNew = Math.abs(targetAvgPrice - params.currentPrice);

  let desiredAddAmount = params.currentAmount;
  if (priceDiffNew > 1e-8) {
    desiredAddAmount = params.currentAmount * (priceDiffOld / priceDiffNew);
  }

  // Convert desired amount to margin
  const desiredMargin = (desiredAddAmount * params.currentPrice) / lev;
  // Bound by safe margin (at least 25 USDT, at most maxSafeMarginForThisStep)
  const finalStake = Math.max(25, Math.min(desiredMargin, Math.max(25, maxSafeMarginForThisStep)));
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
