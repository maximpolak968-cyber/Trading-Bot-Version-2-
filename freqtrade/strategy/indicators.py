"""
Technical Indicators & Level Analysis Module
Includes:
- Wave Reversal Signals (WaveTrend algorithm)
- Support & Resistance Level Detection
- Liquidity Sweep & Reversal Candlestick Patterns
"""
from typing import Tuple, Any, Optional, Dict, List
import pandas as pd
import numpy as np

def calculate_wavetrend(
    dataframe: pd.DataFrame,
    channel_len: int = 10,
    avg_len: int = 21,
    signal_len: int = 4
) -> Tuple[pd.Series, pd.Series]:
    """
    Calculates WaveTrend / Wave Reversal indicator.
    wt1: fast momentum wave
    wt2: smoothed signal wave
    """
    # 1. Average Price (Typical Price)
    ap = (dataframe['high'] + dataframe['low'] + dataframe['close']) / 3.0
    
    # 2. Exponential Moving Average of ap
    esa = ap.ewm(span=channel_len, adjust=False).mean()
    
    # 3. EMA of absolute difference (Mean Deviation)
    d = (ap - esa).abs().ewm(span=channel_len, adjust=False).mean()
    
    # 4. Commodity Channel Index (CI)
    ci = (ap - esa) / (0.015 * d + 1e-9)
    
    # 5. Fast wave (wt1)
    wt1 = ci.ewm(span=avg_len, adjust=False).mean()
    
    # 6. Signal wave (wt2) - Simple Moving Average of wt1
    wt2 = wt1.rolling(window=signal_len).mean().fillna(wt1)
    
    return wt1, wt2


def detect_support_levels(dataframe: pd.DataFrame, window: int = 20) -> pd.Series:
    """
    Identifies dynamic horizontal support levels based on rolling swing lows.
    """
    rolling_low = dataframe['low'].rolling(window=window, min_periods=5).min()
    return rolling_low


def detect_resistance_levels(dataframe: pd.DataFrame, window: int = 20) -> pd.Series:
    """
    Identifies dynamic horizontal resistance levels based on rolling swing highs.
    Mirrors detect_support_levels but for highs.
    """
    rolling_high = dataframe['high'].rolling(window=window, min_periods=5).max()
    return rolling_high


def detect_market_structure(dataframe: pd.DataFrame, lookback: int = 30) -> dict:
    """
    Scans the market structure of candles:
    - Finds local Swing Highs and Swing Lows
    - Calculates absolute Range High and Range Low
    - Evaluates price position in the range (0% at bottom, 100% at top)
    - Finds nearest support and resistance levels for TP & SL target calculation
    """
    if len(dataframe) < 10:
        last_close = dataframe['close'].iloc[-1] if not dataframe.empty else 0.0
        return {
            'range_low': last_close * 0.95,
            'range_high': last_close * 1.05,
            'range_position_pct': 50.0,
            'nearest_support': last_close * 0.98,
            'nearest_resistance': last_close * 1.03,
            'recommended_tp': last_close * 1.025,
            'recommended_sl': last_close * 0.975,
            'swing_highs': [],
            'swing_lows': []
        }

    subset = dataframe.tail(lookback).copy().reset_index(drop=True)
    current_price = subset['close'].iloc[-1]
    
    range_low = float(subset['low'].min())
    range_high = float(subset['high'].max())
    
    # Calculate price relative position inside the range (0% to 100%)
    price_span = max(range_high - range_low, 1e-9)
    range_position_pct = float(((current_price - range_low) / price_span) * 100.0)
    range_position_pct = max(0.0, min(100.0, range_position_pct))

    # Detect fractal swings (window of 2 bars on each side)
    swing_highs = []
    swing_lows = []
    
    for i in range(2, len(subset) - 2):
        h = subset['high'].iloc[i]
        l = subset['low'].iloc[i]
        
        # Swing High: higher than 2 candles before and 2 after
        if h > subset['high'].iloc[i-1] and h > subset['high'].iloc[i-2] and \
           h >= subset['high'].iloc[i+1] and h >= subset['high'].iloc[i+2]:
            swing_highs.append(float(h))
            
        # Swing Low: lower than 2 candles before and 2 after
        if l < subset['low'].iloc[i-1] and l < subset['low'].iloc[i-2] and \
           l <= subset['low'].iloc[i+1] and l <= subset['low'].iloc[i+2]:
            swing_lows.append(float(l))

    # Find key resistance and support: приоритет отдаётся сильным проверенным уровням (по strength_score),
    # а не просто первой микро-кочке через min()/max().
    # Фильтруем уровни, которые слишком близко к цене (менее 0.8% - это шум текущей свечи),
    # чтобы цель (TP) и ориентир были реальными техническими барьерами.
    min_dist_pct = 0.8

    # === Статистика по уровням: сколько раз держали/пробивались за всю историю ===
    # Используем окно 3-5 баров для отсева шума и tolerance_pct=0.6% для устойчивой кластеризации
    levels_with_history = build_levels_with_history(subset, left_bars=3, right_bars=3, tolerance_pct=0.6)

    supports_hist = [
        l for l in levels_with_history 
        if l['type'] == 'support' and ((current_price - l['price']) / current_price * 100.0) >= min_dist_pct
    ]
    resistances_hist = [
        l for l in levels_with_history 
        if l['type'] == 'resistance' and ((l['price'] - current_price) / current_price * 100.0) >= min_dist_pct
    ]

    # Сортируем уровни по их силе (strength_score = касания + отскоки), выбирая самый сильный опорный уровень
    support_history = max(supports_hist, key=lambda l: l['strength_score']) if supports_hist else None
    resistance_history = max(resistances_hist, key=lambda l: l['strength_score']) if resistances_hist else None

    # Если сильный уровень найден — используем его
    if support_history:
        nearest_support = support_history['price']
    else:
        # Fallback к свингам
        supports_below = [s for s in swing_lows if (current_price - s) / current_price * 100.0 >= min_dist_pct]
        nearest_support = max(supports_below) if supports_below else range_low

    if resistance_history:
        nearest_resistance = resistance_history['price']
    else:
        # Fallback к свингам
        resistances_above = [r for r in swing_highs if (r - current_price) / current_price * 100.0 >= min_dist_pct]
        nearest_resistance = min(resistances_above) if resistances_above else range_high

    # Recommended Take-Profit: у сильного уровня сопротивления
    raw_tp = nearest_resistance * 0.998
    recommended_tp = float(raw_tp if raw_tp > current_price else current_price * 1.02)

    # Recommended Stop-Loss: под сильным уровнем поддержки
    raw_sl = nearest_support * 0.997
    recommended_sl = float(raw_sl if raw_sl < current_price else current_price * 0.98)

    return {
        'current_price': current_price,
        'range_low': range_low,
        'range_high': range_high,
        'range_position_pct': round(range_position_pct, 1),
        'nearest_support': round(nearest_support, 6),
        'nearest_resistance': round(nearest_resistance, 6),
        'recommended_tp': round(recommended_tp, 6),
        'recommended_sl': round(recommended_sl, 6),
        'swing_highs': swing_highs,
        'swing_lows': swing_lows,
        'support_history': support_history,
        'resistance_history': resistance_history
    }


