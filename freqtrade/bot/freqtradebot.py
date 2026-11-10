import logging
import time
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional, Tuple
import pandas as pd

from freqtrade.core.config import Config
from freqtrade.database.database import Database
from freqtrade.exchange.exchange import ExchangeManager
from freqtrade.strategy.interface import IStrategy
from freqtrade.strategy.sample_strategy import SampleStrategy
from freqtrade.strategy.scalping_strategy import ScalpingStrategy
from freqtrade.rpc.rpc_manager import RPCManager
from freqtrade.models.trade import Trade
from freqtrade.core.enums import ExitReason, TradeStatus, OrderType, OrderSide
from freqtrade.core.btc_guard import BTCGuard
from freqtrade.strategy.indicators import (
    calculate_wavetrend, detect_reversal_patterns, detect_bearish_reversal_patterns,
    detect_market_structure, analyze_multi_timeframe, is_hedge_entry_candidate,
    is_knife_drop, is_pump_exhaustion, check_candle_rejection, check_rsi_condition,
    find_strongest_dca_level
)
from freqtrade.exchange.market_scanner import Market24hScanner, CandleVolatilityScanner
from freqtrade.bot.pairlist import PairListManager

logger = logging.getLogger('freqtrade')

class FreqtradeBot:
    """
    Main Freqtrade Bot class.
    Handles the core trading loop, evaluating strategies, and managing trades.
    """
    def __init__(self, config: Optional[Config] = None, strategy: Optional[IStrategy] = None):
        self.config = config if config else Config()
        self.config_dict = self.config.to_dict()
        self.db = Database(self.config_dict.get('db_url', 'sqlite:///trades.sqlite'))
        self.exchange = ExchangeManager(self.config_dict)
        self.rpc = RPCManager(self)
        self.btc_guard = BTCGuard(self.exchange, timeframe='1h')
        self.market_scanner = Market24hScanner(self.exchange, min_quote_volume=1_000_000.0)
        self.volatility_scanner = CandleVolatilityScanner(
            self.exchange,
            timeframe=self.config_dict.get('volatility_scan_timeframe', '1h'),
            lookback=int(self.config_dict.get('volatility_scan_lookback', 40)),
            min_candle_move_pct=float(self.config_dict.get('volatility_scan_min_candle_pct', 20.0)),
            cache_ttl=float(self.config_dict.get('volatility_scan_ttl_seconds', 1200.0))
        )
        self.pairlist_manager = PairListManager(self.exchange, self.config_dict)
        self._cached_quality_pairs: List[str] = []
        self._last_pairlist_refresh: float = 0.0
        self.pairlist_refresh_interval_seconds: float = float(self.config_dict.get('pairlist_refresh_interval_seconds', 900.0))
        self._mover_info: Dict[str, dict] = {}
        
        # Load Strategy
        if strategy:
            self.strategy = strategy
        elif self.config_dict.get('strategy') == 'ScalpingStrategy' or self.config_dict.get('timeframe') in ['1m', '1h', '5m', '15m']:
            logger.info(f"Loading ScalpingStrategy for {self.config_dict.get('timeframe', '1h')} scalping")
            self.strategy = ScalpingStrategy(self.config_dict)
        else:
            logger.info("No strategy provided, falling back to SampleStrategy")
            self.strategy = SampleStrategy(self.config_dict)
            
        self._running = False
        self.timeframe = self.config_dict.get('timeframe', '1h')
        self.max_open_trades = self.config_dict.get('max_open_trades', 5)
        self.stake_percent = float(self.config_dict.get('stake_percent', 0.01))
        self.stake_amount = float(self.config_dict.get('stake_amount', 100.0))
        self.cooldown_pairs: Dict[str, datetime] = {}
        self._last_entry_scan_time: float = 0.0
        self.entry_scan_interval_seconds: float = float(self.config_dict.get('entry_scan_interval_seconds', 60.0))

    def get_stake_amount(self) -> float:
        """
        Calculate stake amount dynamically: 1% of current total deposit.
        Falls back to configured stake_amount or dry_run_wallet if balance unavailable.
        """
        stake_currency = self.config_dict.get('stake_currency', 'USDT')
        total_balance = 0.0
        try:
            balance = self.exchange.get_balance()
            if isinstance(balance, dict):
                if stake_currency in balance and isinstance(balance[stake_currency], dict):
                    total_balance = float(balance[stake_currency].get('total', balance[stake_currency].get('free', 0.0)))
                elif 'total' in balance and isinstance(balance['total'], dict) and stake_currency in balance['total']:
                    total_balance = float(balance['total'][stake_currency])
        except Exception as e:
            logger.debug(f"Could not read balance for dynamic stake calculation: {e}")

        # If balance could not be retrieved or is 0, use dry_run_wallet or base stake_amount
        if total_balance <= 0:
            total_balance = float(self.config_dict.get('dry_run_wallet', self.stake_amount * 100.0))

        # 1% of total deposit
        calculated_stake = round(total_balance * self.stake_percent, 4)
        min_stake = float(self.config_dict.get('min_stake_amount', 50.0))
        return max(calculated_stake, min_stake)

    def _get_account_stats_snapshot(self) -> Dict[str, Any]:
        """
        Helper to return current deposit balance and overall trade statistics.
        """
        deposit_balance = 5000.0
        try:
            margin = self.get_margin_status()
            deposit_balance = round(float(margin.get('total', 5000.0)), 2)
        except Exception:
            pass

        total_trades = 0
        total_net_pnl = 0.0
        try:
            analytics = self.db.get_pnl_analytics()
            total_trades = int(analytics.get('total_trades', 0))
            total_net_pnl = round(float(analytics.get('total_net', 0.0)), 2)
        except Exception:
            pass

        return {
            'deposit_balance': deposit_balance,
            'total_trades': total_trades,
            'total_net_pnl': total_net_pnl
        }

    def get_margin_status(self) -> Dict[str, float]:
        """
        Calculate total account balance and margin utilization across all active positions.
        Guarantees that at least 75-80% of margin remains free as a safety buffer.
        """
        stake_currency = self.config_dict.get('stake_currency', 'USDT')
        total_balance = 0.0
        free_balance = 0.0
        try:
            balance = self.exchange.get_balance()
            if isinstance(balance, dict):
                if stake_currency in balance and isinstance(balance[stake_currency], dict):
                    total_balance = float(balance[stake_currency].get('total', 0.0))
                    free_balance = float(balance[stake_currency].get('free', 0.0))
                elif 'total' in balance and isinstance(balance['total'], dict) and stake_currency in balance['total']:
                    total_balance = float(balance['total'].get(stake_currency, 0.0))
                    free_balance = float(balance.get('free', {}).get(stake_currency, total_balance))
        except Exception as e:
            logger.debug(f"Could not read balance for margin status: {e}")

        if total_balance <= 0:
            total_balance = float(self.config_dict.get('dry_run_wallet', 5000.0))
            free_balance = total_balance

        open_trades = self.db.get_open_trades()
        used_margin = sum(t.stake_amount for t in open_trades)
        used_pct = round((used_margin / total_balance) * 100.0, 2) if total_balance > 0 else 0.0
        free_pct = round(max(0.0, 100.0 - used_pct), 2)

        return {
            'total': total_balance,
            'free': free_balance,
            'used_margin': used_margin,
            'used_pct': used_pct,
            'free_pct': free_pct
        }

    def get_quality_pairlist(self) -> List[str]:
        """
        Пары, прошедшие фильтры объёма/волатильности/24ч изменения (config['pairlists']).
        Кэшируется на pairlist_refresh_interval_seconds (по умолчанию 15 минут) —
        каждый прогон фильтров дёргает тикер/свечи по каждой паре биржи, это не дёшево.
        """
        now = time.time()
        if self._cached_quality_pairs and (now - self._last_pairlist_refresh) < self.pairlist_refresh_interval_seconds:
            return self._cached_quality_pairs

        pairs = self.pairlist_manager.refresh_pairlist()
        if pairs:
            self._cached_quality_pairs = pairs
            self._last_pairlist_refresh = now
            logger.info(f"📋 Pairlist refreshed: {len(pairs)} pairs прошли фильтры объёма/волатильности/движения за 24ч.")
        return self._cached_quality_pairs

    def get_active_trading_pairs(self) -> List[str]:
        """
        Комбинированный пул торговых пар:
        1. Высоковолатильные монеты с резкими импульсными свечами (CandleVolatilityScanner).
        2. Пары из базового белого списка (pair_whitelist: BTC, ETH, SOL, BNB, XRP, etc.).
        3. Топ качественные пары по объему и ликвидности (PairListManager).
        """
        pairs: List[str] = []

        # 1. Добавляем высоковолатильные монеты
        try:
            scan_universe = self.exchange.get_tradeable_pairs()
            volatile_candidates = self.volatility_scanner.scan(scan_universe)
            for v in volatile_candidates:
                pair = v['pair']
                self._mover_info[pair] = {
                    'category': 'VOLATILE_CANDLE',
                    'change_24h_pct': v['max_candle_move_pct'],
                    'funding_rate_pct': 0.0,
                }
                if pair not in pairs:
                    pairs.append(pair)
        except Exception as e:
            logger.debug(f"Could not run volatility candle scan: {e}")

        # 2. Добавляем пары из pair_whitelist
        whitelist = self.config_dict.get('exchange', {}).get('pair_whitelist', [])
        for pair in whitelist:
            if pair not in pairs:
                pairs.append(pair)

        # 3. Добавляем пары из фильтра качества/объемов (get_quality_pairlist)
        try:
            quality_pairs = self.get_quality_pairlist()
            for pair in quality_pairs:
                if pair not in pairs:
                    pairs.append(pair)
        except Exception as e:
            logger.debug(f"Could not fetch quality pairs: {e}")

        max_active_pairs = int(self.config_dict.get('max_active_pairs', 40))
        if len(pairs) > max_active_pairs:
            pairs = pairs[:max_active_pairs]

        return pairs

    def start(self) -> None:
        """Start the bot."""
        logger.info("Starting FreqtradeBot...")
        self._running = True
        self.rpc.start()
        self.db.init_db()

        # Fast leverage enforcement on startup for active whitelist and open positions
        configured_leverage = int(self.config_dict.get('leverage', 25))
        margin_mode = self.config_dict.get('margin_mode', 'cross')
        priority_pairs = set(self.config_dict.get('exchange', {}).get('pair_whitelist', []))
        for t in self.db.get_open_trades():
            priority_pairs.add(t.pair)
        for pair in priority_pairs:
            try:
                self.exchange.set_margin_mode(pair, margin_mode)
                self.exchange.set_leverage(pair, configured_leverage)
            except Exception:
                pass
        logger.info(f"✅ Fast startup: Leverage enforced at {configured_leverage}x, margin mode: {margin_mode} for {len(priority_pairs)} priority pairs")

        logger.info(f"Bot started. Trading mode: {self.config_dict.get('trading_mode')}, Dry Run: {self.config_dict.get('dry_run')}")
        self.reconcile_open_positions_on_startup()

    def reconcile_open_positions_on_startup(self) -> None:
        """
        Reconcile and restore memory of all active trades on bot startup.
        Checks existing positions, their target TP, SL, support/resistance levels, and current PnL.
        """
        self._sync_positions_with_exchange()
        open_trades = self.db.get_open_trades()
        if not open_trades:
            logger.info("🧠 Memory Check on Startup: No active open trades in database. Ready for new opportunities.")
            return

        logger.info(f"🧠 Memory Check on Startup: Restoring context for {len(open_trades)} active positions...")
        summary_lines = [f"🧠 <b>BOT RECONNECTED: RESTORED {len(open_trades)} ACTIVE POSITIONS</b>"]

        for trade in open_trades:
            try:
                ticker = self.exchange.get_ticker(trade.pair)
                current_rate = float(ticker.get('last', trade.open_rate))
                pnl_pct = trade.calc_profit(current_rate)
                pnl_abs = trade.calc_profit_abs(current_rate)

                tp_info = f"{trade.target_tp_rate} (+{((trade.target_tp_rate - trade.open_rate)/trade.open_rate)*100:.1f}%)" if trade.target_tp_rate else "Dynamic ROI"
                sl_info = f"{trade.stoploss_rate} ({((trade.stoploss_rate - trade.open_rate)/trade.open_rate)*100:.1f}%)" if trade.stoploss_rate else "Strategy SL"
                plan = trade.plan_notes or "Regular Entry"

                logger.info(
                    f"📌 Restored Trade #{trade.id} [{trade.pair}]: Entry={trade.open_rate}, Current={current_rate} "
                    f"(PnL: {pnl_pct:+.2f}%, {pnl_abs:+.2f} USDT), Target TP={tp_info}, SL={sl_info}, DCA count={trade.dca_count}. Plan: {plan}"
                )

                summary_lines.append(
                    f"\n• <b>{trade.pair}</b> ({'SHORT' if trade.is_short else 'LONG'})\n"
                    f"  Entry: <code>{trade.open_rate}</code> | Now: <code>{current_rate}</code>\n"
                    f"  PnL: <b>{pnl_pct:+.2f}%</b> (<code>{pnl_abs:+.2f} USDT</code>)\n"
                    f"  Target TP: <code>{tp_info}</code>\n"
                    f"  Stop-Loss: <code>{sl_info}</code>\n"
                    f"  DCA Step: <code>{trade.dca_count}/2</code>\n"
                    f"  Plan: <i>{plan}</i>"
                )
            except Exception as e:
                logger.error(f"Failed to reconcile trade #{trade.id} for {trade.pair}: {e}")

        # Send Telegram notification with all active trades and plans
        self.rpc.send_msg({
            'type': 'status',
            'status': "\n".join(summary_lines)
        })

        
    def stop(self) -> None:
        """Stop the bot."""
        logger.info("Stopping FreqtradeBot...")
        self._running = False
        self._cancel_all_orders()
        self.rpc.cleanup()
        logger.info("Bot stopped.")

    def process(self) -> None:
        """
        Main bot processing loop.
        Executed iteratively by the worker.
        """
        if not self._running:
            return
            
        try:
            self.strategy.bot_loop_start()
            
            # 0. Sync open positions with Binance Futures to catch manual exits with exact PnL
            self._sync_positions_with_exchange()

            # 1. Update active trades
            active_trades = self.db.get_open_trades()
            for trade in active_trades:
                self._update_trade(trade)
                
            # 2. Check for exits on active trades
            for trade in active_trades:
                current_price = self.exchange.get_ticker(trade.pair).get('last', trade.open_rate)
                
                if self._check_stoploss(trade, current_price):
                    continue
                if self._check_roi(trade, current_price):
                    continue

                # Управляемая нога хеджа (сиблинг уже закрыт) — своя логика вместо обычного сигнального выхода
                if trade.campaign_banked_profit is not None:
                    if self._check_hedge_exit(trade, current_price):
                        continue
                else:
                    self._process_pair_for_exit(trade, current_price)

            # 2.5 Smart DCA Management (Reversals & Levels with Margin Guard)
            for trade in self.db.get_open_trades():
                current_price = self.exchange.get_ticker(trade.pair).get('last', trade.open_rate)
                self._check_trade_dca(trade, current_price)

            # Не сканировать рынок на новые входы чаще, чем раз в entry_scan_interval_seconds —
            # часовая стратегия не даёт новых сигналов каждые 5 секунд, а вот лимиты Binance так расходуются быстро.
            now_ts = time.time()
            if now_ts - self._last_entry_scan_time < self.entry_scan_interval_seconds:
                return
            self._last_entry_scan_time = now_ts

            # 3. Process new entries if we have free slots
            active_trades_count = len(self.db.get_open_trades())
            if active_trades_count < self.max_open_trades:
                # Check Margin Utilization before new entries (Keep safe buffer)
                margin_status = self.get_margin_status()
                if margin_status.get('used_pct', 0.0) >= 40.0:
                    logger.info(f"🛡️ Margin Guard: {margin_status.get('used_pct'):.1f}% margin used (limit 40%). Preserving buffer for 20 positions and Smart DCA.")
                    return

                active_pairs = self.get_active_trading_pairs()
                logger.info(f"🔍 Scanning {len(active_pairs)} pairs (Top Gainers/Losers + Whitelist) on {self.timeframe} scalp mode (Open: {active_trades_count}/{self.max_open_trades})...")
                for pair in active_pairs:
                    if active_trades_count >= self.max_open_trades:
                        break
                    
                    # Avoid entering same pair twice
                    if any(t.pair == pair for t in self.db.get_open_trades()):
                        continue
                        
                    if self._process_pair(pair):
                        active_trades_count += 1
                        
                # Хедж-кампании: ищем монеты в середине диапазона (LONG+SHORT)
                if active_trades_count + 1 < self.max_open_trades:
                    self.scan_for_hedge_candidates()
                        
        except Exception as e:
            logger.error(f"Error in main process loop: {e}", exc_info=True)

    def _process_pair(self, pair: str) -> bool:
        """
        Analyze a pair and execute entry if signals match.
        """
        # Check cooldown to prevent churn
        if pair in self.cooldown_pairs:
            cooldown_period = 20  # 20 minutes cooldown
            elapsed = (datetime.utcnow() - self.cooldown_pairs[pair]).total_seconds() / 60
            if elapsed < cooldown_period:
                return False
            else:
                del self.cooldown_pairs[pair]

        logger.debug(f"Processing pair {pair} for entry...")
        ohlcv = self.exchange.fetch_ohlcv_cached(pair, self.timeframe, limit=100, ttl=60.0)
        if not ohlcv:
            return False
            
        # Create dataframe
        df = pd.DataFrame(ohlcv, columns=['date', 'open', 'high', 'low', 'close', 'volume'])
        df['date'] = pd.to_datetime(df['date'], unit='ms')
        
        # Multi-Timeframe Level Analysis (1D Macro + 4H Institutional Levels + 1H Scalp)
        mtf = analyze_multi_timeframe(pair, self.exchange, df)
        logger.debug(f"📊 MTF Map for {pair}: {mtf['level_map_summary']}")

        # Единственный источник уровней для входа — умный многотаймфреймовый анализ.
        # Прокидываем его результат в датафрейм ДО того, как стратегия примет решение.
        df['smart_support'] = mtf.get('key_4h_support', df['close'].iloc[-1] * 0.97)
        df['smart_resistance'] = mtf.get('key_4h_resistance', df['close'].iloc[-1] * 1.03)

        # 24h Market Mover Context (Gainer/Loser)
        mover = self._mover_info.get(pair)
        mover_tag = ""
        if mover:
            mtf['mover_category'] = mover.get('category')
            mtf['change_24h_pct'] = mover.get('change_24h_pct')
            mtf['funding_rate_pct'] = mover.get('funding_rate_pct')
            mover_tag = f"[{mover['category']} 24h: {mover['change_24h_pct']:+.2f}%, Funding: {mover['funding_rate_pct']:+.4f}%] "
            logger.info(f"⚡ Analyzing 24h Mover {pair}: {mover_tag} | 4H Pos: {mtf['pos_4h_pct']:.1f}%")

        # Run strategy analysis on 1h scalp timeframe
        analyzed_df = self.strategy.analyze(df, pair)
        
        if analyzed_df.empty:
            return False
            
        latest_row = analyzed_df.iloc[-1]
        
        # Check Long Entry (Bounce on Losers or Pullback on Gainers)
        if latest_row.get('enter_long', 0) == 1:
            # Check BTC Guard specifically for Longs to prevent buying into market dump
            btc_safe, btc_reason = self.btc_guard.check_market_health()
            if not btc_safe:
                logger.warning(f"🛡️ BTC Guard Alert: Blocked Long for {mover_tag}{pair} ({btc_reason})")
            # Multi-Timeframe Guard Check (Safe Default is False)
            elif not mtf.get('allow_long', False):
                logger.info(
                    f"⚠️ MTF Guard: Blocked Long for {mover_tag}{pair} on 1H! Reason: {mtf.get('rejection_reason_long', mtf.get('rejection_reason'))} | "
                    f"4H Res: {mtf.get('key_4h_resistance')}, 4H Pos: {mtf.get('pos_4h_pct')}%, 1D Trend: {mtf.get('d1_trend')}"
                )
            else:
                current_rate = latest_row['close']
                sh = mtf.get('support_history')
                sh_log = f" [Touches: {sh['touches']} | Bounces: {sh['bounces']} | Breaks: {sh['breaks']} | Score: {sh['strength_score']}]" if sh else ""
                rec_tp = mtf.get('recommended_tp_long', mtf.get('recommended_tp', current_rate * 1.02))
                logger.info(
                    f"🟢 A+ Long Signal for {mover_tag}{pair} at {current_rate}!\n"
                    f"   • {mtf['level_map_summary']}{sh_log}\n"
                    f"   • Target TP: {rec_tp} | Smart DCA Support"
                )
                return self._enter_trade(pair, current_rate, direction='long', mtf=mtf)
            
        # Check Short Entry (Overbought fade on Gainers or Breakdown on Losers)
        if latest_row.get('enter_short', 0) == 1:
            # Multi-Timeframe Guard Check (Safe Default is False)
            if not mtf.get('allow_short', False):
                logger.info(
                    f"⚠️ MTF Guard: Blocked Short for {mover_tag}{pair} on 1H! Reason: {mtf.get('rejection_reason_short', mtf.get('rejection_reason'))} | "
                    f"4H Sup: {mtf.get('key_4h_support')}, 4H Pos: {mtf.get('pos_4h_pct')}%, 1D Trend: {mtf.get('d1_trend')}"
                )
            else:
                current_rate = latest_row['close']
                rh = mtf.get('resistance_history')
                rh_log = f" [Touches: {rh['touches']} | Bounces: {rh['bounces']} | Breaks: {rh['breaks']} | Score: {rh['strength_score']}]" if rh else ""
                rec_tp = mtf.get('recommended_tp_short', current_rate * 0.98)
                logger.info(
                    f"🔴 A+ Short Signal for {mover_tag}{pair} at {current_rate}!\n"
                    f"   • {mtf['level_map_summary']}{rh_log}\n"
                    f"   • Target TP: {rec_tp} | Smart DCA Resistance"
                )
                return self._enter_trade(pair, current_rate, direction='short', mtf=mtf)
            
        return False

    def _process_pair_for_exit(self, trade: Trade, current_rate: float) -> bool:
        """
        Analyze a pair to see if strategy dictates an exit.
        Protects positions in WAITING_PULLBACK / DCA_ACTIVE from closing in loss.
        """
        # Изоляция стратегий: Хедж-кампании (4H) управляются отдельно и не закрываются скальпинг-сигналами 1H
        if trade.campaign_id:
            return False

        profit_pct = trade.calc_profit(current_rate)

        # 1. Target TP / Pullback Level Check (Price reached or exceeded planned target TP)
        if trade.target_tp_rate and trade.target_tp_rate > 0:
            is_tp_hit = (current_rate >= trade.target_tp_rate) if not trade.is_short else (current_rate <= trade.target_tp_rate)
            if is_tp_hit:
                logger.info(
                    f"🎯 Target TP / Pullback Level Hit for {trade.pair} ({'SHORT' if trade.is_short else 'LONG'})! "
                    f"Rate={current_rate}, Target={trade.target_tp_rate}, Profit={profit_pct:+.2f}%. Executing profit exit!"
                )
                return self._exit_trade(trade, current_rate, profit_pct, ExitReason.ROI)

        # 2. Pullback / DCA Protection Guard:
        # If position is waiting for pullback/recovery, DO NOT close on adverse trend indicators while in drawdown!
        min_pullback_profit = getattr(trade, 'pullback_min_profit_pct', 0.5)
        if getattr(trade, 'trade_state', 'WAITING_PULLBACK') in ['WAITING_PULLBACK', 'DCA_ACTIVE', 'ACTIVE']:
            if profit_pct < min_pullback_profit:
                logger.debug(
                    f"🛡️ Pullback Guard Active for {trade.pair}: Entry={trade.open_rate}, Now={current_rate}, "
                    f"PnL={profit_pct:+.2f}% (Min required: +{min_pullback_profit}%). Waiting for recovery to TP={trade.target_tp_rate}."
                )
                return False

        ohlcv = self.exchange.fetch_ohlcv_cached(trade.pair, self.timeframe, limit=100, ttl=60.0)
        if not ohlcv:
            return False
            
        df = pd.DataFrame(ohlcv, columns=['date', 'open', 'high', 'low', 'close', 'volume'])
        df['date'] = pd.to_datetime(df['date'], unit='ms')
        
        # Pass saved support/resistance or fallback levels to dataframe
        last_close = df['close'].iloc[-1]
        df['smart_support'] = trade.support_level if (trade.support_level and trade.support_level > 0) else (last_close * 0.97)
        df['smart_resistance'] = trade.resistance_level if (trade.resistance_level and trade.resistance_level > 0) else (last_close * 1.03)
        
        analyzed_df = self.strategy.analyze(df, trade.pair)
        
        if analyzed_df.empty:
            return False
            
        latest_row = analyzed_df.iloc[-1]
        
        if not trade.is_short and latest_row.get('exit_long', 0) == 1:
            if profit_pct >= min_pullback_profit:
                return self._exit_trade(trade, current_rate, profit_pct, ExitReason.EXIT_SIGNAL)
            else:
                logger.info(f"🛡️ Exit Long signal ignored for {trade.pair}: profit {profit_pct:+.2f}% is below threshold (+{min_pullback_profit}%). Holding for pullback.")
                return False
            
        if trade.is_short and latest_row.get('exit_short', 0) == 1:
            if profit_pct >= min_pullback_profit:
                return self._exit_trade(trade, current_rate, profit_pct, ExitReason.EXIT_SIGNAL)
            else:
                logger.info(f"🛡️ Exit Short signal ignored for {trade.pair}: profit {profit_pct:+.2f}% is below threshold (+{min_pullback_profit}%). Holding for pullback.")
                return False
            
        return False

    def can_dca(self, trade: Trade, current_price: float) -> Tuple[bool, str, Dict[str, Any]]:
        """
        Decide whether another DCA step is allowed, using REAL exchange data
        (margin, leverage, liquidation distance) instead of approximations.
        Returns (allowed: bool, reason: str, info: dict with current state for logging/telegram).
        """
        max_dca = int(self.config_dict.get('max_dca_orders', 5))
        max_multiplier = float(self.config_dict.get('max_position_multiplier', 6.0))
        min_liq_distance_pct = float(self.config_dict.get('min_liquidation_distance_pct', 15.0))
        max_margin_for_dca_pct = float(self.config_dict.get('max_margin_used_for_dca_pct', 60.0))
        max_pair_margin_pct = float(self.config_dict.get('max_pair_margin_pct', 20.0))

        initial_amount = trade.initial_amount if trade.initial_amount > 0 else trade.amount
        current_multiplier = round(trade.amount / initial_amount, 2) if initial_amount > 0 else 1.0

        info: Dict[str, Any] = {
            'pair': trade.pair,
            'dca_count': trade.dca_count,
            'max_dca_orders': max_dca,
            'initial_amount': initial_amount,
            'current_amount': trade.amount,
            'current_multiplier': current_multiplier,
            'max_multiplier': max_multiplier,
        }

        # 1. Простой счётчик шагов
        if trade.dca_count >= max_dca:
            return False, f"Достигнут лимит шагов усреднения ({trade.dca_count}/{max_dca})", info

        # 2. Лимит на итоговый множитель объёма (защита от геометрического разгона)
        if current_multiplier >= max_multiplier:
            return False, f"Позиция уже в {current_multiplier}x от начальной (лимит {max_multiplier}x)", info

        # 3. Реальная маржа аккаунта с биржи
        margin = self.exchange.get_account_margin_summary()
        info['account_margin'] = margin
        if margin and margin.get('used_pct', 0.0) >= max_margin_for_dca_pct:
            return False, f"Занято {margin.get('used_pct'):.1f}% маржи аккаунта (лимит {max_margin_for_dca_pct}%)", info

        # 4. Portfolio Margin Guard: лимит маржи на ОДНУ монету (не более 15-20% от депозита)
        total_balance = margin.get('total_margin_balance', 0.0) if margin else 0.0
        position_risk = self.exchange.get_position_risk(trade.pair)
        info['position_risk'] = position_risk
        leverage = position_risk.get('leverage', int(self.config_dict.get('leverage', 25))) if position_risk else 25
        
        current_pair_notional = trade.amount * current_price
        current_pair_margin = current_pair_notional / leverage if leverage > 0 else current_pair_notional
        
        next_add_notional = trade.amount * current_price
        next_add_margin = next_add_notional / leverage if leverage > 0 else next_add_notional
        total_pair_margin_after = current_pair_margin + next_add_margin
        
        if total_balance > 0:
            pair_margin_share_pct = (total_pair_margin_after / total_balance) * 100.0
            if pair_margin_share_pct > max_pair_margin_pct:
                return False, f"Portfolio Guard: монета {trade.pair} займет {pair_margin_share_pct:.1f}% маржи депозита (лимит {max_pair_margin_pct}%)", info

        # 5. Хватит ли свободного баланса на следующий шаг усреднения
        available = margin.get('available_balance', 0.0) if margin else 0.0
        if available < next_add_margin:
            return False, f"Не хватает свободной маржи: нужно ~{next_add_margin:.2f} USDT, доступно {available:.2f} USDT", info

        # 6. Расстояние до цены ликвидации — не усредняться, если и так уже близко к ликвидации
        if position_risk and position_risk.get('liquidation_price'):
            liq_price = position_risk['liquidation_price']
            if liq_price > 0:
                distance_pct = abs(current_price - liq_price) / current_price * 100.0
                info['liquidation_distance_pct'] = round(distance_pct, 2)
                if distance_pct < min_liq_distance_pct:
                    return False, f"Слишком близко к ликвидации: {distance_pct:.1f}% (лимит {min_liq_distance_pct}%)", info

        return True, "OK", info

    def _check_trade_dca(self, trade: Trade, current_price: float) -> bool:
        """
        Smart Level & Martingale DCA Manager:
        Averages down ONLY when touching Key Support/Resistance or Reversal Signals:
        1. Max DCA count: up to 5 steps of doubling positions from major levels.
        2. Exact Coin Doubling:
           - Entry: e.g. 25 coins
           - DCA 1: +25 coins (Total becomes 50 coins)
           - DCA 2: +50 coins (Total becomes 100 coins)
           - DCA 3: +100 coins (Total becomes 200 coins)
        3. Drawdown: calculated with leverage (e.g. 25x). Step triggers every -25% position PnL.
        4. Price Action & Level confirmation:
           - Tests key Support/Resistance level
           - Candle analysis (no knife drops, requires rejection wick or bounce)
           - RSI confirmation (oversold/overbought with reversal turn)
        5. Portfolio margin protection: preserves margin across all coins (max 20% on 1 coin).
        """
        try:
            # 1. Check if DCA is enabled in config
            if not self.config_dict.get('dca_enabled', True):
                return False

            # 2. Determine / Verify the STRONGEST institutional 4H/1D Support/Resistance level
            if not trade.next_dca_price or trade.next_dca_price <= 0:
                strongest_info = find_strongest_dca_level(
                    trade.pair, self.exchange, trade.open_rate, trade.is_short, min_dist_pct=1.5
                )
                trade.next_dca_price = strongest_info['price']
                if not trade.is_short:
                    trade.support_level = strongest_info['price']
                else:
                    trade.resistance_level = strongest_info['price']

            # 3. Strict Price Level Check: Price MUST physically reach the strongest key level
            if not trade.is_short:
                # For LONG: current price must drop to or below the strongest Support level
                if current_price > trade.next_dca_price:
                    dist_pct = ((current_price - trade.next_dca_price) / trade.next_dca_price) * 100.0
                    logger.debug(
                        f"⏳ DCA Long for {trade.pair} waiting key support: "
                        f"Current={current_price} > Strongest Support={trade.next_dca_price} "
                        f"(Distance: {dist_pct:+.2f}%)"
                    )
                    return False
            else:
                # For SHORT: current price must rise to or above the strongest Resistance level
                if current_price < trade.next_dca_price:
                    dist_pct = ((current_price - trade.next_dca_price) / trade.next_dca_price) * 100.0
                    logger.debug(
                        f"⏳ DCA Short for {trade.pair} waiting key resistance: "
                        f"Current={current_price} < Strongest Resistance={trade.next_dca_price} "
                        f"(Distance: {dist_pct:+.2f}%)"
                    )
                    return False

            # 4. Exchange & Risk Protection Check (Max DCA orders, max allocation, liquidation guard)
            allowed, block_reason, dca_info = self.can_dca(trade, current_price)
            if not allowed:
                logger.info(f"🛡️ DCA blocked for {trade.pair}: {block_reason} | State: {dca_info}")
                return False

            # 5. Candlestick Reversal Confirmation at the Key Level (No falling knife / rocket pump)
            ohlcv = self.exchange.fetch_ohlcv_cached(trade.pair, self.timeframe, limit=50, ttl=60.0)
            if not ohlcv or len(ohlcv) < 30:
                return False

            df = pd.DataFrame(ohlcv, columns=['date', 'open', 'high', 'low', 'close', 'volume'])
            wt1, wt2 = calculate_wavetrend(df)

            target_level = trade.next_dca_price
            candle_rej = check_candle_rejection(df, target_level, is_short=trade.is_short)
            rsi_info = check_rsi_condition(df, is_short=trade.is_short)

            wave_reversal_long = bool((wt1.iloc[-1] > wt2.iloc[-1]) and (wt2.iloc[-1] <= -25))
            wave_reversal_short = bool((wt1.iloc[-1] < wt2.iloc[-1]) and (wt2.iloc[-1] >= 25))

            if not trade.is_short:
                # Защита от падающего ножа
                if is_knife_drop(df, -1):
                    logger.debug(f"🔪 DCA Long for {trade.pair} postponed: falling knife at level {target_level}!")
                    return False

                # Условия для усреднения Long: подтверждение отбоя от сильного уровня свечой или Wave/RSI
                candle_ok = candle_rej.get('confirmed', False) or (df['close'].iloc[-1] > df['open'].iloc[-1])
                tech_ok = wave_reversal_long or rsi_info.get('confirmed', False)

                if not (candle_ok or tech_ok):
                    logger.debug(
                        f"DCA Long {trade.pair} at key support {target_level} waiting reversal candle/RSI "
                        f"(Candle: {candle_rej.get('reason')}, RSI: {rsi_info.get('reason')})"
                    )
                    return False
                signal_desc = f"Strong Support {target_level} ({candle_rej.get('reason')}, RSI {rsi_info.get('rsi')})"
            else:
                # Защита от резкого пампа
                if is_pump_exhaustion(df, -1):
                    logger.debug(f"🚀 DCA Short for {trade.pair} postponed: pump rocket at level {target_level}!")
                    return False

                candle_ok = candle_rej.get('confirmed', False) or (df['close'].iloc[-1] < df['open'].iloc[-1])
                tech_ok = wave_reversal_short or rsi_info.get('confirmed', False)

                if not (candle_ok or tech_ok):
                    logger.debug(
                        f"DCA Short {trade.pair} at key resistance {target_level} waiting reversal candle/RSI "
                        f"(Candle: {candle_rej.get('reason')}, RSI: {rsi_info.get('reason')})"
                    )
                    return False
                signal_desc = f"Strong Resistance {target_level} ({candle_rej.get('reason')}, RSI {rsi_info.get('rsi')})"

            logger.info(
                f"🎯 Key Level Reversal confirmed for DCA on {trade.pair} ({signal_desc})! "
                f"Current coins: {trade.amount}. Executing Smart DCA #{trade.dca_count + 1}/{dca_info['max_dca_orders']}..."
            )

            # Calculate DCA stake amount according to configured scale mode
            dca_scale_mode = self.config_dict.get('dca_scale_mode', 'linear')
            if dca_scale_mode == 'linear':
                # Linear DCA (+1x base amount per step: 1x -> 2x -> 3x -> 4x -> 5x)
                initial_amount = trade.initial_amount if trade.initial_amount > 0 else trade.amount
                target_amount = initial_amount
            else:
                # Martingale doubling: add current coins amount
                target_amount = trade.amount

            min_pair_stake = self.exchange.get_min_pair_stake(trade.pair)
            min_pair_amount = min_pair_stake / current_price if current_price > 0 else 1.0

            add_amount = max(target_amount, min_pair_amount)
            add_amount = self.exchange.amount_to_precision(trade.pair, add_amount)

            order_side = OrderSide.BUY.value if not trade.is_short else OrderSide.SELL.value
            pos_side = 'LONG' if not trade.is_short else 'SHORT'

            order = self.exchange.create_order(
                pair=trade.pair,
                order_type=OrderType.MARKET.value,
                side=order_side,
                amount=add_amount,
                price=current_price,
                position_side=pos_side
            )

            if not order:
                logger.error(f"Failed to execute DCA order on exchange for {trade.pair}")
                return False

            executed_price = float(order.get('price')) if order.get('price') and float(order.get('price')) > 0 else current_price
            executed_stake = round(add_amount * executed_price, 2)

            old_avg_rate = trade.open_rate
            old_amount = trade.amount
            trade.apply_dca(add_amount, executed_price, executed_stake)
            trade.trade_state = "DCA_ACTIVE"

            # Recalculate target TP closer to new break-even avg price (+1.2% for Long, -1.2% for Short)
            new_tp = round(trade.open_rate * (1.012 if not trade.is_short else 0.988), 6)
            
            # Find NEXT strongest 4H/1D key level for the subsequent DCA step
            next_strong_level_info = find_strongest_dca_level(
                trade.pair, self.exchange, trade.open_rate, trade.is_short, min_dist_pct=2.0
            )
            next_dca = next_strong_level_info['price']

            trade.target_tp_rate = new_tp
            trade.next_dca_price = next_dca
            trade.stoploss_rate = None  # No stop-loss
            trade.plan_notes = f"Smart DCA #{trade.dca_count} at {signal_desc} | Total: {trade.amount} coins | Break-even TP: {new_tp} (+1.2%), Next Key DCA: {next_dca}"

            self.db.update_trade_position(
                trade.id, trade.open_rate, trade.amount, trade.stake_amount, trade.dca_count,
                dca_history=trade.dca_history, initial_amount=trade.initial_amount, initial_stake=trade.initial_stake,
                next_dca_price=next_dca, trade_state="DCA_ACTIVE"
            )
            self.db.update_trade_targets(trade.id, new_tp, None, trade.plan_notes, next_dca_price=next_dca, trade_state="DCA_ACTIVE")

            # Record DCA execution in orders table
            self.db.record_order(
                trade_id=trade.id,
                pair=trade.pair,
                order_type="market",
                side=order_side,
                price=executed_price,
                amount=add_amount,
                cost=executed_stake,
                fee=round(executed_stake * 0.0005, 4),
                realized_pnl=0.0,
                action_type=f"DCA_STEP_{trade.dca_count}",
                exchange_order_id=order.get('id') if isinstance(order, dict) else None,
                notes=f"DCA #{trade.dca_count} at {executed_price}, New avg: {trade.open_rate:.6f}, TP: {new_tp}"
            )

            logger.info(
                f"✅ Smart DCA #{trade.dca_count} applied for {trade.pair}: Doubled by +{add_amount} coins (was {old_amount} -> now {trade.amount}) at {executed_price}. "
                f"New Avg Price: {trade.open_rate:.6f} (was {old_avg_rate:.6f}). New TP: {new_tp}, Next DCA: {next_dca}. Total Stake: {trade.stake_amount:.2f} USDT"
            )

            # Send Telegram notification
            stats = self._get_account_stats_snapshot()
            self.rpc.send_msg({
                'type': 'dca',
                'pair': trade.pair,
                'direction': 'SHORT' if trade.is_short else 'LONG',
                'dca_step': trade.dca_count,
                'max_dca_orders': dca_info.get('max_dca_orders', 5),
                'position_multiplier': round(trade.amount / trade.initial_amount, 2) if trade.initial_amount > 0 else None,
                'max_multiplier': dca_info.get('max_multiplier', 4.0),
                'liquidation_distance_pct': dca_info.get('liquidation_distance_pct'),
                'signal_desc': signal_desc,
                'add_amount': add_amount,
                'total_amount': trade.amount,
                'add_stake': executed_stake,
                'old_avg_rate': old_avg_rate,
                'new_avg_rate': trade.open_rate,
                'new_tp': new_tp,
                'total_stake': trade.stake_amount,
                'deposit_balance': stats.get('deposit_balance', 0.0),
                'total_trades': stats.get('total_trades', 0),
                'total_net_pnl': stats.get('total_net_pnl', 0.0)
            })
            return True

        except Exception as e:
            logger.error(f"Error checking/executing Smart DCA for {trade.pair}: {e}", exc_info=True)
            return False

    def _enter_trade(self, pair: str, current_rate: float, direction: str = 'long', mtf: Optional[dict] = None, structure: Optional[dict] = None, campaign_id: Optional[str] = None) -> bool:
        """
        Execute trade entry with multi-timeframe market structure and level awareness.
        """
        ctx = mtf if mtf is not None else (structure or {})
        try:
            # Determine dynamic stake amount (1% of deposit)
            stake = self.get_stake_amount()
            # Format amount according to exchange stepSize, precision and min notional 50.0 USDT
            amount = self.exchange.format_amount(pair, stake, current_rate)
            real_stake = round(amount * current_rate, 2)
            logger.info(f"📊 Sizing entry for {pair}: {real_stake} USDT (~{stake} USDT, 1% of deposit) -> {amount} units at {current_rate}")
            
            # Confirm with strategy
            if not self.strategy.confirm_trade_entry(
                pair=pair, order_type="market", amount=amount, rate=current_rate,
                time_in_force="GTC", current_time=datetime.utcnow(), entry_tag=None, side=direction
            ):
                logger.info(f"Strategy rejected entry for {pair}")
                return False
                
            # Create MARKET order on exchange for guaranteed instant execution
            side = OrderSide.BUY.value if direction == 'long' else OrderSide.SELL.value
            position_side = 'LONG' if direction == 'long' else 'SHORT'
            order = self.exchange.create_order(
                pair, OrderType.MARKET.value, side, amount, current_rate, position_side=position_side
            )
            
            if not order:
                logger.error(f"Failed to create order for {pair}")
                return False
                
            open_rate = float(order.get('price')) if order.get('price') and float(order.get('price')) > 0 else current_rate
            real_stake = round(amount * open_rate, 2)

            # Determine targets and plan from Multi-Timeframe Levels (Smart DCA from Support/Resistance, No Stop-Loss)
            if campaign_id:
                # Для ХЕДЖА: цели ставятся на границы 4H диапазона
                # Long цель - верхняя граница диапазона (range_high), Short цель - нижняя граница (range_low)
                range_high = ctx.get('range_high') or round(open_rate * 1.04, 6)
                range_low = ctx.get('range_low') or round(open_rate * 0.96, 6)
                if direction == 'short':
                    target_tp = round(range_low * 1.002, 6)
                else:
                    target_tp = round(range_high * 0.998, 6)
                support_lvl = range_low
                resistance_lvl = range_high
            else:
                # Для СКАЛЬПИНГА 1H: цели ставятся по уровням MTF (1D/4H)
                if direction == 'short':
                    target_tp = ctx.get('recommended_tp_short') or round(open_rate * 0.980, 6)
                else:
                    target_tp = ctx.get('recommended_tp_long') or ctx.get('recommended_tp') or round(open_rate * 1.020, 6)
                support_lvl = ctx.get('key_4h_support') or ctx.get('nearest_support') or round(open_rate * 0.98, 6)
                resistance_lvl = ctx.get('key_4h_resistance') or ctx.get('nearest_resistance') or round(open_rate * 1.02, 6)

            range_pos = ctx.get('pos_4h_pct', ctx.get('range_position_pct', 50.0))
            d1_trend = ctx.get('d1_trend', 'NEUTRAL')
            mover_cat = ctx.get('mover_category')
            change_24h = ctx.get('change_24h_pct')
            funding_rate = ctx.get('funding_rate_pct')

            strategy_type = "4H HEDGE" if campaign_id else "1H SCALP"
            dca_level_note = f"Support: {support_lvl}" if direction == 'long' else f"Resistance: {resistance_lvl}"
            mover_plan_tag = f"24h {mover_cat} ({change_24h:+.1f}%) | " if mover_cat else ""
            plan_desc = (
                f"{direction.upper()} {strategy_type} | {mover_plan_tag}1D: {d1_trend} | {dca_level_note} | "
                f"Target TP: {target_tp} | Smart Martingale DCA"
            )

            # Ensure leverage is applied before entry
            configured_leverage = int(self.config_dict.get('leverage', 25))
            margin_mode = self.config_dict.get('margin_mode', 'cross')
            try:
                self.exchange.set_margin_mode(pair, margin_mode)
                self.exchange.set_leverage(pair, configured_leverage)
            except Exception:
                pass

            # Calculate next DCA target price strictly from the strongest 4H/1D key level
            strongest_dca = find_strongest_dca_level(
                pair=pair,
                exchange=self.exchange,
                current_price=open_rate,
                is_short=(direction == 'short'),
                min_dist_pct=1.5
            )
            next_dca = strongest_dca['price']

            # Create Trade object with full context memory (No stoploss)
            trade = Trade(
                pair=pair,
                open_rate=open_rate,
                stake_amount=real_stake,
                amount=amount,
                initial_amount=amount,
                initial_stake=real_stake,
                campaign_id=campaign_id,
                campaign_banked_profit=None,
                is_open=True,
                is_short=(direction == 'short'),
                exchange=self.config_dict.get('exchange', {}).get('name', 'binance'),
                strategy=self.strategy.__class__.__name__,
                timeframe=self.timeframe,
                target_tp_rate=target_tp,
                stoploss_rate=None,
                support_level=support_lvl,
                resistance_level=resistance_lvl,
                next_dca_price=next_dca,
                trade_state="WAITING_PULLBACK",
                pullback_min_profit_pct=0.5,
                plan_notes=plan_desc
            )
            
            # Save to DB
            trade_id = self.db.add_trade(trade)
            trade.id = trade_id

            # Record initial entry order in orders table
            self.db.record_order(
                trade_id=trade_id,
                pair=pair,
                order_type="market",
                side='buy' if direction == 'long' else 'sell',
                price=open_rate,
                amount=amount,
                cost=real_stake,
                fee=round(real_stake * 0.0005, 4),
                realized_pnl=0.0,
                action_type="INITIAL_ENTRY",
                exchange_order_id=order.get('id') if isinstance(order, dict) else None,
                notes=f"Initial entry at {open_rate}, TP: {target_tp}, Next DCA: {next_dca}"
            )
            logger.info(f"✅ Trade {trade_id} entered for {pair} at {open_rate}. Next DCA: {next_dca}. Plan: {plan_desc}")
            
            tp_gain_pct = ((target_tp - open_rate) / open_rate) * 100 if not trade.is_short else ((open_rate - target_tp) / open_rate) * 100

            stats = self._get_account_stats_snapshot()
            self.rpc.send_msg({
                'type': 'buy',
                'pair': pair,
                'rate': open_rate,
                'amount': amount,
                'stake_amount': real_stake,
                'stoploss_pct': 0.0,
                'target_tp': target_tp,
                'tp_gain_pct': tp_gain_pct,
                'support_level': support_lvl,
                'resistance_level': resistance_lvl,
                'd1_trend': d1_trend,
                'pos_4h_pct': range_pos,
                'mover_category': mover_cat,
                'change_24h_pct': change_24h,
                'funding_rate_pct': funding_rate,
                'plan': plan_desc,
                'direction': direction.upper(),
                'deposit_balance': stats.get('deposit_balance', 0.0),
                'total_trades': stats.get('total_trades', 0),
                'total_net_pnl': stats.get('total_net_pnl', 0.0)
            })
            return True
            
        except Exception as e:
            logger.error(f"Exception during trade entry for {pair}: {e}", exc_info=True)
            return False

    def open_hedge_campaign(self, pair: str, current_price: float, structure: Dict[str, Any]) -> bool:
        """
        Открывает LONG и SHORT одновременно на одну монету, в средней зоне диапазона.
        Обе ноги связаны campaign_id — при закрытии одной, вторая переходит в режим
        управления хеджем (усреднение + решение "ждать безубыток / закрыть частично").
        """
        campaign_id = f"{pair}-{int(time.time())}"
        logger.info(
            f"⚖️ Открываю хедж-кампанию {campaign_id} для {pair}: цена в {structure.get('range_position_pct'):.1f}% "
            f"диапазона (${structure.get('range_low'):.6f} - ${structure.get('range_high'):.6f})"
        )

        long_ok = self._enter_trade(pair, current_price, direction='long', structure=structure, campaign_id=campaign_id)
        short_ok = self._enter_trade(pair, current_price, direction='short', structure=structure, campaign_id=campaign_id)

        if not (long_ok and short_ok):
            logger.warning(f"⚠️ Хедж-кампания {campaign_id} открыта не полностью (long={long_ok}, short={short_ok})")

        return long_ok and short_ok

    def scan_for_hedge_candidates(self) -> None:
        """Ищет монеты в средней зоне диапазона и открывает по ним хедж-кампанию."""
        min_pct = float(self.config_dict.get('hedge_range_min_pct', 35.0))
        max_pct = float(self.config_dict.get('hedge_range_max_pct', 65.0))
        min_width = float(self.config_dict.get('hedge_min_range_width_pct', 3.0))

        active_campaigns = {t.campaign_id for t in self.db.get_open_trades() if t.campaign_id}
        active_pairs_in_campaigns = {t.pair for t in self.db.get_open_trades() if t.campaign_id}

        for pair in self.get_active_trading_pairs():
            if pair in active_pairs_in_campaigns:
                continue  # уже есть активная кампания по этой монете

            ohlcv = self.exchange.fetch_ohlcv_cached(pair, '4h', limit=200, ttl=600.0)
            if not ohlcv or len(ohlcv) < 30:
                continue

            df = pd.DataFrame(ohlcv, columns=['date', 'open', 'high', 'low', 'close', 'volume'])
            structure = detect_market_structure(df, lookback=len(df))

            if is_hedge_entry_candidate(structure, min_pct, max_pct, min_width):
                current_price = structure['current_price']
                self.open_hedge_campaign(pair, current_price, structure)
                break  # одна новая кампания за цикл, не открывать пачками сразу

    def _exit_trade(self, trade: Trade, current_rate: float, profit_percent: float, reason: ExitReason) -> bool:
        """
        Execute trade exit.
        """
        try:
            logger.info(f"Exiting trade {trade.id} for {trade.pair}. Reason: {reason.value}, Profit: {profit_percent:+.2f}%")
            
            # Confirm with strategy
            if not self.strategy.confirm_trade_exit(
                pair=trade.pair, trade=trade, order_type="market", amount=trade.amount,
                rate=current_rate, time_in_force="GTC", exit_reason=reason.value, current_time=datetime.utcnow()
            ):
                logger.info(f"Strategy rejected exit for {trade.pair}")
                return False

            # Set cooldown for this pair to avoid churn
            self.cooldown_pairs[trade.pair] = datetime.utcnow()

            # Create MARKET order on exchange with Hedge Mode support
            side = OrderSide.SELL.value if not trade.is_short else OrderSide.BUY.value
            position_side = 'LONG' if not trade.is_short else 'SHORT'
            order = self.exchange.create_order(
                trade.pair, OrderType.MARKET.value, side, trade.amount, current_rate, position_side=position_side
            )
            
            if not order:
                logger.error(f"Failed to create exit order for {trade.pair}")
                return False
                
            close_rate = float(order.get('price')) if order.get('price') and float(order.get('price')) > 0 else current_rate
            trade.set_close_rate_pct(close_rate, fee_rate=0.0005)

            # Update DB with net pnl and fees
            self.db.close_trade(trade.id, close_rate, fee_rate=0.0005)

            # Record exit order in orders table
            self.db.record_order(
                trade_id=trade.id,
                pair=trade.pair,
                order_type="market",
                side=side,
                price=close_rate,
                amount=trade.amount,
                cost=round(close_rate * trade.amount, 4),
                fee=trade.fee_close,
                realized_pnl=trade.net_profit if trade.net_profit is not None else 0.0,
                action_type="TAKE_PROFIT" if (trade.net_profit and trade.net_profit > 0) else "EXIT",
                exchange_order_id=order.get('id') if isinstance(order, dict) else None,
                notes=f"Exit reason: {reason.value}, Net PnL: {trade.net_profit:+.4f} USDT"
            )

            # Если это нога хедж-кампании — передаём зафиксированную прибыль второй, ещё открытой ноге
            if trade.campaign_id:
                sibling = self.db.get_open_sibling_trade(trade.campaign_id, exclude_trade_id=trade.id)
                if sibling:
                    sibling.campaign_banked_profit = trade.net_profit
                    self.db.update_trade_field(sibling.id, 'campaign_banked_profit', trade.net_profit)
                    logger.info(
                        f"🏦 Кампания {trade.campaign_id}: нога {trade.pair} ({'SHORT' if trade.is_short else 'LONG'}) "
                        f"закрыта с {trade.net_profit:+.2f} USDT. Вторая нога ({sibling.pair}, "
                        f"{'SHORT' if sibling.is_short else 'LONG'}) переходит в режим управления хеджем."
                    )
            logger.info(
                f"✅ Trade {trade.id} closed: Gross={trade.gross_profit:+.2f} USDT, "
                f"Fees={trade.fee_total:.2f} USDT, Net PnL={trade.net_profit:+.2f} USDT ({trade.net_profit_percent:+.2f}%)."
            )
            stats = self._get_account_stats_snapshot()
            self.rpc.send_msg({
                'type': 'sell',
                'pair': trade.pair,
                'direction': 'SHORT' if trade.is_short else 'LONG',
                'amount': trade.amount,
                'stake_amount': trade.stake_amount,
                'open_rate': trade.open_rate,
                'close_rate': close_rate,
                'profit_percent': trade.profit_percent,
                'gross_profit': trade.gross_profit,
                'fee_total': trade.fee_total,
                'net_profit': trade.net_profit,
                'net_profit_percent': trade.net_profit_percent,
                'sell_reason': reason.value,
                'deposit_balance': stats.get('deposit_balance', 0.0),
                'total_trades': stats.get('total_trades', 0),
                'total_net_pnl': stats.get('total_net_pnl', 0.0)
            })
            return True
            
        except Exception as e:
            logger.error(f"Exception during trade exit for {trade.pair}: {e}", exc_info=True)
            return False

    def _check_stoploss(self, trade: Trade, current_rate: float) -> bool:
        """
        Check if stoploss is hit. Disabled when using Support/Resistance Level Smart DCA.
        """
        if not self.config_dict.get('use_stoploss', False):
            return False

        # 1. Direct level-based stoploss check
        if trade.stoploss_rate and trade.stoploss_rate > 0:
            if not trade.is_short and current_rate <= trade.stoploss_rate:
                logger.info(f"🛑 Level Stoploss hit for {trade.pair}! Current {current_rate} <= SL Level {trade.stoploss_rate}")
                return self._handle_trade_stop_loss(trade, current_rate)
            elif trade.is_short and current_rate >= trade.stoploss_rate:
                logger.info(f"🛑 Level Stoploss hit for {trade.pair} (Short)! Current {current_rate} >= SL Level {trade.stoploss_rate}")
                return self._handle_trade_stop_loss(trade, current_rate)

        profit_ratio = trade.calc_profit_ratio(current_rate)  # e.g. -0.015 for -1.5%
        profit_percent = profit_ratio * 100.0                # e.g. -1.5%
        
        # Fetch dynamic stoploss from strategy
        sl = self.strategy.custom_stoploss(
            pair=trade.pair, trade=trade, current_time=datetime.utcnow(),
            current_rate=current_rate, current_profit=profit_ratio
        )
        if sl is None:
            sl = getattr(self.strategy, 'stoploss', -0.015)
            
        sl_ratio = sl if abs(sl) < 1.0 else sl / 100.0
        
        if profit_ratio <= sl_ratio:
            logger.info(f"🛑 Stoploss hit for {trade.pair}! Profit: {profit_percent:+.2f}% <= SL: {sl_ratio * 100:+.2f}%")
            return self._handle_trade_stop_loss(trade, current_rate)
            
        # Trailing stop logic
        if getattr(self.strategy, 'trailing_stop', False):
            offset_val = getattr(self.strategy, 'trailing_stop_positive_offset', 0.010)
            offset_ratio = offset_val if offset_val < 1.0 else offset_val / 100.0
            pos_val = getattr(self.strategy, 'trailing_stop_positive', 0.005)
            pos_ratio = pos_val if pos_val < 1.0 else pos_val / 100.0
            
            if profit_ratio >= offset_ratio:
                dynamic_sl = profit_ratio - pos_ratio
                if profit_ratio <= dynamic_sl:
                    logger.info(f"🛑 Trailing Stoploss hit for {trade.pair}! Profit: {profit_percent:+.2f}%")
                    return self._handle_trade_stop_loss(trade, current_rate)
                    
        return False

    def _check_roi(self, trade: Trade, current_rate: float) -> bool:
        """
        Check if ROI or target Take-Profit price is hit.
        """
        # Take-Profit: Level-based target TP or ROI table
        if not self.config_dict.get('use_takeprofit', True):
            return False

        # 1. Direct level-based target Take-Profit check
        if trade.target_tp_rate and trade.target_tp_rate > 0:
            if not trade.is_short and current_rate >= trade.target_tp_rate:
                logger.info(
                    f"🎯 Target Level TP hit for {trade.pair}! Current {current_rate} >= TP Target {trade.target_tp_rate} "
                    f"(Profit: {trade.calc_profit(current_rate):+.2f}%)"
                )
                return self._handle_trade_roi(trade, current_rate)
            elif trade.is_short and current_rate <= trade.target_tp_rate:
                logger.info(
                    f"🎯 Target Level TP hit for {trade.pair} (Short)! Current {current_rate} <= TP Target {trade.target_tp_rate} "
                    f"(Profit: {trade.calc_profit(current_rate):+.2f}%)"
                )
                return self._handle_trade_roi(trade, current_rate)

            # Есть уровневая цель — ждём её сколько потребуется.
            # Если цена уходит против позиции — за это отвечает DCA (can_dca), не тайм-аут.
            return False

        profit_ratio = trade.calc_profit_ratio(current_rate)
        profit_percent = profit_ratio * 100.0
        trade_duration = int((datetime.utcnow() - trade.open_date).total_seconds() / 60)
        
        # Check custom ROI from strategy
        custom_roi = self.strategy.custom_roi(
            pair=trade.pair, trade=trade, current_time=datetime.utcnow(), current_profit=profit_ratio
        )
        
        roi_table = custom_roi if custom_roi is not None else self.strategy.minimal_roi
        
        if isinstance(roi_table, dict):
            for duration, target_roi in sorted(
                [(int(k), v) for k, v in roi_table.items()], key=lambda x: x[0], reverse=True
            ):
                target_ratio = target_roi if target_roi < 1.0 else target_roi / 100.0
                if trade_duration >= duration and profit_ratio >= target_ratio:
                    logger.info(f"🎯 ROI hit for {trade.pair}! Duration: {trade_duration}m, Profit: {profit_percent:+.2f}% >= {target_ratio * 100:+.2f}%")
                    return self._handle_trade_roi(trade, current_rate)
                    
        elif isinstance(roi_table, (float, int)):
            target_ratio = roi_table if roi_table < 1.0 else roi_table / 100.0
            if profit_ratio >= target_ratio:
                logger.info(f"🎯 Custom ROI hit for {trade.pair}! Profit: {profit_percent:+.2f}% >= {target_ratio * 100:+.2f}%")
                return self._handle_trade_roi(trade, current_rate)
                 
        return False

    def _handle_trade_roi(self, trade: Trade, current_rate: float) -> bool:
        """Exit trade due to ROI."""
        return self._exit_trade(trade, current_rate, trade.calc_profit(current_rate), ExitReason.ROI)
        
    def _handle_trade_stop_loss(self, trade: Trade, current_rate: float) -> bool:
        """Exit trade due to Stoploss."""
        return self._exit_trade(trade, current_rate, trade.calc_profit(current_rate), ExitReason.STOP_LOSS)

    def _check_hedge_exit(self, trade: Trade, current_price: float) -> bool:
        """
        Для ноги хеджа, чья пара уже закрыта (campaign_banked_profit задан):
        решает, ждать полного безубытка или закрыть частично за счёт банка прибыли с первой ноги.
        """
        current_profit_abs = trade.calc_profit_abs(current_price)

        # 1. Уже безубыток или в плюс — закрываем сразу
        if current_profit_abs >= 0:
            logger.info(f"✅ Hedge leg {trade.pair}: безубыток достигнут ({current_profit_abs:+.2f} USDT) — закрываю.")
            return self._exit_trade(trade, current_price, trade.calc_profit(current_price), ExitReason.ROI)

        # 2. Проверяем, есть ли ещё живой технический разворот в нужную сторону
        ohlcv = self.exchange.fetch_ohlcv_cached(trade.pair, self.timeframe, limit=50, ttl=60.0)
        if not ohlcv or len(ohlcv) < 30:
            return False

        df = pd.DataFrame(ohlcv, columns=['date', 'open', 'high', 'low', 'close', 'volume'])
        wt1, wt2 = calculate_wavetrend(df)
        last_candle_bullish = df['close'].iloc[-1] > df['open'].iloc[-1]

        if not trade.is_short:
            # LONG в минусе — нужно, чтобы цена росла дальше к безубытку
            reversal_active = bool((wt1.iloc[-1] > wt2.iloc[-1]) and (wt2.iloc[-1] <= -20)) or last_candle_bullish
        else:
            # SHORT в минусе — нужно, чтобы цена падала дальше к безубытку
            reversal_active = bool((wt1.iloc[-1] < wt2.iloc[-1]) and (wt2.iloc[-1] >= 20)) or (not last_candle_bullish)

        if reversal_active:
            logger.debug(f"⏳ Hedge leg {trade.pair}: разворот к безубытку ещё в силе, жду дальше.")
            return False

        # 3. Разворота нет, последняя свеча закрылась против нужного направления — закрываем частично
        max_loss_allowed = abs(trade.campaign_banked_profit) * float(self.config_dict.get('hedge_max_partial_loss_pct', 50.0) / 100.0)

        if abs(current_profit_abs) <= max_loss_allowed:
            logger.info(
                f"⚖️ Hedge leg {trade.pair}: разворот не подтверждён (свеча закрылась против нас). "
                f"Закрываю частично: {current_profit_abs:+.2f} USDT (лимит -{max_loss_allowed:.2f} USDT из банка {trade.campaign_banked_profit:+.2f} USDT)."
            )
        else:
            logger.warning(
                f"⚠️ Hedge leg {trade.pair}: убыток {current_profit_abs:+.2f} USDT уже превысил лимит -{max_loss_allowed:.2f} USDT из банка. Закрываю немедленно."
            )

        return self._exit_trade(trade, current_price, trade.calc_profit(current_price), ExitReason.EXIT_SIGNAL)

    def _sync_positions_with_exchange(self) -> None:
        """
        Polls active positions from Binance Futures API.
        1. Closes trades in local DB if position on Binance was closed (manual exit or TP/SL hit).
        2. Auto-imports active exchange positions into local DB if not present, ensuring full
           visibility and monitoring of all open positions in Hedge Mode (LONG and SHORT).
        3. Updates local DB open rate and amount if position size was adjusted on exchange.
        """
        try:
            positions = self.exchange.api.fapiPrivateV2GetPositionRisk()
            open_trades = self.db.get_open_trades()

            # Map (symbol, side) and symbol -> position info
            active_exchange_positions = []
            active_keys = set()
            for p in positions:
                amt = float(p.get('positionAmt', 0))
                if amt != 0:
                    sym = p.get('symbol', '')
                    pos_side = p.get('positionSide', 'BOTH')
                    is_short = (pos_side == 'SHORT') or (amt < 0)
                    pair = (sym[:-4] + '/USDT') if sym.endswith('USDT') else sym
                    entry_price = float(p.get('entryPrice', 0))
                    mark_price = float(p.get('markPrice', 0))
                    unrealized_pnl = float(p.get('unRealizedProfit', 0))
                    leverage = float(p.get('leverage', 25.0))
                    notional = abs(amt) * entry_price
                    stake = round(notional / max(leverage, 1.0), 4)

                    pos_data = {
                        'symbol': sym,
                        'pair': pair,
                        'positionSide': pos_side,
                        'is_short': is_short,
                        'amount': abs(amt),
                        'open_rate': entry_price,
                        'current_rate': mark_price,
                        'unrealized_pnl': unrealized_pnl,
                        'leverage': leverage,
                        'stake_amount': stake
                    }
                    active_exchange_positions.append(pos_data)
                    active_keys.add((pair, is_short))

            # 1. Close local DB trades that no longer exist on Binance Futures
            for trade in open_trades:
                trade_key = (trade.pair, bool(trade.is_short))
                if trade_key not in active_keys:
                    sym = trade.pair.replace('/', '').replace(':USDT', '')
                    logger.warning(
                        f"⚠️ Position for {trade.pair} (#{trade.id}, side={'SHORT' if trade.is_short else 'LONG'}) is not active on Binance Futures! "
                        f"Fetching exact closed trade data from Binance API..."
                    )
                    try:
                        user_trades = self.exchange.api.fapiPrivateGetUserTrades({'symbol': sym, 'limit': 15})
                        trade_open_ts = int(trade.open_date.timestamp() * 1000)
                        relevant_trades = [t for t in user_trades if int(t.get('time', 0)) >= trade_open_ts - 5000]
                        closing_trades = [t for t in relevant_trades if float(t.get('realizedPnl', 0)) != 0]

                        if closing_trades:
                            total_realized_pnl = sum(float(t.get('realizedPnl', 0)) for t in closing_trades)
                            total_commission = sum(float(t.get('commission', 0)) for t in relevant_trades)
                            last_close_price = float(closing_trades[-1].get('price', trade.open_rate))
                        elif relevant_trades:
                            total_realized_pnl = sum(float(t.get('realizedPnl', 0)) for t in relevant_trades)
                            total_commission = sum(float(t.get('commission', 0)) for t in relevant_trades)
                            last_close_price = float(relevant_trades[-1].get('price', trade.open_rate))
                        else:
                            ticker = self.exchange.get_ticker(trade.pair)
                            last_close_price = float(ticker.get('last', trade.open_rate))
                            total_realized_pnl = (trade.open_rate - last_close_price) * trade.amount if trade.is_short else (last_close_price - trade.open_rate) * trade.amount
                            total_commission = round(last_close_price * trade.amount * 0.0005, 4)

                        self.db.close_trade(
                            trade_id=trade.id,
                            close_rate=last_close_price,
                            realized_pnl=total_realized_pnl,
                            exact_fee=total_commission,
                            sell_reason='manual_exchange_exit'
                        )

                        stats = self._get_account_stats_snapshot()
                        self.rpc.send_msg({
                            'type': 'sell',
                            'pair': trade.pair,
                            'direction': 'SHORT' if trade.is_short else 'LONG',
                            'amount': trade.amount,
                            'stake_amount': trade.stake_amount,
                            'open_rate': trade.open_rate,
                            'close_rate': last_close_price,
                            'profit_percent': (total_realized_pnl / trade.stake_amount * 100) if trade.stake_amount > 0 else 0,
                            'gross_profit': total_realized_pnl,
                            'fee_total': total_commission,
                            'net_profit': total_realized_pnl - total_commission,
                            'net_profit_percent': ((total_realized_pnl - total_commission) / trade.stake_amount * 100) if trade.stake_amount > 0 else 0,
                            'sell_reason': 'manual_exchange_exit',
                            'deposit_balance': stats.get('deposit_balance', 0.0),
                            'open_trades_count': stats.get('open_trades_count', 0),
                            'daily_net_profit': stats.get('daily_net_profit', 0.0),
                            'daily_win_rate': stats.get('daily_win_rate', 0.0)
                        })
                        logger.info(
                            f"✅ Reconciled & Closed Trade #{trade.id} ({trade.pair}) from Binance: "
                            f"PnL={total_realized_pnl:+.4f} USDT, Fee={total_commission:.4f} USDT, Exit Price={last_close_price}"
                        )
                    except Exception as close_err:
                        logger.error(f"Failed to reconcile closed trade #{trade.id}: {close_err}")

            # 2. Auto-import missing active exchange positions into local DB
            open_db_keys = {(t.pair, bool(t.is_short)): t for t in self.db.get_open_trades()}
            for pos in active_exchange_positions:
                pos_key = (pos['pair'], pos['is_short'])
                if pos_key not in open_db_keys:
                    rec_tp = round(pos['open_rate'] * (1.012 if not pos['is_short'] else 0.988), 6)
                    rec_dca = round(pos['open_rate'] * (0.975 if not pos['is_short'] else 1.025), 6)
                    logger.info(
                        f"📥 Importing active Binance position into DB: {pos['pair']} "
                        f"(side={'SHORT' if pos['is_short'] else 'LONG'}, amount={pos['amount']}, entry={pos['open_rate']}, lev={pos['leverage']}x, Target TP: {rec_tp}, Next DCA: {rec_dca})"
                    )
                    imported_trade = Trade(
                        pair=pos['pair'],
                        open_rate=pos['open_rate'],
                        stake_amount=pos['stake_amount'],
                        amount=pos['amount'],
                        initial_amount=pos['amount'],
                        initial_stake=pos['stake_amount'],
                        is_open=True,
                        is_short=pos['is_short'],
                        leverage=pos['leverage'],
                        open_date=datetime.utcnow(),
                        fee=0.0005,
                        buy_tag='exchange_import',
                        exchange='binance',
                        strategy=self.strategy.name if hasattr(self.strategy, 'name') else 'ScalpingStrategy',
                        timeframe=self.timeframe,
                        target_tp_rate=rec_tp,
                        next_dca_price=rec_dca,
                        trade_state='WAITING_PULLBACK',
                        pullback_min_profit_pct=0.5,
                        plan_notes=f"Imported from Binance | Waiting pullback to TP {rec_tp} (+1.2%), Next DCA: {rec_dca}"
                    )
                    trade_id = self.db.add_trade(imported_trade)
                    imported_trade.id = trade_id

                    # Record in orders table
                    self.db.record_order(
                        trade_id=trade_id,
                        pair=pos['pair'],
                        order_type="market",
                        side='buy' if not pos['is_short'] else 'sell',
                        price=pos['open_rate'],
                        amount=pos['amount'],
                        cost=pos['stake_amount'],
                        fee=round(pos['stake_amount'] * 0.0005, 4),
                        realized_pnl=0.0,
                        action_type="INITIAL_ENTRY",
                        notes=f"Active Binance position imported with pullback plan to {rec_tp}"
                    )
                    logger.info(f"✅ Position {pos['pair']} imported successfully as Trade #{trade_id} with Pullback Plan to {rec_tp}")
                else:
                    # Update local trade amount / open rate if changed
                    existing_t = open_db_keys[pos_key]
                    if abs(existing_t.amount - pos['amount']) > 1e-6 or abs(existing_t.open_rate - pos['open_rate']) > 1e-6:
                        try:
                            conn = self.db.get_connection()
                            cur = conn.cursor()
                            cur.execute(
                                'UPDATE trades SET amount = ?, open_rate = ?, stake_amount = ?, leverage = ? WHERE id = ?',
                                (pos['amount'], pos['open_rate'], pos['stake_amount'], pos['leverage'], existing_t.id)
                            )
                            conn.commit()
                            conn.close()
                        except Exception as update_err:
                            logger.error(f"Failed to update existing trade #{existing_t.id}: {update_err}")
        except Exception as e:
            logger.error(f"Error in _sync_positions_with_exchange: {e}")

    def _update_trade(self, trade: Trade) -> None:
        """
        Sync trade state with exchange (e.g., check if limit orders were filled or DCA filled).
        """
        pass

    def _cancel_all_orders(self) -> None:
        """
        Cancel all open orders on the exchange.
        """
        logger.info("Canceling all open orders...")
        # Implementation depends on saving order IDs to DB.
        pass

    def get_stats(self) -> Dict[str, Any]:
        """
        Get current bot statistics from database.
        """
        return self.db.get_stats()

    def get_balance(self) -> Dict[str, Any]:
        """
        Get current exchange balance.
        """
        return self.exchange.get_balance()
