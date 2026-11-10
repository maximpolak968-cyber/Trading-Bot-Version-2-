class Wallet:
    def __init__(self):
        self.balances = {}

    def update_balance(self, currency: str, amount: float):
        self.balances[currency] = amount
