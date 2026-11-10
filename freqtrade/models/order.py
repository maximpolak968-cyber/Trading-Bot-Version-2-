from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional
from freqtrade.core.enums import OrderType, OrderSide, OrderStatus

@dataclass
class Order:
    """Order model"""
    id: Optional[int] = None
    trade_id: Optional[int] = None
    pair: str = ""
    order_type: OrderType = OrderType.LIMIT
    side: OrderSide = OrderSide.BUY
    price: float = 0.0
    amount: float = 0.0
    filled: float = 0.0
    remaining: float = 0.0
    status: OrderStatus = OrderStatus.OPEN
    exchange_order_id: Optional[str] = None
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)
    cost: float = 0.0
    
    def cost_total(self) -> float:
        """Get total cost"""
        return self.price * self.filled
