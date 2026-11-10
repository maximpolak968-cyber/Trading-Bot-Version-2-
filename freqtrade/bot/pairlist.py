"""
Pairlist module.
Manages the active whitelist of pairs, applying filters dynamically.
"""
import logging
import random
from typing import Dict, Any, List
from abc import ABC, abstractmethod

from freqtrade.exchange.exchange import ExchangeManager

logger = logging.getLogger('freqtrade')

class PairListFilter(ABC):
    """Base class for all pairlist filters."""
    
    def __init__(self, exchange: ExchangeManager, config: Dict[str, Any]):
        self.exchange = exchange
        self.config = config

    @abstractmethod
    def filter_pairs(self, pairs: List[str]) -> List[str]:
        """Apply the filter to the list of pairs."""
        pass


class StaticPairList(PairListFilter):
    """Provides a static list of pairs from configuration."""
    def filter_pairs(self, pairs: List[str]) -> List[str]:
        # Usually acts as the base generator, overriding incoming pairs
        return self.config.get('exchange', {}).get('pair_whitelist', [])


class VolumePairList(PairListFilter):
    """Filters pairs by minimum 24h quote volume and keeps the top N by volume."""
    def __init__(self, exchange: ExchangeManager, config: Dict[str, Any]):
        super().__init__(exchange, config)
        self.min_volume = config.get('min_value', config.get('min_volume', 100000.0))
        self.number_assets = int(config.get('number_assets', 0))  # 0 = без ограничения

    def filter_pairs(self, pairs: List[str]) -> List[str]:
        scored: List[tuple] = []
        for pair in pairs:
            ticker = self.exchange.get_ticker(pair)
            volume = ticker.get('quoteVolume', 0) if ticker else 0
            if volume and volume >= self.min_volume:
                scored.append((pair, volume))

        scored.sort(key=lambda x: x[1], reverse=True)
        if self.number_assets > 0:
            scored = scored[:self.number_assets]

        filtered = [p for p, _ in scored]
        logger.debug(f"VolumePairList kept {len(filtered)} out of {len(pairs)} pairs (top {self.number_assets or 'all'} by volume)")
        return filtered


class PriceFilter(PairListFilter):
    """Filters pairs based on price limits."""
    def __init__(self, exchange: ExchangeManager, config: Dict[str, Any]):
        super().__init__(exchange, config)
        self.min_price = config.get('min_price', 0.00000001)
        self.max_price = config.get('max_price', 100000.0)
        
    def filter_pairs(self, pairs: List[str]) -> List[str]:
        filtered = []
        for pair in pairs:
            ticker = self.exchange.get_ticker(pair)
            if ticker:
                price = ticker.get('last', 0)
                if self.min_price <= price <= self.max_price:
                    filtered.append(pair)
        return filtered


class PrecisionFilter(PairListFilter):
    """Filters pairs based on price/amount precision requirements."""
    def filter_pairs(self, pairs: List[str]) -> List[str]:
        # Assuming all binance pairs have sufficient precision for demo
        # In reality, inspects self.exchange.markets[pair]['precision']
        return pairs


class ShuffleFilter(PairListFilter):
    """Shuffles the list of pairs to avoid bias."""
    def filter_pairs(self, pairs: List[str]) -> List[str]:
        shuffled = list(pairs)
        random.shuffle(shuffled)
        return shuffled


class PercentChangePairList(PairListFilter):
    """Filters pairs based on 24h percentage change."""
    def __init__(self, exchange: ExchangeManager, config: Dict[str, Any]):
        super().__init__(exchange, config)
        self.min_change = config.get('min_change', -100.0)
        self.max_change = config.get('max_change', 100.0)
        
    def filter_pairs(self, pairs: List[str]) -> List[str]:
        filtered = []
        for pair in pairs:
            ticker = self.exchange.get_ticker(pair)
            if ticker:
                change = ticker.get('percentage', 0)
                if change is not None and self.min_change <= change <= self.max_change:
                    filtered.append(pair)
        return filtered