def detect_reversal_patterns(dataframe: pd.DataFrame, support_level: pd.Series) -> pd.Series:
    """
    Detects bounce / liquidity sweep from support levels:
    - Price tested the support zone (within 0.8% or swept below it)
    - Closed above the support
    - Lower wick shows rejection of lower prices (buyers stepped in)
    """
    body = (dataframe['close'] - dataframe['open']).abs()
    lower_wick = dataframe[['open', 'close']].min(axis=1) - dataframe['low']
    
    # Lower wick is significant (at least 50% of candle body or at least 0.3% of price)
    has_wick = (lower_wick >= body * 0.5) | (lower_wick >= dataframe['close'] * 0.003)
    
    # Price tested near support (within 0.8% above or slightly swept below)
    tested_support = (dataframe['low'] <= support_level * 1.008) & (dataframe['close'] >= support_level * 0.995)
    
    # Green candle or strong rejection wick
    bullish_rejection = (dataframe['close'] > dataframe['open']) | has_wick
    
    return tested_support & bullish_rejection


def detect_bearish_reversal_patterns(dataframe: pd.DataFrame, resistance_level: pd.Series) -> pd.Series:
    """
    Detects rejection / liquidity sweep from resistance levels (mirror of detect_reversal_patterns):
    - Price tested the resistance zone (within 0.8% or swept above it)
    - Closed below the resistance
    - Upper wick shows rejection of higher prices (sellers stepped in)
    """
    body = (dataframe['close'] - dataframe['open']).abs()
    upper_wick = dataframe['high'] - dataframe[['open', 'close']].max(axis=1)

    # Upper wick is significant (at least 50% of candle body or at least 0.3% of price)
    has_wick = (upper_wick >= body * 0.5) | (upper_wick >= dataframe['close'] * 0.003)

    # Price tested near resistance (within 0.8% below or slightly swept above)
    tested_resistance = (dataframe['high'] >= resistance_level * 0.992) & (dataframe['close'] <= resistance_level * 1.005)

    # Red candle or strong rejection wick
    bearish_rejection = (dataframe['close'] < dataframe['open']) | has_wick

    return tested_resistance & bearish_rejection


