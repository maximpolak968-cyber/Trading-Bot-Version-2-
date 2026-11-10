from enum import Enum, auto
from typing import Literal

class OrderType(Enum):
    LIMIT = "limit"
    MARKET = "market"

class OrderSide(Enum):
    BUY = "buy"
    SELL = "sell"

class OrderStatus(Enum):
    OPEN = "open"
    CLOSED = "closed"
    CANCELLED = "cancelled"
    EXPIRED = "expired"
    REJECTED = "rejected"

class TradingMode(Enum):
    SPOT = "spot"
    MARGIN = "margin"
    FUTURES = "futures"

class MarginMode(Enum):
    ISOLATED = "isolated"
    CROSS = "cross"

class SignalType(Enum):
    ENTRY = "entry"
    EXIT = "exit"
    STOPLOSS = "stoploss"
    ROI = "roi"

class CandleType(Enum):
    SPOT = "spot"
    MARK = "mark"
    INDEX = "index"

class PriceType(Enum):
    ASK = "ask"
    BID = "bid"
    SAME = "same"

class TradeStatus(Enum):
    OPEN = "open"
    CLOSED = "closed"
    FAILED = "failed"

class ExitReason(Enum):
    ROI = "roi"
    STOP_LOSS = "stop_loss"
    STOPLOSS_ON_EXCHANGE = "stoploss_on_exchange"
    TRAILING_STOP_LOSS = "trailing_stop_loss"
    EXIT_SIGNAL = "exit_signal"
    SELL_SIGNAL = "sell_signal"
    FORCE_EXIT = "force_exit"
    EMERGENCY_EXIT = "emergency_exit"
    PROTECTION_TRIGGERED = "protection_triggered"
    EXPIRED = "expired"
    REPLACED = "replaced"

class ProtectionType(Enum):
    STOPLOSS_GUARD = "stoploss_guard"
    COOLDOWN_PERIOD = "cooldown_period"
    MAX_DRAWDOWN = "max_drawdown"
    LOW_PROFIT = "low_profit"
    CONSECUTIVE_LOSSES = "consecutive_losses"
