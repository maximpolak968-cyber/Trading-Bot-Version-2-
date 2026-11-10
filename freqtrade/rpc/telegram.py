"""
Telegram integration module.
Sends notifications to a Telegram chat using HTTP requests.
"""
import os
import logging
import requests
from typing import Dict, Any

logger = logging.getLogger('freqtrade')

class TelegramManager:
    """
    Handles sending notifications and basic commands via Telegram.
    For simplicity in this environment, uses raw requests to the Telegram Bot API.
    """
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.telegram_config = config.get('telegram', {})
        self.enabled = self.telegram_config.get('enabled', False)
        
        # Read from environment variables (Secrets) first, then fallback to config
        env_token = os.getenv('TELEGRAM_BOT_TOKEN') or os.getenv('TELEGRAM_TOKEN')
        env_chat_id = os.getenv('TELEGRAM_CHAT_ID') or os.getenv('CHAT_ID')

        config_token = self.telegram_config.get('token', '')
        config_chat_id = str(self.telegram_config.get('chat_id', ''))

        self.token = env_token if env_token else ('' if 'ВАШ_' in config_token else config_token)
        self.chat_id = env_chat_id if env_chat_id else ('' if 'ВАШ_' in config_chat_id else config_chat_id)
        
        self.api_url = f"https://api.telegram.org/bot{self.token}/"
        
        if self.enabled:
            if not self.token or not self.chat_id:
                logger.warning("Telegram enabled but Token/ChatID not set in environment or config!")
                self.enabled = False
            else:
                logger.info("Telegram module initialized successfully with credentials.")

    def start(self) -> None:
        """Start module (called by RPC Manager)."""
        if self.enabled:
            self._send_text("🤖 <b>Freqtrade Bot Started</b>\nMode: Scalping on Futures Testnet\nListening for signals...")

    def cleanup(self) -> None:
        """Shutdown module."""
        if self.enabled:
            self._send_text("🔴 <b>Freqtrade Bot Stopped</b>")

    def _send_text(self, text: str) -> None:
        """Send a formatted text message to the chat."""
        if not self.enabled:
            return
            
        url = self.api_url + "sendMessage"
        payload = {
            "chat_id": self.chat_id,
            "text": text,
            "parse_mode": "HTML"
        }
        try:
            response = requests.post(url, json=payload, timeout=10)
            if response.status_code != 200:
                logger.warning(f"Telegram API Error: {response.text}")
        except Exception as e:
            logger.error(f"Failed to send Telegram message: {e}")

    def send_msg(self, msg: Dict[str, Any]) -> None:
        """Process messages from the RPC Manager."""
        if not self.enabled:
            return

        msg_type = msg.get('type')
        
        if msg_type == 'buy':
            direction = str(msg.get('direction', 'LONG')).upper()
            pair = msg.get('pair', '')
            base_coin = pair.split('/')[0] if '/' in pair else (pair.split(':')[0] if ':' in pair else '')
            entry_price = msg.get('rate')
            amount = msg.get('amount')
            stake_amount = float(msg.get('stake_amount') or 0.0)
            deposit_balance = float(msg.get('deposit_balance') or 0.0)
            total_trades = int(msg.get('total_trades') or 0)
            total_net_pnl = float(msg.get('total_net_pnl') or 0.0)
            target_tp = msg.get('target_tp')
            tp_gain = msg.get('tp_gain_pct')
            tp_text = f"<code>{target_tp}</code> (+{tp_gain:.1f}%)" if target_tp and tp_gain else "<code>+1.5% - +2.5%</code>"

            coin_str = f" <code>{amount} {base_coin}</code>" if base_coin else f" <code>{amount}</code>"
            pnl_sign = "+" if total_net_pnl >= 0 else ""

            lines = [
                f"🟢 <b>SCALP ENTRY ({direction})</b>",
                f"Пара: <code>{pair}</code>",
                f"Тип: <b>{direction}</b>",
                f"Цена входа: <code>{entry_price}</code>",
                f"Количество монет:{coin_str}",
                f"Сумма сделки: <code>{stake_amount:.2f} USDT</code>",
                f"Баланс депозита: <code>{deposit_balance:.2f} USDT</code>",
                f"Всего закрытых сделок: <code>{total_trades}</code> (Общий PnL: <code>{pnl_sign}{total_net_pnl:.2f} USDT</code>)",
                f"Цель (Target TP): {tp_text}"
            ]
            self._send_text("\n".join(lines))
            
        elif msg_type == 'sell':
            reason = str(msg.get('sell_reason', 'unknown')).upper()
            direction = str(msg.get('direction', 'LONG')).upper()
            pair = msg.get('pair', '')
            base_coin = pair.split('/')[0] if '/' in pair else (pair.split(':')[0] if ':' in pair else '')
            amount = msg.get('amount')
            stake_amount = float(msg.get('stake_amount') or 0.0)
            open_rate = msg.get('open_rate')
            close_rate = msg.get('close_rate')
            profit = float(msg.get('profit_percent', 0.0))
            net_profit = float(msg.get('net_profit') if msg.get('net_profit') is not None else profit)
            net_profit_pct = float(msg.get('net_profit_percent') if msg.get('net_profit_percent') is not None else profit)
            deposit_balance = float(msg.get('deposit_balance') or 0.0)
            total_trades = int(msg.get('total_trades') or 0)
            total_net_pnl = float(msg.get('total_net_pnl') or 0.0)
            
            icon = "🎯" if net_profit > 0 or profit > 0 else "🔴"
            coin_str = f" <code>{amount} {base_coin}</code>" if (amount and base_coin) else (f" <code>{amount}</code>" if amount else "")
            pnl_sign = "+" if total_net_pnl >= 0 else ""
            net_sign = "+" if net_profit >= 0 else ""
            net_pct_sign = "+" if net_profit_pct >= 0 else ""

            lines = [
                f"{icon} <b>SCALP EXIT ({direction})</b>",
                f"Пара: <code>{pair}</code>",
                f"Тип: <b>{direction}</b>",
                f"Причина закрытия: <b>{reason}</b>",
                f"Вход: <code>{open_rate}</code> ➡️ Выход: <code>{close_rate}</code>"
            ]
            if coin_str:
                lines.append(f"Количество монет:{coin_str}")
            if stake_amount > 0:
                lines.append(f"Сумма сделки: <code>{stake_amount:.2f} USDT</code>")
                
            lines.append(f"PnL сделки: <b><code>{net_sign}{net_profit:.2f} USDT</code> (<code>{net_pct_sign}{net_profit_pct:.2f}%</code>)</b>")
            if deposit_balance > 0:
                lines.append(f"Баланс депозита: <code>{deposit_balance:.2f} USDT</code>")
            lines.append(f"Всего закрытых сделок: <code>{total_trades}</code> (Общий PnL: <code>{pnl_sign}{total_net_pnl:.2f} USDT</code>)")
            
            self._send_text("\n".join(lines))
            
        elif msg_type == 'dca':
            direction = str(msg.get('direction', 'LONG')).upper()
            pair = msg.get('pair', '')
            base_coin = pair.split('/')[0] if '/' in pair else (pair.split(':')[0] if ':' in pair else '')
            dca_step = msg.get('dca_step', 1)
            max_step = msg.get('max_dca_orders', 5)
            tot_amt = msg.get('total_amount') or msg.get('add_amount')
            new_avg = msg.get('new_avg_rate')
            old_avg = msg.get('old_avg_rate')
            total_stake = float(msg.get('total_stake') or 0.0)
            deposit_balance = float(msg.get('deposit_balance') or 0.0)
            new_tp = msg.get('new_tp')
            tp_str = f"\nНовая цель (Target TP): <code>{new_tp}</code> (+1.2%)" if new_tp else ""
            coin_str = f"<code>{tot_amt} {base_coin}</code>" if base_coin else f"<code>{tot_amt}</code>"

            text = (
                f"🔄 <b>DCA УСРЕДНЕНИЕ #{dca_step}/{max_step} ({direction})</b>\n"
                f"Пара: <code>{pair}</code>\n"
                f"Тип: <b>{direction}</b>\n"
                f"Новая средняя цена: <code>{new_avg}</code> (была <code>{old_avg}</code>)\n"
                f"Всего монет в позиции: {coin_str}\n"
                f"Суммарная позиция: <code>{total_stake:.2f} USDT</code>\n"
                f"Баланс депозита: <code>{deposit_balance:.2f} USDT</code>{tp_str}"
            )
            self._send_text(text)

        elif msg_type == 'status':
            self._send_text(f"ℹ️ {msg.get('status')}")