def analyze_multi_timeframe(pair: str, exchange: Any, df_1h: pd.DataFrame) -> dict:
    """
    Multi-Timeframe Market Structure & Level Detection (1D + 4H + 1H):
    - 1D: Macro trend (EMAs) and 30-day range extremes.
    - 4H: Key institutional support and resistance levels, and range position.
    - 1H: Scalping execution levels, tactical TP & SL targets.
    """
    current_price = float(df_1h['close'].iloc[-1]) if not df_1h.empty else 0.0

    # 1. Fetch 1D and 4H candles with caching — берём МАКСИМУМ доступной истории,
    # а не последние несколько дней, чтобы уровни были по-настоящему "проверены временем".
    # 4H x 1000 ≈ 166 дней (~5.5 месяцев). 1D x 1000 ≈ вся доступная история большинства пар на Binance Futures.
    candles_4h = exchange.fetch_ohlcv_cached(pair, '4h', limit=1000, ttl=600.0) if exchange else []
    candles_1d = exchange.fetch_ohlcv_cached(pair, '1d', limit=1000, ttl=1800.0) if exchange else []

    # Process 1D Data
    d1_trend = "NEUTRAL"
    d1_high = current_price * 1.10
    d1_low = current_price * 0.90
    if len(candles_1d) >= 15:
        df_1d = pd.DataFrame(candles_1d, columns=['date', 'open', 'high', 'low', 'close', 'volume'])
        d1_ema20 = df_1d['close'].ewm(span=20, adjust=False).mean().iloc[-1]
        d1_ema50 = df_1d['close'].ewm(span=min(50, len(df_1d)), adjust=False).mean().iloc[-1]
        d1_high = float(df_1d['high'].max())
        d1_low = float(df_1d['low'].min())
        
        last_1d_close = df_1d['close'].iloc[-1]
        if last_1d_close > d1_ema20 and d1_ema20 > d1_ema50:
            d1_trend = "BULLISH"
        elif last_1d_close < d1_ema20 and d1_ema20 < d1_ema50:
            d1_trend = "BEARISH"
        elif last_1d_close > d1_ema20:
            d1_trend = "MILD_BULLISH"
        else:
            d1_trend = "MILD_BEARISH"

    # Process 4H Data (Key Institutional Levels) — используем ВСЮ полученную историю, не только хвост
    structure_4h = {}
    if len(candles_4h) >= 15:
        df_4h = pd.DataFrame(candles_4h, columns=['date', 'open', 'high', 'low', 'close', 'volume'])
        structure_4h = detect_market_structure(df_4h, lookback=len(df_4h))
    else:
        structure_4h = detect_market_structure(df_1h, lookback=40)

    # Process 1D Data (Долгосрочные уровни — то, что монета показывала за всю доступную историю)
    structure_1d = {}
    if len(candles_1d) >= 30:
        df_1d_levels = pd.DataFrame(candles_1d, columns=['date', 'open', 'high', 'low', 'close', 'volume'])
        structure_1d = detect_market_structure(df_1d_levels, lookback=len(df_1d_levels))

    # Process 1H Data (Execution / Scalping)
    structure_1h = detect_market_structure(df_1h, lookback=30)

    # Reconcile Levels across 4H and 1H
    key_4h_support = structure_4h.get('nearest_support', structure_1h.get('nearest_support', current_price * 0.98))
    key_4h_resistance = structure_4h.get('nearest_resistance', structure_1h.get('nearest_resistance', current_price * 1.03))
    pos_4h_pct = structure_4h.get('range_position_pct', 50.0)

    # Если долгосрочный уровень найден — он становится ключевым ориентиром для цели,
    # а не только для guard-проверки allow_long/allow_short.
    if structure_1d.get('nearest_support'):
        key_4h_support = max(key_4h_support, structure_1d['nearest_support']) if structure_1d['nearest_support'] < current_price else key_4h_support
    if structure_1d.get('nearest_resistance'):
        key_4h_resistance = min(key_4h_resistance, structure_1d['nearest_resistance']) if structure_1d['nearest_resistance'] > current_price else key_4h_resistance

    local_1h_support = structure_1h.get('nearest_support', current_price * 0.99)
    local_1h_resistance = structure_1h.get('nearest_resistance', current_price * 1.02)
    pos_1h_pct = structure_1h.get('range_position_pct', 50.0)

    # Distance to key 4H resistance and support
    dist_to_4h_res_pct = ((key_4h_resistance - current_price) / current_price) * 100.0 if current_price > 0 else 0.0
    dist_to_4h_sup_pct = ((current_price - key_4h_support) / current_price) * 100.0 if current_price > 0 else 0.0

    # Decision Matrix & Guard Rails
    allow_long = True
    allow_short = True
    rejection_reason_long = None
    rejection_reason_short = None

    # Guard: Don't Long if 4H position > 85% or less than 0.85% to major 4H resistance
    if pos_4h_pct > 85.0 and d1_trend != "BULLISH":
        allow_long = False
        rejection_reason_long = f"4H Range Top: price is at {pos_4h_pct:.1f}% of 4H channel (Overbought)"
    elif dist_to_4h_res_pct < 0.85 and dist_to_4h_res_pct > 0:
        allow_long = False
        rejection_reason_long = f"Too close to 4H Resistance: only {dist_to_4h_res_pct:.2f}% to {key_4h_resistance}"
    elif d1_trend == "BEARISH" and pos_4h_pct > 50.0:
        allow_long = False
        rejection_reason_long = f"1D Trend is Bearish and 4H is above middle ({pos_4h_pct:.1f}%)"

    # Guard: Don't Short if 4H position < 15% or less than 0.85% to major 4H support (Oversold bottom)
    if pos_4h_pct < 15.0 and d1_trend != "BEARISH":
        allow_short = False
        rejection_reason_short = f"4H Range Bottom: price is at {pos_4h_pct:.1f}% of 4H channel (Oversold)"
    elif dist_to_4h_sup_pct < 0.85 and dist_to_4h_sup_pct > 0:
        allow_short = False
        rejection_reason_short = f"Too close to 4H Support: only {dist_to_4h_sup_pct:.2f}% to {key_4h_support}"
    elif d1_trend == "BULLISH" and pos_4h_pct < 50.0:
        allow_short = False
        rejection_reason_short = f"1D Trend is Bullish and 4H is below middle ({pos_4h_pct:.1f}%)"

    # Fast Scalp Targets (0.8% - 1.5% price move = 20% - 37.5% gross / ~17% - 34% net ROI on 25x after 0.06% Taker fees):
    # LONG Targets:
    min_tp_long = current_price * 1.008
    max_tp_long = current_price * 1.015
    default_tp_long = current_price * 1.012
    raw_tp_long = local_1h_resistance * 0.998 if (min_tp_long <= local_1h_resistance * 0.998 <= max_tp_long) else (
        key_4h_resistance * 0.998 if (min_tp_long <= key_4h_resistance * 0.998 <= max_tp_long) else default_tp_long
    )
    rec_tp_long = raw_tp_long

    # SL: Place strictly below key support (0.3% buffer under level)
    support_anchor = key_4h_support if key_4h_support < current_price else local_1h_support
    raw_sl_long = support_anchor * 0.997
    rec_sl_long = raw_sl_long if raw_sl_long < current_price else current_price * 0.99

    # SHORT Targets (Symmetric):
    min_tp_short = current_price * 0.992
    max_tp_short = current_price * 0.985
    default_tp_short = current_price * 0.988
    raw_tp_short = local_1h_support * 1.002 if (max_tp_short <= local_1h_support * 1.002 <= min_tp_short) else (
        key_4h_support * 1.002 if (max_tp_short <= key_4h_support * 1.002 <= min_tp_short) else default_tp_short
    )
    rec_tp_short = raw_tp_short

    # SL: Place strictly above key resistance (0.3% buffer above level)
    resistance_anchor = key_4h_resistance if key_4h_resistance > current_price else local_1h_resistance
    raw_sl_short = resistance_anchor * 1.003
    rec_sl_short = raw_sl_short if raw_sl_short > current_price else current_price * 1.01

    level_map_summary = (
        f"1D Trend: {d1_trend} [Range: {d1_low:.4f} - {d1_high:.4f}] | "
        f"4H Levels: Support={key_4h_support}, Resistance={key_4h_resistance} (Pos: {pos_4h_pct:.1f}%) | "
        f"1H Scalp Levels: Support={local_1h_support}, Resistance={local_1h_resistance} (Pos: {pos_1h_pct:.1f}%)"
    )

    # Support / Resistance history: приоритет долгосрочным уровням (1D — вся история),
    # затем 4H, и только потом 1H как самый "слабый" источник.
    support_history = structure_1d.get('support_history') or structure_4h.get('support_history') or structure_1h.get('support_history')
    resistance_history = structure_1d.get('resistance_history') or structure_4h.get('resistance_history') or structure_1h.get('resistance_history')

    # Guard against entering at levels with poor historical bounce rate (breaks > bounces)
    if support_history and support_history.get('breaks', 0) > support_history.get('bounces', 0):
        allow_long = False
        rejection_reason_long = f"Support at {support_history['price']} has weak history: {support_history['bounces']} bounces vs {support_history['breaks']} breaks"

    if resistance_history and resistance_history.get('breaks', 0) > resistance_history.get('bounces', 0):
        allow_short = False
        rejection_reason_short = f"Resistance at {resistance_history['price']} has weak history: {resistance_history['bounces']} bounces vs {resistance_history['breaks']} breaks"

    return {
        'd1_trend': d1_trend,
        'd1_high': d1_high,
        'd1_low': d1_low,
        'key_4h_support': key_4h_support,
        'key_4h_resistance': key_4h_resistance,
        'pos_4h_pct': pos_4h_pct,
        'local_1h_support': local_1h_support,
        'local_1h_resistance': local_1h_resistance,
        'pos_1h_pct': pos_1h_pct,
        'dist_to_4h_res_pct': round(dist_to_4h_res_pct, 2),
        'dist_to_4h_sup_pct': round(dist_to_4h_sup_pct, 2),
        'recommended_tp': round(rec_tp_long, 6),
        'recommended_tp_long': round(rec_tp_long, 6),
        'recommended_tp_short': round(rec_tp_short, 6),
        'recommended_sl': round(rec_sl_long, 6),
        'recommended_sl_long': round(rec_sl_long, 6),
        'recommended_sl_short': round(rec_sl_short, 6),
        'allow_long': allow_long,
        'allow_short': allow_short,
        'rejection_reason': rejection_reason_long or rejection_reason_short,
        'rejection_reason_long': rejection_reason_long,
        'rejection_reason_short': rejection_reason_short,
        'level_map_summary': level_map_summary,
        'support_history': support_history,
        'resistance_history': resistance_history
    }


