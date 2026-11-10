"""
Strategy Interface module.
"""
from typing import Dict, Any, Optional
import pandas as pd
from freqtrade.models.trade import Trade

class IStrategy:
    """
    Base Strategy Interface.
    All strategies should inherit from this class.
    """
    # Strategy settings
    timeframe = '5m'
    startup_candle_count: int = 20
    
    # ROI table:
    minimal_roi = {
        "0": 0.05
    }

    # Stoploss:
    stoploss = -0.10

    # Trailing stop:
    trailing_stop = False
    trailing_stop_positive = 0.005
    trailing_stop_positive_offset = 0.0
    trailing_only_offset_is_reached = False

    def __init__(self, config: Dict[str, Any]):
        self.config = config

    def populate_indicators(self, dataframe: pd.DataFrame, metadata: Dict[str, Any]) -> pd.DataFrame:
        """
        Populate indicators that will be used in the Buy and Sell strategy.
        """
        return dataframe

    def populate_entry_trend(self, dataframe: pd.DataFrame, metadata: Dict[str, Any]) -> pd.DataFrame:
        """
        Based on TA indicators, populates the entry signal for the given dataframe.
        """
        dataframe.loc[:, 'enter_long'] = 0
        dataframe.loc[:, 'enter_short'] = 0
        return dataframe

    def populate_exit_trend(self, dataframe: pd.DataFrame, metadata: Dict[str, Any]) -> pd.DataFrame:
        """
        Based on TA indicators, populates the exit signal for the given dataframe.
        """
        dataframe.loc[:, 'exit_long'] = 0
        dataframe.loc[:, 'exit_short'] = 0
        return dataframe

    def analyze(self, dataframe: pd.DataFrame, pair: str) -> pd.DataFrame:
        """
        Convenience method calling the populate_* methods.
        """
        metadata = {'pair': pair}
        df = self.populate_indicators(dataframe.copy(), metadata)
        df = self.populate_entry_trend(df, metadata)
        df = self.populate_exit_trend(df, metadata)
        return df

    def confirm_trade_entry(self, pair: str, order_type: str, amount: float, rate: float,
                            time_in_force: str, current_time: Any, entry_tag: Optional[str],
                            side: str, **kwargs) -> bool:
        """
        Called right before placing a entry order.
        Timing for this function is critical, so avoid doing heavy computations or
        network requests in this method.

        For full documentation please go to https://www.freqtrade.io/en/latest/strategy-advanced/
        """
        return True

    def confirm_trade_exit(self, pair: str, trade: Trade, order_type: str, amount: float,
                           rate: float, time_in_force: str, exit_reason: str,
                           current_time: Any, **kwargs) -> bool:
        """
        Called right before placing a regular exit order.
        Timing for this function is critical, so avoid doing heavy computations or
        network requests in this method.

        For full documentation please go to https://www.freqtrade.io/en/latest/strategy-advanced/
        """
        return True

    def custom_stoploss(self, pair: str, trade: Trade, current_time: Any,
                        current_rate: float, current_profit: float, **kwargs) -> float:
        """
        Custom stoploss logic, returning the new distance relative to current_rate (as ratio).
        e.g. returning -0.05 would create a stoploss 5% below current_rate.
        """
        return self.stoploss

    def custom_roi(self, pair: str, trade: Trade, current_time: Any, current_profit: float) -> Optional[float]:
        """
        Custom ROI logic, returning the ROI multiplier (e.g. 0.05 for 5%).
        Return None to use the default minimal_roi table.
        """
        return None

    def bot_loop_start(self, **kwargs) -> None:
        """
        Called at the start of the bot iteration (one loop).
        Might be used to perform some operations once per iteration.
        """
        pass
        
    def process_maybe_execute_buy(self):
        pass
        
    def process_maybe_execute_sell(self):
        pass
