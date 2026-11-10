"""
Bitcoin Trend & Volatility Guard
Monitors BTC/USDT to protect altcoin trades from market-wide dumps.
"""
from datetime import datetime, timedelta
from typing import Dict, Any, Tuple, Optional
import pandas as pd
import logging

logger = logging.getLogger(__name__)

class BTCGuard:
    """
    Monitors Bitcoin condition to protect against altcoin market crashes.
    """
    def __init__(self, exchange, timeframe: str = '1h'):
        self.exchange = exchange
        self.timeframe = timeframe
        self.btc_symbol = 'BTC/USDT'
        self.last_check_time: Optional[datetime] = None
        self.cached_safe: bool = True
        self.cached_status: Dict[str, Any] = {}
        self.cache_ttl_seconds = 60  # Check BTC at most once per minute
        
    def check_market_health(self) -> Tuple[bool, str]:
        """
        Returns (is_safe_for_long, reason).
        """
        now = datetime.utcnow()
        if self.last_check_time and (now - self.last_check_time).total_seconds() < self.cache_ttl_seconds:
            return self.cached_safe, self.cached_status.get('reason', 'Cached BTC check')
            
        try:
            ohlcv = self.exchange.fetch_ohlcv(self.btc_symbol, self.timeframe, limit=50)
            if not ohlcv or len(ohlcv) < 25:
                # If can't fetch BTC, default to safe to not halt bot entirely
                return True, "BTC data unavailable, proceeding with caution"
                
            df = pd.DataFrame(ohlcv, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
            close = df['close'].iloc[-1]
            open_price = df['open'].iloc[-1]
            
            # EMAs
            ema20 = df['close'].ewm(span=20, adjust=False).mean().iloc[-1]
            ema50 = df['close'].ewm(span=50, adjust=False).mean().iloc[-1]
            
            # Current candle price change %
            candle_change_pct = ((close - open_price) / open_price) * 100.0
            
            # Consecutive dump check (last 2 candles)
            prev_close = df['close'].iloc[-2]
            prev_open = df['open'].iloc[-2]
            prev_change_pct = ((prev_close - prev_open) / prev_open) * 100.0
            
            is_safe = True
            reason = "BTC is stable / bullish"
            
            # Condition 1: Severe flash dump in current 1h candle (> 2% drop)
            if candle_change_pct < -2.0:
                is_safe = False
                reason = f"BTC flash dumping: {candle_change_pct:.2f}% in current 1h candle"
                
            # Condition 2: Deep breakdown below EMA 50 by more than 1.5%
            elif close < (ema50 * 0.985) and candle_change_pct < -0.8:
                is_safe = False
                reason = f"BTC breakdown below EMA 50 ({close:.1f} vs EMA50 {ema50:.1f})"
                
            # Condition 3: Double consecutive red bars with expanding volume
            elif candle_change_pct < -1.0 and prev_change_pct < -1.0:
                is_safe = False
                reason = f"BTC consecutive sell-off: 2 hours of heavy selling"
                
            self.cached_safe = is_safe
            self.cached_status = {
                'reason': reason,
                'btc_price': close,
                'candle_change_pct': candle_change_pct,
                'ema20': ema20,
                'ema50': ema50
            }
            self.last_check_time = now
            return is_safe, reason
            
        except Exception as e:
            logger.warning(f"Error checking BTC market health: {e}")
            return True, f"BTC check error: {e}"