def find_pivots(dataframe: pd.DataFrame, left_bars: int = 3, right_bars: int = 3) -> List[Dict[str, Any]]:
    """
    Находит локальные экстремумы (пивоты): свечи, чей high/low строго максимум/минимум
    в окне [i-left_bars, i+right_bars]. Это "сырые" точки будущих уровней.
    """
    highs = dataframe['high'].values
    lows = dataframe['low'].values
    pivots: List[Dict[str, Any]] = []
    n = len(dataframe)

    for i in range(left_bars, n - right_bars):
        window_high = highs[i - left_bars:i + right_bars + 1]
        window_low = lows[i - left_bars:i + right_bars + 1]
        if highs[i] == window_high.max():
            pivots.append({'index': i, 'price': float(highs[i]), 'type': 'high'})
        if lows[i] == window_low.min():
            pivots.append({'index': i, 'price': float(lows[i]), 'type': 'low'})

    return pivots


def cluster_pivots_into_levels(pivots: List[Dict[str, Any]], tolerance_pct: float = 0.5) -> List[Dict[str, Any]]:
    """
    Группирует пивоты одного типа, близкие друг к другу по цене (в пределах tolerance_pct%),
    в единые "сырые" уровни.
    """
    sorted_pivots = sorted(pivots, key=lambda p: p['price'])
    clusters: List[Dict[str, Any]] = []

    for pivot in sorted_pivots:
        found = None
        for c in clusters:
            if c['type'] != pivot['type']:
                continue
            avg_price = sum(c['prices']) / len(c['prices'])
            if avg_price == 0:
                continue
            if abs(pivot['price'] - avg_price) / avg_price * 100 <= tolerance_pct:
                found = c
                break
        if found is not None:
            found['prices'].append(pivot['price'])
            found['indices'].append(pivot['index'])
        else:
            clusters.append({'prices': [pivot['price']], 'type': pivot['type'], 'indices': [pivot['index']]})

    return [
        {'price': sum(c['prices']) / len(c['prices']), 'type': c['type'], 'indices': c['indices']}
        for c in clusters
    ]


