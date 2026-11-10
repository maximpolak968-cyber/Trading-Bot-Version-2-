from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

@dataclass
class Trade:
    """Trade model"""
    id: Optional[int] = None
    pair: str = ""
    open_rate: float = 0.0
    close_rate: Optional[float] = None
    stake_amount: float = 0.0
    amount: float = 0.0
    is_open: bool = True
    is_short: bool = False
    leverage: float = 1.0
    open_date: datetime = field(default_factory=datetime.utcnow)
    close_date: Optional[datetime] = None
    profit: Optional[float] = None
    profit_percent: Optional[float] = None
    fee: float = 0.001
    buy_tag: Optional[str] = None
    sell_reason: Optional[str] = None
    exchange: str = "binance"
    strategy: str = "SampleStrategy"
    timeframe: str = "5m"
    dca_count: int = 0
    last_dca_date: Optional[datetime] = None
    initial_amount: float = 0.0
    initial_stake: float = 0.0
    dca_history: list = field(default_factory=list)
    campaign_id: Optional[str] = None
    campaign_banked_profit: Optional[float] = None  # прибыль с первой закрытой ноги хеджа (None = обычная сделка)
    target_tp_rate: Optional[float] = None
    target_profit_usdt: Optional[float] = None
    stoploss_rate: Optional[float] = None
    support_level: Optional[float] = None
    resistance_level: Optional[float] = None
    next_dca_price: Optional[float] = None
    trade_state: str = "WAITING_PULLBACK"
    pullback_min_profit_pct: float = 0.5
    plan_notes: Optional[str] = None
    fee_open: float = 0.0
    fee_close: float = 0.0
    fee_total: float = 0.0
    gross_profit: Optional[float] = None
    net_profit: Optional[float] = None
    net_profit_percent: Optional[float] = None

    def apply_dca(self, additional_amount: float, additional_rate: float, additional_stake: float) -> None:
        """Update position with dollar-cost averaging, keeping full history."""
        # Запоминаем исходный объём первого входа один раз, при первом усреднении
        if not self.dca_history:
            self.initial_amount = self.amount
            self.initial_stake = self.stake_amount

        total_amount = self.amount + additional_amount
        if total_amount > 0:
            self.open_rate = (self.amount * self.open_rate + additional_amount * additional_rate) / total_amount
            self.amount = total_amount
            self.stake_amount += additional_stake
            self.dca_count += 1
            self.last_dca_date = datetime.utcnow()

            self.dca_history.append({
                'step': self.dca_count,
                'added_amount': additional_amount,
                'added_price': additional_rate,
                'added_stake': additional_stake,
                'cumulative_amount': self.amount,
                'cumulative_stake': self.stake_amount,
                'new_avg_price': self.open_rate,
                'timestamp': self.last_dca_date.isoformat()
            })
    
    def calc_profit_ratio(self, current_rate: float) -> float:
        """Calculate profit as ratio, e.g. 0.015 for +1.5%"""
        if self.open_rate <= 0:
            return 0.0
        if self.is_short:
            return (self.open_rate - current_rate) / self.open_rate
        else:
            return (current_rate - self.open_rate) / self.open_rate

    def calc_profit(self, current_rate: float) -> float:
        """Calculate profit in percentage, e.g. 1.5 for +1.5%"""
        return self.calc_profit_ratio(current_rate) * 100.0
    
    def calc_profit_abs(self, current_rate: float) -> float:
        """Calculate absolute profit"""
        profit_abs = (current_rate - self.open_rate) * self.amount
        if self.is_short:
            profit_abs = -profit_abs
        return profit_abs
    
    def set_close_rate_pct(self, rate: float, fee_rate: Optional[float] = None) -> None:
        """Set close rate and calculate gross profit, exchange fees, and net PnL"""
        self.close_rate = rate
        active_fee = fee_rate if fee_rate is not None else self.fee
        
        entry_val = self.open_rate * self.amount
        exit_val = rate * self.amount
        
        self.fee_open = round(entry_val * active_fee, 4)
        self.fee_close = round(exit_val * active_fee, 4)
        self.fee_total = round(self.fee_open + self.fee_close, 4)
        
        self.profit_percent = round(self.calc_profit(rate), 2)
        self.gross_profit = round(self.calc_profit_abs(rate), 4)
        self.profit = self.gross_profit
        
        self.net_profit = round(self.gross_profit - self.fee_total, 4)
        stake = self.stake_amount if self.stake_amount > 0 else entry_val
        self.net_profit_percent = round((self.net_profit / stake) * 100.0, 2) if stake > 0 else self.profit_percent
        self.close_date = datetime.utcnow()
