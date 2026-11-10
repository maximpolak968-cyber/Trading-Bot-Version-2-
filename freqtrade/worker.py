import time
from freqtrade.bot.freqtradebot import FreqtradeBot

class Worker:
    def __init__(self):
        self.bot = FreqtradeBot()

    def run(self):
        print("Worker initialized.")
        self.bot.start()
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("Stopping...")