def analyze_level_interactions(
    dataframe: pd.DataFrame,
    raw_levels: List[Dict[str, Any]],
    touch_tolerance_pct: float = 0.35
) -> List[Dict[str, Any]]:
    """
    Проходит по ВСЕЙ истории свечей в dataframe и для каждого уровня считает:
      - touches: сколько раз цена подходила близко к уровню (в пределах touch_tolerance_pct%)
      - bounces: сколько раз после касания цена закрылась (в следующие 1-3 свечи) по ту же
                 сторону уровня, что и раньше (уровень удержал)
      - breaks:  сколько раз цена закрылась за уровнем (уровень пробит)
    Возвращает список уровней, отсортированный по strength_score (сила) по убыванию.
    """
    highs = dataframe['high'].values
    lows = dataframe['low'].values
    closes = dataframe['close'].values
    n = len(dataframe)

    levels: List[Dict[str, Any]] = []

    for raw in raw_levels:
        # Минимум 2 пивота нужно, чтобы считать это настоящим уровнем, а не случайной свечой
        if len(raw['indices']) < 2:
            continue

        price = raw['price']
        touches = 0
        bounces = 0
        breaks = 0
        last_touch_index = raw['indices'][0]

        for i in range(n):
            dist_high = abs(highs[i] - price) / price * 100
            dist_low = abs(lows[i] - price) / price * 100
            if dist_high > touch_tolerance_pct and dist_low > touch_tolerance_pct:
                continue

            last_touch_index = i

            lookahead = closes[i + 1:i + 4]
            if len(lookahead) == 0:
                # Если это самая последняя свеча (нет истории для оценки исхода),
                # считаем текущий отскок, чтобы touches == bounces + breaks
                touches += 1
                bounces += 1
                continue

            touches += 1

            is_resistance = raw['type'] == 'high'
            if is_resistance:
                broke = any(c > price * (1 + touch_tolerance_pct / 100) for c in lookahead)
            else:
                broke = any(c < price * (1 - touch_tolerance_pct / 100) for c in lookahead)

            if broke:
                breaks += 1
            else:
                bounces += 1

        if touches == 0:
            continue

        bounce_rate = bounces / touches
        recency_weight = 1 - (n - 1 - last_touch_index) / n
        # Сила уровня: больше касаний + выше доля отскоков (не пробоев) + свежесть последнего касания
        strength_score = touches * 0.3 + bounce_rate * 2 + recency_weight

        levels.append({
            'price': round(price, 8),
            'type': 'resistance' if raw['type'] == 'high' else 'support',
            'touches': touches,
            'bounces': bounces,
            'breaks': breaks,
            'bounce_rate': round(bounce_rate, 3),
            'last_touch_index': last_touch_index,
            'strength_score': round(strength_score, 3),
        })

    return sorted(levels, key=lambda l: l['strength_score'], reverse=True)


