import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
// Use Node 22 built-in node:sqlite DatabaseSync
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (filename: string) => any;
};

function resolveSqliteDbPath(): string {
  const customEnvPath = (process.env.SQLITE_DB_PATH || '').trim();
  if (customEnvPath) {
    const resolvedCustom = path.resolve(customEnvPath);
    const customDir = path.dirname(resolvedCustom);
    if (fs.existsSync(customDir)) {
      return resolvedCustom;
    }
  }
  const localDbPath = path.resolve(process.cwd(), 'trades.sqlite');
  try {
    if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) {
      const renderDiskDbPath = '/data/trades.sqlite';
      if (!fs.existsSync(renderDiskDbPath) && fs.existsSync(localDbPath)) {
        try {
          fs.copyFileSync(localDbPath, renderDiskDbPath);
        } catch {
          // ignore copy error
        }
      }
      return renderDiskDbPath;
    }
  } catch {
    // fallback to localDbPath
  }
  return localDbPath;
}

const DB_PATH = resolveSqliteDbPath();

export interface SqliteBotLevelRow {
  id: string;
  pair: string;
  label: string;
  role: 'support' | 'resistance' | 'entry_trigger';
  price: number;
  touches?: number;
  bounces?: number;
  breaks?: number;
  strength_score?: number;
  source?: string;
  manual_override?: boolean;
  deleted?: boolean;
  updated_at: string;
}

export class SqliteBotDatabase {
  private db: any;

