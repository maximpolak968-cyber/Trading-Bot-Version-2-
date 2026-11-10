import os
import time
import math
import logging
from typing import Dict, List, Optional, Any, Tuple
from datetime import datetime
import importlib

logger = logging.getLogger('freqtrade')

class ExchangeManager:
    """
    Manager for exchange connections and operations.
    Handles order creation, fetching data, and interacting with the exchange.
    Supports both Binance Spot and Binance Futures (USDT-M) with Hedge mode.
    """
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.exchange_name = self.config.get('exchange', {}).get('name', 'binance').lower()
        self.api = None
        self._markets = {}
        self._futures_symbols: Dict[str, Any] = {}
        self._ohlcv_cache: Dict[str, Tuple[float, List[List[Any]]]] = {}
        self._init_exchange()

    def _init_exchange(self) -> None:
        """Initialize the CCXT exchange instance."""
        logger.info(f"Initializing exchange: {self.exchange_name}")
        try:
            ccxt = importlib.import_module('ccxt')
            exchange_class = getattr(ccxt, self.exchange_name)
            
            exchange_config = self.config.get('exchange', {})
            is_futures = self.config.get('trading_mode') == 'futures'
            is_testnet = exchange_config.get('testnet', False)

            # Read credentials from environment variables (Secrets) first
            env_key = os.getenv('BINANCE_TESTNET_API_KEY') or os.getenv('BINANCE_API_KEY')
            env_secret = os.getenv('BINANCE_TESTNET_SECRET') or os.getenv('BINANCE_API_SECRET')

            config_key = exchange_config.get('key', '')
            config_secret = exchange_config.get('secret', '')

            api_key = env_key if env_key else ('' if 'ВАШ_' in config_key else config_key)
            secret = env_secret if env_secret else ('' if 'ВАШ_' in config_secret else config_secret)

            options = dict(exchange_config.get('ccxt_config', {}))
            if is_futures:
                options['defaultType'] = 'future'
            options['adjustForTimeDifference'] = True
            options['recvWindow'] = 10000

            self.api = exchange_class({
                'apiKey': api_key,
                'secret': secret,
                'enableRateLimit': True,
                'options': options
            })

            # Enable testnet sandbox / endpoint mapping
            if is_testnet:
                if is_futures:
                    for k in list(self.api.urls['api'].keys()):
                        if 'fapi' in k or 'dapi' in k:
                            self.api.urls['api'][k] = self.api.urls['api'][k].replace('fapi.binance.com', 'testnet.binancefuture.com').replace('dapi.binance.com', 'testnet.binancefuture.com')
                    logger.info("✅ Binance Futures Testnet active: https://testnet.binancefuture.com")
                elif hasattr(self.api, 'set_sandbox_mode'):
                    self.api.set_sandbox_mode(True)
                    logger.info("Sandbox / Testnet mode enabled for CCXT exchange.")
            
            # Preload futures symbols info if futures mode
            if is_futures and hasattr(self.api, 'fapiPublicGetExchangeInfo'):
                try:
                    f_info = self.api.fapiPublicGetExchangeInfo()
                    self._futures_symbols = {s['symbol']: s for s in f_info.get('symbols', [])}
                    logger.info(f"Loaded {len(self._futures_symbols)} symbols metadata from Binance Futures Testnet.")
                except Exception as e:
                    logger.warning(f"Could not preload futures symbols metadata: {e}")

            logger.info(f"✅ Exchange {self.exchange_name} initialized.")
        except Exception as e:
            logger.error(f"Failed to initialize exchange {self.exchange_name}: {e}")
            raise

    def fetch_ohlcv(self, pair: str, timeframe: str, limit: int = 500) -> List[List[Any]]:
        """Fetch OHLCV data."""
        if not self.api:
            return []
        try:
            is_futures = self.config.get('trading_mode') == 'futures'
            if is_futures and hasattr(self.api, 'fapiPublicGetKlines'):
                symbol_clean = pair.replace('/', '').replace(':USDT', '')
                raw_klines = self.api.fapiPublicGetKlines({
                    'symbol': symbol_clean,
                    'interval': timeframe,
                    'limit': limit
                })
                return [[int(k[0]), float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])] for k in raw_klines]
            
            return self.api.fetch_ohlcv(pair, timeframe, limit=limit)
        except Exception as e:
            logger.error(f"Error fetching OHLCV for {pair}: {e}")
            return []

    def fetch_ohlcv_cached(self, pair: str, timeframe: str, limit: int = 100, ttl: float = 120.0) -> List[List[Any]]:
        """
        Fetch OHLCV data with in-memory TTL caching to avoid rate-limiting on higher timeframes (4h, 1d).
        """
        cache_key = f"{pair}:{timeframe}:{limit}"
        now = time.time()
        if cache_key in self._ohlcv_cache:
            timestamp, cached_data = self._ohlcv_cache[cache_key]
            if now - timestamp < ttl:
                return cached_data

        data = self.fetch_ohlcv(pair, timeframe, limit=limit)
        if data:
            self._ohlcv_cache[cache_key] = (now, data)
        return data

    def get_ticker(self, pair: str) -> Dict[str, Any]:
        """Get ticker info for a pair (includes 24h volume & % change for futures)."""
        if not self.api:
            return {}
        try:
            is_futures = self.config.get('trading_mode') == 'futures'
            if is_futures and hasattr(self.api, 'fapiPublicGetTicker24hr'):
                symbol_clean = pair.replace('/', '').replace(':USDT', '')
                res = self.api.fapiPublicGetTicker24hr({'symbol': symbol_clean})
                price = float(res.get('lastPrice', 0.0))
                return {
                    'last': price,
                    'close': price,
                    'symbol': pair,
                    'quoteVolume': float(res.get('quoteVolume', 0.0)),
                    'percentage': float(res.get('priceChangePercent', 0.0)),
                    'high': float(res.get('highPrice', 0.0)),
                    'low': float(res.get('lowPrice', 0.0)),
                }

            return self.api.fetch_ticker(pair)
        except Exception as e:
            logger.error(f"Error fetching ticker for {pair}: {e}")
            return {}

    def get_balance(self) -> Dict[str, Any]:
        """Get account balance."""
        if self.config.get('dry_run', True):
            wallet = float(self.config.get('dry_run_wallet', 5000.0))
            return {
                "USDT": {"free": wallet, "total": wallet},
                "total": {"USDT": wallet},
                "free": {"USDT": wallet}
            }
            
        if not self.api:
            return {}
        try:
            is_futures = self.config.get('trading_mode') == 'futures'
            if is_futures and hasattr(self.api, 'fapiPrivateV2GetBalance'):
                res = self.api.fapiPrivateV2GetBalance()
                for item in res:
                    if item.get('asset') == 'USDT':
                        total = float(item.get('balance', 0.0))
                        free = float(item.get('availableBalance', 0.0))
                        return {
                            "USDT": {"free": free, "total": total},
                            "total": {"USDT": total},
                            "free": {"USDT": free}
                        }
            return self.api.fetch_balance()
        except Exception as e:
            logger.error(f"Error fetching balance: {e}")
            return {}

    def get_symbol_filters(self, pair: str) -> Dict[str, Any]:
        """Get lot size and price filters for a futures symbol."""
        symbol_clean = pair.replace('/', '').replace(':USDT', '')
        if not self._futures_symbols and hasattr(self.api, 'fapiPublicGetExchangeInfo'):
            try:
                info = self.api.fapiPublicGetExchangeInfo()
                self._futures_symbols = {s['symbol']: s for s in info.get('symbols', [])}
            except Exception as e:
                logger.error(f"Error fetching symbol filters: {e}")
        return self._futures_symbols.get(symbol_clean, {})

    def format_amount(self, pair: str, target_stake_usdt: float, price: float) -> float:
        """
        Format order quantity to strictly respect:
        1. 1% of total deposit
        2. Exchange stepSize & precision
        3. Minimum Binance Futures notional (50.0 USDT)
        """
        if price <= 0:
            return 0.0

        s_info = self.get_symbol_filters(pair)
        if not s_info:
            raw_qty = target_stake_usdt / price
            return round(raw_qty, 4)

        lot_filter = next((f for f in s_info.get('filters', []) if f['filterType'] == 'LOT_SIZE'), None)
        precision = int(s_info.get('quantityPrecision', 3))
        step_size = float(lot_filter['stepSize']) if lot_filter else 10 ** (-precision)

        raw_qty = target_stake_usdt / price
        steps = math.ceil(raw_qty / step_size)
        qty = round(steps * step_size, precision)

        # Ensure order value meets min notional requirement (50.0 USDT)
        while qty * price < 50.0:
            steps += 1
            qty = round(steps * step_size, precision)

        return qty

    def create_order(
        self,
        pair: str,
        order_type: str,
        side: str,
        amount: float,
        price: Optional[float] = None,
        position_side: str = 'LONG'
    ) -> Dict[str, Any]:
        """Create a new order on the exchange."""
        if self.config.get('dry_run', True):
            logger.info(f"DRY RUN: Would create {side} {order_type} order for {amount} {pair} at {price} (positionSide={position_side})")
            return {
                "id": f"dry_run_{int(datetime.utcnow().timestamp())}",
                "symbol": pair,
                "type": order_type,
                "side": side,
                "amount": amount,
                "price": price,
                "status": "closed" if order_type == "market" else "open"
            }

        if not self.api:
            return {}
        try:
            is_futures = self.config.get('trading_mode') == 'futures'
            symbol_clean = pair.replace('/', '').replace(':USDT', '')
            logger.info(f"🚀 Submitting REAL {side.upper()} {order_type.upper()} order for {amount} {pair} at {price} (positionSide={position_side}) to Binance Testnet...")

            if is_futures and hasattr(self.api, 'fapiPrivatePostOrder'):
                order_payload: Dict[str, Any] = {
                    'symbol': symbol_clean,
                    'side': side.upper(),
                    'positionSide': position_side.upper(),
                    'type': order_type.upper(),
                    'quantity': amount,
                }
                if order_type.lower() == 'limit' and price is not None:
                    # Format price to tick size if available
                    s_info = self.get_symbol_filters(pair)
                    price_filter = next((f for f in s_info.get('filters', []) if f['filterType'] == 'PRICE_FILTER'), None)
                    price_precision = int(s_info.get('pricePrecision', 2))
                    formatted_price = round(price, price_precision)
                    order_payload['price'] = formatted_price
                    order_payload['timeInForce'] = 'GTC'
                
                res = self.api.fapiPrivatePostOrder(order_payload)
                avg_price = float(res.get('avgPrice', 0.0)) if res.get('avgPrice') else 0.0
                real_price = avg_price if avg_price > 0 else (price if price is not None else 0.0)
                logger.info(f"✅ Real order successfully placed on Binance Futures Testnet! Order ID: {res.get('orderId')} Status: {res.get('status')} Price: {real_price}")
                return {
                    "id": str(res.get('orderId')),
                    "symbol": pair,
                    "type": order_type,
                    "side": side,
                    "amount": amount,
                    "price": real_price,
                    "status": res.get('status', 'open').lower()
                }

            # Standard CCXT fallback
            if order_type == 'limit' and price is not None:
                return self.api.create_order(pair, order_type, side, amount, price, params={'positionSide': position_side})
            elif order_type == 'market':
                return self.api.create_order(pair, order_type, side, amount, params={'positionSide': position_side})
            else:
                raise ValueError("Invalid order type or missing price for limit order.")
        except Exception as e:
            logger.error(f"❌ Error creating order for {pair}: {e}")
            return {}

    def cancel_order(self, order_id: str, pair: str) -> bool:
        """Cancel an existing order."""
        if self.config.get('dry_run', True):
            logger.info(f"DRY RUN: Would cancel order {order_id} for {pair}")
            return True

        if not self.api:
            return False
        try:
            is_futures = self.config.get('trading_mode') == 'futures'
            symbol_clean = pair.replace('/', '').replace(':USDT', '')
            if is_futures and hasattr(self.api, 'fapiPrivateDeleteOrder'):
                res = self.api.fapiPrivateDeleteOrder({
                    'symbol': symbol_clean,
                    'orderId': order_id
                })
                logger.info(f"✅ Real order {order_id} cancelled on Binance Futures Testnet. Status: {res.get('status')}")
                return True

            self.api.cancel_order(order_id, pair)
            return True
        except Exception as e:
            logger.error(f"Error canceling order {order_id}: {e}")
            return False

    def get_tradeable_pairs(self) -> List[str]:
        """
        Get list of tradeable pairs.
        If pair_whitelist is provided and not empty, returns whitelist minus blacklist.
        If pair_whitelist is empty or scan_all_pairs is True, discovers ALL active market pairs (e.g. */USDT).
        """
        exchange_config = self.config.get('exchange', {})
        whitelist = exchange_config.get('pair_whitelist', [])
        blacklist = set(exchange_config.get('pair_blacklist', []))
        stake_currency = self.config.get('stake_currency', 'USDT')
        trading_mode = self.config.get('trading_mode', 'spot')

        # If whitelist is explicitly defined and scan_all_pairs is False, use it
        if whitelist and not exchange_config.get('scan_all_pairs', False):
            return [p for p in whitelist if p not in blacklist]

        stablecoins = {'USDC', 'FDUSD', 'TUSD', 'BUSD', 'EUR', 'DAI', 'USDP', 'AEUR', 'UST'}

        # If futures mode, discover from fapiPublicGetExchangeInfo
        if trading_mode == 'futures' and hasattr(self.api, 'fapiPublicGetExchangeInfo'):
            try:
                f_info = self.api.fapiPublicGetExchangeInfo()
                self._futures_symbols = {s['symbol']: s for s in f_info.get('symbols', [])}
                futures_pairs = []
                for s in f_info.get('symbols', []):
                    if s.get('status') == 'TRADING' and s.get('quoteAsset') == stake_currency:
                        base = s.get('baseAsset')
                        if base not in stablecoins:
                            pair_str = f"{base}/{stake_currency}"
                            if pair_str not in blacklist and s.get('symbol') not in blacklist:
                                futures_pairs.append(pair_str)
                if futures_pairs:
                    return futures_pairs
            except Exception as e:
                logger.error(f"Error discovering futures tradeable pairs: {e}")

        # Scan spot exchange markets fallback
        tradeable = []
        try:
            if not self._markets and self.api:
                self.api.load_markets()
                self._markets = self.api.markets or {}

            for symbol, market in self._markets.items():
                if not isinstance(market, dict):
                    continue
                if not market.get('active', True):
                    continue
                base = market.get('base', '')
                quote = market.get('quote', '')
                if quote != stake_currency:
                    continue
                if base in stablecoins:
                    continue
                if symbol in blacklist:
                    continue
                tradeable.append(symbol)

        except Exception as e:
            logger.error(f"Error scanning markets for tradeable pairs: {e}")

        # Fallback to whitelist if market scan returned empty
        if not tradeable and whitelist:
            return [p for p in whitelist if p not in blacklist]

        return tradeable

    def fetch_order_history(self, pair: str, limit: int = 50) -> List[Dict[str, Any]]:
        """Fetch order history for a pair."""
        if not self.api:
            return []
        try:
             # Some exchanges don't support fetch_orders, might need fetch_closed_orders
             if self.api.has.get('fetchOrders', False):
                 return self.api.fetch_orders(pair, limit=limit)
             elif self.api.has.get('fetchClosedOrders', False):
                 return self.api.fetch_closed_orders(pair, limit=limit)
             return []
        except Exception as e:
            logger.error(f"Error fetching order history for {pair}: {e}")
            return []

    def get_order_status(self, order_id: str, pair: str) -> Dict[str, Any]:
        """Fetch the current status of an order."""
        if self.config.get('dry_run', True):
            return {"status": "closed"}
            
        if not self.api:
            return {}
        try:
            return self.api.fetch_order(order_id, pair)
        except Exception as e:
            logger.error(f"Error fetching status for order {order_id}: {e}")
            return {}

    def get_funding_rate(self, pair: str) -> float:
        """Get funding rate for perpetual futures."""
        if not self.api or not self.api.has.get('fetchFundingRate'):
            return 0.0
        try:
            res = self.api.fetch_funding_rate(pair)
            return res.get('fundingRate', 0.0)
        except Exception as e:
            logger.error(f"Error fetching funding rate for {pair}: {e}")
            return 0.0

    def get_leverage(self, pair: str) -> int:
        """Get current leverage for a pair from active position or config."""
        try:
            risk = self.get_position_risk(pair)
            if risk and risk.get('leverage'):
                return int(risk['leverage'])
        except Exception:
            pass
        return int(self.config.get('leverage', 25))

    def set_leverage(self, pair: str, leverage: int = 25) -> bool:
        """
        Set leverage for a pair. If the requested leverage (e.g. 25x) is not supported
        or exceeds pair limit, tries the closest available leverage.
        """
        if self.config.get('dry_run', True):
            logger.info(f"DRY RUN: Would set leverage {leverage}x for {pair}")
            return True

        if not self.api:
            return False
        
        symbol_clean = pair.replace('/', '').replace(':USDT', '')
        
        # Try requested leverage first, then fallback to descending levels (20, 15, 10, 5) if pair max is lower
        candidate_leverages = [leverage]
        for fallback in [20, 15, 10, 5, 3, 1]:
            if fallback < leverage and fallback not in candidate_leverages:
                candidate_leverages.append(fallback)

        for lev in candidate_leverages:
            try:
                if hasattr(self.api, 'fapiPrivatePostLeverage'):
                    res = self.api.fapiPrivatePostLeverage({'symbol': symbol_clean, 'leverage': lev})
                    actual_lev = res.get('leverage', lev)
                    logger.info(f"✅ Leverage set to {actual_lev}x for {pair}")
                    return True
                elif self.api.has.get('setLeverage'):
                    self.api.set_leverage(lev, pair)
                    logger.info(f"✅ Leverage set to {lev}x for {pair}")
                    return True
            except Exception as e:
                err_msg = str(e)
                # If error is about leverage exceeding max limit, try next lower leverage
                if any(kw in err_msg.lower() for kw in ['leverage', 'exceed', 'max', 'invalid', 'range']):
                    logger.warning(f"Leverage {lev}x not accepted for {pair} ({err_msg}). Trying closest available leverage...")
                    continue
                else:
                    logger.error(f"Error setting leverage for {pair}: {e}")
                    return False

        logger.warning(f"setLeverage could not apply any leverage level for {pair}")
        return False

    def set_margin_mode(self, pair: str, margin_mode: str) -> bool:
        """Set margin mode (cross/isolated) for a futures pair."""
        if self.config.get('dry_run', True):
            logger.info(f"DRY RUN: Would set margin mode {margin_mode} for {pair}")
            return True
        if not self.api:
            return False
        try:
            symbol_clean = pair.replace('/', '').replace(':USDT', '')
            mode = 'CROSSED' if margin_mode.lower() == 'cross' else 'ISOLATED'
            if hasattr(self.api, 'fapiPrivatePostMarginType'):
                self.api.fapiPrivatePostMarginType({'symbol': symbol_clean, 'marginType': mode})
            elif hasattr(self.api, 'set_margin_mode'):
                self.api.set_margin_mode(margin_mode.lower(), pair)
            return True
        except Exception as e:
            # Binance возвращает ошибку, если режим уже установлен таким — это не сбой
            if 'No need to change margin type' in str(e):
                return True
            logger.error(f"Error setting margin mode for {pair}: {e}")
            return False

    def get_position_risk(self, pair: str) -> Dict[str, Any]:
        """
        Fetch REAL position data directly from Binance: leverage, entry price,
        mark price, liquidation price, position margin, notional value.
        This is authoritative — do not recompute these manually in bot logic.
        """
        if self.config.get('dry_run', True):
            return {}
        if not self.api or not hasattr(self.api, 'fapiPrivateV2GetPositionRisk'):
            return {}
        try:
            symbol_clean = pair.replace('/', '').replace(':USDT', '')
            positions = self.api.fapiPrivateV2GetPositionRisk({'symbol': symbol_clean})
            for p in positions:
                amt = float(p.get('positionAmt', 0.0))
                if amt == 0:
                    continue
                return {
                    'symbol': p.get('symbol'),
                    'position_side': p.get('positionSide'),
                    'amount': amt,
                    'entry_price': float(p.get('entryPrice', 0.0)),
                    'mark_price': float(p.get('markPrice', 0.0)),
                    'liquidation_price': float(p.get('liquidationPrice', 0.0)),
                    'leverage': int(float(p.get('leverage', 1))),
                    'margin_type': p.get('marginType', 'cross'),
                    'isolated_margin': float(p.get('isolatedMargin', 0.0)),
                    'position_initial_margin': float(p.get('positionInitialMargin', 0.0)) if 'positionInitialMargin' in p else None,
                    'unrealized_pnl': float(p.get('unRealizedProfit', 0.0)),
                }
            return {}
        except Exception as e:
            logger.error(f"Error fetching position risk for {pair}: {e}")
            return {}

    def get_account_margin_summary(self) -> Dict[str, Any]:
        """
        Fetch REAL account-wide margin data directly from Binance
        (totalWalletBalance, availableBalance, totalMarginBalance, totalInitialMargin, totalMaintMargin).
        Use this instead of manually summing trade.stake_amount across open trades.
        """
        if self.config.get('dry_run', True):
            wallet = float(self.config.get('dry_run_wallet', 5000.0))
            return {
                'total_wallet_balance': wallet,
                'available_balance': wallet,
                'total_margin_balance': wallet,
                'total_initial_margin': 0.0,
                'total_maint_margin': 0.0,
                'used_pct': 0.0,
                'free_pct': 100.0,
            }
        if not self.api or not hasattr(self.api, 'fapiPrivateV2GetAccount'):
            return {}
        try:
            acc = self.api.fapiPrivateV2GetAccount()
            total_wallet = float(acc.get('totalWalletBalance', 0.0))
            available = float(acc.get('availableBalance', 0.0))
            total_margin_balance = float(acc.get('totalMarginBalance', total_wallet))
            total_initial_margin = float(acc.get('totalInitialMargin', 0.0))
            total_maint_margin = float(acc.get('totalMaintMargin', 0.0))
            used_pct = round((total_initial_margin / total_margin_balance) * 100.0, 2) if total_margin_balance > 0 else 0.0
            return {
                'total_wallet_balance': total_wallet,
                'available_balance': available,
                'total_margin_balance': total_margin_balance,
                'total_initial_margin': total_initial_margin,
                'total_maint_margin': total_maint_margin,
                'used_pct': used_pct,
                'free_pct': round(max(0.0, 100.0 - used_pct), 2),
            }
        except Exception as e:
            logger.error(f"Error fetching account margin summary: {e}")
            return {}

    def fetch_trades(self, pair: str, limit: int = 50) -> List[Dict[str, Any]]:
        """Fetch recent trades for a pair."""
        if not self.api:
            return []
        try:
            return self.api.fetch_trades(pair, limit=limit)
        except Exception as e:
            logger.error(f"Error fetching trades for {pair}: {e}")
            return []

    def fetch_order_book(self, pair: str, limit: int = 20) -> Dict[str, Any]:
        """Fetch order book for a pair."""
        if not self.api:
            return {}
        try:
            return self.api.fetch_order_book(pair, limit=limit)
        except Exception as e:
            logger.error(f"Error fetching order book for {pair}: {e}")
            return {}

    def get_min_notional(self, pair: str) -> float:
        """Get minimum notional value (min cost) for an order."""
        if not self._markets or pair not in self._markets:
            return 50.0 if self.config.get('trading_mode') == 'futures' else 5.0
        market = self._markets[pair]
        return float(market.get('limits', {}).get('cost', {}).get('min', 50.0 if self.config.get('trading_mode') == 'futures' else 5.0))

    def get_min_pair_stake(self, pair: str) -> float:
        """Get minimum stake in quote currency (USDT) to satisfy Binance filters."""
        min_notional = self.get_min_notional(pair)
        return max(min_notional, 50.0 if self.config.get('trading_mode') == 'futures' else 5.0)

    def amount_to_precision(self, pair: str, amount: float) -> float:
        """Round amount to the valid lot size step of the symbol."""
        s_info = self.get_symbol_filters(pair)
        if not s_info:
            return round(amount, 4)
        lot_filter = next((f for f in s_info.get('filters', []) if f['filterType'] == 'LOT_SIZE'), None)
        precision = int(s_info.get('quantityPrecision', 3))
        step_size = float(lot_filter['stepSize']) if lot_filter else 10 ** (-precision)
        steps = math.floor(amount / step_size)
        return round(steps * step_size, precision)

    def get_max_leverage(self) -> int:
        """Get maximum allowed leverage from config."""
        return int(self.config.get('leverage', 25))
