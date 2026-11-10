"""
Sample Strategy (MA Crossover + RSI)
"""
from typing import Dict, Any
import pandas as pd
from freqtrade.strategy.interface import IStrategy
# import talib.abstract as ta # Using pandas implementations for simplicity without talib dependency if needed, but TA-Lib is standard in Freqtrade.
# Assuming standard pandas/numpy or simplified TA logic for this generated version to ensure it runs without strict C-dependencies, 
# but in real Freqtrade `import talib.abstract as ta` and `import pandas_ta as pta` are used.

class SampleStrategy(IStrategy):
    """
    This is a sample strategy to get you started.
    """
    timeframe = '5m'
    startup_candle_count = 30
    
    minimal_roi = {
        "60": 0.01,
        "30": 0.02,
        "0": 0.04
    }
    stoploss = -0.10
    trailing_stop = False

    def populate_indicators(self, dataframe: pd.DataFrame, metadata: Dict[str, Any]) -> pd.DataFrame:
        """
        Calculates simple indicators (SMA, RSI) manually or via pandas_ta if available.
        For self-containment in this generated block, using simple pandas rolling.
        """
        # RSI (simplified 14-period calculation for example purposes)
        delta = dataframe['close'].diff()
        gain = (delta.where(delta > 0, 0)).fillna(0)
        loss = (-delta.where(delta < 0, 0)).fillna(0)
        avg_gain = gain.rolling(window=14, min_periods=1).mean()
        avg_loss = loss.rolling(window=14, min_periods=1).mean()
        rs = avg_gain / avg_loss
        dataframe['rsi'] = 100 - (100 / (1 + rs))

        # SMA
        dataframe['sma_fast'] = dataframe['close'].rolling(window=10).mean()
        dataframe['sma_slow'] = dataframe['close'].rolling(window=30).mean()
        
        # MACD (Simplified)
        ema_12 = dataframe['close'].ewm(span=12, adjust=False).mean()
        ema_26 = dataframe['close'].ewm(span=26, adjust=False).mean()
        dataframe['macd'] = ema_12 - ema_26
        dataframe['macdsignal'] = dataframe['macd'].ewm(span=9, adjust=False).mean()
        
        # Bollinger Bands (Simplified)
        window = 20
        no_of_std = 2
        rolling_mean = dataframe['close'].rolling(window).mean()
        rolling_std = dataframe['close'].rolling(window).std()
        dataframe['bb_upperband'] = rolling_mean + (rolling_std * no_of_std)
        dataframe['bb_lowerband'] = rolling_mean - (rolling_std * no_of_std)

        return dataframe

    def populate_entry_trend(self, dataframe: pd.DataFrame, metadata: Dict[str, Any]) -> pd.DataFrame:
        """
        Buy condition: fast SMA crosses above slow SMA and RSI is not overbought.
        """
        # Initialize column
        dataframe.loc[:, 'enter_long'] = 0
        
        # Simple cross up logic
        cross_up = (dataframe['sma_fast'] > dataframe['sma_slow']) & (dataframe['sma_fast'].shift(1) <= dataframe['sma_slow'].shift(1))
        
        dataframe.loc[
            (
                cross_up &
                (dataframe['rsi'] < 70) &  # Not overbought
                (dataframe['volume'] > 0)  # Make sure Volume is not 0
            ),
            'enter_long'] = 1

        return dataframe

    def populate_exit_trend(self, dataframe: pd.DataFrame, metadata: Dict[str, Any]) -> pd.DataFrame:
        """
        Sell condition: fast SMA crosses below slow SMA.
        """
        # Initialize column
        dataframe.loc[:, 'exit_long'] = 0
        
        # Simple cross down logic
        cross_down = (dataframe['sma_fast'] < dataframe['sma_slow']) & (dataframe['sma_fast'].shift(1) >= dataframe['sma_slow'].shift(1))
        
        dataframe.loc[
            (
                cross_down &
                (dataframe['volume'] > 0)
            ),
            'exit_long'] = 1

        return dataframe
