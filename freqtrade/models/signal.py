from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional
from freqtrade.core.enums import SignalType

@dataclass
class Signal:
    """Trade signal"""
    pair: str
    timestamp: datetime
    signal_type: SignalType
    direction: str  # 'long' or 'short'
    confidence: float  # 0.0 - 1.0
    price: float
    reason: str = ""
    indicators: Optional[dict] = None
