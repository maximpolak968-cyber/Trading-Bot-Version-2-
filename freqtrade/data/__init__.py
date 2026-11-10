"""
Data module initialization.
Handles fetching, storing, and transforming market data.
"""
from freqtrade.data.history import get_historical_data
from freqtrade.data.dataprovider import DataProvider
from freqtrade.data.converter import ohlcv_to_dataframe

__all__ = ['get_historical_data', 'DataProvider', 'ohlcv_to_dataframe']
