"""
Core module initialization.
"""
from freqtrade.core.config import Config
from freqtrade.core.enums import (
    OrderType, OrderSide, OrderStatus, TradingMode, MarginMode,
    SignalType, CandleType, PriceType, TradeStatus, ExitReason, ProtectionType
)

__all__ = [
    'Config',
    'OrderType', 'OrderSide', 'OrderStatus', 'TradingMode', 'MarginMode',
    'SignalType', 'CandleType', 'PriceType', 'TradeStatus', 'ExitReason', 'ProtectionType'
]
