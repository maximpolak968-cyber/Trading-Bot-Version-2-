"""
Hyperopt Loss functions.
Defines how the hyperoptimizer evaluates the "goodness" of a backtest result.
"""
from abc import ABC, abstractmethod
from typing import Any

from freqtrade.models.backtest_result import BacktestResult

class IHyperOptLoss(ABC):
    """
    Base class for Hyperopt Loss functions.
    Goal is to minimize the return value.
    """
    @abstractmethod
    def calculate_loss(self, result: BacktestResult, **kwargs: Any) -> float:
        pass


class ShortTradeDurHyperOptLoss(IHyperOptLoss):
    """
    Optimizes for shorter trade duration and higher profit.
    """
    def calculate_loss(self, result: BacktestResult, **kwargs: Any) -> float:
        if result.total_trades == 0:
            return 1000.0
            
        profit = result.total_profit_percent
        # In a real implementation, we'd calculate avg trade duration from trades list
        # We mock it here.
        avg_duration_minutes = 60 # Mock
        
        # Penalize long durations, reward profit
        loss = -(profit * 100) + (avg_duration_minutes / 10)
        return loss


class SharpeHyperOptLoss(IHyperOptLoss):
    """
    Optimizes for the highest Sharpe Ratio.
    """
    def calculate_loss(self, result: BacktestResult, **kwargs: Any) -> float:
        if result.total_trades == 0:
            return 1000.0
        
        # Real implementation calculates variance of returns
        # We use the pre-calculated sharpe if available, else mock
        sharpe = getattr(result, 'sharpe_ratio', 0)
        if sharpe == 0:
             # Mock sharpe
             sharpe = result.total_profit_percent / max(result.max_drawdown_percent, 0.01)
             
        # Minimize negative sharpe
        return -sharpe


class SortinoHyperOptLoss(IHyperOptLoss):
    """
    Optimizes for the highest Sortino Ratio (penalizes only downside volatility).
    """
    def calculate_loss(self, result: BacktestResult, **kwargs: Any) -> float:
         if result.total_trades == 0:
             return 1000.0
             
         sortino = getattr(result, 'sortino_ratio', 0)
         if sortino == 0:
              # Mock sortino
              sortino = result.total_profit_percent / max(result.max_drawdown_percent, 0.005)
              
         return -sortino


class MaxDrawDownHyperOptLoss(IHyperOptLoss):
    """
    Optimizes strictly for minimal maximum drawdown, while maintaining positive profit.
    """
    def calculate_loss(self, result: BacktestResult, **kwargs: Any) -> float:
        if result.total_trades == 0 or result.total_profit_percent <= 0:
            return 1000.0
            
        # Heavy penalty for drawdown, slight reward for profit
        return (result.max_drawdown_percent * 1000) - (result.total_profit_percent * 10)


class MultiMetricHyperOptLoss(IHyperOptLoss):
    """
    Balances profit, drawdown, win rate, and trade count.
    """
    def calculate_loss(self, result: BacktestResult, **kwargs: Any) -> float:
        if result.total_trades < 5:
            return 1000.0
            
        profit_score = -result.total_profit_percent * 100
        drawdown_penalty = result.max_drawdown_percent * 200
        win_rate_penalty = (1.0 - result.win_rate) * 50
        
        return profit_score + drawdown_penalty + win_rate_penalty