  constructor(dbPath = DB_PATH) {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema() {
    try {
      this.db.exec(`PRAGMA busy_timeout = 5000;`);
    } catch {
      // ignore pragma error
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pair TEXT NOT NULL,
        open_rate REAL NOT NULL,
        close_rate REAL,
        stake_amount REAL NOT NULL,
        amount REAL NOT NULL,
        is_open BOOLEAN DEFAULT 1,
        is_short BOOLEAN DEFAULT 0,
        leverage REAL DEFAULT 25.0,
        open_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        close_date TIMESTAMP,
        profit REAL,
        profit_percent REAL,
        fee REAL DEFAULT 0.0006,
        buy_tag TEXT,
        sell_reason TEXT,
        exchange TEXT DEFAULT 'binance',
        strategy TEXT DEFAULT 'ScalpingStrategy',
        timeframe TEXT DEFAULT '1h',
        dca_count INTEGER DEFAULT 0,
        last_dca_date TIMESTAMP,
        target_tp_rate REAL,
        stoploss_rate REAL,
        support_level REAL,
        resistance_level REAL,
        plan_notes TEXT,
        fee_open REAL DEFAULT 0.0,
        fee_close REAL DEFAULT 0.0,
        fee_total REAL DEFAULT 0.0,
        gross_profit REAL,
        net_profit REAL,
        net_profit_percent REAL,
        initial_amount REAL DEFAULT 0.0,
        initial_stake REAL DEFAULT 0.0,
        dca_history TEXT DEFAULT '[]',
        campaign_id TEXT,
        campaign_banked_profit REAL,
        trade_state TEXT DEFAULT 'WAITING_PULLBACK',
        next_dca_price REAL,
        target_profit_usdt REAL,
        pullback_min_profit_pct REAL DEFAULT 0.5,
        tp_manual_override INTEGER DEFAULT 0,
        sl_manual_override INTEGER DEFAULT 0,
        dca_manual_override INTEGER DEFAULT 0,
        planned_dca_json TEXT DEFAULT '[]',
        orders_json TEXT DEFAULT '[]',
        initial_open_rate REAL
      );

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
        status TEXT DEFAULT 'filled',
        exchange_order_id TEXT,
        cost REAL,
        fee REAL DEFAULT 0.0,
        realized_pnl REAL DEFAULT 0.0,
        action_type TEXT DEFAULT 'INITIAL_ENTRY',
        order_notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

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
      );

      CREATE TABLE IF NOT EXISTS bot_levels (
        id TEXT PRIMARY KEY,
        pair TEXT NOT NULL,
        label TEXT NOT NULL,
        role TEXT NOT NULL,
        price REAL NOT NULL,
        touches INTEGER DEFAULT 0,
        bounces INTEGER DEFAULT 0,
        breaks INTEGER DEFAULT 0,
        strength_score REAL DEFAULT 0,
        source TEXT DEFAULT '4H',
        manual_override INTEGER DEFAULT 0,
        deleted INTEGER DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS exchange_accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_label TEXT NOT NULL,
        exchange TEXT NOT NULL,
        market_type TEXT DEFAULT 'futures',
        api_key_masked TEXT NOT NULL,
        has_passphrase INTEGER DEFAULT 0,
        is_owner INTEGER DEFAULT 1,
        client_access_code TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        copy_trading INTEGER DEFAULT 1,
        copy_multiplier REAL DEFAULT 1.0,
        max_leverage INTEGER DEFAULT 25,
        balance_usdt REAL DEFAULT 1000,
        status TEXT DEFAULT 'connected',
        last_sync TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS site_auth (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner_login TEXT NOT NULL DEFAULT 'admin',
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_changed INTEGER DEFAULT 0,
        require_login INTEGER DEFAULT 1,
        session_secret TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS invite_links (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'client',
        enabled INTEGER DEFAULT 1,
        uses_count INTEGER DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chart_drawings (
        id TEXT PRIMARY KEY,
        pair TEXT NOT NULL,
        tool TEXT NOT NULL,
        points_json TEXT NOT NULL DEFAULT '[]',
        color TEXT DEFAULT '#2962ff',
        text TEXT,
        locked INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);

    // Initialize default owner credentials if not yet present
    try {
      const row = this.db.prepare(`SELECT id FROM site_auth WHERE id = 1`).get();
      const envLogin = (process.env.OWNER_LOGIN || '').trim();
      const envPass = (process.env.OWNER_PASSWORD || '').trim();
      if (!row) {
        const defaultLogin = envLogin || 'admin';
        const defaultPass = envPass || 'admin123';
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(defaultPass, salt, 64).toString('hex');
        const secret = crypto.randomBytes(32).toString('hex');
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        this.db
          .prepare(
            `INSERT INTO site_auth (id, owner_login, password_hash, password_salt, password_changed, require_login, session_secret, updated_at)
             VALUES (1, ?, ?, ?, ?, 1, ?, ?)`
          )
          .run(defaultLogin, hash, salt, envPass ? 1 : 0, secret, now);
      }
    } catch (e) {
      console.error('site_auth init error:', e);
    }

    const extraTradeCols = [
      ['tp_manual_override', 'INTEGER DEFAULT 0'],
      ['sl_manual_override', 'INTEGER DEFAULT 0'],
      ['dca_manual_override', 'INTEGER DEFAULT 0'],
      ['planned_dca_json', "TEXT DEFAULT '[]'"],
      ['orders_json', "TEXT DEFAULT '[]'"],
      ['initial_open_rate', 'REAL'],
      ['account_id', "TEXT DEFAULT 'master'"],
      ['account_name', "TEXT DEFAULT 'Master'"],
      ['parent_trade_id', 'INTEGER'],
      ['current_rate', 'REAL'],
      ['synced_accounts_json', "TEXT DEFAULT '[]'"],
    ];
    for (const [col, def] of extraTradeCols) {
      try {
        this.db.exec(`ALTER TABLE trades ADD COLUMN ${col} ${def}`);
      } catch {
        // column already exists
      }
    }

    const extraAccCols = [
      ['api_key_raw', 'TEXT'],
      ['api_secret_raw', 'TEXT'],
      ['passphrase_raw', 'TEXT'],
      ['connected_at', 'INTEGER DEFAULT 0'],
    ];
    for (const [col, def] of extraAccCols) {
      try {
        this.db.exec(`ALTER TABLE exchange_accounts ADD COLUMN ${col} ${def}`);
      } catch {
        // column already exists
      }
    }
  }

  private inTransaction = false;

  public runInTransaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      return fn();
    }
    this.inTransaction = true;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback error
      }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  public recordOrder(params: {
    trade_id: number;
    pair: string;
    order_type: string;
    side: string;
    price: number;
    amount: number;
    cost: number;
    fee: number;
    realized_pnl: number;
    action_type: string;
    notes: string;
  }) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO orders (trade_id, pair, order_type, side, price, amount, filled, remaining, status, cost, fee, realized_pnl, action_type, order_notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'filled', ?, ?, ?, ?, ?)
      `);
      stmt.run(
        params.trade_id,
        params.pair,
        params.order_type,
        params.side,
        params.price,
        params.amount,
        params.amount,
        params.cost,
        params.fee,
        params.realized_pnl,
        params.action_type,
        params.notes
      );
    } catch {
      // ignore non-critical order log failure
    }
  }

  public recordSignal(params: {
    pair: string;
    signal_type: string;
    direction: string;
    confidence: number;
    price: number;
    reason: string;
    indicators?: Record<string, any>;
  }) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO signals (pair, signal_type, direction, confidence, price, reason, indicators)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        params.pair,
        params.signal_type,
        params.direction,
        params.confidence,
        params.price,
        params.reason,
        JSON.stringify(params.indicators || {})
      );
    } catch {
      // ignore
    }
  }

  public getRecentSignals(limit = 30): any[] {
    try {
      return this.db
        .prepare(`SELECT * FROM signals ORDER BY id DESC LIMIT ?`)
        .all(limit);
    } catch {
      return [];
    }
  }

  public getRecentOrders(limit = 150): any[] {
    try {
      return this.db
        .prepare(`SELECT * FROM orders ORDER BY id DESC LIMIT ?`)
        .all(limit);
    } catch {
      return [];
    }
  }

  public getPnlAnalytics(): any {
    try {
      const closed = this.db
        .prepare(`SELECT * FROM trades WHERE is_open = 0 ORDER BY close_date DESC`)
        .all() as any[];
      let totalGross = 0;
      let totalNet = 0;
      let totalFees = 0;
      let wins = 0;
      let losses = 0;
      const byPair: Record<string, { trades: number; net_pnl: number; wins: number }> = {};

      for (const t of closed) {
        const net = Number(t.net_profit ?? t.profit ?? 0);
        const gross = Number(t.gross_profit ?? t.profit ?? 0);
        const fee = Number(t.fee_total ?? 0);
        totalGross += gross;
        totalNet += net;
        totalFees += fee;
        if (net >= 0) wins++;
        else losses++;

        const p = String(t.pair || 'UNKNOWN');
        if (!byPair[p]) byPair[p] = { trades: 0, net_pnl: 0, wins: 0 };
        byPair[p].trades += 1;
        byPair[p].net_pnl = Number((byPair[p].net_pnl + net).toFixed(4));
        if (net >= 0) byPair[p].wins += 1;
      }

      return {
        total_closed_trades: closed.length,
        winning_trades: wins,
        losing_trades: losses,
        win_rate: closed.length > 0 ? Number(((wins / closed.length) * 100).toFixed(1)) : 0,
        total_gross_profit: Number(totalGross.toFixed(4)),
        total_net_profit: Number(totalNet.toFixed(4)),
        total_fees: Number(totalFees.toFixed(4)),
        by_pair: byPair,
      };
    } catch {
      return {
        total_closed_trades: 0,
        winning_trades: 0,
        losing_trades: 0,
        win_rate: 0,
        total_gross_profit: 0,
        total_net_profit: 0,
        total_fees: 0,
        by_pair: {},
      };
    }
  }

  public upsertTrade(trade: any) {
    try {
      const existing = this.db
        .prepare(`SELECT id FROM trades WHERE id = ?`)
        .get(trade.trade_id);

      const rawOrders = Array.isArray(trade.orders) ? trade.orders : [];
      const derivedDcaHistory =
        Array.isArray(trade.dca_history) && trade.dca_history.length > 0
          ? trade.dca_history
          : rawOrders
              .filter((o: any) => Number(o.step) > 0)
              .map((o: any) => ({
                step: o.step,
                price: o.price,
                amount: o.amount,
                stake_amount: o.stake_amount,
                date: o.date,
                timestamp: o.timestamp,
                label: o.label,
              }));

      const dcaHistJson = JSON.stringify(derivedDcaHistory);
      const plannedDcaJson = JSON.stringify(trade.planned_dca_levels || []);
      const ordersJson = JSON.stringify(rawOrders);
      const syncedAccJson = JSON.stringify(trade.synced_accounts || []);
      const nextDca = trade.planned_dca_levels?.[0]?.price ?? trade.next_dca_price ?? null;

      if (!existing) {
        const stmt = this.db.prepare(`
          INSERT INTO trades (
            id, pair, open_rate, close_rate, stake_amount, amount,
            is_open, is_short, leverage, open_date, close_date,
            profit, profit_percent, fee, buy_tag, sell_reason,
            exchange, strategy, timeframe, dca_count, last_dca_date,
            target_tp_rate, stoploss_rate, support_level, resistance_level,
            plan_notes, fee_open, fee_close, fee_total, gross_profit,
            net_profit, net_profit_percent, initial_amount, initial_stake,
            dca_history, campaign_id, campaign_banked_profit, trade_state,
            next_dca_price, pullback_min_profit_pct,
            tp_manual_override, sl_manual_override, dca_manual_override,
            planned_dca_json, orders_json, initial_open_rate,
            account_id, account_name, parent_trade_id,
            current_rate, synced_accounts_json
          ) VALUES (
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?
          )
        `);
        stmt.run(
          trade.trade_id,
          trade.pair,
          trade.open_rate,
          trade.close_rate ?? null,
          trade.stake_amount,
          trade.amount,
          trade.is_open ? 1 : 0,
          trade.is_short ? 1 : 0,
          trade.leverage || 25,
          trade.open_date,
          trade.close_date ?? null,
          trade.profit_abs ?? 0,
          trade.profit_pct ?? 0,
          0.0006,
          trade.enter_tag || '',
          trade.exit_reason ?? null,
          trade.exchange || 'binance',
          trade.strategy || 'ScalpingStrategy',
          trade.timeframe || '1h',
          trade.dca_count || 0,
          trade.last_dca_date ?? null,
          trade.take_profit_abs || null,
          trade.stop_loss_abs || null,
          trade.support_level ?? null,
          trade.resistance_level ?? null,
          trade.plan_notes ?? null,
          trade.fee_open ?? 0,
          trade.fee_close ?? 0,
          trade.fee_total ?? 0,
          trade.gross_profit ?? trade.profit_abs ?? 0,
          trade.net_profit ?? trade.profit_abs ?? 0,
          trade.net_profit_percent ?? trade.profit_pct ?? 0,
          trade.initial_amount ?? trade.amount,
          trade.initial_stake ?? trade.stake_amount,
          dcaHistJson,
          trade.campaign_id ?? null,
          trade.campaign_banked_profit ?? null,
          trade.trade_state || (trade.dca_count > 0 ? 'DCA_ACTIVE' : 'WAITING_PULLBACK'),
          nextDca,
          trade.pullback_min_profit_pct ?? 0.5,
          trade.tp_manual_override ? 1 : 0,
          trade.sl_manual_override ? 1 : 0,
          trade.dca_manual_override ? 1 : 0,
          plannedDcaJson,
          ordersJson,
          trade.initial_open_rate ?? trade.open_rate,
          trade.account_id || 'master',
          trade.account_name || 'Master',
          trade.parent_trade_id ?? null,
          trade.current_rate ?? trade.open_rate,
          syncedAccJson
        );
      } else {
        const stmt = this.db.prepare(`
          UPDATE trades SET
            open_rate = ?, close_rate = ?, stake_amount = ?, amount = ?,
            is_open = ?, is_short = ?, leverage = ?, close_date = ?,
            profit = ?, profit_percent = ?, buy_tag = ?, sell_reason = ?,
            dca_count = ?, last_dca_date = ?, target_tp_rate = ?, stoploss_rate = ?,
            support_level = ?, resistance_level = ?, plan_notes = ?,
            fee_open = ?, fee_close = ?, fee_total = ?, gross_profit = ?,
            net_profit = ?, net_profit_percent = ?, dca_history = ?,
            campaign_id = ?, campaign_banked_profit = ?, trade_state = ?,
            next_dca_price = ?, tp_manual_override = ?, sl_manual_override = ?,
            dca_manual_override = ?, planned_dca_json = ?, orders_json = ?,
            account_id = ?, account_name = ?, parent_trade_id = ?,
            current_rate = ?, synced_accounts_json = ?
          WHERE id = ?
        `);
        stmt.run(
          trade.open_rate,
          trade.close_rate ?? null,
          trade.stake_amount,
          trade.amount,
          trade.is_open ? 1 : 0,
          trade.is_short ? 1 : 0,
          trade.leverage || 25,
          trade.close_date ?? null,
          trade.profit_abs ?? 0,
          trade.profit_pct ?? 0,
          trade.enter_tag || '',
          trade.exit_reason ?? null,
          trade.dca_count || 0,
          trade.last_dca_date ?? null,
          trade.take_profit_abs || null,
          trade.stop_loss_abs || null,
          trade.support_level ?? null,
          trade.resistance_level ?? null,
          trade.plan_notes ?? null,
          trade.fee_open ?? 0,
          trade.fee_close ?? 0,
          trade.fee_total ?? 0,
          trade.gross_profit ?? trade.profit_abs ?? 0,
          trade.net_profit ?? trade.profit_abs ?? 0,
          trade.net_profit_percent ?? trade.profit_pct ?? 0,
          dcaHistJson,
          trade.campaign_id ?? null,
          trade.campaign_banked_profit ?? null,
          trade.trade_state || (trade.is_open ? (trade.dca_count > 0 ? 'DCA_ACTIVE' : 'WAITING_PULLBACK') : 'CLOSED'),
          nextDca,
          trade.tp_manual_override ? 1 : 0,
          trade.sl_manual_override ? 1 : 0,
          trade.dca_manual_override ? 1 : 0,
          plannedDcaJson,
          ordersJson,
          trade.account_id || 'master',
          trade.account_name || 'Master',
          trade.parent_trade_id ?? null,
          trade.current_rate ?? trade.open_rate,
          syncedAccJson,
          trade.trade_id
        );
      }
    } catch (e) {
      console.error('SQLite upsertTrade error:', e);
    }
  }

  public deleteTrade(tradeId: number) {
    try {
      this.db.prepare(`DELETE FROM orders WHERE trade_id = ?`).run(tradeId);
      this.db.prepare(`DELETE FROM trades WHERE id = ?`).run(tradeId);
    } catch (e) {
      console.error('SQLite deleteTrade error:', e);
    }
  }

  public loadAllTrades(): any[] {
    try {
      const rows = this.db.prepare(`SELECT * FROM trades ORDER BY id DESC`).all();
      return rows.map((r: any) => {
        const pair = String(r.pair || 'ETH/USDT:USDT');
        const [base, quote] = pair.split(':')[0].split('/');
        let orders: any[] = [];
        let plannedDca: any[] = [];
        let dcaHistory: any[] = [];
        let syncedAccounts: string[] = [];
        try {
          orders = JSON.parse(r.orders_json || '[]');
        } catch {
          orders = [];
        }
        try {
          plannedDca = JSON.parse(r.planned_dca_json || '[]');
        } catch {
          plannedDca = [];
        }
        try {
          dcaHistory = JSON.parse(r.dca_history || '[]');
        } catch {
          dcaHistory = [];
        }
        try {
          syncedAccounts = JSON.parse(r.synced_accounts_json || '[]');
        } catch {
          syncedAccounts = [];
        }

        const openDateStr = String(r.open_date || new Date().toISOString().replace('T', ' ').slice(0, 19));
        const openTs = Date.parse(openDateStr) || Date.now();
        const closeDateStr = r.close_date ? String(r.close_date) : null;
        const closeTs = closeDateStr ? Date.parse(closeDateStr) || Date.now() : null;
        const tradeIdNum = Number(r.id);
        const isShortBool = Boolean(r.is_short);

        // Резервное восстановление цепочки ордеров (Нач. вход + все шаги DCA) из таблицы orders, если orders_json был пуст
        if (!Array.isArray(orders) || orders.length === 0) {
          try {
            const dbOrderRows = this.db
              .prepare(
                `SELECT * FROM orders WHERE trade_id = ? AND action_type NOT LIKE '%EXIT%' AND action_type NOT LIKE '%PROFIT%' ORDER BY id ASC`
              )
              .all(tradeIdNum);
            if (dbOrderRows.length > 0) {
              orders = dbOrderRows.map((o: any, idx: number) => ({
                id: `ord-${tradeIdNum}-${idx}`,
                step: idx,
                label:
                  idx === 0
                    ? `Нач. вход #1 (${isShortBool ? 'Шорт' : 'Лонг'})`
                    : `Усреднение #${idx}`,
                side: isShortBool ? 'short' : 'long',
                price: Number(o.price || r.open_rate),
                amount: Number(o.amount || r.amount),
                stake_amount: Number(o.cost || r.stake_amount),
                timestamp: Date.parse(String(o.created_at || openDateStr)) || openTs,
                date: String(o.created_at || openDateStr),
              }));
            } else {
              orders = [
                {
                  id: `ord-${tradeIdNum}-0`,
                  step: 0,
                  label: `Нач. вход #1 (${isShortBool ? 'Шорт' : 'Лонг'})`,
                  side: isShortBool ? 'short' : 'long',
                  price: Number(r.initial_open_rate || r.open_rate || 0),
                  amount: Number(r.initial_amount || r.amount || 0),
                  stake_amount: Number(r.initial_stake || r.stake_amount || 0),
                  timestamp: openTs,
                  date: openDateStr,
                },
              ];
            }
          } catch {
            // fallback
          }
        }

        if ((!Array.isArray(dcaHistory) || dcaHistory.length === 0) && orders.length > 1) {
          dcaHistory = orders
            .filter((o: any) => Number(o.step) > 0)
            .map((o: any) => ({
              step: o.step,
              price: o.price,
              amount: o.amount,
              stake_amount: o.stake_amount,
              date: o.date,
              timestamp: o.timestamp,
              label: o.label,
            }));
        }

        return {
          trade_id: tradeIdNum,
          pair,
          base_currency: base || 'ETH',
          quote_currency: quote || 'USDT',
          is_open: Boolean(r.is_open),
          is_short: isShortBool,
          exchange: String(r.exchange || 'binance'),
          account_id: String(r.account_id || 'master'),
          account_name: String(r.account_name || 'Master'),
          parent_trade_id: r.parent_trade_id ? Number(r.parent_trade_id) : undefined,
          synced_accounts: syncedAccounts.length > 0 ? syncedAccounts : undefined,
          amount: Number(r.amount || 0),
          initial_amount: Number(r.initial_amount || r.amount || 0),
          stake_amount: Number(r.stake_amount || 0),
          initial_stake: Number(r.initial_stake || r.stake_amount || 0),
          strategy: String(r.strategy || 'ScalpingStrategy'),
          timeframe: String(r.timeframe || '1h'),
          enter_tag: String(r.buy_tag || (isShortBool ? 'Short' : 'Long')),
          open_date: openDateStr,
          open_timestamp: openTs,
          open_rate: Number(r.open_rate || 0),
          initial_open_rate: Number(r.initial_open_rate || r.open_rate || 0),
          dca_count: Number(r.dca_count || 0),
          last_dca_date: r.last_dca_date ? String(r.last_dca_date) : null,
          current_rate: Number(r.close_rate || r.current_rate || r.open_rate || 0),
          close_date: closeDateStr,
          close_timestamp: closeTs,
          close_rate: r.close_rate !== null && r.close_rate !== undefined ? Number(r.close_rate) : null,
          profit_ratio: Number(((r.profit_percent || 0) / 100).toFixed(4)),
          profit_pct: Number(r.profit_percent || 0),
          profit_abs: Number(r.net_profit ?? r.profit ?? 0),
          take_profit_abs: Number(r.target_tp_rate || 0),
          take_profit_pct: 1.8,
          tp_manual_override: Boolean(r.tp_manual_override),
          stop_loss_abs: Number(r.stoploss_rate || 0),
          stop_loss_pct: -3.0,
          sl_manual_override: Boolean(r.sl_manual_override),
          dca_manual_override: Boolean(r.dca_manual_override),
          initial_stop_loss_abs: Number(r.stoploss_rate || 0),
          initial_stop_loss_pct: -3.0,
          exit_reason: r.sell_reason ? String(r.sell_reason) : null,
          leverage: Number(r.leverage || 25),
          support_level: r.support_level ? Number(r.support_level) : undefined,
          resistance_level: r.resistance_level ? Number(r.resistance_level) : undefined,
          next_dca_price: r.next_dca_price ? Number(r.next_dca_price) : undefined,
          trade_state: String(r.trade_state || (Number(r.dca_count || 0) > 0 ? 'AVERAGED' : 'WAITING_PULLBACK')),
          pullback_min_profit_pct: Number(r.pullback_min_profit_pct ?? 0.5),
          plan_notes: r.plan_notes ? String(r.plan_notes) : undefined,
          campaign_id: r.campaign_id ? String(r.campaign_id) : undefined,
          campaign_banked_profit:
            r.campaign_banked_profit !== null && r.campaign_banked_profit !== undefined
              ? Number(r.campaign_banked_profit)
              : undefined,
          fee_open: Number(r.fee_open || 0),
          fee_close: Number(r.fee_close || 0),
          fee_total: Number(r.fee_total || 0),
          gross_profit: Number(r.gross_profit ?? r.profit ?? 0),
          net_profit: Number(r.net_profit ?? r.profit ?? 0),
          net_profit_percent: Number(r.net_profit_percent ?? r.profit_percent ?? 0),
          dca_history: dcaHistory,
          orders,
          planned_dca_levels: plannedDca,
        };
      });
    } catch {
      return [];
    }
  }

  public getBotLevelsForPair(pair: string): SqliteBotLevelRow[] {
    try {
      const rows = this.db
        .prepare(`SELECT * FROM bot_levels WHERE pair = ? AND deleted = 0 ORDER BY price DESC`)
        .all(pair.toUpperCase());
      return rows.map((r: any) => ({
        id: String(r.id),
        pair: String(r.pair),
        label: String(r.label),
        role: (r.role === 'resistance' ? 'resistance' : r.role === 'entry_trigger' ? 'entry_trigger' : 'support') as SqliteBotLevelRow['role'],
        price: Number(r.price),
        touches: Number(r.touches || 0),
        bounces: Number(r.bounces || 0),
        breaks: Number(r.breaks || 0),
        strength_score: Number(r.strength_score || 0),
        source: String(r.source || '4H'),
        manual_override: Boolean(r.manual_override),
        deleted: Boolean(r.deleted),
        updated_at: String(r.updated_at),
      }));
    } catch {
      return [];
    }
  }

  public hasAnyBotLevelsRecordForPair(pair: string): boolean {
    try {
      const row = this.db
        .prepare(`SELECT COUNT(*) as cnt FROM bot_levels WHERE pair = ?`)
        .get(pair.toUpperCase());
      return Number(row?.cnt || 0) > 0;
    } catch {
      return false;
    }
  }

  public upsertBotLevel(level: SqliteBotLevelRow) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO bot_levels (id, pair, label, role, price, touches, bounces, breaks, strength_score, source, manual_override, deleted, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          role = excluded.role,
          price = excluded.price,
          touches = excluded.touches,
          bounces = excluded.bounces,
          breaks = excluded.breaks,
          strength_score = excluded.strength_score,
          source = excluded.source,
          manual_override = excluded.manual_override,
          deleted = excluded.deleted,
          updated_at = excluded.updated_at
      `);
      stmt.run(
        level.id,
        level.pair.toUpperCase(),
        level.label,
        level.role,
        level.price,
        level.touches || 0,
        level.bounces || 0,
        level.breaks || 0,
        level.strength_score || 0,
        level.source || '4H',
        level.manual_override ? 1 : 0,
        level.deleted ? 1 : 0,
        level.updated_at
      );
    } catch (e) {
      console.error('upsertBotLevel error:', e);
    }
  }

  public markBotLevelDeleted(id: string) {
    try {
      this.db.prepare(`UPDATE bot_levels SET deleted = 1 WHERE id = ?`).run(id);
    } catch {
      // ignore
    }
  }

  public getAllBotLevelsForPairIncludeDeleted(pair: string): SqliteBotLevelRow[] {
    try {
      const rows = this.db
        .prepare(`SELECT * FROM bot_levels WHERE pair = ? ORDER BY price DESC`)
        .all(pair.toUpperCase());
      return rows.map((r: any) => ({
        id: String(r.id),
        pair: String(r.pair),
        label: String(r.label),
        role: (r.role === 'resistance' ? 'resistance' : r.role === 'entry_trigger' ? 'entry_trigger' : 'support') as SqliteBotLevelRow['role'],
        price: Number(r.price),
        touches: Number(r.touches || 0),
        bounces: Number(r.bounces || 0),
        breaks: Number(r.breaks || 0),
        strength_score: Number(r.strength_score || 0),
        source: String(r.source || '4H'),
        manual_override: Boolean(r.manual_override),
        deleted: Boolean(r.deleted),
        updated_at: String(r.updated_at),
      }));
    } catch {
      return [];
    }
  }

  public replaceAutoBotLevelsWithManual(pair: string, role: string, keepId: string) {
    try {
      this.db
        .prepare(
          `DELETE FROM bot_levels WHERE pair = ? AND role = ? AND manual_override = 0 AND id != ?`
        )
        .run(pair.toUpperCase(), role, keepId);
    } catch {
      // ignore
    }
  }

  public clearBotLevelsForPair(pair: string) {
    try {
      this.db.prepare(`DELETE FROM bot_levels WHERE pair = ?`).run(pair.toUpperCase());
    } catch {
      // ignore
    }
  }

  public getChartDrawingsForPair(pair: string): any[] {
    try {
      const rows = this.db
        .prepare(`SELECT * FROM chart_drawings WHERE pair = ? ORDER BY rowid ASC`)
        .all(pair.toUpperCase());
      return rows.map((r: any) => {
        let pts: any[] = [];
        try {
          pts = JSON.parse(String(r.points_json || '[]'));
        } catch {
          pts = [];
        }
        return {
          id: String(r.id),
          pair: String(r.pair),
          tool: String(r.tool),
          points: Array.isArray(pts) ? pts : [],
          color: String(r.color || '#2962ff'),
          text: r.text ? String(r.text) : undefined,
          locked: Boolean(r.locked),
          created_at: String(r.created_at || ''),
        };
      });
    } catch {
      return [];
    }
  }

  public upsertChartDrawing(drawing: {
    id: string;
    pair: string;
    tool: string;
    points: any[];
    color: string;
    text?: string;
    locked?: boolean;
    created_at: string;
  }) {
    try {
      this.db
        .prepare(
          `INSERT INTO chart_drawings (id, pair, tool, points_json, color, text, locked, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             pair = excluded.pair,
             tool = excluded.tool,
             points_json = excluded.points_json,
             color = excluded.color,
             text = excluded.text,
             locked = excluded.locked`
        )
        .run(
          drawing.id,
          drawing.pair.toUpperCase(),
          drawing.tool,
          JSON.stringify(drawing.points || []),
          drawing.color || '#2962ff',
          drawing.text ?? null,
          drawing.locked ? 1 : 0,
          drawing.created_at || new Date().toISOString().replace('T', ' ').slice(0, 19)
        );
    } catch (e) {
      console.error('upsertChartDrawing error:', e);
    }
  }

  public deleteChartDrawing(id: string) {
    try {
      this.db.prepare(`DELETE FROM chart_drawings WHERE id = ?`).run(id);
    } catch {
      // ignore
    }
  }

  public clearChartDrawingsForPair(pair: string) {
    try {
      this.db.prepare(`DELETE FROM chart_drawings WHERE pair = ?`).run(pair.toUpperCase());
    } catch {
      // ignore
    }
  }

  public loadExchangeAccounts(): any[] {
    try {
      const rows = this.db.prepare(`SELECT * FROM exchange_accounts ORDER BY rowid ASC`).all();
      return rows.map((r: any) => ({
        id: String(r.id),
        name: String(r.name),
        owner_label: String(r.owner_label || r.name),
        exchange: String(r.exchange),
        market_type: r.market_type === 'spot' ? 'spot' : 'futures',
        api_key_masked: String(r.api_key_masked),
        api_key_raw: r.api_key_raw ? String(r.api_key_raw) : undefined,
        api_secret_raw: r.api_secret_raw ? String(r.api_secret_raw) : undefined,
        passphrase_raw: r.passphrase_raw ? String(r.passphrase_raw) : undefined,
        connected_at: Number(r.connected_at || 0),
        has_passphrase: Boolean(r.has_passphrase),
        is_owner: Boolean(r.is_owner),
        client_access_code: String(r.client_access_code),
        enabled: Boolean(r.enabled),
        copy_trading: Boolean(r.copy_trading),
        copy_multiplier: Number(r.copy_multiplier || 1.0),
        max_leverage: Number(r.max_leverage || 25),
        balance_usdt: Number(r.balance_usdt || 1000),
        unrealized_pnl: 0,
        open_trades_count: 0,
        status: r.status === 'paused' ? 'paused' : 'connected',
        last_sync: String(r.last_sync),
      }));
    } catch {
      return [];
    }
  }

  public upsertExchangeAccount(acc: any) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO exchange_accounts (
          id, name, owner_label, exchange, market_type, api_key_masked,
          has_passphrase, is_owner, client_access_code, enabled,
          copy_trading, copy_multiplier, max_leverage, balance_usdt,
          status, last_sync, api_key_raw, api_secret_raw, passphrase_raw, connected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          owner_label = excluded.owner_label,
          enabled = excluded.enabled,
          copy_trading = excluded.copy_trading,
          copy_multiplier = excluded.copy_multiplier,
          max_leverage = excluded.max_leverage,
          balance_usdt = excluded.balance_usdt,
          client_access_code = excluded.client_access_code,
          status = excluded.status,
          last_sync = excluded.last_sync,
          api_key_raw = COALESCE(excluded.api_key_raw, exchange_accounts.api_key_raw),
          api_secret_raw = COALESCE(excluded.api_secret_raw, exchange_accounts.api_secret_raw),
          passphrase_raw = COALESCE(excluded.passphrase_raw, exchange_accounts.passphrase_raw),
          connected_at = CASE WHEN exchange_accounts.connected_at > 0 THEN exchange_accounts.connected_at ELSE excluded.connected_at END
      `);
      stmt.run(
        acc.id,
        acc.name,
        acc.owner_label || acc.name,
        acc.exchange,
        acc.market_type || 'futures',
        acc.api_key_masked,
        acc.has_passphrase ? 1 : 0,
        acc.is_owner ? 1 : 0,
        acc.client_access_code,
        acc.enabled ? 1 : 0,
        acc.copy_trading ? 1 : 0,
        acc.copy_multiplier || 1.0,
        acc.max_leverage || 25,
        acc.balance_usdt || 1000,
        acc.status || 'connected',
        acc.last_sync,
        acc.api_key_raw ?? null,
        acc.api_secret_raw ?? null,
        acc.passphrase_raw ?? null,
        acc.connected_at || Date.now()
      );
    } catch (e) {
      console.error('upsertExchangeAccount error:', e);
    }
  }

  public deleteExchangeAccount(id: string) {
    try {
      this.db.prepare(`DELETE FROM exchange_accounts WHERE id = ?`).run(id);
    } catch {
      // ignore
    }
  }

  public clearAllExchangeAccounts() {
    try {
      this.db.prepare(`DELETE FROM exchange_accounts`).run();
      this.db.prepare(`DELETE FROM signals`).run();
      this.db.prepare(`DELETE FROM bot_levels WHERE manual_override = 0`).run();
    } catch {
      // ignore
    }
  }

  public getSiteAuthConfig(): {
    owner_login: string;
    password_changed: boolean;
    require_login: boolean;
    has_env_secrets: boolean;
  } {
    const envLogin = (process.env.OWNER_LOGIN || '').trim();
    const envPass = (process.env.OWNER_PASSWORD || '').trim();
    const hasEnvSecrets = Boolean(envLogin && envPass);
    try {
      const row = this.db.prepare(`SELECT * FROM site_auth WHERE id = 1`).get() as any;
      if (!row) {
        return {
          owner_login: envLogin || 'admin',
          password_changed: hasEnvSecrets,
          require_login: true,
          has_env_secrets: hasEnvSecrets,
        };
      }
      return {
        owner_login: envLogin || String(row.owner_login || 'admin'),
        password_changed: hasEnvSecrets || Boolean(row.password_changed),
        require_login: Boolean(row.require_login),
        has_env_secrets: hasEnvSecrets,
      };
    } catch {
      return {
        owner_login: envLogin || 'admin',
        password_changed: hasEnvSecrets,
        require_login: true,
        has_env_secrets: hasEnvSecrets,
      };
    }
  }

  public verifyOwnerCredentials(login: string, password: string): boolean {
    try {
      const envLogin = (process.env.OWNER_LOGIN || '').trim();
      const envPass = (process.env.OWNER_PASSWORD || '').trim();

      const inputLogin = String(login || '').trim().toLowerCase();
      const inputPass = String(password || '');

      // 1. If OWNER_LOGIN and OWNER_PASSWORD are set in Secrets (.env), verify against Secrets first
      if (envLogin && envPass) {
        const loginMatch = inputLogin === envLogin.toLowerCase();
        const passHashA = crypto.createHash('sha256').update(inputPass).digest();
        const passHashB = crypto.createHash('sha256').update(envPass).digest();
        const passMatch = crypto.timingSafeEqual(passHashA, passHashB);
        if (loginMatch && passMatch) return true;
        return false;
      }

      // 2. Otherwise verify against site_auth table in trades.sqlite
      const row = this.db.prepare(`SELECT * FROM site_auth WHERE id = 1`).get() as any;
      if (!row) return false;
      const expectedLogin = (envLogin || String(row.owner_login || 'admin')).trim().toLowerCase();
      if (inputLogin !== expectedLogin) {
        return false;
      }
      if (envPass) {
        const passHashA = crypto.createHash('sha256').update(inputPass).digest();
        const passHashB = crypto.createHash('sha256').update(envPass).digest();
        return crypto.timingSafeEqual(passHashA, passHashB);
      }
      const computed = crypto
        .scryptSync(inputPass, String(row.password_salt), 64)
        .toString('hex');
      return crypto.timingSafeEqual(
        Buffer.from(computed, 'hex'),
        Buffer.from(String(row.password_hash), 'hex')
      );
    } catch {
      return false;
    }
  }

  public verifyClientAccessCode(code: string): any | null {
    try {
      const cleanCode = String(code || '').trim().toUpperCase();
      if (!cleanCode) return null;
      const row = this.db
        .prepare(`SELECT * FROM exchange_accounts WHERE UPPER(client_access_code) = ?`)
        .get(cleanCode) as any;
      return row || null;
    } catch {
      return null;
    }
  }

  public listInviteLinks(): Array<{
    id: string;
    label: string;
    token: string;
    role: 'client' | 'owner';
    enabled: boolean;
    uses_count: number;
    last_used_at: string | null;
    created_at: string;
  }> {
    try {
      const rows = this.db
        .prepare(`SELECT * FROM invite_links ORDER BY created_at DESC`)
        .all() as any[];
      return rows.map((r) => ({
        id: String(r.id),
        label: String(r.label),
        token: String(r.token),
        role: r.role === 'owner' ? 'owner' : 'client',
        enabled: Boolean(r.enabled),
        uses_count: Number(r.uses_count || 0),
        last_used_at: r.last_used_at ? String(r.last_used_at) : null,
        created_at: String(r.created_at),
      }));
    } catch {
      return [];
    }
  }

  public createInviteLink(label: string, role: 'client' | 'owner' = 'client') {
    const id = `inv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const token = `inv_${crypto.randomBytes(18).toString('hex')}`;
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const cleanLabel = String(label || 'Гостевой доступ').trim() || 'Гостевой доступ';
    const cleanRole: 'client' | 'owner' = role === 'owner' ? 'owner' : 'client';

    this.db
      .prepare(
        `INSERT INTO invite_links (id, label, token, role, enabled, uses_count, last_used_at, created_at)
         VALUES (?, ?, ?, ?, 1, 0, NULL, ?)`
      )
      .run(id, cleanLabel, token, cleanRole, now);

    return {
      id,
      label: cleanLabel,
      token,
      role: cleanRole,
      enabled: true,
      uses_count: 0,
      last_used_at: null,
      created_at: now,
    };
  }

  public deleteInviteLink(id: string) {
    try {
      this.db.prepare(`DELETE FROM invite_links WHERE id = ?`).run(String(id));
    } catch {
      // ignore
    }
  }

  public consumeInviteToken(inviteToken: string): {
    id: string;
    label: string;
    token: string;
    role: 'client' | 'owner';
  } | null {
    try {
      const cleanToken = String(inviteToken || '').trim();
      if (!cleanToken) return null;
      const row = this.db
        .prepare(`SELECT * FROM invite_links WHERE token = ? AND enabled = 1`)
        .get(cleanToken) as any;
      if (!row) return null;
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      this.db
        .prepare(`UPDATE invite_links SET uses_count = uses_count + 1, last_used_at = ? WHERE id = ?`)
        .run(now, row.id);
      return {
        id: String(row.id),
        label: String(row.label),
        token: String(row.token),
        role: row.role === 'owner' ? 'owner' : 'client',
      };
    } catch {
      return null;
    }
  }

  public updateOwnerCredentials(params: {
    newLogin?: string;
    newPassword?: string;
    requireLogin?: boolean;
  }): {
    owner_login: string;
    password_changed: boolean;
    require_login: boolean;
    has_env_secrets: boolean;
  } {
    try {
      const row = this.db.prepare(`SELECT * FROM site_auth WHERE id = 1`).get() as any;
      if (!row) return this.getSiteAuthConfig();

      const nextLogin =
        params.newLogin && params.newLogin.trim().length >= 2
          ? params.newLogin.trim()
          : String(row.owner_login);
      let nextHash = String(row.password_hash);
      let nextSalt = String(row.password_salt);
      let nextChanged = Number(row.password_changed || 0);

      if (params.newPassword && params.newPassword.trim().length >= 4) {
        nextSalt = crypto.randomBytes(16).toString('hex');
        nextHash = crypto.scryptSync(params.newPassword.trim(), nextSalt, 64).toString('hex');
        nextChanged = 1;
      }

      const nextRequire =
        params.requireLogin !== undefined ? (params.requireLogin ? 1 : 0) : Number(row.require_login);
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

      this.db
        .prepare(
          `UPDATE site_auth
           SET owner_login = ?, password_hash = ?, password_salt = ?, password_changed = ?, require_login = ?, updated_at = ?
           WHERE id = 1`
        )
        .run(nextLogin, nextHash, nextSalt, nextChanged, nextRequire, now);
    } catch (e) {
      console.error('updateOwnerCredentials error:', e);
    }
    return this.getSiteAuthConfig();
  }

  public createAuthToken(payload: {
    role: 'owner' | 'client';
    login: string;
    accountId?: string;
    inviteId?: string;
  }): string {
    try {
      const row = this.db.prepare(`SELECT session_secret FROM site_auth WHERE id = 1`).get() as any;
      const secret = String(row?.session_secret || 'scalpbot-fallback-secret');
      const data = JSON.stringify({
        role: payload.role,
        login: payload.login,
        accountId: payload.accountId || '',
        inviteId: payload.inviteId || '',
        exp: Date.now() + 1000 * 60 * 60 * 24 * 30, // 30 days
      });
      const b64 = Buffer.from(data, 'utf8').toString('base64url');
      const sig = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
      return `${b64}.${sig}`;
    } catch {
      return '';
    }
  }

  public verifyAuthToken(token: string): {
    valid: boolean;
    role?: 'owner' | 'client';
    login?: string;
    accountId?: string;
    inviteId?: string;
  } {
    try {
      if (!token || !token.includes('.')) return { valid: false };
      const [b64, sig] = token.split('.');
      const row = this.db.prepare(`SELECT session_secret FROM site_auth WHERE id = 1`).get() as any;
      const secret = String(row?.session_secret || 'scalpbot-fallback-secret');
      const expectedSig = crypto.createHmac('sha256', secret).update(b64).digest('base64url');
      if (sig !== expectedSig) return { valid: false };
      const parsed = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
      if (!parsed || typeof parsed.exp !== 'number' || Date.now() > parsed.exp) {
        return { valid: false };
      }
      // If token came from an invite link, verify the invite link has not been revoked
      if (parsed.inviteId) {
        const inv = this.db
          .prepare(`SELECT enabled FROM invite_links WHERE id = ?`)
          .get(String(parsed.inviteId)) as any;
        if (!inv || !inv.enabled) {
          return { valid: false };
        }
      }
      return {
        valid: true,
        role: parsed.role === 'client' ? 'client' : 'owner',
        login: String(parsed.login || 'admin'),
        accountId: parsed.accountId ? String(parsed.accountId) : undefined,
        inviteId: parsed.inviteId ? String(parsed.inviteId) : undefined,
      };
    } catch {
      return { valid: false };
    }
  }
}
