"""
TradeManager module.
Provides higher-level abstractions for managing trades in the database and keeping state in sync.
"""
import logging
from typing import List, Optional
from datetime import datetime

from freqtrade.database.database import Database
from freqtrade.exchange.exchange import ExchangeManager
from freqtrade.models.trade import Trade

logger = logging.getLogger('freqtrade')

class TradeManager:
    """
    Trade Manager class.
    Acts as an intermediary between the Bot logic and the Database, 
    managing the lifecycle and persistence of Trade objects.
    """
    def __init__(self, db: Database, exchange: ExchangeManager):
        self.db = db
        self.exchange = exchange

    def get_trade_by_id(self, trade_id: int) -> Optional[Trade]:
        """Fetch a specific trade by ID."""
        trades = self.db.get_open_trades() + self.db.get_closed_trades()
        for t in trades:
            if t.id == trade_id:
                return t
        return None

    def get_open_trades(self) -> List[Trade]:
        """Fetch all currently open trades."""
        return self.db.get_open_trades()
        
    def get_closed_trades(self) -> List[Trade]:
        """Fetch all closed trades."""
        return self.db.get_closed_trades()

    def add_trade(self, trade: Trade) -> int:
        """Add a new trade to the database."""
        trade_id = self.db.add_trade(trade)
        trade.id = trade_id
        return trade_id

    def update_trade(self, trade: Trade) -> None:
        """
        Sync a trade's state with the exchange (e.g. check order fills).
        """
        if not trade.is_open:
            return
            
        # Simplified: Update current profit based on ticker
        ticker = self.exchange.get_ticker(trade.pair)
        if ticker and 'last' in ticker:
            current_rate = ticker['last']
            trade.profit_percent = trade.calc_profit(current_rate)
            # In a full implementation, this would persist the updated profit to DB if necessary
            # or check open orders associated with this trade to see if they filled.

    def close_trade(self, trade: Trade, close_rate: float, reason: str = "custom") -> None:
        """Close an open trade."""
        if not trade.is_open:
            logger.warning(f"Attempted to close already closed trade {trade.id}")
            return
            
        trade.close_rate = close_rate
        trade.sell_reason = reason
        trade.close_date = datetime.utcnow()
        trade.is_open = False
        trade.profit_percent = trade.calc_profit(close_rate)
        
        self.db.close_trade(trade.id, close_rate)
        logger.info(f"Trade {trade.id} ({trade.pair}) closed at {close_rate}. Reason: {reason}")

    def force_exit_trade(self, trade_id: int) -> bool:
        """Forcefully exit a trade via a market order."""
        trade = self.get_trade_by_id(trade_id)
        if not trade or not trade.is_open:
            logger.error(f"Cannot force exit: Trade {trade_id} not found or not open.")
            return False
            
        ticker = self.exchange.get_ticker(trade.pair)
        if not ticker or 'last' not in ticker:
            logger.error(f"Cannot fetch ticker for force exit of {trade.pair}")
            return False
            
        current_rate = ticker['last']
        side = 'sell' if not trade.is_short else 'buy'
        
        logger.warning(f"Force exiting trade {trade.id} via market order.")
        order = self.exchange.create_order(trade.pair, "market", side, trade.amount)
        
        if order:
            self.close_trade(trade, current_rate, reason="force_exit")
            return True
            
        return False
        
    def adjust_trade_position(self, trade: Trade, amount_to_add: float, entry_rate: float) -> bool:
         """
         Adjust trade position (DCA).
         This is a simplified mock for adding to an existing position.
         """
         if not trade.is_open:
             return False
             
         logger.info(f"Adjusting position for trade {trade.id}. Adding {amount_to_add} @ {entry_rate}")
         
         # Calculate new average entry
         total_cost = (trade.amount * trade.open_rate) + (amount_to_add * entry_rate)
         new_amount = trade.amount + amount_to_add
         new_avg_rate = total_cost / new_amount
         
         trade.open_rate = new_avg_rate
         trade.amount = new_amount
         trade.stake_amount += (amount_to_add * entry_rate)
         
         # Note: A real implementation requires DB schema support for multiple orders per trade
         return True
