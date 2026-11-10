"""
DataProvider module.
Provides a unified interface for strategies to request data, abstracting away where it comes from.
"""
from typing import Dict, Any, List, Optional
import pandas as pd
from datetime import datetime

from freqtrade.data.history import get_historical_data
from freqtrade.exchange.exchange import ExchangeManager

class DataProvider:
    """
    Data Provider class.
    Injected into strategies so they can request additional pairs/timeframes data safely.
    """
    def __init__(self, config: Dict[str, Any], exchange: ExchangeManager):
        self._config = config
        self._exchange = exchange
        self._datadir = config.get('datadir', 'user_data/data')
        self._cached_data: Dict[str, pd.DataFrame] = {}

    def get_pair_dataframe(self, pair: str, timeframe: str = '5m') -> pd.DataFrame:
        """
        Get OHLCV data for a specific pair and timeframe.
        """
        cache_key = f"{pair}_{timeframe}"
        if cache_key in self._cached_data:
            return self._cached_data[cache_key].copy()
            
        # 1. Try fetching from memory cache (done above)
        # 2. Try fetching from local history
        df = get_historical_data(pair, timeframe, self._datadir)
        
        # 3. If live/dry-run, fetch from exchange (mocked logic)
        # In a real bot, we'd fetch latest candles from exchange if live
        if df.empty and not self._config.get('runmode') == 'backtest':
             ohlcv = self._exchange.fetch_ohlcv(pair, timeframe)
             from freqtrade.data.converter import ohlcv_to_dataframe
             df = ohlcv_to_dataframe(ohlcv)
             
        if not df.empty:
             self._cached_data[cache_key] = df
             
        return df.copy() if not df.empty else pd.DataFrame()

    def get_analyzed_dataframe(self, pair: str, timeframe: str = '5m') -> pd.DataFrame:
        """
        Get OHLCV data that has already been processed by the strategy (contains indicators).
        (Simplified implementation).
        """
        return self.get_pair_dataframe(pair, timeframe)
        
    def current_whitelist(self) -> List[str]:
        """Get the currently active whitelist of pairs."""
        return self._config.get('exchange', {}).get('pair_whitelist', [])

    def available_pairs(self) -> List[str]:
         """Get all pairs available on the exchange."""
         return self._exchange.get_tradeable_pairs()
