"""
Webhook module.
Sends HTTP POST requests to configured URLs on events.
"""
import logging
import json
# import requests # Used in real env
from typing import Dict, Any

logger = logging.getLogger('freqtrade')

class WebhookLogger:
    """
    Webhook logger.
    Sends notifications to an external service (e.g. Discord, Slack, custom endpoint).
    """
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.webhook_config = config.get('webhook', {})
        self.enabled = self.webhook_config.get('enabled', False)
        self.url = self.webhook_config.get('url')
        self.format = self.webhook_config.get('format', 'form') # 'form' or 'json'

    def send_msg(self, msg: Dict[str, Any]) -> None:
        """Send message via webhook."""
        if not self.enabled or not self.url:
            return
            
        # Filter messages we don't want to send via webhook if needed
        # (Usually configured in config.json)
        
        try:
            # Mocking the request
            # if self.format == 'json':
            #     requests.post(self.url, json=msg, timeout=10)
            # else:
            #     requests.post(self.url, data=msg, timeout=10)
            logger.debug(f"Webhook sent to {self.url} (Mocked): {msg.get('type')}")
        except Exception as e:
            logger.warning(f"Failed to send webhook: {e}")
