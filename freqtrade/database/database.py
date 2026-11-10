import sqlite3
import json
from datetime import datetime
from typing import List, Optional, Dict, Any
from pathlib import Path
from freqtrade.models.trade import Trade
from freqtrade.models.order import Order
import logging

logger = logging.getLogger('freqtrade')

class Database:
    """Database management"""
    
    def __init__(self, db_url: str = "sqlite:///trades.sqlite"):
        self.db_file = db_url.replace("sqlite:///", "")
        self.init_db()
    
    def get_connection(self):
        """Get connection"""
        conn = sqlite3.connect(self.db_file)
        conn.row_factory = sqlite3.Row
        return conn
    
    def init_db(self):
        """Initialize all tables"""
        conn = self.get_connection()
        cursor = conn.cursor()
        
        # Trades table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pair TEXT NOT NULL,
                open_rate REAL NOT NULL,
                close_rate REAL,
                stake_amount REAL NOT NULL,
                amount REAL NOT NULL,
                is_open BOOLEAN DEFAULT 1,
                is_short BOOLEAN DEFAULT 0,
                leverage REAL DEFAULT 1.0,
                open_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                close_date TIMESTAMP,
                profit REAL,
                profit_percent REAL,
                fee REAL DEFAULT 0.001,
                buy_tag TEXT,
                sell_reason TEXT,
                exchange TEXT,
                strategy TEXT,
                timeframe TEXT,
                dca_count INTEGER DEFAULT 0,
                target_tp_rate REAL,
                stoploss_rate REAL,
                support_level REAL,
                resistance_level REAL,
                plan_notes TEXT
            )
        ''')
        
        # Ensure new columns exist for backwards compatibility
        for col_def in [
            ('dca_count', 'INTEGER DEFAULT 0'),
            ('last_dca_date', 'TEXT'),
            ('target_tp_rate', 'REAL'),
            ('target_profit_usdt', 'REAL'),
            ('stoploss_rate', 'REAL'),
            ('support_level', 'REAL'),
            ('resistance_level', 'REAL'),
            ('next_dca_price', 'REAL'),
            ('trade_state', "TEXT DEFAULT 'WAITING_PULLBACK'"),
            ('pullback_min_profit_pct', 'REAL DEFAULT 0.5'),
            ('plan_notes', 'TEXT'),
            ('initial_amount', 'REAL DEFAULT 0.0'),
            ('initial_stake', 'REAL DEFAULT 0.0'),
            ('dca_history', 'TEXT DEFAULT "[]"'),
            ('campaign_id', 'TEXT'),
            ('campaign_banked_profit', 'REAL'),
            ('fee_open', 'REAL DEFAULT 0.0'),
            ('fee_close', 'REAL DEFAULT 0.0'),
            ('fee_total', 'REAL DEFAULT 0.0'),
            ('gross_profit', 'REAL DEFAULT 0.0'),
            ('net_profit', 'REAL DEFAULT 0.0'),
            ('net_profit_percent', 'REAL DEFAULT 0.0')
        ]:
            try:
                cursor.execute(f'ALTER TABLE trades ADD COLUMN {col_def[0]} {col_def[1]}')
            except Exception:
                pass

        # Backfill legacy closed trades with exact fees and net profit
        try:
            cursor.execute('''
                SELECT id, pair, open_rate, close_rate, amount, stake_amount, is_short, fee 
                FROM trades 
                WHERE is_open = 0 AND (fee_total = 0.0 OR fee_total IS NULL) AND close_rate IS NOT NULL
            ''')
            legacy_rows = cursor.fetchall()
            for r in legacy_rows:
                tid = r['id']
                o_rate = float(r['open_rate'] or 0.0)
                c_rate = float(r['close_rate'] or o_rate)
                amt = float(r['amount'] or 0.0)
                stk = float(r['stake_amount'] or (o_rate * amt))
                is_sh = bool(r['is_short'] or 0)
                f_rate = float(r['fee'] or 0.0005)
                if f_rate > 0.01: # sanitize
                    f_rate = 0.0005

                gross = ((o_rate - c_rate) * amt) if is_sh else ((c_rate - o_rate) * amt)
                f_open = round((o_rate * amt) * f_rate, 4)
                f_close = round((c_rate * amt) * f_rate, 4)
                f_tot = round(f_open + f_close, 4)
                net = round(gross - f_tot, 4)
                net_pct = round((net / stk) * 100.0, 2) if stk > 0 else 0.0

                cursor.execute('''
                    UPDATE trades 
                    SET fee_open = ?, fee_close = ?, fee_total = ?, 
                        gross_profit = ?, net_profit = ?, net_profit_percent = ?
                    WHERE id = ?
                ''', (f_open, f_close, f_tot, round(gross, 4), net, net_pct, tid))
        except Exception as bfe:
            logger.debug(f"Legacy trades backfill skipped: {bfe}")

        # Ensure all open trades have a target pullback TP and next DCA level
        try:
            cursor.execute('''
                UPDATE trades 
                SET target_tp_rate = ROUND(open_rate * (CASE WHEN is_short = 1 THEN 0.988 ELSE 1.012 END), 6),
                    next_dca_price = ROUND(open_rate * (CASE WHEN is_short = 1 THEN 1.025 ELSE 0.975 END), 6),
                    trade_state = COALESCE(trade_state, 'WAITING_PULLBACK'),
                    pullback_min_profit_pct = COALESCE(pullback_min_profit_pct, 0.5)
                WHERE is_open = 1 AND (target_tp_rate IS NULL OR target_tp_rate = 0.0)
            ''')
            conn.commit()
        except Exception as tpe:
            logger.debug(f"Pullback TP backfill skipped: {tpe}")
        
        # Orders table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                trade_id INTEGER,
                pair TEXT NOT NULL,
                order_type TEXT NOT NULL,
                side TEXT NOT NULL,
                price REAL NOT NULL,
                amount REAL NOT NULL,
                filled REAL DEFAULT 0,
                remaining REAL,
                status TEXT DEFAULT 'open',
                exchange_order_id TEXT,
                cost REAL,
                fee REAL DEFAULT 0.0,
                realized_pnl REAL DEFAULT 0.0,
                action_type TEXT DEFAULT 'INITIAL_ENTRY',
                order_notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(trade_id) REFERENCES trades(id)
            )
        ''')

        # Ensure order columns exist
        for o_col in [
            ('cost', 'REAL'),
            ('fee', 'REAL DEFAULT 0.0'),
            ('realized_pnl', 'REAL DEFAULT 0.0'),
            ('action_type', "TEXT DEFAULT 'INITIAL_ENTRY'"),
            ('order_notes', 'TEXT')
        ]:
            try:
                cursor.execute(f'ALTER TABLE orders ADD COLUMN {o_col[0]} {o_col[1]}')
            except Exception:
                pass
        
        # Signals table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS signals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pair TEXT NOT NULL,
                signal_type TEXT NOT NULL,
                direction TEXT NOT NULL,
                confidence REAL,
                price REAL,
                reason TEXT,
                indicators TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # Backtests table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS backtests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                strategy_name TEXT NOT NULL,
                timerange TEXT,
                total_trades INTEGER,
                winning_trades INTEGER,
                losing_trades INTEGER,
                win_rate REAL,
                total_profit REAL,
                avg_profit REAL,
                max_profit REAL,
                min_profit REAL,
                max_drawdown REAL,
                sharpe_ratio REAL,
                sortino_ratio REAL,
                calmar_ratio REAL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                results TEXT
            )
        ''')
        
        # Hyperopt results table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS hyperopt_results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                epoch INTEGER,
                params TEXT,
                results TEXT,
                loss REAL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # Balance history table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS balance_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                currency TEXT NOT NULL,
                free REAL,
                used REAL,
                total REAL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # Strategies table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS strategies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                code TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # ML models table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS ml_models (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                model_type TEXT,
                accuracy REAL,
                model_data BLOB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        conn.commit()
        conn.close()
        logger.info(f"✅ Database initialized: {self.db_file}")
    
    def add_trade(self, trade: Trade) -> int:
        """Add trade"""
        conn = self.get_connection()
        cursor = conn.cursor()
        
        initial_amount = getattr(trade, 'initial_amount', 0.0) or trade.amount
        initial_stake = getattr(trade, 'initial_stake', 0.0) or trade.stake_amount
        dca_history_json = json.dumps(getattr(trade, 'dca_history', []))

        cursor.execute('''
            INSERT INTO trades 
            (pair, open_rate, stake_amount, amount, is_open, is_short, open_date, 
             leverage, fee, buy_tag, exchange, strategy, timeframe, dca_count,
             target_tp_rate, stoploss_rate, support_level, resistance_level, plan_notes,
             initial_amount, initial_stake, dca_history, campaign_id, campaign_banked_profit,
             trade_state, next_dca_price, target_profit_usdt, pullback_min_profit_pct)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (trade.pair, trade.open_rate, trade.stake_amount, trade.amount,
              trade.is_open, trade.is_short, trade.open_date, trade.leverage,
              trade.fee, trade.buy_tag, trade.exchange, trade.strategy, trade.timeframe,
              getattr(trade, 'dca_count', 0), getattr(trade, 'target_tp_rate', None),
              getattr(trade, 'stoploss_rate', None), getattr(trade, 'support_level', None),
              getattr(trade, 'resistance_level', None), getattr(trade, 'plan_notes', None),
              initial_amount, initial_stake, dca_history_json,
              getattr(trade, 'campaign_id', None), getattr(trade, 'campaign_banked_profit', None),
              getattr(trade, 'trade_state', 'WAITING_PULLBACK'), getattr(trade, 'next_dca_price', None),
              getattr(trade, 'target_profit_usdt', None), getattr(trade, 'pullback_min_profit_pct', 0.5)))
        
        conn.commit()
        trade_id = cursor.lastrowid
        conn.close()
        
        logger.info(f"✅ Added trade: {trade.pair} ID={trade_id} (TP: {trade.target_tp_rate}, State: {getattr(trade, 'trade_state', 'WAITING_PULLBACK')})")
        return trade_id
    
    def close_trade(
        self,
        trade_id: int,
        close_rate: float,
        fee_rate: float = 0.0005,
        realized_pnl: Optional[float] = None,
        exact_fee: Optional[float] = None,
        sell_reason: Optional[str] = None
    ) -> None:
        """Close trade with exact gross profit, fees, and net PnL (from exchange or calculated)"""
        conn = self.get_connection()
        cursor = conn.cursor()
        
        cursor.execute('SELECT * FROM trades WHERE id = ?', (trade_id,))
        row = cursor.fetchone()
        
        if row:
            open_rate = float(row['open_rate'])
            amount = float(row['amount'])
            stake_amount = float(row['stake_amount']) if row['stake_amount'] else (open_rate * amount)
            is_short = bool(row['is_short']) if 'is_short' in row.keys() else False

            # 1. Gross Profit / PnL
            if realized_pnl is not None:
                gross_profit = float(realized_pnl)
                if is_short:
                    profit_percent = ((open_rate - close_rate) / open_rate) * 100.0 if open_rate > 0 else 0.0
                else:
                    profit_percent = ((close_rate - open_rate) / open_rate) * 100.0 if open_rate > 0 else 0.0
            else:
                if is_short:
                    gross_profit = (open_rate - close_rate) * amount
                    profit_percent = ((open_rate - close_rate) / open_rate) * 100.0 if open_rate > 0 else 0.0
                else:
                    gross_profit = (close_rate - open_rate) * amount
                    profit_percent = ((close_rate - open_rate) / open_rate) * 100.0 if open_rate > 0 else 0.0

            # 2. Exchange Fees (Binance Futures USDT-M taker fee default 0.05%)
            if exact_fee is not None:
                fee_total = round(float(exact_fee), 4)
                fee_open = round(fee_total / 2.0, 4)
                fee_close = round(fee_total / 2.0, 4)
            else:
                effective_fee = float(row['fee']) if 'fee' in row.keys() and row['fee'] else fee_rate
                entry_val = open_rate * amount
                exit_val = close_rate * amount
                fee_open = round(entry_val * effective_fee, 4)
                fee_close = round(exit_val * effective_fee, 4)
                fee_total = round(fee_open + fee_close, 4)

            # 3. Net PnL (in wallet currency USDT and %)
            net_profit = round(gross_profit - fee_total, 4)
            net_profit_percent = round((net_profit / stake_amount) * 100.0, 2) if stake_amount > 0 else round(profit_percent, 2)
            reason = sell_reason or (row['sell_reason'] if 'sell_reason' in row.keys() else 'closed')
            
            cursor.execute('''
                UPDATE trades 
                SET is_open = 0, close_rate = ?, close_date = ?, 
                    profit = ?, profit_percent = ?,
                    gross_profit = ?, fee_open = ?, fee_close = ?, fee_total = ?,
                    net_profit = ?, net_profit_percent = ?, sell_reason = ?,
                    trade_state = 'CLOSED'
                WHERE id = ?
            ''', (close_rate, datetime.utcnow(), gross_profit, profit_percent,
                  gross_profit, fee_open, fee_close, fee_total,
                  net_profit, net_profit_percent, reason, trade_id))
            
            conn.commit()
            logger.info(
                f"✅ Closed trade ID={trade_id} ({reason}): Gross={gross_profit:+.4f} USDT, "
                f"Fees={fee_total:.4f} USDT, Net PnL={net_profit:+.4f} USDT ({net_profit_percent:+.2f}%)"
            )
        
        conn.close()

    def get_pnl_analytics(self) -> Dict[str, Any]:
        """
        Calculates complete profitability history, exchange fees deducted, and net returns.
        """
        conn = self.get_connection()
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT * FROM trades 
            WHERE is_open = 0 
            ORDER BY close_date DESC
        ''')
        rows = cursor.fetchall()
        
        total_trades = len(rows)
        winning_trades = 0
        losing_trades = 0
        break_even = 0
        
        total_gross = 0.0
        total_fees = 0.0
        total_net = 0.0
        total_volume = 0.0
        
        gross_wins = 0.0
        gross_losses = 0.0
        
        trade_history = []

        for r in rows:
            d = dict(r)
            # Safe fallbacks if old schema rows exist
            stake = float(d.get('stake_amount') or 0.0)
            open_r = float(d.get('open_rate') or 0.0)
            close_r = float(d.get('close_rate') or open_r)
            amt = float(d.get('amount') or 0.0)
            is_sh = bool(d.get('is_short') or 0)
            
            # Gross
            gross = d.get('gross_profit')
            if gross is None:
                gross = ((open_r - close_r) * amt) if is_sh else ((close_r - open_r) * amt)
            gross = float(gross)
            
            # Fees
            fee_tot = d.get('fee_total')
            if fee_tot is None:
                fee_rate = float(d.get('fee') or 0.0005)
                fee_tot = (open_r * amt + close_r * amt) * fee_rate
            fee_tot = float(fee_tot)
            
            # Net
            net = d.get('net_profit')
            if net is None:
                net = gross - fee_tot
            net = float(net)
            
            net_pct = d.get('net_profit_percent')
            if net_pct is None:
                net_pct = (net / stake * 100.0) if stake > 0 else 0.0
            net_pct = float(net_pct)
            
            # Stats accumulation
            total_gross += gross
            total_fees += fee_tot
            total_net += net
            total_volume += (open_r * amt)
            
            if net > 0.001:
                winning_trades += 1
                gross_wins += gross
            elif net < -0.001:
                losing_trades += 1
                gross_losses += abs(gross)
            else:
                break_even += 1

            trade_history.append({
                'id': d.get('id'),
                'pair': d.get('pair'),
                'direction': 'SHORT' if is_sh else 'LONG',
                'open_rate': open_r,
                'close_rate': close_r,
                'amount': amt,
                'stake_amount': round(stake, 2),
                'open_date': d.get('open_date'),
                'close_date': d.get('close_date'),
                'sell_reason': d.get('sell_reason') or 'target_hit',
                'gross_profit': round(gross, 2),
                'fee_total': round(fee_tot, 2),
                'net_profit': round(net, 2),
                'net_profit_percent': round(net_pct, 2),
                'plan_notes': d.get('plan_notes')
            })

        conn.close()

        win_rate = round((winning_trades / total_trades * 100.0), 1) if total_trades > 0 else 0.0
        profit_factor = round(gross_wins / gross_losses, 2) if gross_losses > 0 else (round(gross_wins, 2) if gross_wins > 0 else 1.0)
        avg_trade = round(total_net / total_trades, 2) if total_trades > 0 else 0.0

        return {
            'total_trades': total_trades,
            'winning_trades': winning_trades,
            'losing_trades': losing_trades,
            'break_even_trades': break_even,
            'win_rate_pct': win_rate,
            'total_gross_profit': round(total_gross, 2),
            'total_fees_paid': round(total_fees, 2),
            'total_net_profit': round(total_net, 2),
            'profit_factor': profit_factor,
            'avg_trade_net_pnl': avg_trade,
            'total_volume_traded': round(total_volume, 2),
            'history': trade_history
        }
    
    def update_trade_position(self, trade_id: int, new_open_rate: float, new_amount: float, new_stake_amount: float, dca_count: int, dca_history: Optional[list] = None, initial_amount: Optional[float] = None, initial_stake: Optional[float] = None, last_dca_date: Optional[datetime] = None, next_dca_price: Optional[float] = None, trade_state: Optional[str] = None) -> None:
        """Update open rate, amount, stake and DCA count after smart DCA"""
        conn = self.get_connection()
        cursor = conn.cursor()
        dca_history_json = json.dumps(dca_history) if dca_history is not None else None
        last_dca_str = last_dca_date.isoformat() if last_dca_date else (datetime.utcnow().isoformat() if dca_count > 0 else None)
        cursor.execute('''
            UPDATE trades 
            SET open_rate = ?, amount = ?, stake_amount = ?, dca_count = ?,
                dca_history = COALESCE(?, dca_history),
                initial_amount = COALESCE(?, initial_amount),
                initial_stake = COALESCE(?, initial_stake),
                last_dca_date = COALESCE(?, last_dca_date),
                next_dca_price = COALESCE(?, next_dca_price),
                trade_state = COALESCE(?, trade_state)
            WHERE id = ?
        ''', (new_open_rate, new_amount, new_stake_amount, dca_count, dca_history_json, initial_amount, initial_stake, last_dca_str, next_dca_price, trade_state, trade_id))
        conn.commit()
        conn.close()
        logger.info(f"✅ Database updated for trade {trade_id} after DCA #{dca_count}: avg_rate={new_open_rate}, total_stake={new_stake_amount}")

    def update_trade_targets(self, trade_id: int, target_tp_rate: float, stoploss_rate: Optional[float] = None, plan_notes: Optional[str] = None, next_dca_price: Optional[float] = None, trade_state: Optional[str] = None) -> None:
        """Update take-profit, stop-loss and trade plan notes"""
        conn = self.get_connection()
        cursor = conn.cursor()
        cursor.execute('''
            UPDATE trades 
            SET target_tp_rate = ?, stoploss_rate = ?, plan_notes = COALESCE(?, plan_notes),
                next_dca_price = COALESCE(?, next_dca_price),
                trade_state = COALESCE(?, trade_state)
            WHERE id = ?
        ''', (target_tp_rate, stoploss_rate, plan_notes, next_dca_price, trade_state, trade_id))
        conn.commit()
        conn.close()
        logger.info(f"🎯 Targets updated for trade {trade_id}: TP={target_tp_rate}, Next DCA={next_dca_price}, State={trade_state}")

    def record_order(
        self,
        trade_id: int,
        pair: str,
        order_type: str,
        side: str,
        price: float,
        amount: float,
        cost: Optional[float] = None,
        fee: float = 0.0,
        realized_pnl: float = 0.0,
        action_type: str = "INITIAL_ENTRY",
        status: str = "filled",
        exchange_order_id: Optional[str] = None,
        notes: Optional[str] = None
    ) -> int:
        """Record an executed order (entry, DCA step, TP exit, stop) in the orders table."""
        conn = self.get_connection()
        cursor = conn.cursor()
        total_cost = cost if cost is not None else round(price * amount, 4)
        cursor.execute('''
            INSERT INTO orders 
            (trade_id, pair, order_type, side, price, amount, filled, remaining, status, exchange_order_id, cost, fee, realized_pnl, action_type, order_notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ''', (trade_id, pair, order_type, side, price, amount, amount, status, str(exchange_order_id) if exchange_order_id else None, total_cost, fee, realized_pnl, action_type, notes))
        conn.commit()
        order_id = cursor.lastrowid
        conn.close()
        logger.info(f"📝 Recorded Order #{order_id} for Trade #{trade_id} [{pair}]: {action_type} {side} {amount} @ {price} (Cost: {total_cost} USDT, Fee: {fee} USDT, PnL: {realized_pnl:+.4f} USDT)")
        return order_id

    def get_orders_for_trade(self, trade_id: int) -> List[Dict[str, Any]]:
        """Retrieve all executed orders for a trade (entries, DCAs, exits)."""
        conn = self.get_connection()
        cursor = conn.cursor()
        cursor.execute('''
            SELECT * FROM orders WHERE trade_id = ? ORDER BY id ASC
        ''', (trade_id,))
        rows = [dict(r) for r in cursor.fetchall()]
        conn.close()
        return rows

    def get_all_orders(self, limit: int = 200) -> List[Dict[str, Any]]:
        """Retrieve recent executed orders across all trades."""
        conn = self.get_connection()
        cursor = conn.cursor()
        cursor.execute('''
            SELECT * FROM orders ORDER BY id DESC LIMIT ?
        ''', (limit,))
        rows = [dict(r) for r in cursor.fetchall()]
        conn.close()
        return rows

    def add_order(self, order: Order) -> int:
        """Add order"""
        conn = self.get_connection()
        cursor = conn.cursor()
        
        cursor.execute('''
            INSERT INTO orders 
            (trade_id, pair, order_type, side, price, amount, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (order.trade_id, order.pair, order.order_type.value,
              order.side.value, order.price, order.amount, order.status.value))
        
        conn.commit()
        order_id = cursor.lastrowid
        conn.close()
        
        return order_id
    
    def get_open_trades(self) -> List[Trade]:
        """Get open trades"""
        conn = self.get_connection()
        cursor = conn.cursor()
        
        cursor.execute('SELECT * FROM trades WHERE is_open = 1 ORDER BY open_date DESC')
        rows = cursor.fetchall()
        conn.close()
        
        trades = []
        for row in rows:
            keys = row.keys()
            dca_hist = []
            if 'dca_history' in keys and row['dca_history']:
                try:
                    dca_hist = json.loads(row['dca_history'])
                except Exception:
                    dca_hist = []

            init_amt = float(row['initial_amount']) if ('initial_amount' in keys and row['initial_amount'] is not None and float(row['initial_amount']) > 0) else float(row['amount'])
            init_stk = float(row['initial_stake']) if ('initial_stake' in keys and row['initial_stake'] is not None and float(row['initial_stake']) > 0) else float(row['stake_amount'])

            last_dca_dt = None
            if 'last_dca_date' in keys and row['last_dca_date']:
                try:
                    last_dca_dt = datetime.fromisoformat(row['last_dca_date'])
                except Exception:
                    last_dca_dt = None
            if not last_dca_dt and dca_hist:
                try:
                    last_ts = dca_hist[-1].get('timestamp')
                    if last_ts:
                        last_dca_dt = datetime.fromisoformat(last_ts)
                except Exception:
                    last_dca_dt = None

            trade = Trade(
                id=row['id'],
                pair=row['pair'],
                open_rate=row['open_rate'],
                stake_amount=row['stake_amount'],
                amount=row['amount'],
                initial_amount=init_amt,
                initial_stake=init_stk,
                dca_history=dca_hist,
                last_dca_date=last_dca_dt,
                campaign_id=row['campaign_id'] if 'campaign_id' in keys else None,
                campaign_banked_profit=float(row['campaign_banked_profit']) if 'campaign_banked_profit' in keys and row['campaign_banked_profit'] is not None else None,
                is_open=bool(row['is_open']),
                is_short=bool(row['is_short']),
                leverage=row['leverage'],
                open_date=datetime.fromisoformat(row['open_date']),
                fee=row['fee'],
                buy_tag=row['buy_tag'],
                exchange=row['exchange'],
                strategy=row['strategy'],
                timeframe=row['timeframe'],
                dca_count=row['dca_count'] if 'dca_count' in keys and row['dca_count'] is not None else 0,
                target_tp_rate=row['target_tp_rate'] if 'target_tp_rate' in keys else None,
                target_profit_usdt=float(row['target_profit_usdt']) if ('target_profit_usdt' in keys and row['target_profit_usdt'] is not None) else None,
                stoploss_rate=row['stoploss_rate'] if 'stoploss_rate' in keys else None,
                support_level=row['support_level'] if 'support_level' in keys else None,
                resistance_level=row['resistance_level'] if 'resistance_level' in keys else None,
                next_dca_price=float(row['next_dca_price']) if ('next_dca_price' in keys and row['next_dca_price'] is not None) else None,
                trade_state=row['trade_state'] if 'trade_state' in keys and row['trade_state'] else 'WAITING_PULLBACK',
                pullback_min_profit_pct=float(row['pullback_min_profit_pct']) if ('pullback_min_profit_pct' in keys and row['pullback_min_profit_pct'] is not None) else 0.5,
                plan_notes=row['plan_notes'] if 'plan_notes' in keys else None,
                fee_open=float(row['fee_open']) if 'fee_open' in keys and row['fee_open'] is not None else 0.0,
                fee_close=float(row['fee_close']) if 'fee_close' in keys and row['fee_close'] is not None else 0.0,
                fee_total=float(row['fee_total']) if 'fee_total' in keys and row['fee_total'] is not None else 0.0,
                gross_profit=float(row['gross_profit']) if 'gross_profit' in keys and row['gross_profit'] is not None else None,
                net_profit=float(row['net_profit']) if 'net_profit' in keys and row['net_profit'] is not None else None,
                net_profit_percent=float(row['net_profit_percent']) if 'net_profit_percent' in keys and row['net_profit_percent'] is not None else None
            )
            trades.append(trade)
        
        return trades
    
    def get_closed_trades(self, limit: int = 100) -> List[Trade]:
        """Get closed trades"""
        conn = self.get_connection()
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT * FROM trades WHERE is_open = 0 
            ORDER BY close_date DESC LIMIT ?
        ''', (limit,))
        rows = cursor.fetchall()
        conn.close()
        
        trades = []
        for row in rows:
            keys = row.keys()
            dca_hist = []
            if 'dca_history' in keys and row['dca_history']:
                try:
                    dca_hist = json.loads(row['dca_history'])
                except Exception:
                    dca_hist = []

            init_amt = float(row['initial_amount']) if ('initial_amount' in keys and row['initial_amount'] is not None and float(row['initial_amount']) > 0) else float(row['amount'])
            init_stk = float(row['initial_stake']) if ('initial_stake' in keys and row['initial_stake'] is not None and float(row['initial_stake']) > 0) else float(row['stake_amount'])

            trade = Trade(
                id=row['id'],
                pair=row['pair'],
                open_rate=row['open_rate'],
                close_rate=row['close_rate'],
                stake_amount=row['stake_amount'],
                amount=row['amount'],
                initial_amount=init_amt,
                initial_stake=init_stk,
                dca_history=dca_hist,
                campaign_id=row['campaign_id'] if 'campaign_id' in keys else None,
                campaign_banked_profit=float(row['campaign_banked_profit']) if 'campaign_banked_profit' in keys and row['campaign_banked_profit'] is not None else None,
                is_open=bool(row['is_open']),
                is_short=bool(row['is_short']),
                profit=row['profit'],
                profit_percent=row['profit_percent'],
                open_date=datetime.fromisoformat(row['open_date']),
                close_date=datetime.fromisoformat(row['close_date']) if row['close_date'] else None,
                fee=row['fee'],
                sell_reason=row['sell_reason'],
                exchange=row['exchange'],
                strategy=row['strategy'],
                timeframe=row['timeframe'],
                dca_count=row['dca_count'] if 'dca_count' in keys and row['dca_count'] is not None else 0,
                target_tp_rate=row['target_tp_rate'] if 'target_tp_rate' in keys else None,
                target_profit_usdt=float(row['target_profit_usdt']) if ('target_profit_usdt' in keys and row['target_profit_usdt'] is not None) else None,
                stoploss_rate=row['stoploss_rate'] if 'stoploss_rate' in keys else None,
                support_level=row['support_level'] if 'support_level' in keys else None,
                resistance_level=row['resistance_level'] if 'resistance_level' in keys else None,
                next_dca_price=float(row['next_dca_price']) if ('next_dca_price' in keys and row['next_dca_price'] is not None) else None,
                trade_state=row['trade_state'] if 'trade_state' in keys and row['trade_state'] else 'CLOSED',
                pullback_min_profit_pct=float(row['pullback_min_profit_pct']) if ('pullback_min_profit_pct' in keys and row['pullback_min_profit_pct'] is not None) else 0.5,
                fee_open=float(row['fee_open']) if 'fee_open' in keys and row['fee_open'] is not None else 0.0,
                fee_close=float(row['fee_close']) if 'fee_close' in keys and row['fee_close'] is not None else 0.0,
                fee_total=float(row['fee_total']) if 'fee_total' in keys and row['fee_total'] is not None else 0.0,
                gross_profit=float(row['gross_profit']) if 'gross_profit' in keys and row['gross_profit'] is not None else (row['profit'] if 'profit' in keys else None),
                net_profit=float(row['net_profit']) if 'net_profit' in keys and row['net_profit'] is not None else (row['profit'] if 'profit' in keys else None),
                net_profit_percent=float(row['net_profit_percent']) if 'net_profit_percent' in keys and row['net_profit_percent'] is not None else (row['profit_percent'] if 'profit_percent' in keys else None)
            )
            trades.append(trade)
        
        return trades

    def get_open_sibling_trade(self, campaign_id: str, exclude_trade_id: int) -> Optional[Trade]:
        """Находит открытую вторую ногу той же хедж-кампании."""
        if not campaign_id:
            return None
        for t in self.get_open_trades():
            if t.campaign_id == campaign_id and t.id != exclude_trade_id:
                return t
        return None

    def update_trade_field(self, trade_id: int, field: str, value: Any) -> None:
        """Обновляет одно поле сделки по имени (используется для служебных полей вроде campaign_banked_profit)."""
        allowed_fields = {'campaign_banked_profit', 'support_level', 'resistance_level'}
        if field not in allowed_fields:
            raise ValueError(f"Field '{field}' not allowed for direct update")
        conn = self.get_connection()
        cursor = conn.cursor()
        cursor.execute(f"UPDATE trades SET {field} = ? WHERE id = ?", (value, trade_id))
        conn.commit()
        conn.close()
    
    def get_stats(self) -> Dict[str, Any]:
        """Get statistics"""
        conn = self.get_connection()
        cursor = conn.cursor()
        
        cursor.execute('''
            SELECT 
                COUNT(*) as total_trades,
                SUM(CASE WHEN profit_percent > 0 THEN 1 ELSE 0 END) as winning_trades,
                SUM(CASE WHEN profit_percent < 0 THEN 1 ELSE 0 END) as losing_trades,
                AVG(profit_percent) as avg_profit,
                SUM(profit) as total_profit,
                MAX(profit_percent) as max_profit,
                MIN(profit_percent) as min_profit
            FROM trades WHERE is_open = 0
        ''')
        
        stats_row = cursor.fetchone()
        
        cursor.execute('SELECT COUNT(*) as count FROM trades WHERE is_open = 1')
        open_trades = cursor.fetchone()['count']
        
        conn.close()
        
        total = stats_row['total_trades'] or 0
        winning = stats_row['winning_trades'] or 0
        
        return {
            "total_trades": total,
            "winning_trades": winning,
            "losing_trades": stats_row['losing_trades'] or 0,
            "open_trades": open_trades,
            "avg_profit": round(stats_row['avg_profit'] or 0, 2),
            "total_profit": round(stats_row['total_profit'] or 0, 2),
            "max_profit": round(stats_row['max_profit'] or 0, 2),
            "min_profit": round(stats_row['min_profit'] or 0, 2),
            "win_rate": (winning / total * 100) if total > 0 else 0
        }