def build_levels_with_history(
    dataframe: pd.DataFrame,
    left_bars: int = 3,
    right_bars: int = 3,
    tolerance_pct: float = 0.5
) -> List[Dict[str, Any]]:
    """
    Полный конвейер: найти пивоты -> сгруппировать в уровни -> посчитать историю
    касаний/отскоков/пробоев. Используй эту функцию как основную точку входа.
    """
    pivots = find_pivots(dataframe, left_bars, right_bars)
    raw_levels = cluster_pivots_into_levels(pivots, tolerance_pct)
    return analyze_level_interactions(dataframe, raw_levels, tolerance_pct)


def is_knife_drop(dataframe: pd.DataFrame, candle_idx: int = -1) -> bool:
    """
    Проверяет, не падает ли монета "падающим ножом" (сильная полнотелая красная свеча
    с почти полным отсутствием нижней тени отбоя).
    При таком падении категорически ЗАПРЕЩЕНО усреднять или входить в LONG.
    """
    if dataframe.empty or len(dataframe) < abs(candle_idx):
        return False
    row = dataframe.iloc[candle_idx]
    open_p, high_p, low_p, close_p = row['open'], row['high'], row['low'], row['close']
    if close_p >= open_p:
        return False  # Зеленая свеча — не падающий нож

    candle_range = max(high_p - low_p, 1e-9)
    body = open_p - close_p
    lower_wick = close_p - low_p

    # Если тело составляет более 75% всей свечи, а нижняя тень менее 10% от диапазона свечи — это свободное падение
    is_strong_dump = (body / candle_range >= 0.75) and (lower_wick / candle_range <= 0.10)
    # Или свеча упала более чем на 2.0% без признаков откупа
    is_large_dump = (body / open_p >= 0.02) and (lower_wick <= body * 0.15)

    return bool(is_strong_dump or is_large_dump)


def is_pump_exhaustion(dataframe: pd.DataFrame, candle_idx: int = -1) -> bool:
    """
    Проверяет, не летит ли монета "ракетой" (сильная полнотелая зелёная свеча
    без верхней тени). При таком росте категорически ЗАПРЕЩЕНО усреднять SHORT.
    """
    if dataframe.empty or len(dataframe) < abs(candle_idx):
        return False
    row = dataframe.iloc[candle_idx]
    open_p, high_p, low_p, close_p = row['open'], row['high'], row['low'], row['close']
    if close_p <= open_p:
        return False

    candle_range = max(high_p - low_p, 1e-9)
    body = close_p - open_p
    upper_wick = high_p - close_p

    is_strong_pump = (body / candle_range >= 0.75) and (upper_wick / candle_range <= 0.10)
    is_large_pump = (body / open_p >= 0.02) and (upper_wick <= body * 0.15)

    return bool(is_strong_pump or is_large_pump)


