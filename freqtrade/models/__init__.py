"""
Models module initialization.
"""
from freqtrade.models.trade import Trade
from freqtrade.models.order import Order
from freqtrade.models.signal import Signal
from freqtrade.models.backtest_result import BacktestResult

__all__ = ['Trade', 'Order', 'Signal', 'BacktestResult']
