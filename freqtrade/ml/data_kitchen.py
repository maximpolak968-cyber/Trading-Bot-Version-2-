"""
FreqAI Data Kitchen.
Prepares features and targets for machine learning models.
"""
import logging
from typing import Dict, Any, List, Tuple
import pandas as pd
import numpy as np

logger = logging.getLogger('freqtrade')

class FreqaiDataKitchen:
    """
    Data preparation pipeline for FreqAI.
    Handles feature engineering, normalization, and label generation.
    """
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.freqai_config = config.get('freqai', {})
        self.label_period = self.freqai_config.get('label_period_candles', 5)
        self.feature_windows = self.freqai_config.get('feature_parameters', {}).get('include_timeframes', ['5m', '15m'])

    def populate_features(self, dataframe: pd.DataFrame) -> pd.DataFrame:
        """
        Generate machine learning features from base OHLCV data.
        """
        logger.info("FreqaiDataKitchen: Populating features...")
        df = dataframe.copy()
        
        # 1. Base price features
        df['return_1'] = df['close'].pct_change(1)
        df['return_5'] = df['close'].pct_change(5)
        
        # 2. Volatility features
        df['volatility_10'] = df['return_1'].rolling(window=10).std()
        
        # 3. Volume features
        df['volume_change'] = df['volume'].pct_change(1)
        
        # 4. Moving Average Distances
        df['sma_10'] = df['close'].rolling(10).mean()
        df['sma_50'] = df['close'].rolling(50).mean()
        df['dist_sma_10'] = (df['close'] - df['sma_10']) / df['sma_10']
        
        # Clean up NaNs created by rolling windows
        df.dropna(inplace=True)
        
        return df

    def create_labels(self, dataframe: pd.DataFrame) -> Tuple[pd.DataFrame, pd.Series]:
        """
        Create target labels (y) for supervised learning.
        For example, predict if the price will go up by X% in the next N candles.
        """
        df = dataframe.copy()
        
        # Label: percentage change after N candles
        # Shift negative means looking into the future
        future_close = df['close'].shift(-self.label_period)
        df['label'] = (future_close - df['close']) / df['close']
        
        # Drop rows where we can't calculate the label (end of dataset)
        df.dropna(subset=['label'], inplace=True)
        
        labels = df.pop('label')
        return df, labels

    def normalize_features(self, dataframe: pd.DataFrame) -> pd.DataFrame:
        """
        Normalize/scale features (e.g. Z-score normalization).
        """
        # In a real environment, use sklearn StandardScaler or similar
        # and fit only on training data, transform on test.
        # This is a simplified mock.
        df = dataframe.copy()
        
        feature_cols = [c for c in df.columns if c not in ['date', 'open', 'high', 'low', 'close', 'volume']]
        
        for col in feature_cols:
            mean = df[col].mean()
            std = df[col].std()
            if std != 0:
                df[col] = (df[col] - mean) / std
                
        return df
        
    def prepare_data(self, dataframe: pd.DataFrame) -> Tuple[pd.DataFrame, pd.Series]:
        """Full pipeline: features -> labels -> normalize."""
        df_features = self.populate_features(dataframe)
        df_labeled, labels = self.create_labels(df_features)
        df_normalized = self.normalize_features(df_labeled)
        return df_normalized, labels
