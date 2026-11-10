"""
__main__.py for Freqtrade.
Allows running the bot via `python -m freqtrade`.
"""
import sys
from freqtrade.main import main

if __name__ == '__main__':
    sys.exit(main())
