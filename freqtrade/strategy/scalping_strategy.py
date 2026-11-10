"""
Scalping Strategy (1h timeframe)
Optimized for high-probability momentum scalping on Binance Futures with 1% risk per trade.
"""
from typing import Dict, Any
import pandas as pd
from freqtrade.strategy.interface import IStrategy
from datetime import datetime
from freqtrade.strategy.indicators import (
    calculate_wavetrend, detect_reversal_patterns, detect_bearish_reversal_patterns
)

class ScalpingStrategy(IStrategy):
    """
    1-Hour Scalping Strategy.
    Timeframe: 1h
    Logic: 
    - Wave Reversal Signals (WaveTrend wt1/wt2 by Crypto Frontman)
    - Horizontal Support & Resistance Levels (Liquidity sweep & bounce)
    - EMA 9/21/50 Trend & Momentum Alignment
    - Volume & RSI Confirmation
    """
    timeframe = '1h'
    startup_candle_count = 1000
    
    # Выходы строго по уровням поддержки/сопротивления, поведению цены, слому тренда и сигналам RSI:
    minimal_roi = {}  # Отключаем фиксированные проценты по таймеру
    stoploss = -0.99   # Отключаем фиксированный процентный стоп, так как риск контролируется уровнями и Smart DCA
    trailing_stop = False

    def populate_indicators(self, dataframe: pd.DataFrame, metadata: Dict[str, Any]) -> pd.DataFrame:
        """Calculate indicators for 1h scalping."""
        
        # 1. Экспоненциальные средние: быстрый импульс (EMA 9), средний тренд (EMA 21), базовый тренд (EMA 50)
        dataframe['ema_fast'] = dataframe['close'].ewm(span=9, adjust=False).mean()
        dataframe['ema_slow'] = dataframe['close'].ewm(span=21, adjust=False).mean()
        dataframe['ema_trend'] = dataframe['close'].ewm(span=50, adjust=False).mean()
        
        # 2. Индекс относительной силы (RSI 14)
        delta = dataframe['close'].diff()
        gain = (delta.where(delta > 0, 0)).fillna(0)
        loss = (-delta.where(delta < 0, 0)).fillna(0)
        avg_gain = gain.rolling(window=14).mean()
        avg_loss = loss.rolling(window=14).mean()
        rs = avg_gain / (avg_loss + 1e-9)
        dataframe['rsi'] = 100 - (100 / (1 + rs))

        # 3. Средний объем за 20 свечей для выявления импульса
        dataframe['volume_mean'] = dataframe['volume'].rolling(window=20).mean()

        # 4. Wave Reversal Signals (WaveTrend - wt1 быстрая волна, wt2 сигнальная волна)
        dataframe['wt1'], dataframe['wt2'] = calculate_wavetrend(dataframe, channel_len=10, avg_len=21, signal_len=4)

        # 5. Уровни поддержки/сопротивления — ЕДИНСТВЕННЫЙ источник: умный анализ
        # (analyze_multi_timeframe с полной историей 4H/1D), переданный извне через
        # freqtradebot.py._process_pair ДО вызова populate_indicators. Никакой
        # собственной скользящей логики здесь больше нет.
        if 'smart_support' not in dataframe.columns or 'smart_resistance' not in dataframe.columns:
            raise ValueError(
                "smart_support/smart_resistance отсутствуют в датафрейме — "
                "убедитесь, что freqtradebot.py заполняет их до вызова strategy.analyze()"
            )
        dataframe['support_level'] = dataframe['smart_support']
        dataframe['resistance_level'] = dataframe['smart_resistance']

        # 6. Отскок / снятие ликвидности от уровня поддержки (по умному уровню)
        dataframe['support_bounce'] = detect_reversal_patterns(dataframe, dataframe['support_level'])

        # 7. Отклонение / снятие ликвидности от уровня сопротивления (по умному уровню)
        dataframe['resistance_rejection'] = detect_bearish_reversal_patterns(dataframe, dataframe['resistance_level'])

        return dataframe

    def populate_entry_trend(self, dataframe: pd.DataFrame, metadata: Dict[str, Any]) -> pd.DataFrame:
        """
        Условия входа в позицию (основаны на уровнях, RSI, WaveTrend и тренде):
        LONG:
          Режим А: Вход от уровня поддержки с подтверждением Wave Reversal и RSI.
          Режим Б: Трендовое продолжение движения вверх (EMA 9/21/50 + здоровый RSI + объем).
        SHORT (зеркально):
          Режим А: Вход от уровня сопротивления с подтверждением Wave Reversal и RSI.
          Режим Б: Трендовое продолжение движения вниз.
        """
        dataframe.loc[:, 'enter_long'] = 0
        dataframe.loc[:, 'enter_short'] = 0

        # Общие фильтры свечи и объема (с учетом незавершенной свечи)
        green_candle = dataframe['close'] > dataframe['open']
        red_candle = dataframe['close'] < dataframe['open']
        volume_ok = (dataframe['volume'] >= (dataframe['volume_mean'] * 0.70)) | (dataframe['volume'].shift(1) >= (dataframe['volume_mean'].shift(1) * 0.95))
        volume_trend_ok = (dataframe['volume'] >= (dataframe['volume_mean'] * 0.80)) | (dataframe['volume'].shift(1) >= (dataframe['volume_mean'].shift(1) * 1.05))

        # === LONG (Отскок от поддержки / Трендовый импульс) ===
        near_support = (dataframe['low'] <= dataframe['support_level'] * 1.012) & (dataframe['close'] >= dataframe['support_level'] * 0.985)
        support_signal = dataframe['support_bounce'] | near_support
        wave_oversold_cross = (dataframe['wt1'] > dataframe['wt2']) & ((dataframe['wt1'].shift(1) <= dataframe['wt2'].shift(1)) | (dataframe['wt2'] <= -25))
        rsi_oversold_ok = (dataframe['rsi'] <= 42) | ((dataframe['rsi'] > dataframe['rsi'].shift(1)) & (dataframe['rsi'] <= 55))
        
        level_reversal_entry = support_signal & wave_oversold_cross & rsi_oversold_ok & (green_candle | (dataframe['close'] > dataframe['low'])) & volume_ok

        trend_bullish = (dataframe['close'] > dataframe['ema_trend'] * 0.995) & (dataframe['ema_slow'] >= dataframe['ema_trend'] * 0.995)
        ema_crossover_up = (dataframe['ema_fast'] > dataframe['ema_slow']) & (dataframe['ema_fast'].shift(1) <= dataframe['ema_slow'].shift(1))
        ema_bounce_up = (dataframe['low'] <= dataframe['ema_slow'] * 1.008) & (dataframe['close'] > dataframe['ema_slow']) & (dataframe['ema_fast'] >= dataframe['ema_slow'])
        momentum_signal_up = ema_crossover_up | ema_bounce_up | ((dataframe['close'] > dataframe['ema_fast']) & (dataframe['ema_fast'] > dataframe['ema_slow']))
        momentum_rsi_up = (dataframe['rsi'] >= 42) & (dataframe['rsi'] <= 68)
        trend_momentum_entry_long = trend_bullish & momentum_signal_up & momentum_rsi_up & volume_trend_ok & green_candle

        dataframe.loc[level_reversal_entry | trend_momentum_entry_long, 'enter_long'] = 1

        # === SHORT (Отклонение от сопротивления / Нисходящий импульс) ===
        near_resistance = (dataframe['high'] >= dataframe['resistance_level'] * 0.988) & (dataframe['close'] <= dataframe['resistance_level'] * 1.015)
        resistance_signal = dataframe['resistance_rejection'] | near_resistance
        wave_overbought_cross = (dataframe['wt1'] < dataframe['wt2']) & ((dataframe['wt1'].shift(1) >= dataframe['wt2'].shift(1)) | (dataframe['wt2'] >= 25))
        rsi_overbought_ok = (dataframe['rsi'] >= 58) | ((dataframe['rsi'] < dataframe['rsi'].shift(1)) & (dataframe['rsi'] >= 45))
        
        level_reversal_entry_short = resistance_signal & wave_overbought_cross & rsi_overbought_ok & (red_candle | (dataframe['close'] < dataframe['high'])) & volume_ok

        trend_bearish = (dataframe['close'] < dataframe['ema_trend'] * 1.005) & (dataframe['ema_slow'] <= dataframe['ema_trend'] * 1.005)
        ema_crossover_down = (dataframe['ema_fast'] < dataframe['ema_slow']) & (dataframe['ema_fast'].shift(1) >= dataframe['ema_slow'].shift(1))
        ema_bounce_down = (dataframe['high'] >= dataframe['ema_slow'] * 0.992) & (dataframe['close'] < dataframe['ema_slow']) & (dataframe['ema_fast'] <= dataframe['ema_slow'])
        momentum_signal_down = ema_crossover_down | ema_bounce_down | ((dataframe['close'] < dataframe['ema_fast']) & (dataframe['ema_fast'] < dataframe['ema_slow']))
        momentum_rsi_down = (dataframe['rsi'] >= 32) & (dataframe['rsi'] <= 58)
        trend_momentum_entry_short = trend_bearish & momentum_signal_down & momentum_rsi_down & volume_trend_ok & red_candle

        dataframe.loc[level_reversal_entry_short | trend_momentum_entry_short, 'enter_short'] = 1

        return dataframe

    def populate_exit_trend(self, dataframe: pd.DataFrame, metadata: Dict[str, Any]) -> pd.DataFrame:
        """
        Условия выхода (основаны на уровнях, RSI и сломе структуры тренда):
        LONG выход:
          1. Достижение/тест уровня сопротивления при перекупленности (RSI >= 68 или Wave Reversal).
          2. Экстремальный RSI (> 78) с разворотной красной свечой (исчерпание покупательской силы).
          3. Слом восходящей структуры тренда: цена закрылась ниже EMA 50 + медвежий кросс EMA 9 < EMA 21 + RSI < 40.
        SHORT выход (зеркально):
          1. Достижение/тест уровня поддержки при перепроданности (RSI <= 32 или Wave Reversal со дна).
          2. Экстремальный RSI (< 22) с разворотной зеленой свечой (исчерпание давления продавцов).
          3. Слом нисходящей структуры тренда: цена закрылась выше EMA 50 + бычий кросс EMA 9 > EMA 21 + RSI > 60.
        """
        dataframe.loc[:, 'exit_long'] = 0
        dataframe.loc[:, 'exit_short'] = 0

        # === LONG Exit ===
        # 1. Тест сопротивления при высокой перекупленности
        resistance_tested = dataframe['high'] >= (dataframe['resistance_level'] * 0.998)
        rsi_overbought = dataframe['rsi'] >= 68
        wave_top_reversal = (
            (dataframe['wt1'] < dataframe['wt2']) &
            (dataframe['wt1'].shift(1) >= dataframe['wt2'].shift(1)) &
            (dataframe['wt2'] >= 45)
        )
        level_target_exit_long = resistance_tested & (rsi_overbought | wave_top_reversal)

        # 2. Экстремальная кульминация покупок (RSI > 78 и красная свеча)
        rsi_exhaustion_long = (dataframe['rsi'] >= 78) & (dataframe['close'] < dataframe['open'])

        # 3. Полный слом восходящего тренда
        trend_break_long = (
            (dataframe['close'] < dataframe['ema_trend']) &
            (dataframe['ema_fast'] < dataframe['ema_slow']) &
            (dataframe['rsi'] < 40)
        )

        dataframe.loc[
            level_target_exit_long | rsi_exhaustion_long | trend_break_long,
            'exit_long'
        ] = 1

        # === SHORT Exit (зеркально) ===
        # 1. Тест поддержки при глубокой перепроданности
        support_tested = dataframe['low'] <= (dataframe['support_level'] * 1.002)
        rsi_oversold = dataframe['rsi'] <= 32
        wave_bottom_reversal = (
            (dataframe['wt1'] > dataframe['wt2']) &
            (dataframe['wt1'].shift(1) <= dataframe['wt2'].shift(1)) &
            (dataframe['wt2'] <= -45)
        )
        level_target_exit_short = support_tested & (rsi_oversold | wave_bottom_reversal)

        # 2. Экстремальная кульминация продаж (RSI < 22 и зеленая свеча)
        rsi_exhaustion_short = (dataframe['rsi'] <= 22) & (dataframe['close'] > dataframe['open'])

        # 3. Полный слом нисходящего тренда
        trend_break_short = (
            (dataframe['close'] > dataframe['ema_trend']) &
            (dataframe['ema_fast'] > dataframe['ema_slow']) &
            (dataframe['rsi'] > 60)
        )

        dataframe.loc[
            level_target_exit_short | rsi_exhaustion_short | trend_break_short,
            'exit_short'
        ] = 1

        return dataframe

