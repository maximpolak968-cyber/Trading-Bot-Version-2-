"""
Freqtrade is a free and open source crypto trading bot written in Python.
It is designed to support all major exchanges and be controlled via Telegram or webUI.
"""
__version__ = "2026.9-dev"
__author__ = "Freqtrade Community"

from freqtrade.core.config import Config
from freqtrade.database.database import Database

try:
    from freqtrade.bot.freqtradebot import FreqtradeBot
    from freqtrade.strategy.interface import IStrategy
except ImportError:
    FreqtradeBot = None  # type: ignore
    IStrategy = None  # type: ignore

__all__ = ["Config", "FreqtradeBot", "IStrategy", "Database"]

