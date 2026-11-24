// ============================================================================
// РАЗБОР ИСТОРИИ МОНЕТЫ: ПОДХОДЫ К УРОВНЯМ — РАЗВОРОТ ИЛИ ПРОБОЙ
//
// Инструмент, чтобы учиться «видеть» рынок. Находит в истории монеты все подходы цены к сильному
// уровню (минимум/максимум за последние ~120 свечей), запоминает, что было в момент подхода
// (дневной тренд, RSI, объём, тень свечи, снос за уровень, растянутость, 3-фазный сигнал бота),
// и чем закончилось:
//   «разворот» — цена ушла на 2 ATR от уровня раньше, чем на 1 ATR против;
//   «пробой»   — наоборот;
//   «неясно»   — ни то ни другое за горизонт;
//   «ещё идёт» — горизонт ещё не закончился.
// Признаки считаются только по данным до свечи события — без заглядывания в будущее.
// При случайном входе с соотношением цели и стопа 2:1 «разворот» бывает примерно в 33% случаев.
// ============================================================================

import {
  OhlcvCandle,
  calcEmaSeries,
  calcRsiSeries,
  assessTimeframeTrend,
  detectThreePhaseLevelReversal,
} from './scalpBotEngine.ts';

export type ReversalOutcome = 'reversal' | 'breakout' | 'unclear' | 'pending';

export interface ReversalHistoryEvent {
  timestamp: number;
  side: 'support' | 'resistance';
  level: number;
  price: number;
  atr: number;
  outcome: ReversalOutcome;
  /** Через сколько свечей наступил исход (если наступил). */
  bars_to_outcome: number | null;
  /** Наибольший ход в сторону разворота за горизонт, в ATR. */
  max_move_atr: number;
  features: {
    daily_trend: 'UP' | 'DOWN' | 'RANGE';
    with_daily_trend: boolean;
    against_daily_trend: boolean;
    rsi: number;
    rsi_extreme: boolean;
    rsi_divergence: boolean;
    volume_x: number;
    volume_climax: boolean;
    wick_pct: number;
    long_wick: boolean;
    swept_and_closed_back: boolean;
    extension_atr: number;
    extended: boolean;
    level_touches: number;
    bot_three_phase: boolean;
  };
}

export interface ReversalFeatureStat {
  key: string;
  label: string;
  events: number;
  reversal_pct: number;
}

export interface ReversalHistoryResult {
  timeframe: string;
  horizon_bars: number;
  total_events: number;
  resolved_events: number;
  reversal_pct: number;
  breakout_pct: number;
  unclear_pct: number;
  random_baseline_pct: number;
  feature_stats: ReversalFeatureStat[];
  events: ReversalHistoryEvent[];
}

const FEATURE_LABELS: Array<[keyof ReversalHistoryEvent['features'], string]> = [
  ['with_daily_trend', 'По дневному тренду'],
  ['against_daily_trend', 'Против дневного тренда'],
  ['bot_three_phase', '3-фазный сигнал бота'],
  ['swept_and_closed_back', 'Снос за уровень и возврат'],
  ['long_wick', 'Длинная тень ≥50% свечи'],
  ['rsi_divergence', 'Дивергенция RSI'],
  ['rsi_extreme', 'RSI <30 / >70'],
  ['volume_climax', 'Объём ≥2x среднего'],
  ['extended', 'Растянуто ≥2 ATR от EMA20'],
];

function atrSeries(cs: OhlcvCandle[], period = 14): number[] {
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    const tr =
      i === 0
        ? c.high - c.low
        : Math.max(c.high - c.low, Math.abs(c.high - cs[i - 1].close), Math.abs(c.low - cs[i - 1].close));
    prev = i < period ? (prev * i + tr) / (i + 1) : (prev * (period - 1) + tr) / period;
    out.push(prev);
  }
  return out;
}

const DAY_MS = 86_400_000;

