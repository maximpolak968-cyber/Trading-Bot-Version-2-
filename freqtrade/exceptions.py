class FreqtradeException(Exception):
    """Base exception"""
    pass

class OperationalException(FreqtradeException):
    """Requires manual intervention"""
    pass

class ConfigurationError(OperationalException):
    """Configuration error"""
    pass

class DependencyException(FreqtradeException):
    """Dependency not met"""
    pass

class ExchangeError(DependencyException):
    """Exchange error"""
    pass

class TemporaryError(ExchangeError):
    """Temporary network error"""
    pass

class DDosProtection(TemporaryError):
    """DDOS protection triggered"""
    pass

class InvalidOrderException(ExchangeError):
    """Invalid order"""
    pass

class InsufficientFundsError(InvalidOrderException):
    """Insufficient funds"""
    pass

class RetryableOrderError(InvalidOrderException):
    """Retryable order error"""
    pass

class StrategyError(FreqtradeException):
    """Strategy error"""
    pass

class IndicatorError(StrategyError):
    """Indicator error"""
    pass

class BacktestException(FreqtradeException):
    """Backtest error"""
    pass

class HyperoptException(FreqtradeException):
    """Hyperopt error"""
    pass
