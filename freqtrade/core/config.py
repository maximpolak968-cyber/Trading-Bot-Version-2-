import json
from pathlib import Path
from typing import Dict, Any, Optional
from freqtrade.constants import DEFAULT_CONFIG

class Config:
    """Конфигурация бота"""
    
    def __init__(self, config_file: Optional[str] = None):
        if not config_file:
            candidates = ["freqtrade/config.json", "config.json", "./freqtrade/config.json"]
            for c in candidates:
                if Path(c).exists():
                    config_file = c
                    break

        default_data = self.default_config()
        if config_file and Path(config_file).exists():
            with open(config_file, 'r') as f:
                loaded = json.load(f)
                default_data.update(loaded)
                self.data = default_data
        else:
            self.data = default_data

        # Environment variable overrides for Render/cloud deployments
        import os
        if os.environ.get("BINANCE_API_KEY"):
            self.data.setdefault("exchange", {})["key"] = os.environ.get("BINANCE_API_KEY")
        if os.environ.get("BINANCE_API_SECRET"):
            self.data.setdefault("exchange", {})["secret"] = os.environ.get("BINANCE_API_SECRET")
        if os.environ.get("BINANCE_TESTNET") is not None:
            self.data.setdefault("exchange", {})["testnet"] = os.environ.get("BINANCE_TESTNET").strip().lower() in ("true", "1", "yes")
        if os.environ.get("DB_URL"):
            self.data["db_url"] = os.environ.get("DB_URL")
        if os.environ.get("DRY_RUN") is not None:
            self.data["dry_run"] = os.environ.get("DRY_RUN").strip().lower() in ("true", "1", "yes")
    
    @staticmethod
    def default_config() -> Dict[str, Any]:
        """Default configuration"""
        return {
            "max_open_trades": 30,
            "stake_currency": "USDT",
            "dry_run": False,
            "dry_run_wallet": 0.0,
            "trading_mode": "futures",
            
            "exchange": {
                "name": "binance",
                "key": "",
                "secret": "",
                "pair_whitelist": ["BTC/USDT", "ETH/USDT", "ADA/USDT"],
                "pair_blacklist": [],
                "ccxt_config": {},
                "ccxt_async_config": {}
            },
            
            "timeframe": "1h",
            "startup_candle_count": 30,
            "stake_amount": 25,
            "min_stake_amount": 5,
            
            "minimal_roi": {"0": 0.012},
            "stoploss": -1.0,
            "trailing_stop": False,
            "trailing_stop_positive": 0.005,
            "trailing_only_offset_is_reached": False,
            
            "telegram": {
                "enabled": True,
                "token": "",
                "chat_id": "",
                "keyboard": True,
                "notification_settings": {
                    "buy": True,
                    "sell": True,
                    "stoploss": True
                }
            },
            
            "api_server": {
                "enabled": True,
                "listen_ip_address": "127.0.0.1",
                "listen_port": 8080,
                "username": "freqtrader",
                "password": "freqtrader",
                "jwt_secret_key": "secret"
            },
            
            "db_url": "sqlite:///trades.sqlite",
            "verbosity": "info",
            "logfile": "freqtrade.log",
            
            "enable_protections": True,
            "stop_duration_candles": 1,
            "stop_duration": 3,
            
            "strategy": "ScalpingStrategy",
            "strategy_path": "./strategies",
            
            "hyperopt": {
                "enabled": False,
                "loss": "SharpeHyperOptLoss",
                "epochs": 100,
                "spaces": ["buy", "sell", "roi", "stoploss"],
                "random_state": 42
            },
            
            "freqai": {
                "enabled": False,
                "model": "LightGBMClassifier",
                "retrain_period": 24
            },
            
            "backtest": {
                "timerange": None,
                "stake_amount": "unlimited",
                "cache": "day",
                "enable_protections": True
            }
        }
    
    def get(self, key: str, default=None) -> Any:
        """Get config value"""
        keys = key.split('.')
        value = self.data
        for k in keys:
            if isinstance(value, dict):
                value = value.get(k, default)
            else:
                return default
        return value
    
    def set(self, key: str, value: Any) -> None:
        """Set config value"""
        keys = key.split('.')
        config = self.data
        for k in keys[:-1]:
            if k not in config:
                config[k] = {}
            config = config[k]
        config[keys[-1]] = value
    
    def save(self, filename: str) -> None:
        """Save config to file"""
        with open(filename, 'w') as f:
            json.dump(self.data, f, indent=2)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict"""
        return self.data.copy()
