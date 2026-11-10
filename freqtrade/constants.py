DOCS_LINK = "https://www.freqtrade.io/en/stable"
DEFAULT_CONFIG = "config.json"
DEFAULT_DB_PROD_URL = "sqlite:///tradesv3.sqlite"
DEFAULT_DB_DRYRUN_URL = "sqlite:///tradesv3.dryrun.sqlite"
UNLIMITED_STAKE_AMOUNT = "unlimited"
DRY_RUN_WALLET = 1000.0
PROCESS_THROTTLE_SECS = 5
RETRY_TIMEOUT = 30
HYPEROPT_EPOCH = 100

HYPEROPT_LOSS_BUILTIN = [
    "ShortTradeDurHyperOptLoss",
    "OnlyProfitHyperOptLoss",
    "SharpeHyperOptLoss",
    "SharpeHyperOptLossDaily",
    "SortinoHyperOptLoss",
    "CalmarHyperOptLoss",
    "MaxDrawDownHyperOptLoss",
    "ProfitDrawDownHyperOptLoss",
    "MultiMetricHyperOptLoss",
]

AVAILABLE_PAIRLISTS = [
    "StaticPairList",
    "VolumePairList",
    "PercentChangePairList",
    "PerformanceFilter",
    "PriceFilter",
    "SpreadFilter",
    "VolatilityFilter",
    "ShuffleFilter",
    "RangeStabilityFilter",
    "PrecisionFilter",
]

SUPPORTED_EXCHANGES = [
    "binance", "kraken", "okx", "bybit", "gate", "kucoin",
    "bingx", "bitget", "htx", "hyperliquid", "myokx"
]

TELEGRAM_SETTING_OPTIONS = ["on", "off", "silent"]
WEBHOOK_FORMAT_OPTIONS = ["form", "json", "raw"]
EXPORT_OPTIONS = ["none", "trades", "signals"]

DL_DATA_TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"]
BACKTEST_BREAKDOWNS = ["day", "week", "month", "year", "weekday"]
BACKTEST_CACHE_AGE = ["none", "day", "week", "month"]

DATETIME_PRINT_FORMAT = "%Y-%m-%d %H:%M:%S"
MATH_CLOSE_PREC = 1e-14

DECIMAL_PER_COIN_FALLBACK = 3
DECIMALS_PER_COIN = {
    "BTC": 8,
    "ETH": 5,
}

DUST_PER_COIN = {"BTC": 0.0001, "ETH": 0.01}

SUPPORTED_FIAT = [
    "AUD", "BRL", "CAD", "CHF", "CLP", "CNY", "CZK", "DKK",
    "EUR", "GBP", "HKD", "HUF", "IDR", "ILS", "INR", "JPY",
    "KRW", "MXN", "MYR", "NOK", "NZD", "PHP", "PKR", "PLN",
    "RUB", "UAH", "SEK", "SGD", "THB", "TRY", "TWD", "ZAR", "USD",
    "BTC", "ETH", "XRP", "LTC", "BCH", "BNB", ""
]