def check_candle_rejection(dataframe: pd.DataFrame, level: float, is_short: bool = False, tolerance_pct: float = 1.0) -> Dict[str, Any]:
    """
    Анализирует поведение цены на ключевом уровне:
    - Для LONG (уровень поддержки): была ли отбойная нижняя тень (пин-бар) или закрытие выше уровня.
    - Для SHORT (уровень сопротивления): была ли отбойная верхняя тень или закрытие ниже уровня.
    """
    if dataframe.empty or len(dataframe) < 2 or level <= 0:
        return {'confirmed': False, 'reason': 'No candle data'}

    last_row = dataframe.iloc[-1]
    prev_row = dataframe.iloc[-2]

    open_p, high_p, low_p, close_p = last_row['open'], last_row['high'], last_row['low'], last_row['close']
    body = abs(close_p - open_p)
    candle_range = max(high_p - low_p, 1e-9)

    if not is_short:
        # Анализ поддержки (Long)
        near_level = low_p <= level * (1 + tolerance_pct / 100.0)
        if not near_level:
            return {'confirmed': False, 'reason': f'Price {low_p} not testing support {level}'}

        if is_knife_drop(dataframe, -1):
            return {'confirmed': False, 'reason': 'Falling knife detected (no lower wick, strong dump candle)'}

        lower_wick = min(open_p, close_p) - low_p
        # Отбойная тень (тень составляет хотя бы 35% свечи или закрылись зелёной)
        has_rejection_wick = (lower_wick / candle_range >= 0.35) or (lower_wick >= body * 0.8)
        closed_above_level = close_p >= level * 0.998
        is_green = close_p > open_p
        bullish_engulfing = is_green and (close_p > prev_row['open']) and (prev_row['close'] < prev_row['open'])

        confirmed = closed_above_level and (has_rejection_wick or is_green or bullish_engulfing)
        return {
            'confirmed': bool(confirmed),
            'has_wick': bool(has_rejection_wick),
            'is_green': bool(is_green),
            'bullish_engulfing': bool(bullish_engulfing),
            'reason': 'Support bounce confirmed by price action' if confirmed else 'Waiting for support rejection confirmation'
        }
    else:
        # Анализ сопротивления (Short)
        near_level = high_p >= level * (1 - tolerance_pct / 100.0)
        if not near_level:
            return {'confirmed': False, 'reason': f'Price {high_p} not testing resistance {level}'}

        if is_pump_exhaustion(dataframe, -1):
            return {'confirmed': False, 'reason': 'Rocket pump detected (no upper wick, strong pump candle)'}

        upper_wick = high_p - max(open_p, close_p)
        has_rejection_wick = (upper_wick / candle_range >= 0.35) or (upper_wick >= body * 0.8)
        closed_below_level = close_p <= level * 1.002
        is_red = close_p < open_p
        bearish_engulfing = is_red and (close_p < prev_row['open']) and (prev_row['close'] > prev_row['open'])

        confirmed = closed_below_level and (has_rejection_wick or is_red or bearish_engulfing)
        return {
            'confirmed': bool(confirmed),
            'has_wick': bool(has_rejection_wick),
            'is_red': bool(is_red),
            'bearish_engulfing': bool(bearish_engulfing),
            'reason': 'Resistance rejection confirmed by price action' if confirmed else 'Waiting for resistance rejection confirmation'
        }


def check_rsi_condition(dataframe: pd.DataFrame, is_short: bool = False, period: int = 14) -> Dict[str, Any]:
    """
    Рассчитывает RSI и проверяет экстремальные зоны и разворот:
    - Long: перепроданность (RSI <= 38) и загиб вверх (rsi[-1] > rsi[-2] или rsi[-1] <= 32).
    - Short: перекупленность (RSI >= 62) и загиб вниз (rsi[-1] < rsi[-2] или rsi[-1] >= 68).
    """
    if len(dataframe) < period + 2:
        return {'confirmed': False, 'rsi': 50.0, 'reason': 'Not enough candles for RSI'}

    delta = dataframe['close'].diff()
    gain = (delta.where(delta > 0, 0)).fillna(0)
    loss = (-delta.where(delta < 0, 0)).fillna(0)
    avg_gain = gain.rolling(window=period).mean()
    avg_loss = loss.rolling(window=period).mean()
    rs = avg_gain / (avg_loss + 1e-9)
    rsi_series = 100 - (100 / (1 + rs))

    rsi_now = float(rsi_series.iloc[-1])
    rsi_prev = float(rsi_series.iloc[-2])
    rsi_turn_up = rsi_now > rsi_prev
    rsi_turn_down = rsi_now < rsi_prev

    if not is_short:
        # Для Long: перепроданность + разворот
        is_oversold = rsi_now <= 40.0
        reversal = is_oversold and (rsi_turn_up or rsi_now <= 30.0)
        return {
            'confirmed': bool(reversal),
            'rsi': round(rsi_now, 2),
            'rsi_prev': round(rsi_prev, 2),
            'is_oversold': bool(is_oversold),
            'reason': f"RSI {rsi_now:.1f} oversold and turning up" if reversal else f"RSI {rsi_now:.1f} not in reversal setup for Long"
        }
    else:
        # Для Short: перекупленность + разворот
        is_overbought = rsi_now >= 60.0
        reversal = is_overbought and (rsi_turn_down or rsi_now >= 70.0)
        return {
            'confirmed': bool(reversal),
            'rsi': round(rsi_now, 2),
            'rsi_prev': round(rsi_prev, 2),
            'is_overbought': bool(is_overbought),
            'reason': f"RSI {rsi_now:.1f} overbought and turning down" if reversal else f"RSI {rsi_now:.1f} not in reversal setup for Short"
        }


