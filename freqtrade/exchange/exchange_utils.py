"""
Exchange utility functions.
"""
from typing import Optional
from datetime import datetime, timedelta

def get_timeframe_seconds(timeframe: str) -> int:
    """Convert timeframe string to seconds."""
    timeframe_minutes = {
        '1m': 1,
        '3m': 3,
        '5m': 5,
        '15m': 15,
        '30m': 30,
        '1h': 60,
        '2h': 120,
        '4h': 240,
        '6h': 360,
        '8h': 480,
        '12h': 720,
        '1d': 1440,
        '3d': 4320,
        '1w': 10080,
    }
    minutes = timeframe_minutes.get(timeframe)
    if minutes is None:
        raise ValueError(f"Invalid timeframe: {timeframe}")
    return minutes * 60

def timeframe_to_prev_candle(timeframe: str, timestamp: datetime) -> datetime:
    """Align timestamp to the start of the previous candle."""
    seconds = get_timeframe_seconds(timeframe)
    # Simple alignment for minutes/hours, more complex for days/weeks etc.
    # This is a simplified version.
    timestamp_s = int(timestamp.timestamp())
    aligned_s = timestamp_s - (timestamp_s % seconds) - seconds
    return datetime.utcfromtimestamp(aligned_s)

def timeframe_to_next_candle(timeframe: str, timestamp: datetime) -> datetime:
    """Align timestamp to the start of the next candle."""
    seconds = get_timeframe_seconds(timeframe)
    timestamp_s = int(timestamp.timestamp())
    aligned_s = timestamp_s - (timestamp_s % seconds) + seconds
    return datetime.utcfromtimestamp(aligned_s)

def get_candle_period(timeframe: str) -> timedelta:
    """Get timedelta for a timeframe."""
    return timedelta(seconds=get_timeframe_seconds(timeframe))

def market_is_tradable(market: dict) -> bool:
    """Check if a market is tradable."""
    return market.get('active', True)

def get_pair_base_quote(pair: str) -> tuple[str, str]:
    """Split a pair into base and quote currencies."""
    parts = pair.split('/')
    if len(parts) != 2:
        # Handle cases without slash if needed, e.g., BTCUSDT
        raise ValueError(f"Invalid pair format: {pair}. Expected 'BASE/QUOTE'.")
    return parts[0], parts[1]
