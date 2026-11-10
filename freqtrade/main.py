"""
Main entry point for Freqtrade bot.
Handles initialization and execution of the Worker process.
"""
import sys
import time
import logging
from typing import Any
from freqtrade.core.config import Config
from freqtrade.core.logging import setup_logging
from freqtrade.bot.freqtradebot import FreqtradeBot

logger = logging.getLogger('freqtrade')

class Worker:
    """
    Freqtrade worker class.
    Responsible for the main bot loop and graceful shutdown.
    """
    def __init__(self, args: Any = None) -> None:
        """Init worker"""
        setup_logging()
        logger.info("Starting Freqtrade Worker...")
        
        self.config = Config()
        self.bot = FreqtradeBot(config=self.config)
        self._running = False

    def run(self) -> None:
        """Main run loop"""
        self._running = True
        try:
            self.bot.start()
            while self._running:
                try:
                    self.bot.process()
                except Exception as e:
                    logger.error(f"Error in bot cycle: {e}", exc_info=True)
                time.sleep(5)
        except KeyboardInterrupt:
            logger.info("KeyboardInterrupt received. Stopping...")
            self.exit()
        except Exception as e:
            logger.error(f"Fatal worker exception occurred: {e}", exc_info=True)
            self.exit()

    def exit(self) -> None:
        """Graceful exit"""
        self._running = False
        logger.info("Stopping bot...")
        if hasattr(self, 'bot'):
            self.bot.stop() # Assuming bot has a stop method
        logger.info("Worker stopped.")

def main(args: Any = None) -> int:
    """Main entry point"""
    try:
        worker = Worker(args)
        worker.run()
        return 0
    except Exception as e:
        print(f"Fatal error: {e}")
        return 1

if __name__ == '__main__':
    sys.exit(main())
