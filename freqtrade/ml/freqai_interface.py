"""
FreqAI Interface.
Base class for implementing machine learning models (e.g. LightGBM, XGBoost).
"""
import logging
from abc import ABC, abstractmethod
from typing import Dict, Any, Tuple
import pandas as pd
import numpy as np

from freqtrade.ml.data_kitchen import FreqaiDataKitchen

logger = logging.getLogger('freqtrade')

class IFreqaiModel(ABC):
    """
    Base FreqAI Model Interface.
    """
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.data_kitchen = FreqaiDataKitchen(config)
        self.model: Any = None
        self.is_trained = False

    @abstractmethod
    def train(self, dataframe: pd.DataFrame) -> None:
        """
        Train the machine learning model on historical data.
        """
        pass

    @abstractmethod
    def predict(self, dataframe: pd.DataFrame) -> pd.Series:
        """
        Generate predictions for the given data.
        """
        pass

    def get_features(self, dataframe: pd.DataFrame) -> pd.DataFrame:
        """Helper to get processed features via data kitchen."""
        return self.data_kitchen.populate_features(dataframe)


class LightGBMFreqaiModel(IFreqaiModel):
    """
    Mock implementation of a LightGBM model for Freqtrade.
    """
    def train(self, dataframe: pd.DataFrame) -> None:
        logger.info("Training LightGBM model...")
        
        # 1. Prepare data
        X, y = self.data_kitchen.prepare_data(dataframe)
        
        # 2. Mock Training
        # In reality: import lightgbm as lgb; self.model = lgb.LGBMRegressor(); self.model.fit(X, y)
        self.model = "MockLGBMModel"
        
        logger.info(f"Model trained on {len(X)} samples.")
        self.is_trained = True

    def predict(self, dataframe: pd.DataFrame) -> pd.Series:
        if not self.is_trained:
            logger.error("Attempting to predict before training!")
            return pd.Series(np.zeros(len(dataframe)), index=dataframe.index)
            
        # 1. Prepare features
        X = self.data_kitchen.populate_features(dataframe)
        X = self.data_kitchen.normalize_features(X)
        
        # 2. Mock Prediction
        # In reality: return pd.Series(self.model.predict(X), index=X.index)
        logger.debug(f"Predicting for {len(X)} samples using {self.model}")
        
        # Generate dummy predictions centered around 0 (mocking percentage change)
        dummy_preds = np.random.normal(loc=0.0, scale=0.02, size=len(X))
        
        return pd.Series(dummy_preds, index=X.index)


class XGBoostFreqaiModel(IFreqaiModel):
    """
    Mock implementation of an XGBoost model.
    """
    def train(self, dataframe: pd.DataFrame) -> None:
        logger.info("Training XGBoost model...")
        X, y = self.data_kitchen.prepare_data(dataframe)
        self.model = "MockXGBoostModel"
        self.is_trained = True
        logger.info("XGBoost training complete.")

    def predict(self, dataframe: pd.DataFrame) -> pd.Series:
         if not self.is_trained:
             return pd.Series(np.zeros(len(dataframe)), index=dataframe.index)
             
         X = self.data_kitchen.populate_features(dataframe)
         dummy_preds = np.random.normal(loc=0.001, scale=0.015, size=len(X))
         return pd.Series(dummy_preds, index=X.index)