def is_hedge_entry_candidate(
    structure: Dict[str, Any],
    min_range_pct: float = 35.0,
    max_range_pct: float = 65.0,
    min_range_width_pct: float = 3.0
) -> bool:
    """
    Монета подходит для одновременного входа LONG+SHORT только если цена сейчас
    в средней зоне диапазона (не на хаях, не на лоях) И диапазон не боковик
    (достаточно широкий, чтобы было куда идти в обе стороны).
    """
    pos = structure.get('range_position_pct')
    range_high = structure.get('range_high')
    range_low = structure.get('range_low')
    current_price = structure.get('current_price')

    if pos is None or not range_high or not range_low or not current_price or current_price <= 0:
        return False

    if not (min_range_pct <= pos <= max_range_pct):
        return False

    range_width_pct = ((range_high - range_low) / current_price) * 100.0
    if range_width_pct < min_range_width_pct:
        return False  # боковик — диапазон слишком узкий, нечего ловить

    return True


def find_strongest_dca_level(
    pair: str,
    exchange: Any,
    current_price: float,
    is_short: bool,
    min_dist_pct: float = 1.5
) -> Dict[str, Any]:
    """
    Finds the single strongest institutional Support (for Long) or Resistance (for Short)
    on 4H and 1D timeframes based on historical strength_score (bounces/touches vs breaks).
    
    Ensures DCA is not triggered at weak intermediate levels or noise.
    """
    if not exchange or current_price <= 0:
        fallback = round(current_price * (1.025 if is_short else 0.975), 6)
        return {'price': fallback, 'strength_score': 0, 'source': 'fallback'}

    # 1. Fetch 4H and 1D historical data
    candles_4h = exchange.fetch_ohlcv_cached(pair, '4h', limit=1000, ttl=300.0) if exchange else []
    candles_1d = exchange.fetch_ohlcv_cached(pair, '1d', limit=1000, ttl=900.0) if exchange else []

    all_candidate_levels = []

    # 2. Extract levels from 4H
    if len(candles_4h) >= 30:
        df_4h = pd.DataFrame(candles_4h, columns=['date', 'open', 'high', 'low', 'close', 'volume'])
        levels_4h = build_levels_with_history(df_4h, left_bars=3, right_bars=3, tolerance_pct=0.6)
        for lvl in levels_4h:
            lvl['source'] = '4H'
            all_candidate_levels.append(lvl)

    # 3. Extract levels from 1D
    if len(candles_1d) >= 30:
        df_1d = pd.DataFrame(candles_1d, columns=['date', 'open', 'high', 'low', 'close', 'volume'])
        levels_1d = build_levels_with_history(df_1d, left_bars=3, right_bars=3, tolerance_pct=0.8)
        for lvl in levels_1d:
            lvl['source'] = '1D'
            # Give 1D levels a strength boost due to macro significance
            lvl['strength_score'] = lvl.get('strength_score', 0) * 1.5
            all_candidate_levels.append(lvl)

    # 4. Filter strictly by direction and minimum distance
    valid_levels = []
    for lvl in all_candidate_levels:
        lvl_price = lvl['price']
        if not is_short:
            # For LONG: Must be Support strictly below current price by at least min_dist_pct
            dist_pct = ((current_price - lvl_price) / current_price) * 100.0
            if lvl['type'] == 'support' and dist_pct >= min_dist_pct:
                valid_levels.append(lvl)
        else:
            # For SHORT: Must be Resistance strictly above current price by at least min_dist_pct
            dist_pct = ((lvl_price - current_price) / current_price) * 100.0
            if lvl['type'] == 'resistance' and dist_pct >= min_dist_pct:
                valid_levels.append(lvl)

    if valid_levels:
        # Pick the level with the absolute highest strength_score
        best_level = max(valid_levels, key=lambda l: (l.get('strength_score', 0), l.get('bounces', 0)))
        return {
            'price': round(best_level['price'], 6),
            'strength_score': best_level.get('strength_score', 0),
            'bounces': best_level.get('bounces', 0),
            'breaks': best_level.get('breaks', 0),
            'source': best_level.get('source', '4H/1D'),
            'type': best_level.get('type')
        }

    # Fallback to calculated step if no macro level found
    fallback_price = round(current_price * (1.025 if is_short else 0.975), 6)
    return {
        'price': fallback_price,
        'strength_score': 0,
        'bounces': 0,
        'breaks': 0,
        'source': 'default_step',
        'type': 'resistance' if is_short else 'support'
    }








