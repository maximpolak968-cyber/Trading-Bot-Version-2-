"""
Advanced Strategy (MACD + Bollinger + Volume)
"""
from typing import Dict, Any, Optional
import pandas as pd
from freqtrade.strategy.interface import IStrategy
from freqtrade.models.trade import Trade
from datetime import datetime

class AdvancedStrategy(IStrategy):
    """
    Advanced strategy with custom stoploss, trailing stop, and stricter entry rules.
    """
    timeframe = '15m'
    startup_candle_count = 50
    
    # Dynamic ROI
    minimal_roi = {
        "120": 0.015,
        "60": 0.03,
        "30": 0.05,
        "0": 0.08
    }
    
    stoploss = -0.15
    trailing_stop = True
    trailing_stop_positive = 0.01
    trailing_stop_positive_offset = 0.03
    trailing_only_offset_is_reached = True

    def populate_indicators(self, dataframe: pd.DataFrame, metadata: Dict[str, Any]) -> pd.DataFrame:
        """Calculate advanced indicators."""
        
        # MACD
        ema_12 = dataframe['close'].ewm(span=12, adjust=False).mean()
        ema_26 = dataframe['close'].ewm(span=26, adjust=False).mean()
        dataframe['macd'] = ema_12 - ema_26
        dataframe['macdsignal'] = dataframe['macd'].ewm(span=9, adjust=False).mean()
        dataframe['macdhist'] = dataframe['macd'] - dataframe['macdsignal']
        
        # Bollinger Bands
        window = 20
        rolling_mean = dataframe['close'].rolling(window).mean()
        rolling_std = dataframe['close'].rolling(window).std()
        dataframe['bb_upperband'] = rolling_mean + (rolling_std * 2)
        dataframe['bb_middleband'] = rolling_mean
        dataframe['bb_lowerband'] = rolling_mean - (rolling_std * 2)
        dataframe['bb_percent'] = (dataframe['close'] - dataframe['bb_lowerband']) / (dataframe['bb_upperband'] - dataframe['bb_lowerband'])
        
        # Volume SMA
        dataframe['volume_mean'] = dataframe['volume'].rolling(window=20).mean()
        
        # RSI
        delta = dataframe['close'].diff()
        gain = (delta.where(delta > 0, 0)).fillna(0)
        loss = (-delta.where(delta < 0, 0)).fillna(0)
        avg_gain = gain.rolling(window=14).mean()
        avg_loss = loss.rolling(window=14).mean()
        rs = avg_gain / avg_loss
        dataframe['rsi'] = 100 - (100 / (1 + rs))

        return dataframe

    def populate_entry_trend(self, dataframe: pd.DataFrame, metadata: Dict[str, Any]) -> pd.DataFrame:
        """
        Buy condition: Price touches lower BB, MACD starts rising, high volume.
        """
        dataframe.loc[:, 'enter_long'] = 0
        
        dataframe.loc[
            (
                (dataframe['close'] < dataframe['bb_lowerband']) & # Touched lower band
                (dataframe['macdhist'] > dataframe['macdhist'].shift(1)) & # MACD hist is growing
                (dataframe['macd'] < 0) & # MACD is below 0 line
                (dataframe['rsi'] < 35) & # RSI is low
                (dataframe['volume'] > dataframe['volume_mean'] * 1.5) # Volume spike
            ),
            'enter_long'] = 1
            
        # Short condition (if margin/futures)
        dataframe.loc[:, 'enter_short'] = 0
        dataframe.loc[
            (
                (dataframe['close'] > dataframe['bb_upperband']) & 
                (dataframe['macdhist'] < dataframe['macdhist'].shift(1)) &
                (dataframe['macd'] > 0) & 
                (dataframe['rsi'] > 65) & 
                (dataframe['volume'] > dataframe['volume_mean'] * 1.5) 
            ),
            'enter_short'] = 1

        return dataframe

    def populate_exit_trend(self, dataframe: pd.DataFrame, metadata: Dict[str, Any]) -> pd.DataFrame:
        """
        Sell condition: Price touches upper BB or MACD crosses down.
        """
        dataframe.loc[:, 'exit_long'] = 0
        
        macd_cross_down = (dataframe['macd'] < dataframe['macdsignal']) & (dataframe['macd'].shift(1) >= dataframe['macdsignal'].shift(1))
        
        dataframe.loc[
            (
                (dataframe['close'] > dataframe['bb_upperband']) | # Hits upper band
                macd_cross_down # MACD cross down
            ) & (dataframe['volume'] > 0),
            'exit_long'] = 1
            
        # Exit short condition
        dataframe.loc[:, 'exit_short'] = 0
        macd_cross_up = (dataframe['macd'] > dataframe['macdsignal']) & (dataframe['macd'].shift(1) <= dataframe['macdsignal'].shift(1))
        
        dataframe.loc[
            (
                (dataframe['close'] < dataframe['bb_lowerband']) | 
                macd_cross_up 
            ) & (dataframe['volume'] > 0),
            'exit_short'] = 1

        return dataframe
        
    def custom_stoploss(self, pair: str, trade: Trade, current_time: datetime,
                        current_rate: float, current_profit: float, **kwargs) -> float:
        """
        Custom stoploss based on profit.
        """
        # If in profit > 4%, tighten stoploss to breakeven + 1%
        if current_profit > 0.04:
            return 0.01
            
        # If in profit > 2%, move stoploss to breakeven
        if current_profit > 0.02:
            return 0.0
            
        return self.stoploss
