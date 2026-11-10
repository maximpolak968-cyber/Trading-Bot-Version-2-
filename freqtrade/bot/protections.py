"""
Protections module.
Provides mechanisms to stop trading based on certain conditions (drawdown, consecutive losses, etc.).
"""
import logging
from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta

from freqtrade.models.trade import Trade
from freqtrade.core.enums import ProtectionType

logger = logging.getLogger('freqtrade')

class Protection(ABC):
    """Base Protection class."""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.lock_end_time: Optional[datetime] = None

    @abstractmethod
    def check(self, trades: List[Trade], current_time: datetime) -> None:
        """Evaluate protection rules against trade history."""
        pass

    def is_locked(self, current_time: datetime) -> bool:
        """Check if trading is currently locked by this protection."""
        if self.lock_end_time and current_time < self.lock_end_time:
            return True
        return False
        
    def lock(self, until: datetime, reason: str) -> None:
        """Lock trading until a specific time."""
        self.lock_end_time = until
        logger.warning(f"🔒 Global Trading Lock triggered by {self.__class__.__name__} until {until}. Reason: {reason}")
        
    def reset(self) -> None:
        """Reset the protection lock."""
        self.lock_end_time = None
        logger.info(f"🔓 Lock reset for {self.__class__.__name__}")


class StoplossGuard(Protection):
    """
    StoplossGuard protection.
    Locks trading if too many stoplosses hit in a specific time window.
    """
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        # Defaults
        self.lookback_period_minutes = config.get('lookback_period_minutes', 60)
        self.trade_limit = config.get('trade_limit', 3)
        self.stop_duration_minutes = config.get('stop_duration_minutes', 60)

    def check(self, trades: List[Trade], current_time: datetime) -> None:
        if self.is_locked(current_time):
            return
            
        lookback_time = current_time - timedelta(minutes=self.lookback_period_minutes)
        
        # Count stoploss trades in the lookback window
        sl_trades = [
            t for t in trades 
            if t.close_date and t.close_date >= lookback_time 
            and t.sell_reason == "stop_loss"
        ]
        
        if len(sl_trades) >= self.trade_limit:
            lock_until = current_time + timedelta(minutes=self.stop_duration_minutes)
            self.lock(lock_until, f"Hit {len(sl_trades)} stoplosses in {self.lookback_period_minutes}m")


class CooldownPeriod(Protection):
    """
    CooldownPeriod protection.
    Prevents entering a trade on the same pair immediately after exiting it.
    """
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self.cooldown_minutes = config.get('stop_duration_minutes', 5)
        self.pair_locks: Dict[str, datetime] = {}

    def check(self, trades: List[Trade], current_time: datetime) -> None:
        # Check closed trades and update pair locks
        for trade in trades:
            if trade.close_date:
                lock_until = trade.close_date + timedelta(minutes=self.cooldown_minutes)
                if current_time < lock_until:
                    # Update pair lock if it's further in the future
                    current_lock = self.pair_locks.get(trade.pair)
                    if not current_lock or lock_until > current_lock:
                        self.pair_locks[trade.pair] = lock_until

    def is_pair_locked(self, pair: str, current_time: datetime) -> bool:
        """Check if a specific pair is locked."""
        lock_until = self.pair_locks.get(pair)
        if lock_until and current_time < lock_until:
             return True
        return False


class MaxDrawdownProtection(Protection):
    """
    MaxDrawdownProtection.
    Locks trading if global max drawdown exceeds the configured limit.
    """
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self.max_drawdown = config.get('max_allowed_drawdown', 0.10) # 10%
        self.stop_duration_minutes = config.get('stop_duration_minutes', 1440) # 24h

    def check(self, trades: List[Trade], current_time: datetime) -> None:
        if self.is_locked(current_time):
            return
            
        if not trades:
            return
            
        # Very simplified drawdown calculation for the example
        # In reality, this requires tracking portfolio value over time
        total_profit_pct = sum(t.profit_percent for t in trades if t.profit_percent is not None)
        
        # If total account profit has dropped by max_drawdown from its peak...
        # (Mocking the condition for brevity)
        if total_profit_pct < -self.max_drawdown:
            lock_until = current_time + timedelta(minutes=self.stop_duration_minutes)
            self.lock(lock_until, f"Max drawdown exceeded: {total_profit_pct*100:.2f}%")


class ConsecutiveLossesProtection(Protection):
    """
    ConsecutiveLossesProtection.
    Locks trading after a sequence of consecutive losing trades.
    """
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self.trade_limit = config.get('trade_limit', 4)
        self.stop_duration_minutes = config.get('stop_duration_minutes', 120)

    def check(self, trades: List[Trade], current_time: datetime) -> None:
        if self.is_locked(current_time):
            return
            
        closed_trades = sorted([t for t in trades if t.close_date], key=lambda t: t.close_date)
        if not closed_trades:
            return
            
        consecutive_losses = 0
        for trade in reversed(closed_trades):
            if trade.profit is not None and trade.profit < 0:
                consecutive_losses += 1
            else:
                break # Streak broken
                
        if consecutive_losses >= self.trade_limit:
            lock_until = current_time + timedelta(minutes=self.stop_duration_minutes)
            self.lock(lock_until, f"{consecutive_losses} consecutive losses")


class LowProfitProtection(Protection):
    """
    LowProfitProtection.
    Locks trading if recent closed trades have too low an average profit.
    """
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self.lookback_period_minutes = config.get('lookback_period_minutes', 1440)
        self.required_profit_ratio = config.get('required_profit', 0.01) # 1%
        self.trade_limit = config.get('trade_limit', 5)
        self.stop_duration_minutes = config.get('stop_duration_minutes', 60)

    def check(self, trades: List[Trade], current_time: datetime) -> None:
        if self.is_locked(current_time):
            return
            
        lookback_time = current_time - timedelta(minutes=self.lookback_period_minutes)
        recent_trades = [
            t for t in trades 
            if t.close_date and t.close_date >= lookback_time
        ]
        
        if len(recent_trades) >= self.trade_limit:
            total_profit = sum(t.profit_percent for t in recent_trades if t.profit_percent is not None)
            avg_profit = total_profit / len(recent_trades)
            
            if avg_profit < self.required_profit_ratio:
                 lock_until = current_time + timedelta(minutes=self.stop_duration_minutes)
                 self.lock(lock_until, f"Avg profit {avg_profit*100:.2f}% < {self.required_profit_ratio*100:.2f}% over {len(recent_trades)} trades")
