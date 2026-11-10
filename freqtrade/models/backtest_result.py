"""
Backtest result model.
"""
from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Dict, Any

@dataclass
class BacktestResult:
    """Backtest Result model"""
    strategy_name: str
    timerange: str
    total_trades: int = 0
    winning_trades: int = 0
    losing_trades: int = 0
    win_rate: float = 0.0
    total_profit: float = 0.0
    total_profit_percent: float = 0.0
    avg_profit: float = 0.0
    max_profit: float = 0.0
    min_profit: float = 0.0
    max_drawdown: float = 0.0
    max_drawdown_percent: float = 0.0
    sharpe_ratio: float = 0.0
    sortino_ratio: float = 0.0
    calmar_ratio: float = 0.0
    profit_factor: float = 0.0
    created_at: datetime = field(default_factory=datetime.utcnow)
    trades: List[Dict[str, Any]] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary"""
        return {
            "strategy_name": self.strategy_name,
            "timerange": self.timerange,
            "total_trades": self.total_trades,
            "winning_trades": self.winning_trades,
            "losing_trades": self.losing_trades,
            "win_rate": self.win_rate,
            "total_profit": self.total_profit,
            "total_profit_percent": self.total_profit_percent,
            "avg_profit": self.avg_profit,
            "max_profit": self.max_profit,
            "min_profit": self.min_profit,
            "max_drawdown": self.max_drawdown,
            "max_drawdown_percent": self.max_drawdown_percent,
            "sharpe_ratio": self.sharpe_ratio,
            "sortino_ratio": self.sortino_ratio,
            "calmar_ratio": self.calmar_ratio,
            "profit_factor": self.profit_factor,
            "created_at": self.created_at.isoformat()
        }
