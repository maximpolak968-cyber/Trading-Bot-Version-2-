"""
Edge positioning module.
Calculates expectancy and win rates to dynamically adjust stoploss/takeprofit based on market edge.
"""
import logging
from typing import Dict, Any, List, Optional
import pandas as pd
from datetime import datetime

from freqtrade.models.trade import Trade
from freqtrade.database.database import Database

logger = logging.getLogger('freqtrade')

class EdgeCli:
    """
    Edge Module.
    Calculates statistical edge of trades based on historical performance per pair,
    allowing dynamic adjustment of stoploss based on expectancy.
    """
    def __init__(self, config: Dict[str, Any], db: Database):
        self.config = config
        self.db = db
        self.enabled = config.get('edge', {}).get('enabled', False)
        self.min_trades = config.get('edge', {}).get('min_trades_per_pair', 10)
        self.expectancy_threshold = config.get('edge', {}).get('expectancy_threshold', 0.1)
        self._pair_stats: Dict[str, Any] = {}

    def calculate(self, current_time: datetime) -> None:
        """
        Analyze closed trades and calculate edge/expectancy per pair.
        """
        if not self.enabled:
            return

        logger.info("Calculating Edge statistics...")
        closed_trades = self.db.get_closed_trades()
        if not closed_trades:
            return

        # Group trades by pair
        trades_by_pair: Dict[str, List[Trade]] = {}
        for t in closed_trades:
            if t.pair not in trades_by_pair:
                trades_by_pair[t.pair] = []
            trades_by_pair[t.pair].append(t)

        for pair, trades in trades_by_pair.items():
            if len(trades) < self.min_trades:
                continue

            winning_trades = [t for t in trades if t.profit_percent is not None and t.profit_percent > 0]
            losing_trades = [t for t in trades if t.profit_percent is not None and t.profit_percent <= 0]
            
            win_rate = len(winning_trades) / len(trades)
            loss_rate = 1 - win_rate
            
            avg_win = sum(t.profit_percent for t in winning_trades) / len(winning_trades) if winning_trades else 0
            avg_loss = sum(abs(t.profit_percent) for t in losing_trades) / len(losing_trades) if losing_trades else 0
            
            # Expectancy = (Win Rate x Average Win) - (Loss Rate x Average Loss)
            expectancy = (win_rate * avg_win) - (loss_rate * avg_loss)
            
            self._pair_stats[pair] = {
                "win_rate": win_rate,
                "expectancy": expectancy,
                "avg_win": avg_win,
                "avg_loss": avg_loss,
                "total_trades": len(trades)
            }
            
            logger.debug(f"Edge {pair}: WinRate {win_rate*100:.1f}%, Expectancy {expectancy:.4f}")

    def get_stoploss(self, pair: str, default_stoploss: float) -> float:
        """
        Adjust stoploss based on edge expectancy.
        """
        if not self.enabled or pair not in self._pair_stats:
            return default_stoploss
            
        stats = self._pair_stats[pair]
        expectancy = stats['expectancy']
        
        if expectancy < self.expectancy_threshold:
            # Poor edge, tighten stoploss to reduce risk
            adjusted = default_stoploss * 0.8
            logger.info(f"Edge: Tightening stoploss for {pair} to {adjusted:.3f} due to low expectancy ({expectancy:.3f})")
            return adjusted
            
        return default_stoploss

    def should_trade(self, pair: str) -> bool:
         """
         Determine if a pair has a positive edge and should be traded.
         """
         if not self.enabled:
             return True
             
         if pair not in self._pair_stats:
             # If we don't have enough data, allow trading to gather data
             return True
             
         stats = self._pair_stats[pair]
         if stats['expectancy'] <= 0:
              logger.info(f"Edge: Rejecting trade for {pair} due to negative expectancy ({stats['expectancy']:.3f})")
              return False
              
         return True
