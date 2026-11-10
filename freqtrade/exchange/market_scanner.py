"""
Market 24-Hour Anomalies Scanner Module (Top Gainers & Top Losers)
Discovers market movers with extreme 24h price percentage change and funding rates.
"""
import time
import logging
from typing import Dict, List, Any, Optional

logger = logging.getLogger('freqtrade')

class Market24hScanner:
    """
    Scans exchange futures market for extreme 24-hour gainers and losers.
    Pairs are filtered by minimum volume and volatility threshold.
    """
    def __init__(self, exchange: Any, min_quote_volume: float = 1_000_000.0, cache_ttl: float = 90.0):
        self.exchange = exchange
        self.min_quote_volume = min_quote_volume
        self.cache_ttl = cache_ttl
        self._last_scan_time: float = 0.0
        self._cached_results: Dict[str, Any] = {}

    def scan_market(self, top_n: int = 5, force: bool = False) -> Dict[str, Any]:
        """
        Scan all 24hr tickers and return:
        - 'gainers': Top N pairs with highest positive 24h price change
        - 'losers': Top N pairs with highest negative 24h price change
        - 'all_scanned_count': Total valid futures pairs evaluated
        """
        now = time.time()
        if not force and self._cached_results and (now - self._last_scan_time < self.cache_ttl):
            return self._cached_results

        if not self.exchange or not self.exchange.api:
            return {'gainers': [], 'losers': [], 'all_scanned_count': 0}

        try:
            raw_tickers = []
            if hasattr(self.exchange.api, 'fapiPublicGetTicker24hr'):
                raw_tickers = self.exchange.api.fapiPublicGetTicker24hr()
            elif hasattr(self.exchange.api, 'fetch_tickers'):
                tickers_dict = self.exchange.api.fetch_tickers()
                raw_tickers = list(tickers_dict.values())

            # Optional funding rates map
            funding_map: Dict[str, float] = {}
            if hasattr(self.exchange.api, 'fapiPublicGetPremiumIndex'):
                try:
                    premium_list = self.exchange.api.fapiPublicGetPremiumIndex()
                    for p in premium_list:
                        sym = p.get('symbol', '')
                        rate = float(p.get('lastFundingRate', 0.0))
                        funding_map[sym] = rate
                except Exception as fe:
                    logger.debug(f"Could not fetch funding rates: {fe}")

            # Filter valid trading pairs
            ignored_tokens = {'USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'BUSDUSDT', 'EURUSDT', 'DAIUSDT'}
            valid_items = []

            for item in raw_tickers:
                symbol = item.get('symbol', '')
                if not symbol.endswith('USDT') or symbol in ignored_tokens:
                    continue

                quote_vol = float(item.get('quoteVolume', item.get('baseVolume', 0.0)))
                if quote_vol < self.min_quote_volume:
                    continue

                change_pct = float(item.get('priceChangePercent', item.get('percentage', 0.0)))
                last_price = float(item.get('lastPrice', item.get('last', item.get('close', 0.0))))
                high_price = float(item.get('highPrice', item.get('high', 0.0)))
                low_price = float(item.get('lowPrice', item.get('low', 0.0)))
                funding = funding_map.get(symbol, 0.0)

                # Standardize pair format for bot (e.g. BTC/USDT)
                base = symbol[:-4]
                pair_formatted = f"{base}/USDT"

                valid_items.append({
                    'pair': pair_formatted,
                    'symbol': symbol,
                    'change_24h_pct': round(change_pct, 2),
                    'last_price': last_price,
                    'high_24h': high_price,
                    'low_24h': low_price,
                    'quote_volume': quote_vol,
                    'funding_rate_pct': round(funding * 100, 4)
                })

            if not valid_items:
                return {'gainers': [], 'losers': [], 'all_scanned_count': 0}

            # Sort gainers (highest positive change first)
            gainers = sorted(
                [x for x in valid_items if x['change_24h_pct'] > 0],
                key=lambda x: x['change_24h_pct'],
                reverse=True
            )[:top_n]

            # Sort losers (lowest / most negative change first)
            losers = sorted(
                [x for x in valid_items if x['change_24h_pct'] < 0],
                key=lambda x: x['change_24h_pct']
            )[:top_n]

            results = {
                'gainers': gainers,
                'losers': losers,
                'all_scanned_count': len(valid_items),
                'timestamp': now
            }
            self._cached_results = results
            self._last_scan_time = now

            logger.info(
                f"🔥 Market 24h Scan completed ({len(valid_items)} futures pairs): "
                f"Top Gainer: {gainers[0]['pair']} ({gainers[0]['change_24h_pct']:+.2f}%) | "
                f"Top Loser: {losers[0]['pair']} ({losers[0]['change_24h_pct']:+.2f}%)"
                if gainers and losers else "Market 24h Scan completed"
            )
            return results

        except Exception as e:
            logger.error(f"Error scanning 24h market movers: {e}", exc_info=True)
            return {'gainers': [], 'losers': [], 'all_scanned_count': 0}

    def get_market_movers_pairs(self, top_per_side: int = 3) -> List[Dict[str, Any]]:
        """
        Returns combined candidate pairs with tags:
        [
            {'pair': 'XXX/USDT', 'type': 'GAINER', 'change_24h_pct': +55.2, 'funding_pct': -0.42},
            {'pair': 'YYY/USDT', 'type': 'LOSER', 'change_24h_pct': -18.4, 'funding_pct': +0.01}
        ]
        """
        scan = self.scan_market(top_n=top_per_side)
        candidates = []
        for g in scan.get('gainers', []):
            item = dict(g)
            item['category'] = 'GAINER'
            candidates.append(item)
        for l in scan.get('losers', []):
            item = dict(l)
            item['category'] = 'LOSER'
            candidates.append(item)
        return candidates


class CandleVolatilityScanner:
    """
    Ищет монеты, у которых ОТДЕЛЬНЫЕ свечи дают резкое процентное движение
    (не накопленный % за 24 часа, а размах конкретной свечи high-low/open).
    Именно такие монеты дают взрывной рост за 1-3 свечи, а не размеренный дрейф.
    """
    def __init__(
        self,
        exchange: Any,
        timeframe: str = '15m',
        lookback: int = 40,
        min_candle_move_pct: float = 15.0,
        cache_ttl: float = 1200.0
    ):
        self.exchange = exchange
        self.timeframe = timeframe
        self.lookback = lookback
        self.min_candle_move_pct = min_candle_move_pct
        self.cache_ttl = cache_ttl
        self._last_scan_time: float = 0.0
        self._cached_results: List[Dict[str, Any]] = []

    def scan(self, candidate_pairs: List[str], force: bool = False) -> List[Dict[str, Any]]:
        now = time.time()
        if not force and self._cached_results and (now - self._last_scan_time) < self.cache_ttl:
            return self._cached_results

        results: List[Dict[str, Any]] = []
        for pair in candidate_pairs:
            try:
                # Нормализуем таймфрейм для совместимости (например '1H' -> '1h')
                tf = self.timeframe.lower() if isinstance(self.timeframe, str) else self.timeframe
                candles = self.exchange.fetch_ohlcv_cached(pair, tf, limit=self.lookback, ttl=self.cache_ttl)
                if not candles or len(candles) < 5:
                    continue

                max_move_pct = 0.0
                max_move_time = None
                for c in candles:
                    o, h, l = float(c[1]), float(c[2]), float(c[3])
                    if o <= 0:
                        continue
                    # Полный размах свечи (high-low) относительно open — ловит и резкий рост, и резкий вынос вниз
                    candle_range_pct = ((h - l) / o) * 100.0
                    if candle_range_pct > max_move_pct:
                        max_move_pct = candle_range_pct
                        max_move_time = int(c[0])

                if max_move_pct >= self.min_candle_move_pct:
                    results.append({
                        'pair': pair,
                        'max_candle_move_pct': round(max_move_pct, 2),
                        'timeframe': self.timeframe,
                        'candle_time': max_move_time,
                    })
            except Exception as e:
                logger.debug(f"Volatility scan skipped {pair}: {e}")
                continue

        results.sort(key=lambda x: x['max_candle_move_pct'], reverse=True)
        self._cached_results = results
        self._last_scan_time = now
        if results:
            logger.info(
                f"⚡ Volatility scan ({self.timeframe}): {len(results)} пар с размахом свечи >= {self.min_candle_move_pct}%. "
                f"Топ: {results[0]['pair']} ({results[0]['max_candle_move_pct']}%)"
            )
        return results
