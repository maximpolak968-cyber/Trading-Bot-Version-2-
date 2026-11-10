"""
RPC Manager.
Coordinates messages across different RPC protocols (API, Telegram, Webhooks).
"""
import logging
from typing import Dict, Any, List

from freqtrade.models.trade import Trade
from freqtrade.rpc.api_server import ApiServer
from freqtrade.rpc.webhook import WebhookLogger

logger = logging.getLogger('freqtrade')

class RPCManager:
    """
    Manages all RPC channels.
    Routes messages to API, Webhooks, etc.
    """
    def __init__(self, bot: Any):
        if isinstance(bot, dict):
            self.bot = None
            self.config = bot
        else:
            self.bot = bot
            self.config = getattr(bot, 'config_dict', bot)
        self._registered_modules: List[Any] = []
        
        self._init_modules()

    def _init_modules(self) -> None:
        """Initialize enabled RPC modules."""
        # API Server
        if self.config.get('api_server', {}).get('enabled', False):
            api_server = ApiServer(self.config, self.bot)
            self._registered_modules.append(api_server)
            
        # Webhook
        if self.config.get('webhook', {}).get('enabled', False):
            webhook = WebhookLogger(self.config)
            self._registered_modules.append(webhook)
            
        # Telegram
        if self.config.get('telegram', {}).get('enabled', False):
            from freqtrade.rpc.telegram import TelegramManager
            telegram = TelegramManager(self.config)
            self._registered_modules.append(telegram)

    def start(self) -> None:
         """Start all RPC modules."""
         for module in self._registered_modules:
             if hasattr(module, 'start'):
                 module.start()
                 
    def cleanup(self) -> None:
         """Cleanup/stop all RPC modules."""
         for module in self._registered_modules:
             if hasattr(module, 'cleanup'):
                 module.cleanup()

    def send_msg(self, msg: Dict[str, Any]) -> None:
        """
        Broadcast a message to all registered RPC modules.
        Example msg: {'type': 'buy', 'trade_id': 1, 'pair': 'BTC/USDT'}
        """
        logger.debug(f"RPC Broadcasting message: {msg}")
        for module in self._registered_modules:
            try:
                module.send_msg(msg)
            except Exception as e:
                logger.error(f"Error sending message via {module.__class__.__name__}: {e}")

    def notify_buy(self, trade: Trade) -> None:
        """Helper to send a buy notification."""
        msg = {
            'type': 'buy',
            'trade_id': trade.id,
            'pair': trade.pair,
            'rate': trade.open_rate,
            'amount': trade.amount,
            'stake_amount': trade.stake_amount
        }
        self.send_msg(msg)

    def notify_sell(self, trade: Trade) -> None:
        """Helper to send a sell notification."""
        msg = {
            'type': 'sell',
            'trade_id': trade.id,
            'pair': trade.pair,
            'open_rate': trade.open_rate,
            'close_rate': trade.close_rate,
            'profit_percent': trade.profit_percent,
            'sell_reason': trade.sell_reason
        }
        self.send_msg(msg)

    def notify_status(self, message: str) -> None:
         """Helper to send a generic status notification."""
         msg = {
             'type': 'status',
             'status': message
         }
         self.send_msg(msg)
