"""
Data converter utilities.
"""
from typing import List, Any
import pandas as pd

def ohlcv_to_dataframe(ohlcv: List[List[Any]]) -> pd.DataFrame:
    """
    Convert a list of OHLCV data from CCXT to a Pandas DataFrame.
    """
    if not ohlcv:
        return pd.DataFrame(columns=['date', 'open', 'high', 'low', 'close', 'volume'])
        
    df = pd.DataFrame(ohlcv, columns=['date', 'open', 'high', 'low', 'close', 'volume'])
    df['date'] = pd.to_datetime(df['date'], unit='ms')
    
    # Ensure proper types
    df['open'] = df['open'].astype('float64')
    df['high'] = df['high'].astype('float64')
    df['low'] = df['low'].astype('float64')
    df['close'] = df['close'].astype('float64')
    df['volume'] = df['volume'].astype('float64')
    
    return df

def dataframe_to_ohlcv(df: pd.DataFrame) -> List[List[Any]]:
    """
    Convert a Pandas DataFrame back to CCXT OHLCV list format.
    """
    if df.empty:
        return []
        
    result = []
    for _, row in df.iterrows():
        result.append([
            int(row['date'].timestamp() * 1000),
            row['open'],
            row['high'],
            row['low'],
            row['close'],
            row['volume']
        ])
    return result
