"""
Machine Learning module initialization.
Provides FreqAI components for predictive modeling.
"""
from freqtrade.ml.freqai_interface import IFreqaiModel
from freqtrade.ml.data_kitchen import FreqaiDataKitchen
from freqtrade.ml.tensorboard_logger import TensorboardLogger

__all__ = ['IFreqaiModel', 'FreqaiDataKitchen', 'TensorboardLogger']
