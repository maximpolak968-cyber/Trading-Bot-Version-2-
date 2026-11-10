"""
History module.
Handles downloading and saving historical market data for backtesting.
"""
import logging
import json
from pathlib import Path
from typing import Dict, Any, List, Optional
from datetime import datetime
import pandas as pd

from freqtrade.exchange.exchange import ExchangeManager
from freqtrade.data.converter import ohlcv_to_dataframe

logger = logging.getLogger('freqtrade')

def download_data(config: Dict[str, Any], pair: str, timeframe: str, days: int = 30) -> pd.DataFrame:
    """Download historical data from exchange."""
    exchange = ExchangeManager(config)
    
    # In a real scenario, this would paginate backward in time
    # This is a simplified fetch for recent data
    limit = min(days * 24 * (60 // int(timeframe.replace('m', '').replace('h', '60'))), 1000) if 'm' in timeframe or 'h' in timeframe else 1000
    
    ohlcv = exchange.fetch_ohlcv(pair, timeframe, limit=limit)
    if not ohlcv:
        logger.warning(f"No data fetched for {pair} {timeframe}")
        return pd.DataFrame()
        
    df = ohlcv_to_dataframe(ohlcv)
    _save_data(df, pair, timeframe, config.get('datadir', 'user_data/data'))
    return df

def get_historical_data(pair: str, timeframe: str, datadir: str = 'user_data/data') -> pd.DataFrame:
    """Load historical data from local storage."""
    file_path = Path(datadir) / f"{pair.replace('/', '_')}-{timeframe}.json"
    
    if not file_path.exists():
        logger.warning(f"Data file not found: {file_path}")
        return pd.DataFrame()
        
    try:
        with open(file_path, 'r') as f:
            ohlcv = json.load(f)
        return ohlcv_to_dataframe(ohlcv)
    except Exception as e:
        logger.error(f"Failed to load data from {file_path}: {e}")
        return pd.DataFrame()

def _save_data(df: pd.DataFrame, pair: str, timeframe: str, datadir: str) -> None:
    """Save DataFrame to local JSON file."""
    dir_path = Path(datadir)
    dir_path.mkdir(parents=True, exist_ok=True)
    
    file_path = dir_path / f"{pair.replace('/', '_')}-{timeframe}.json"
    
    try:
        # Convert df back to list format for storage
        data_to_save = []
        for _, row in df.iterrows():
            data_to_save.append([
                int(row['date'].timestamp() * 1000),
                row['open'], row['high'], row['low'], row['close'], row['volume']
            ])
            
        with open(file_path, 'w') as f:
            json.dump(data_to_save, f)
        logger.info(f"Saved {len(data_to_save)} candles for {pair} {timeframe} to {file_path}")
    except Exception as e:
        logger.error(f"Failed to save data to {file_path}: {e}")