export function analyzeReversalHistory(
  candlesRaw: OhlcvCandle[],
  candles1dRaw: OhlcvCandle[],
  timeframe: string,
  opts: { horizonBars?: number; lookbackBars?: number } = {}
): ReversalHistoryResult {
  const horizon = opts.horizonBars ?? 48;
  const lookback = opts.lookbackBars ?? 120;
  // Последние свечи считаются незакрытыми и в разбор не входят
  const cs = candlesRaw.slice(0, -1);
  const d1 = candles1dRaw.slice(0, -1);
  const result: ReversalHistoryResult = {
    timeframe,
    horizon_bars: horizon,
    total_events: 0,
    resolved_events: 0,
    reversal_pct: 0,
    breakout_pct: 0,
    unclear_pct: 0,
    random_baseline_pct: 33.3,
    feature_stats: [],
    events: [],
  };
  if (cs.length < lookback + 20) return result;

  const closes = cs.map((c) => c.close);
  const atr = atrSeries(cs, 14);
  const rsi = calcRsiSeries(closes, 14);
  const ema20 = calcEmaSeries(closes, 20);
  const volAvg = cs.map((_, i) => {
    let s = 0;
    let n = 0;
    for (let k = Math.max(0, i - 20); k < i; k++) {
      s += cs[k].volume || 0;
      n++;
    }
    return n > 0 ? s / n : cs[i].volume || 0;
  });

  // Дневной тренд на момент события — по дневным свечам, закрытым до него
  const dailyCache = new Map<number, 'UP' | 'DOWN' | 'RANGE'>();
  const dailyTrendAt = (ts: number): 'UP' | 'DOWN' | 'RANGE' => {
    let idx = -1;
    for (let k = d1.length - 1; k >= 0; k--) {
      if (d1[k].timestamp + DAY_MS <= ts) {
        idx = k;
        break;
      }
    }
    if (idx < 0) return 'RANGE';
    if (!dailyCache.has(idx)) {
      dailyCache.set(idx, assessTimeframeTrend(d1.slice(0, idx + 1), '1D', false).direction);
    }
    return dailyCache.get(idx)!;
  };

  const events: ReversalHistoryEvent[] = [];
  let lastEventIdx = -999;
  for (let i = lookback; i < cs.length; i++) {
    if (i - lastEventIdx < 6) continue; // один подход к уровню — одно событие
    const a = atr[i];
    if (!(a > 0)) continue;
    let sup = Infinity;
    let res = -Infinity;
    for (let k = i - lookback; k < i - 5; k++) {
      if (cs[k].low < sup) sup = cs[k].low;
      if (cs[k].high > res) res = cs[k].high;
    }
    const recent = cs.slice(i - 2, i + 1);
    const lowR = Math.min(...recent.map((c) => c.low));
    const highR = Math.max(...recent.map((c) => c.high));
    const atSupport = lowR <= sup + 0.5 * a;
    const atResistance = highR >= res - 0.5 * a;
    if (!atSupport && !atResistance) continue;
    const isSupport =
      atSupport && (!atResistance || Math.abs(cs[i].close - sup) <= Math.abs(res - cs[i].close));
    const level = isSupport ? sup : res;
    lastEventIdx = i;
    const c = cs[i];

    // Исход: вход по закрытию свечи события, цель 2 ATR в сторону разворота, стоп 1 ATR против
    const tp = isSupport ? c.close + 2 * a : c.close - 2 * a;
    const sl = isSupport ? c.close - a : c.close + a;
    let outcome: ReversalOutcome = i + horizon < cs.length ? 'unclear' : 'pending';
    let barsToOutcome: number | null = null;
    let maxMove = 0;
    for (let j = i + 1; j <= Math.min(cs.length - 1, i + horizon); j++) {
      const x = cs[j];
      const move = isSupport ? (x.high - c.close) / a : (c.close - x.low) / a;
      if (move > maxMove) maxMove = move;
      if (isSupport ? x.low <= sl : x.high >= sl) {
        outcome = 'breakout';
        barsToOutcome = j - i;
        break;
      }
      if (isSupport ? x.high >= tp : x.low <= tp) {
        outcome = 'reversal';
        barsToOutcome = j - i;
        break;
      }
    }

    // Признаки в момент подхода (только прошлые данные)
    const range = Math.max(1e-12, c.high - c.low);
    const wick = isSupport ? Math.min(c.open, c.close) - c.low : c.high - Math.max(c.open, c.close);
    const swept = isSupport ? lowR < level : highR > level;
    const closedBack = isSupport ? c.close > level : c.close < level;
    let divergence = false;
    if (i >= 60) {
      let pi = i - 60;
      for (let k = i - 60; k < i - 8; k++) {
        if (isSupport ? cs[k].low < cs[pi].low : cs[k].high > cs[pi].high) pi = k;
      }
      divergence = isSupport
        ? lowR <= cs[pi].low && rsi[i] > rsi[pi] + 3
        : highR >= cs[pi].high && rsi[i] < rsi[pi] - 3;
    }
    const volX = Math.max(...recent.map((x, k) => (x.volume || 0) / Math.max(1e-12, volAvg[i - 2 + k])));
    const extension = isSupport ? (ema20[i] - c.close) / a : (c.close - ema20[i]) / a;
    let touches = 0;
    for (let k = i - lookback; k < i - 5; k++) {
      const p = isSupport ? cs[k].low : cs[k].high;
      if (Math.abs(p - level) <= 0.5 * a) touches++;
    }
    const daily = dailyTrendAt(c.timestamp);
    const threePhase = detectThreePhaseLevelReversal(
      cs.slice(Math.max(0, i - 40), i + 1),
      level,
      isSupport,
      0.75
    ).confirmed;

    events.push({
      timestamp: c.timestamp,
      side: isSupport ? 'support' : 'resistance',
      level: Number(level.toPrecision(8)),
      price: c.close,
      atr: Number(a.toPrecision(6)),
      outcome,
      bars_to_outcome: barsToOutcome,
      max_move_atr: Number(maxMove.toFixed(2)),
      features: {
        daily_trend: daily,
        with_daily_trend: isSupport ? daily === 'UP' : daily === 'DOWN',
        against_daily_trend: isSupport ? daily === 'DOWN' : daily === 'UP',
        rsi: Number(rsi[i].toFixed(1)),
        rsi_extreme: isSupport ? rsi[i] < 30 : rsi[i] > 70,
        rsi_divergence: divergence,
        volume_x: Number(volX.toFixed(2)),
        volume_climax: volX >= 2,
        wick_pct: Math.round((wick / range) * 100),
        long_wick: wick / range >= 0.5,
        swept_and_closed_back: swept && closedBack,
        extension_atr: Number(extension.toFixed(2)),
        extended: extension >= 2,
        level_touches: touches,
        bot_three_phase: threePhase,
      },
    });
  }

  const resolved = events.filter((e) => e.outcome !== 'pending');
  const pct = (n: number, d: number) => (d > 0 ? Number(((n / d) * 100).toFixed(1)) : 0);
  result.events = events;
  result.total_events = events.length;
  result.resolved_events = resolved.length;
  result.reversal_pct = pct(resolved.filter((e) => e.outcome === 'reversal').length, resolved.length);
  result.breakout_pct = pct(resolved.filter((e) => e.outcome === 'breakout').length, resolved.length);
  result.unclear_pct = pct(resolved.filter((e) => e.outcome === 'unclear').length, resolved.length);
  result.feature_stats = FEATURE_LABELS.map(([key, label]) => {
    const subset = resolved.filter((e) => Boolean(e.features[key]));
    return {
      key,
      label,
      events: subset.length,
      reversal_pct: pct(subset.filter((e) => e.outcome === 'reversal').length, subset.length),
    };
  });
  return result;
}