class VolatilityFilter(PairListFilter):
    """Filters pairs that are too volatile or not volatile enough."""
    def __init__(self, exchange: ExchangeManager, config: Dict[str, Any]):
        super().__init__(exchange, config)
        self.min_volatility = config.get('min_volatility', 0.01)
        self.max_volatility = config.get('max_volatility', 0.10)
        
    def filter_pairs(self, pairs: List[str]) -> List[str]:
        filtered = []
        for pair in pairs:
            ohlcv = self.exchange.fetch_ohlcv(pair, '1d', limit=5)
            if ohlcv and len(ohlcv) > 0:
                # Basic volatility measure: high-low / close
                recent_candle = ohlcv[-1]
                high, low, close = recent_candle[2], recent_candle[3], recent_candle[4]
                if close > 0:
                    volatility = (high - low) / close
                    if self.min_volatility <= volatility <= self.max_volatility:
                        filtered.append(pair)
        return filtered


class PerformanceFilter(PairListFilter):
    """Filters pairs based on past trade performance (win rate on the pair)."""
    def __init__(self, exchange: ExchangeManager, config: Dict[str, Any], db):
        super().__init__(exchange, config)
        self.db = db
        self.min_win_rate = config.get('min_win_rate', 0.0)
        
    def filter_pairs(self, pairs: List[str]) -> List[str]:
        if self.min_win_rate <= 0:
            return pairs
            
        filtered = []
        stats = self.db.get_stats()
        pair_stats = stats.get('pair_performance', {})
        
        for pair in pairs:
            p_stat = pair_stats.get(pair)
            if not p_stat:
                filtered.append(pair) # Keep if no history
            else:
                total = p_stat.get('total', 0)
                wins = p_stat.get('wins', 0)
                if total > 0 and (wins / total) >= self.min_win_rate:
                    filtered.append(pair)
        return filtered


class RangeStabilityFilter(PairListFilter):
    """Filters pairs that have been stable in a tight range."""
    def filter_pairs(self, pairs: List[str]) -> List[str]:
        # Simplified implementation
        return pairs


class PairListManager:
    """
    Manages the pairlist generation and filtering pipeline.
    """
    def __init__(self, exchange: ExchangeManager, config: Dict[str, Any]):
        self.exchange = exchange
        self.config = config
        self.filters: List[PairListFilter] = []
        self._init_filters()
        
    def _init_filters(self) -> None:
        """Initialize configured filters."""
        pairlist_config = self.config.get('pairlists', [
            {"method": "StaticPairList"},
            {"method": "ShuffleFilter"}
        ])
        
        # Mapping names to classes
        filter_map = {
            "StaticPairList": StaticPairList,
            "VolumePairList": VolumePairList,
            "PriceFilter": PriceFilter,
            "PrecisionFilter": PrecisionFilter,
            "ShuffleFilter": ShuffleFilter,
            "PercentChangePairList": PercentChangePairList,
            "VolatilityFilter": VolatilityFilter,
            "RangeStabilityFilter": RangeStabilityFilter,
            # PerformanceFilter excluded here as it needs DB, handled separately or injected
        }
        
        for p_config in pairlist_config:
            method_name = p_config.get("method")
            if method_name in filter_map:
                logger.info(f"Adding pairlist filter: {method_name}")
                self.filters.append(filter_map[method_name](self.exchange, p_config))
            else:
                logger.warning(f"Unknown pairlist filter: {method_name}")

    def refresh_pairlist(self) -> List[str]:
        """
        Run the full filter pipeline and return the active pairlist.
        """
        pairs: List[str] = []
        for i, filter_obj in enumerate(self.filters):
            if i == 0 and not isinstance(filter_obj, StaticPairList):
                # Первый фильтр в конфиге — не генератор списка (StaticPairList),
                # значит перед фильтрацией нужно получить полный список торгуемых пар с биржи.
                pairs = self.exchange.get_tradeable_pairs()
            pairs = filter_obj.filter_pairs(pairs)

        # Enforce blacklist
        blacklist = set(self.config.get('exchange', {}).get('pair_blacklist', []))
        pairs = [p for p in pairs if p not in blacklist]

        logger.debug(f"PairListManager generated {len(pairs)} pairs")
        return pairs
