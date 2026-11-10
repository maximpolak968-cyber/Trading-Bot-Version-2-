"""
Backtesting module.
Simulates trading on historical data to evaluate strategy performance.
"""
import logging
from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta
import pandas as pd

from freqtrade.core.config import Config
from freqtrade.database.database import Database
from freqtrade.strategy.interface import IStrategy
from freqtrade.exchange.exchange import ExchangeManager
from freqtrade.models.trade import Trade
from freqtrade.models.backtest_result import BacktestResult
from freqtrade.core.enums import ExitReason

logger = logging.getLogger('freqtrade')

class Backtester:
    """Backtesting core logic."""
    
    def __init__(self, config: Dict[str, Any], strategy: IStrategy, db: Database):
        self.config = config
        self.strategy = strategy
        self.db = db
        self.exchange = ExchangeManager(config) # Used strictly for fetching historical data if needed
        self.timeframe = self.config.get('timeframe', '5m')
        self.stake_amount = self.config.get('stake_amount', 100)
        self.starting_balance = self.config.get('dry_run_wallet', 1000)
        
    def _load_data(self, pair: str, start_date: datetime, end_date: datetime) -> pd.DataFrame:
        """Load historical data (Mocked to fetch from exchange for brevity, should use local data provider)."""
        logger.info(f"Loading data for {pair} from {start_date} to {end_date}")
        ohlcv = self.exchange.fetch_ohlcv(pair, self.timeframe, limit=1000) # Simplified
        if not ohlcv:
            return pd.DataFrame()
            
        df = pd.DataFrame(ohlcv, columns=['date', 'open', 'high', 'low', 'close', 'volume'])
        df['date'] = pd.to_datetime(df['date'], unit='ms')
        return df

    def backtest(self, pair: str, start_date: datetime, end_date: datetime) -> BacktestResult:
        """Run backtest for a single pair."""
        logger.info(f"Starting backtest for {pair} using {self.strategy.__class__.__name__}")
        df = self._load_data(pair, start_date, end_date)
        
        if df.empty:
            logger.warning(f"No data for {pair}")
            return BacktestResult(strategy_name=self.strategy.__class__.__name__, timerange=f"{start_date}-{end_date}")

        # Populate indicators and signals
        analyzed_df = self.strategy.analyze(df, pair)
        
        open_trades: List[Trade] = []
        closed_trades: List[Trade] = []
        
        # Iterate row by row to simulate time progressing
        for index, row in analyzed_df.iterrows():
            current_time = row['date']
            current_rate = row['close']
            
            # 1. Check open trades for exit conditions (ROI, Stoploss, Signal)
            for trade in list(open_trades):
                # Stoploss check
                sl = self.strategy.custom_stoploss(pair, trade, current_time, current_rate, trade.calc_profit(current_rate))
                if trade.calc_profit(current_rate) <= sl:
                    self._close_simulated_trade(trade, current_rate, current_time, ExitReason.STOP_LOSS, closed_trades, open_trades)
                    continue
                    
                # ROI check
                roi = self.strategy.custom_roi(pair, trade, current_time, trade.calc_profit(current_rate))
                if roi is not None and trade.calc_profit(current_rate) >= roi:
                     self._close_simulated_trade(trade, current_rate, current_time, ExitReason.ROI, closed_trades, open_trades)
                     continue
                     
                # Signal check
                if not trade.is_short and row.get('exit_long', 0) == 1:
                     self._close_simulated_trade(trade, current_rate, current_time, ExitReason.EXIT_SIGNAL, closed_trades, open_trades)
                elif trade.is_short and row.get('exit_short', 0) == 1:
                     self._close_simulated_trade(trade, current_rate, current_time, ExitReason.EXIT_SIGNAL, closed_trades, open_trades)

            # 2. Check for entry signals
            if len(open_trades) == 0: # Simplify: max 1 trade per pair at a time
                if row.get('enter_long', 0) == 1:
                    new_trade = self._create_simulated_trade(pair, current_rate, current_time, 'long')
                    open_trades.append(new_trade)
                elif row.get('enter_short', 0) == 1:
                    new_trade = self._create_simulated_trade(pair, current_rate, current_time, 'short')
                    open_trades.append(new_trade)

        # Force close remaining open trades at the end of backtest
        if len(open_trades) > 0:
            last_row = analyzed_df.iloc[-1]
            for trade in list(open_trades):
                 self._close_simulated_trade(trade, last_row['close'], last_row['date'], ExitReason.FORCE_EXIT, closed_trades, open_trades)

        return self._calculate_stats(closed_trades, start_date, end_date)

    def _create_simulated_trade(self, pair: str, rate: float, date: datetime, direction: str) -> Trade:
        amount = self.stake_amount / rate
        return Trade(
            pair=pair,
            open_rate=rate,
            stake_amount=self.stake_amount,
            amount=amount,
            is_open=True,
            is_short=(direction == 'short'),
            open_date=date,
            strategy=self.strategy.__class__.__name__
        )
        
    def _close_simulated_trade(self, trade: Trade, rate: float, date: datetime, reason: ExitReason, closed_list: List[Trade], open_list: List[Trade]):
        trade.close_rate = rate
        trade.close_date = date
        trade.sell_reason = reason.value
        trade.is_open = False
        trade.profit_percent = trade.calc_profit(rate)
        trade.profit = trade.calc_profit_abs(rate)
        
        closed_list.append(trade)
        open_list.remove(trade)

    def _calculate_stats(self, trades: List[Trade], start_date: datetime, end_date: datetime) -> BacktestResult:
        """Calculate comprehensive backtest statistics."""
        if not trades:
            return BacktestResult(strategy_name=self.strategy.__class__.__name__, timerange=f"{start_date}-{end_date}")

        total_trades = len(trades)
        winning_trades = sum(1 for t in trades if t.profit_percent > 0)
        losing_trades = sum(1 for t in trades if t.profit_percent <= 0)
        
        total_profit_abs = sum(t.profit for t in trades if t.profit is not None)
        total_profit_pct = sum(t.profit_percent for t in trades if t.profit_percent is not None)
        
        avg_profit = total_profit_pct / total_trades if total_trades > 0 else 0
        max_profit = max((t.profit_percent for t in trades if t.profit_percent is not None), default=0)
        min_profit = min((t.profit_percent for t in trades if t.profit_percent is not None), default=0)
        
        win_rate = winning_trades / total_trades if total_trades > 0 else 0

        # Drawdown calculation
        cumulative_profit = 0
        peak = 0
        max_drawdown_abs = 0
        
        for t in trades:
            cumulative_profit += (t.profit or 0)
            if cumulative_profit > peak:
                peak = cumulative_profit
            
            drawdown = peak - cumulative_profit
            if drawdown > max_drawdown_abs:
                max_drawdown_abs = drawdown
                
        max_drawdown_pct = max_drawdown_abs / self.starting_balance if self.starting_balance > 0 else 0

        result = BacktestResult(
            strategy_name=self.strategy.__class__.__name__,
            timerange=f"{start_date.date()} to {end_date.date()}",
            total_trades=total_trades,
            winning_trades=winning_trades,
            losing_trades=losing_trades,
            win_rate=win_rate,
            total_profit=total_profit_abs,
            total_profit_percent=total_profit_pct,
            avg_profit=avg_profit,
            max_profit=max_profit,
            min_profit=min_profit,
            max_drawdown=max_drawdown_abs,
            max_drawdown_percent=max_drawdown_pct
        )
        
        self._save_backtest(result)
        return result

    def _save_backtest(self, result: BacktestResult) -> None:
        """Save results to DB."""
        # Simplified save
        logger.info(f"Backtest {result.strategy_name} completed. Profit: {result.total_profit_percent:.2f}%")
