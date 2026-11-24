import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import {
  sanitizePositionMarginUsdt,
  sanitizeWalletUsedMarginUsdt,
} from './exchangeWebSocket';

const require = createRequire(import.meta.url);
// Use Node 22 built-in node:sqlite DatabaseSync
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (filename: string) => any;
};

function getPersistentHomeDir(): string | null {
  try {
    const home = os.homedir();
    if (!home) return null;
    const dir = path.join(home, '.scalpbot');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  } catch {
    return null;
  }
}

function resolveSqliteDbPath(): string {
  const customEnvPath = (process.env.SQLITE_DB_PATH || '').trim();
  if (
    customEnvPath &&
    (customEnvPath.endsWith('.sqlite') ||
      customEnvPath.endsWith('.sqlite3') ||
      customEnvPath.endsWith('.db'))
  ) {
    const resolvedCustom = path.resolve(customEnvPath);
    const customDir = path.dirname(resolvedCustom);
    if (fs.existsSync(customDir)) {
      return resolvedCustom;
    }
  }
  const localDbPath = path.resolve(process.cwd(), 'trades.sqlite');
  try {
    if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) {
      // Локальную trades.sqlite на диск /data не копируем: если база попала в образ,
      // вместе с ней на сервер уехал бы чужой session_secret. Пустая база создаётся автоматически.
      return '/data/trades.sqlite';
    }
  } catch {
    // fallback to localDbPath
  }

  // Если при обновлении кода на сервере рабочая папка пересоздана, восстанавливаем БД из ~/.scalpbot/trades.sqlite.bak
  try {
    const homeDir = getPersistentHomeDir();
    if (homeDir) {
      const homeDbBak = path.join(homeDir, 'trades.sqlite.bak');
      if (!fs.existsSync(localDbPath) && fs.existsSync(homeDbBak)) {
        fs.copyFileSync(homeDbBak, localDbPath);
      }
    }
  } catch {
    // ignore
  }
  return localDbPath;
}

const DB_PATH = resolveSqliteDbPath();

/**
 * Версия секрета подписи сессий. Секреты с версией ниже текущей считаются скомпрометированными:
 * до версии 2 файл trades.sqlite (вместе с session_secret) лежал в репозитории и Docker-образе.
 * При старте такой секрет заменяется новым, и все старые токены перестают работать.
 */
const SESSION_SECRET_VERSION = 2;

/**
 * Читает секрет из окружения: обрезает пробелы и одну пару обрамляющих кавычек.
 * В панелях Railway/Render значение часто вставляют в формате .env (`"мой-пароль"`),
 * и кавычки тогда становятся частью пароля — из-за этого вход «не принимал» верный пароль.
 */
function readEnvSecret(name: 'OWNER_LOGIN' | 'OWNER_PASSWORD' | 'SESSION_SECRET'): string {
  const raw = String(process.env[name] || '').trim();
  const quoted = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw[raw.length - 1] === raw[0];
  return (quoted ? raw.slice(1, -1) : raw).trim();
}

function generateRandomOwnerPassword(): string {
  return crypto.randomBytes(12).toString('base64url');
}

function announceGeneratedOwnerPassword(login: string, password: string): void {
  console.warn(
    [
      '',
      '================================================================',
      ' OWNER_PASSWORD не задан — сгенерирован случайный пароль владельца:',
      `   логин:  ${login}`,
      `   пароль: ${password}`,
      ' Сохраните его или задайте OWNER_PASSWORD в переменных окружения.',
      ' Повторно этот пароль показан не будет.',
      '================================================================',
      '',
    ].join('\n')
  );
}

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

      -- Разовые миграции данных (чтобы выполнялись ровно один раз)
      CREATE TABLE IF NOT EXISTS app_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        note TEXT
      );

      -- Журнал сигналов разворота, на которые смотрел бот, и их фактический исход
      CREATE TABLE IF NOT EXISTS reversal_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        pair TEXT NOT NULL,
        timeframe TEXT NOT NULL DEFAULT '4h',
        candle_ts INTEGER NOT NULL,
        side TEXT NOT NULL,
        level REAL NOT NULL,
        price REAL NOT NULL,
        atr REAL NOT NULL,
        purpose TEXT NOT NULL,
        daily_trend TEXT NOT NULL,
        with_trend INTEGER NOT NULL DEFAULT 0,
        acted INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL DEFAULT 'pending',
        bars_to_outcome INTEGER,
        resolved_at INTEGER,
        UNIQUE(pair, timeframe, candle_ts, side, purpose)
      );
    `);

    try {
      this.db.exec(`ALTER TABLE site_auth ADD COLUMN secret_version INTEGER DEFAULT 0`);
    } catch {
      // column already exists
    }

    // Initialize default owner credentials if not yet present
    try {
      const row = this.db.prepare(`SELECT id FROM site_auth WHERE id = 1`).get();
      const envLogin = readEnvSecret('OWNER_LOGIN');
      const envPass = readEnvSecret('OWNER_PASSWORD');
      if (!row) {
        const defaultLogin = envLogin || 'admin';
        // Без OWNER_PASSWORD генерируем случайный пароль вместо общеизвестного admin123
        const defaultPass = envPass || generateRandomOwnerPassword();
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(defaultPass, salt, 64).toString('hex');
        const secret = crypto.randomBytes(32).toString('hex');
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        this.db
          .prepare(
            `INSERT INTO site_auth (id, owner_login, password_hash, password_salt, password_changed, require_login, session_secret, updated_at, secret_version)
             VALUES (1, ?, ?, ?, ?, 1, ?, ?, ?)`
          )
          .run(defaultLogin, hash, salt, envPass ? 1 : 0, secret, now, SESSION_SECRET_VERSION);
        if (!envPass) {
          announceGeneratedOwnerPassword(defaultLogin, defaultPass);
        }
      }
    } catch (e) {
      console.error('site_auth init error:', e);
    }

    this.migrateLeakedAuthSecrets();

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
      ['open_timestamp', 'INTEGER'],
      ['close_timestamp', 'INTEGER'],
      ['user_id', "TEXT DEFAULT 'owner'"],
      ['campaign_role', 'TEXT'],
      ['rehedge_stop_price', 'REAL'],
      ['rehedge_stop_qty', 'REAL'],
      ['whipsaw_stop_price', 'REAL'],
      ['tail_bites_count', 'INTEGER DEFAULT 0'],
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
      ['is_testnet', 'INTEGER DEFAULT 0'],
      ['user_id', "TEXT DEFAULT 'owner'"],
      ['used_margin_usdt', 'REAL DEFAULT 0'],
      ['available_balance_usdt', 'REAL DEFAULT 0'],
    ];
    for (const [col, def] of extraAccCols) {
      try {
        this.db.exec(`ALTER TABLE exchange_accounts ADD COLUMN ${col} ${def}`);
      } catch {
        // column already exists
      }
    }

    const extraDrawingCols = [['user_id', "TEXT DEFAULT 'owner'"]];
    for (const [col, def] of extraDrawingCols) {
      try {
        this.db.exec(`ALTER TABLE chart_drawings ADD COLUMN ${col} ${def}`);
      } catch {
        // column already exists
      }
    }

    const extraBotLevelCols = [['user_id', "TEXT DEFAULT 'owner'"]];
    for (const [col, def] of extraBotLevelCols) {
      try {
        this.db.exec(`ALTER TABLE bot_levels ADD COLUMN ${col} ${def}`);
      } catch {
        // column already exists
      }
    }
  }

  private parseStoredUtcTimestamp(dateStr?: string | null, explicitTs?: number | null): number | null {
    if (explicitTs && Number.isFinite(Number(explicitTs)) && Number(explicitTs) > 0) {
      return Number(explicitTs);
    }
    if (!dateStr) return null;
    const raw = String(dateStr).trim();
    if (!raw) return null;
    const isoCandidate = raw.includes('T')
      ? raw.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(raw)
        ? raw
        : `${raw}Z`
      : `${raw.replace(' ', 'T')}Z`;
    const parsedUtc = Date.parse(isoCandidate);
    if (Number.isFinite(parsedUtc) && parsedUtc > 0) {
      return parsedUtc;
    }
    const parsedFallback = Date.parse(raw);
    if (Number.isFinite(parsedFallback) && parsedFallback > 0) {
      return parsedFallback;
    }
    return null;
  }

  private getAccountsBackupPaths(): string[] {
    const paths: string[] = [];
    try {
      if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) {
        paths.push('/data/.exchange_accounts.backup.json');
      }
    } catch {
      // ignore
    }
    const homeDir = getPersistentHomeDir();
    if (homeDir) {
      paths.push(path.join(homeDir, '.exchange_accounts.backup.json'));
    }
    paths.push(path.resolve(process.cwd(), '.exchange_accounts.backup.json'));
    return paths;
  }

  private getTradesBackupPaths(): string[] {
    const paths: string[] = [];
    try {
      if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) {
        paths.push('/data/.trades.backup.json');
      }
    } catch {
      // ignore
    }
    const homeDir = getPersistentHomeDir();
    if (homeDir) {
      paths.push(path.join(homeDir, '.trades.backup.json'));
    }
    paths.push(path.resolve(process.cwd(), '.trades.backup.json'));
    return paths;
  }

  private isRealUserAccountKey(rawKey: unknown): boolean {
    const key = String(rawKey || '').trim().toLowerCase();
    return Boolean(
      key &&
        !key.startsWith('test_') &&
        !key.startsWith('mock_') &&
        !key.startsWith('sim_') &&
        !key.startsWith('ownr9988') &&
        !key.startsWith('clnt1122')
    );
  }

  private isRealUserTrade(tradeObj: any, simulatedAccountIds: Set<string>): boolean {
    if (!tradeObj || !tradeObj.pair) return false;
    const accId = String(tradeObj.account_id || '').trim();
    if (accId && simulatedAccountIds.has(accId)) {
      return false;
    }
    const accName = String(tradeObj.account_name || '').trim();
    if (
      accName === 'Master Owner Account' ||
      accName === 'Инвестор Алексей' ||
      accName.toLowerCase().includes('simulated test')
    ) {
      return false;
    }
    if (
      Array.isArray(tradeObj.orders) &&
      tradeObj.orders.some((o: any) => String(o?.id || '').startsWith('sim-'))
    ) {
      return false;
    }
    return true;
  }

  public syncTradesBackupFile(allowEmptyOverwrite = false) {
    try {
      const accRows = this.db.prepare(`SELECT id, api_key_raw FROM exchange_accounts`).all() as any[];
      const simulatedAccIds = new Set<string>();
      for (const a of accRows) {
        if (a?.api_key_raw && !this.isRealUserAccountKey(a.api_key_raw)) {
          simulatedAccIds.add(String(a.id));
        }
      }
      const allTrades = this.loadAllTradesInternal();
      const realTrades = allTrades.filter((t: any) => this.isRealUserTrade(t, simulatedAccIds));
      if (realTrades.length === 0 && !allowEmptyOverwrite) {
        return;
      }
      const jsonStr = JSON.stringify(realTrades, null, 2);
      for (const p of this.getTradesBackupPaths()) {
        try {
          fs.writeFileSync(p, jsonStr, 'utf-8');
        } catch {
          // ignore write error
        }
      }
    } catch {
      // ignore backup error
    }
  }

  public restoreTradesFromBackupIfEmpty(): number {
    try {
      const existingCount = Number(
        (this.db.prepare(`SELECT COUNT(*) as cnt FROM trades`).get() as any)?.cnt || 0
      );
      if (existingCount > 0) return 0;

      for (const p of this.getTradesBackupPaths()) {
        try {
          if (fs.existsSync(p)) {
            const raw = fs.readFileSync(p, 'utf-8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
              const validReal = parsed.filter((t: any) => this.isRealUserTrade(t, new Set()));
              if (validReal.length > 0) {
                for (const tr of validReal) {
                  this.upsertTrade(tr, true);
                }
                return validReal.length;
              }
            }
          }
        } catch {
          // try next path
        }
      }
    } catch {
      // ignore restore error
    }
    return 0;
  }

  private syncAccountsBackupFile(allowEmptyOverwrite = false) {
    try {
      const rows = this.db.prepare(`SELECT * FROM exchange_accounts ORDER BY rowid ASC`).all();
      const realAccounts = rows.filter((r: any) => this.isRealUserAccountKey(r.api_key_raw));
      // Защита от случайного затирания резервной копии API-ключей при тестах или пустой БД:
      // перезаписываем пустым массивом ТОЛЬКО при явной очистке/удалении пользователем (allowEmptyOverwrite = true).
      if (realAccounts.length === 0 && !allowEmptyOverwrite) {
        return;
      }
      const jsonStr = JSON.stringify(realAccounts, null, 2);
      for (const p of this.getAccountsBackupPaths()) {
        try {
          fs.writeFileSync(p, jsonStr, 'utf-8');
        } catch {
          // ignore write error
        }
      }
    } catch {
      // ignore backup error
    }
  }

  private restoreAccountsFromBackupOrEnvIfEmpty() {
    try {
      const existingCount = Number(
        (this.db.prepare(`SELECT COUNT(*) as cnt FROM exchange_accounts`).get() as any)?.cnt || 0
      );
      if (existingCount > 0) return;

      for (const p of this.getAccountsBackupPaths()) {
        try {
          if (fs.existsSync(p)) {
            const raw = fs.readFileSync(p, 'utf-8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
              const validReal = parsed.filter((acc: any) => this.isRealUserAccountKey(acc?.api_key_raw));
              if (validReal.length !== parsed.length) {
                try {
                  fs.writeFileSync(p, JSON.stringify(validReal, null, 2), 'utf-8');
                } catch {
                  // ignore cleanup write error
                }
              }
              if (validReal.length > 0) {
                for (const acc of validReal) {
                  this.upsertExchangeAccountInternal(acc);
                }
                return;
              }
            }
          }
        } catch {
          // try next backup path
        }
      }

      // Fallback: check environment variables if configured in Render / .env
      const bybitKey = (process.env.BYBIT_API_KEY || '').trim();
      const bybitSecret = (process.env.BYBIT_API_SECRET || '').trim();
      if (bybitKey && bybitSecret) {
        const masked =
          bybitKey.length > 8 ? `${bybitKey.slice(0, 4)}****${bybitKey.slice(-4)}` : '****';
        this.upsertExchangeAccountInternal({
          id: 'env-bybit-master',
          name: 'Bybit Account',
          owner_label: 'Owner',
          exchange: 'bybit',
          market_type: 'futures',
          api_key_masked: masked,
          api_key_raw: bybitKey,
          api_secret_raw: bybitSecret,
          has_passphrase: false,
          is_owner: true,
          client_access_code: 'BYBIT-ENV1',
          enabled: true,
          copy_trading: false,
          copy_multiplier: 1.0,
          max_leverage: 25,
          balance_usdt: 1000,
          status: 'connected',
          last_sync: new Date().toISOString().replace('T', ' ').slice(0, 19),
          connected_at: Date.now(),
          is_testnet: String(process.env.BYBIT_TESTNET || '').toLowerCase() === 'true',
          user_id: 'owner',
        });
      }

      const binanceKey = (process.env.BINANCE_API_KEY || '').trim();
      const binanceSecret = (process.env.BINANCE_API_SECRET || '').trim();
      if (binanceKey && binanceSecret) {
        const masked =
          binanceKey.length > 8 ? `${binanceKey.slice(0, 4)}****${binanceKey.slice(-4)}` : '****';
        this.upsertExchangeAccountInternal({
          id: 'env-binance-master',
          name: 'Binance Account',
          owner_label: 'Owner',
          exchange: 'binance',
          market_type: 'futures',
          api_key_masked: masked,
          api_key_raw: binanceKey,
          api_secret_raw: binanceSecret,
          has_passphrase: false,
          is_owner: true,
          client_access_code: 'BINANCE-ENV1',
          enabled: true,
          copy_trading: false,
          copy_multiplier: 1.0,
          max_leverage: 25,
          balance_usdt: 1000,
          status: 'connected',
          last_sync: new Date().toISOString().replace('T', ' ').slice(0, 19),
          connected_at: Date.now(),
          is_testnet: String(process.env.BINANCE_TESTNET || '').toLowerCase() === 'true',
          user_id: 'owner',
        });
      }
    } catch {
      // ignore restore error
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

  public isMigrationApplied(name: string): boolean {
    try {
      return Boolean(this.db.prepare(`SELECT 1 FROM app_migrations WHERE name = ?`).get(name));
    } catch {
      return false;
    }
  }

  public markMigrationApplied(name: string, note = ''): void {
    try {
      this.db
        .prepare(`INSERT OR REPLACE INTO app_migrations (name, applied_at, note) VALUES (?, ?, ?)`)
        .run(name, Date.now(), note);
    } catch {
      // ignore
    }
  }

  // ---------------- Журнал сигналов разворота ----------------

  public recordReversalSignal(params: {
    pair: string;
    timeframe: string;
    candle_ts: number;
    side: 'support' | 'resistance';
    level: number;
    price: number;
    atr: number;
    purpose: string;
    daily_trend: string;
    with_trend: boolean;
    acted: boolean;
  }): void {
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO reversal_journal
             (created_at, pair, timeframe, candle_ts, side, level, price, atr, purpose, daily_trend, with_trend, acted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          Date.now(),
          params.pair,
          params.timeframe,
          params.candle_ts,
          params.side,
          params.level,
          params.price,
          params.atr,
          params.purpose,
          params.daily_trend,
          params.with_trend ? 1 : 0,
          params.acted ? 1 : 0
        );
    } catch {
      // журнал не критичен для торговли
    }
  }

  public listPendingReversalSignals(limit = 200): any[] {
    try {
      return this.db
        .prepare(`SELECT * FROM reversal_journal WHERE outcome = 'pending' ORDER BY candle_ts ASC LIMIT ?`)
        .all(limit);
    } catch {
      return [];
    }
  }

  public resolveReversalSignal(id: number, outcome: string, barsToOutcome: number | null): void {
    try {
      this.db
        .prepare(`UPDATE reversal_journal SET outcome = ?, bars_to_outcome = ?, resolved_at = ? WHERE id = ?`)
        .run(outcome, barsToOutcome, Date.now(), id);
    } catch {
      // ignore
    }
  }

  public getReversalJournal(pair?: string, limit = 30): { rows: any[]; groups: any[] } {
    try {
      const where = pair ? `WHERE pair = ?` : '';
      const args = pair ? [pair] : [];
      const rows = this.db
        .prepare(`SELECT * FROM reversal_journal ${where} ORDER BY candle_ts DESC LIMIT ?`)
        .all(...args, limit);
      const groups = this.db
        .prepare(
          `SELECT purpose, with_trend,
                  COUNT(*) AS total,
                  SUM(CASE WHEN outcome != 'pending' THEN 1 ELSE 0 END) AS resolved,
                  SUM(CASE WHEN outcome = 'reversal' THEN 1 ELSE 0 END) AS reversals,
                  SUM(CASE WHEN outcome = 'breakout' THEN 1 ELSE 0 END) AS breakouts
             FROM reversal_journal ${where}
             GROUP BY purpose, with_trend
             ORDER BY purpose, with_trend DESC`
        )
        .all(...args);
      return { rows, groups };
    } catch {
      return { rows: [], groups: [] };
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

  public getRecentOrders(limit = 150, userId?: string): any[] {
    try {
      if (userId) {
        return this.db
          .prepare(
            `SELECT orders.* FROM orders
             INNER JOIN trades ON orders.trade_id = trades.id
             WHERE COALESCE(trades.user_id, 'owner') = ?
             ORDER BY orders.id DESC LIMIT ?`
          )
          .all(userId, limit);
      }
      return this.db
        .prepare(`SELECT * FROM orders ORDER BY id DESC LIMIT ?`)
        .all(limit);
    } catch {
      return [];
    }
  }

  public getPnlAnalytics(userId?: string): any {
    try {
      const closed = (userId
        ? this.db
            .prepare(
              `SELECT * FROM trades WHERE is_open = 0 AND COALESCE(user_id, 'owner') = ? ORDER BY close_date DESC`
            )
            .all(userId)
        : this.db
            .prepare(`SELECT * FROM trades WHERE is_open = 0 ORDER BY close_date DESC`)
            .all()) as any[];
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

  public upsertTrade(trade: any, skipBackup = false) {
    try {
      const existing = this.db
        .prepare(`SELECT id, open_date, open_timestamp, close_date, close_timestamp FROM trades WHERE id = ?`)
        .get(trade.trade_id) as any;

      const lev = Math.max(1, Number(trade.leverage || 25));
      const amt = Math.max(0, Number(trade.amount || 0));
      const openRate = Math.max(0, Number(trade.open_rate || 0));
      const dcaCount = Number(trade.dca_count || 0);
      if (amt > 0 && openRate > 0) {
        trade.stake_amount = sanitizePositionMarginUsdt(
          Number(trade.stake_amount || 0),
          amt,
          openRate,
          lev
        );
        const initAmt = Math.max(0, Number(trade.initial_amount || amt));
        const initRate = Math.max(0, Number(trade.initial_open_rate || openRate));
        trade.initial_stake = sanitizePositionMarginUsdt(
          Number(trade.initial_stake || trade.stake_amount || 0),
          initAmt,
          initRate,
          lev
        );
      }
      if (dcaCount === 0 && openRate > 0) {
        trade.initial_open_rate = openRate;
      }

      const rawOrders = Array.isArray(trade.orders) ? trade.orders : [];
      if (dcaCount === 0 && openRate > 0 && rawOrders.length === 1 && Number(rawOrders[0]?.step || 0) === 0) {
        rawOrders[0].price = openRate;
        if (trade.stake_amount > 0) {
          rawOrders[0].stake_amount = trade.stake_amount;
        }
      }
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
      const nextDca =
        (Array.isArray(trade.planned_dca_levels)
          ? trade.planned_dca_levels.find((l: any) => !l.filled)?.price
          : undefined) ??
        trade.next_dca_price ??
        null;

      const openDateStr =
        trade.open_date ||
        existing?.open_date ||
        new Date().toISOString().replace('T', ' ').slice(0, 19);
      const openTs =
        this.parseStoredUtcTimestamp(openDateStr, trade.open_timestamp ?? existing?.open_timestamp) ??
        Date.now();

      const closeDateStr = trade.close_date ?? existing?.close_date ?? null;
      const closeTs = closeDateStr
        ? this.parseStoredUtcTimestamp(
            closeDateStr,
            trade.close_timestamp ?? existing?.close_timestamp
          )
        : null;

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
            current_rate, synced_accounts_json, open_timestamp, close_timestamp, user_id,
            campaign_role, rehedge_stop_price, rehedge_stop_qty, whipsaw_stop_price, tail_bites_count
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
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?
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
          openDateStr,
          closeDateStr,
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
          syncedAccJson,
          openTs,
          closeTs,
          trade.user_id || 'owner',
          trade.campaign_role ?? null,
          trade.rehedge_stop_price ?? null,
          trade.rehedge_stop_qty ?? null,
          trade.whipsaw_stop_price ?? null,
          trade.tail_bites_count ?? 0
        );
      } else {
        const effectiveDcaCount = Math.max(
          Number(trade.dca_count || 0),
          Array.isArray(rawOrders) ? rawOrders.filter((o: any) => Number(o?.step) > 0).length : 0
        );
        const stmt = this.db.prepare(`
          UPDATE trades SET
            open_rate = ?, close_rate = ?, stake_amount = ?, amount = ?,
            is_open = ?, is_short = ?, leverage = ?, open_date = ?, close_date = ?,
            profit = ?, profit_percent = ?, buy_tag = ?, sell_reason = ?,
            dca_count = ?, last_dca_date = ?, target_tp_rate = ?, stoploss_rate = ?,
            support_level = ?, resistance_level = ?, plan_notes = ?,
            fee_open = ?, fee_close = ?, fee_total = ?, gross_profit = ?,
            net_profit = ?, net_profit_percent = ?, initial_amount = ?, initial_stake = ?,
            dca_history = ?,
            campaign_id = ?, campaign_banked_profit = ?, trade_state = ?,
            next_dca_price = ?, tp_manual_override = ?, sl_manual_override = ?,
            dca_manual_override = ?, planned_dca_json = ?, orders_json = ?,
            initial_open_rate = ?,
            account_id = ?, account_name = ?, parent_trade_id = ?,
            current_rate = ?, synced_accounts_json = ?, open_timestamp = ?, close_timestamp = ?,
            user_id = ?,
            campaign_role = ?, rehedge_stop_price = ?, rehedge_stop_qty = ?, whipsaw_stop_price = ?, tail_bites_count = ?
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
          openDateStr,
          closeDateStr,
          trade.profit_abs ?? 0,
          trade.profit_pct ?? 0,
          trade.enter_tag || '',
          trade.exit_reason ?? null,
          effectiveDcaCount,
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
          trade.trade_state || (trade.is_open ? (effectiveDcaCount > 0 ? 'DCA_ACTIVE' : 'WAITING_PULLBACK') : 'CLOSED'),
          nextDca,
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
          syncedAccJson,
          openTs,
          closeTs,
          trade.user_id || 'owner',
          trade.campaign_role ?? null,
          trade.rehedge_stop_price ?? null,
          trade.rehedge_stop_qty ?? null,
          trade.whipsaw_stop_price ?? null,
          trade.tail_bites_count ?? 0,
          trade.trade_id
        );
      }
      if (!skipBackup) {
        this.syncTradesBackupFile();
      }
    } catch (e) {
      console.error('SQLite upsertTrade error:', e);
    }
  }

  public deleteTrade(tradeId: number) {
    try {
      this.db.prepare(`DELETE FROM orders WHERE trade_id = ?`).run(tradeId);
      this.db.prepare(`DELETE FROM trades WHERE id = ?`).run(tradeId);
      this.syncTradesBackupFile(true);
    } catch (e) {
      console.error('SQLite deleteTrade error:', e);
    }
  }

  public loadAllTrades(): any[] {
    this.restoreTradesFromBackupIfEmpty();
    return this.loadAllTradesInternal();
  }

  private loadAllTradesInternal(): any[] {
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

        const openDateStr = String(
          r.open_date || new Date().toISOString().replace('T', ' ').slice(0, 19)
        );
        const openTs =
          this.parseStoredUtcTimestamp(openDateStr, r.open_timestamp) ?? 1700000000000;
        const closeDateStr = r.close_date ? String(r.close_date) : null;
        const closeTs = closeDateStr
          ? this.parseStoredUtcTimestamp(closeDateStr, r.close_timestamp) ?? openTs
          : r.close_timestamp
          ? Number(r.close_timestamp)
          : null;
        const tradeIdNum = Number(r.id);
        const isShortBool = Boolean(r.is_short);

        // Резервное восстановление цепочки ордеров (Нач. вход + все шаги DCA) из таблицы orders, если orders_json был пуст или не содержал все шаги
        try {
          const dbOrderRows = this.db
            .prepare(
              `SELECT * FROM orders WHERE trade_id = ? AND action_type NOT LIKE '%EXIT%' AND action_type NOT LIKE '%PROFIT%' AND action_type NOT LIKE '%CLOSE%' ORDER BY id ASC`
            )
            .all(tradeIdNum);
          if (
            dbOrderRows.length > 0 &&
            (!Array.isArray(orders) || orders.length === 0 || dbOrderRows.length > orders.length)
          ) {
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
              timestamp:
                this.parseStoredUtcTimestamp(String(o.created_at || openDateStr)) ?? openTs,
              date: String(o.created_at || openDateStr),
            }));
          } else if (!Array.isArray(orders) || orders.length === 0) {
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

        const rawAmount = Number(r.amount || 0);
        const orderDcaSteps = Array.isArray(orders)
          ? orders.filter((o: any) => Number(o?.step) > 0).length
          : 0;
        const dcaCountNum = Math.max(
          Number(r.dca_count || 0),
          Array.isArray(dcaHistory) ? dcaHistory.length : 0,
          orderDcaSteps
        );
        const firstOrder = Array.isArray(orders) && orders.length > 0 ? orders[0] : null;
        const storedInitAmt = Number(r.initial_amount || 0);
        const rawInitialAmount =
          dcaCountNum > 0 &&
          firstOrder &&
          Number(firstOrder.amount) > 0 &&
          (storedInitAmt <= 0 || (rawAmount > 0 && Math.abs(storedInitAmt - rawAmount) < 1e-6 && orders.length > 1))
            ? Number(firstOrder.amount)
            : storedInitAmt > 0
            ? storedInitAmt
            : rawAmount;
        const rawOpenRate = Number(r.open_rate || 0);
        const rawInitialOpenRate =
          dcaCountNum === 0 && rawOpenRate > 0
            ? rawOpenRate
            : Number(
                (firstOrder && Number(firstOrder.price) > 0 ? firstOrder.price : 0) ||
                  r.initial_open_rate ||
                  rawOpenRate ||
                  0
              );
        const rawLev = Math.max(1, Number(r.leverage || 25));
        const rawStake = Number(r.stake_amount || 0);
        const sanitizedStake =
          rawAmount > 0 && rawOpenRate > 0
            ? sanitizePositionMarginUsdt(rawStake, rawAmount, rawOpenRate, rawLev)
            : rawStake;
        const storedInitStake = Number(r.initial_stake || 0);
        const rawInitialStake =
          dcaCountNum > 0 &&
          firstOrder &&
          Number(firstOrder.stake_amount) > 0 &&
          (storedInitStake <= 0 || (sanitizedStake > 0 && Math.abs(storedInitStake - sanitizedStake) < 0.05 && orders.length > 1))
            ? Number(firstOrder.stake_amount)
            : storedInitStake > 0
            ? storedInitStake
            : sanitizedStake;
        const sanitizedInitialStake =
          rawInitialAmount > 0 && rawInitialOpenRate > 0
            ? sanitizePositionMarginUsdt(rawInitialStake, rawInitialAmount, rawInitialOpenRate, rawLev)
            : sanitizedStake;

        if (dcaCountNum === 0 && rawOpenRate > 0 && orders.length === 1 && Number(orders[0]?.step || 0) === 0) {
          orders[0].price = rawOpenRate;
          orders[0].stake_amount = sanitizedStake;
        }

        if (
          Math.abs(rawStake - sanitizedStake) > 1.0 ||
          Math.abs(storedInitStake - sanitizedInitialStake) > 1.0 ||
          Math.abs(storedInitAmt - rawInitialAmount) > 1e-5 ||
          dcaCountNum !== Number(r.dca_count || 0) ||
          (dcaCountNum === 0 && Math.abs(Number(r.initial_open_rate || rawOpenRate) - rawOpenRate) > 1e-8)
        ) {
          try {
            this.db
              .prepare(
                `UPDATE trades SET stake_amount = ?, initial_stake = ?, initial_amount = ?, dca_count = ?, initial_open_rate = ?, orders_json = ? WHERE id = ?`
              )
              .run(
                sanitizedStake,
                sanitizedInitialStake,
                rawInitialAmount,
                dcaCountNum,
                rawInitialOpenRate,
                JSON.stringify(orders),
                tradeIdNum
              );
          } catch {
            // ignore self-heal error
          }
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
          user_id: String(r.user_id || 'owner'),
          parent_trade_id: r.parent_trade_id ? Number(r.parent_trade_id) : undefined,
          synced_accounts: syncedAccounts.length > 0 ? syncedAccounts : undefined,
          amount: rawAmount,
          initial_amount: rawInitialAmount,
          stake_amount: sanitizedStake,
          initial_stake: sanitizedInitialStake,
          strategy: String(r.strategy || 'ScalpingStrategy'),
          timeframe: String(r.timeframe || '1h'),
          enter_tag: String(r.buy_tag || (isShortBool ? 'Short' : 'Long')),
          open_date: openDateStr,
          open_timestamp: openTs,
          open_rate: rawOpenRate,
          initial_open_rate: rawInitialOpenRate,
          dca_count: dcaCountNum,
          last_dca_date: r.last_dca_date ? String(r.last_dca_date) : null,
          current_rate: Number(r.close_rate || r.current_rate || r.open_rate || 0),
          close_date: closeDateStr,
          close_timestamp: closeTs,
          close_rate: r.close_rate !== null && r.close_rate !== undefined ? Number(r.close_rate) : null,
          profit_ratio: Number(((r.profit_percent || 0) / 100).toFixed(4)),
          profit_pct: Number(r.profit_percent || 0),
          profit_abs: Boolean(r.is_open)
            ? Number(r.gross_profit ?? r.profit ?? 0)
            : Number(r.net_profit ?? r.profit ?? 0),
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
          trade_state: String(r.trade_state || (dcaCountNum > 0 ? 'DCA_ACTIVE' : 'WAITING_PULLBACK')),
          pullback_min_profit_pct: Number(r.pullback_min_profit_pct ?? 0.5),
          plan_notes: r.plan_notes ? String(r.plan_notes) : undefined,
          campaign_id: r.campaign_id ? String(r.campaign_id) : undefined,
          campaign_role:
            r.campaign_role === 'primary' || r.campaign_role === 'insurance'
              ? r.campaign_role
              : undefined,
          campaign_banked_profit:
            r.campaign_banked_profit !== null && r.campaign_banked_profit !== undefined
              ? Number(r.campaign_banked_profit)
              : undefined,
          rehedge_stop_price:
            r.rehedge_stop_price !== null && r.rehedge_stop_price !== undefined
              ? Number(r.rehedge_stop_price)
              : undefined,
          rehedge_stop_qty:
            r.rehedge_stop_qty !== null && r.rehedge_stop_qty !== undefined
              ? Number(r.rehedge_stop_qty)
              : undefined,
          whipsaw_stop_price:
            r.whipsaw_stop_price !== null && r.whipsaw_stop_price !== undefined
              ? Number(r.whipsaw_stop_price)
              : undefined,
          tail_bites_count:
            r.tail_bites_count !== null && r.tail_bites_count !== undefined
              ? Number(r.tail_bites_count)
              : 0,
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

  private toScopedBotLevelDbId(id: string, userId = 'owner'): string {
    const cleanUser = String(userId || 'owner').trim() || 'owner';
    if (cleanUser === 'owner') return id;
    const prefix = `${cleanUser}::`;
    return id.startsWith(prefix) ? id : `${prefix}${id}`;
  }

  private fromScopedBotLevelDbId(dbId: string, userId = 'owner'): string {
    const cleanUser = String(userId || 'owner').trim() || 'owner';
    if (cleanUser === 'owner') return dbId;
    const prefix = `${cleanUser}::`;
    return dbId.startsWith(prefix) ? dbId.slice(prefix.length) : dbId;
  }

  public getBotLevelsForPair(pair: string, userId = 'owner'): SqliteBotLevelRow[] {
    try {
      const cleanUser = String(userId || 'owner').trim() || 'owner';
      const rows = this.db
        .prepare(
          `SELECT * FROM bot_levels WHERE pair = ? AND COALESCE(user_id, 'owner') = ? AND deleted = 0 ORDER BY price DESC`
        )
        .all(pair.toUpperCase(), cleanUser);
      return rows.map((r: any) => ({
        id: this.fromScopedBotLevelDbId(String(r.id), cleanUser),
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

  public hasAnyBotLevelsRecordForPair(pair: string, userId = 'owner'): boolean {
    try {
      const cleanUser = String(userId || 'owner').trim() || 'owner';
      const row = this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM bot_levels WHERE pair = ? AND COALESCE(user_id, 'owner') = ?`
        )
        .get(pair.toUpperCase(), cleanUser);
      return Number(row?.cnt || 0) > 0;
    } catch {
      return false;
    }
  }

  public upsertBotLevel(level: SqliteBotLevelRow, userId = 'owner') {
    try {
      const cleanUser = String(userId || 'owner').trim() || 'owner';
      const dbId = this.toScopedBotLevelDbId(level.id, cleanUser);
      const stmt = this.db.prepare(`
        INSERT INTO bot_levels (id, pair, label, role, price, touches, bounces, breaks, strength_score, source, manual_override, deleted, updated_at, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          updated_at = excluded.updated_at,
          user_id = excluded.user_id
      `);
      stmt.run(
        dbId,
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
        level.updated_at,
        cleanUser
      );
    } catch (e) {
      console.error('upsertBotLevel error:', e);
    }
  }

  public markBotLevelDeleted(id: string, userId = 'owner') {
    try {
      const cleanUser = String(userId || 'owner').trim() || 'owner';
      const dbId = this.toScopedBotLevelDbId(id, cleanUser);
      this.db
        .prepare(`UPDATE bot_levels SET deleted = 1 WHERE id = ? AND COALESCE(user_id, 'owner') = ?`)
        .run(dbId, cleanUser);
    } catch {
      // ignore
    }
  }

  public getAllBotLevelsForPairIncludeDeleted(pair: string, userId = 'owner'): SqliteBotLevelRow[] {
    try {
      const cleanUser = String(userId || 'owner').trim() || 'owner';
      const rows = this.db
        .prepare(
          `SELECT * FROM bot_levels WHERE pair = ? AND COALESCE(user_id, 'owner') = ? ORDER BY price DESC`
        )
        .all(pair.toUpperCase(), cleanUser);
      return rows.map((r: any) => ({
        id: this.fromScopedBotLevelDbId(String(r.id), cleanUser),
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

  public replaceAutoBotLevelsWithManual(pair: string, role: string, keepId: string, userId = 'owner') {
    try {
      const cleanUser = String(userId || 'owner').trim() || 'owner';
      const dbKeepId = this.toScopedBotLevelDbId(keepId, cleanUser);
      this.db
        .prepare(
          `DELETE FROM bot_levels WHERE pair = ? AND role = ? AND COALESCE(user_id, 'owner') = ? AND manual_override = 0 AND id != ?`
        )
        .run(pair.toUpperCase(), role, cleanUser, dbKeepId);
    } catch {
      // ignore
    }
  }

  public clearBotLevelsForPair(pair: string, userId = 'owner') {
    try {
      const cleanUser = String(userId || 'owner').trim() || 'owner';
      this.db
        .prepare(`DELETE FROM bot_levels WHERE pair = ? AND COALESCE(user_id, 'owner') = ?`)
        .run(pair.toUpperCase(), cleanUser);
    } catch {
      // ignore
    }
  }

  public getChartDrawingsForPair(pair: string, userId = 'owner'): any[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM chart_drawings WHERE pair = ? AND COALESCE(user_id, 'owner') = ? ORDER BY rowid ASC`
        )
        .all(pair.toUpperCase(), userId);
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
          user_id: String(r.user_id || 'owner'),
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
    user_id?: string;
    created_at: string;
  }) {
    try {
      this.db
        .prepare(
          `INSERT INTO chart_drawings (id, pair, tool, points_json, color, text, locked, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             pair = excluded.pair,
             tool = excluded.tool,
             points_json = excluded.points_json,
             color = excluded.color,
             text = excluded.text,
             locked = excluded.locked,
             user_id = excluded.user_id`
        )
        .run(
          drawing.id,
          drawing.pair.toUpperCase(),
          drawing.tool,
          JSON.stringify(drawing.points || []),
          drawing.color || '#2962ff',
          drawing.text ?? null,
          drawing.locked ? 1 : 0,
          drawing.user_id || 'owner',
          drawing.created_at || new Date().toISOString().replace('T', ' ').slice(0, 19)
        );
    } catch (e) {
      console.error('upsertChartDrawing error:', e);
    }
  }

  public deleteChartDrawing(id: string, userId?: string) {
    try {
      if (userId) {
        this.db
          .prepare(`DELETE FROM chart_drawings WHERE id = ? AND COALESCE(user_id, 'owner') = ?`)
          .run(id, userId);
      } else {
        this.db.prepare(`DELETE FROM chart_drawings WHERE id = ?`).run(id);
      }
    } catch {
      // ignore
    }
  }

  public clearChartDrawingsForPair(pair: string, userId = 'owner') {
    try {
      this.db
        .prepare(`DELETE FROM chart_drawings WHERE pair = ? AND COALESCE(user_id, 'owner') = ?`)
        .run(pair.toUpperCase(), userId);
    } catch {
      // ignore
    }
  }

  public loadExchangeAccounts(): any[] {
    try {
      this.restoreAccountsFromBackupOrEnvIfEmpty();
      const rows = this.db.prepare(`SELECT * FROM exchange_accounts ORDER BY rowid ASC`).all();
      return rows.map((r: any) => {
        const balUsdt = Number(r.balance_usdt || 1000);
        const rawUsed = Number(r.used_margin_usdt || 0);
        const usedMargin = sanitizeWalletUsedMarginUsdt(rawUsed, balUsdt, 0, 1);
        const rawAvail = Number(r.available_balance_usdt || 0);
        const availBal =
          rawAvail > 0 && rawAvail <= balUsdt - usedMargin + 0.5
            ? rawAvail
            : Math.max(0, balUsdt - usedMargin);
        return {
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
          user_id: String(r.user_id || 'owner'),
          client_access_code: String(r.client_access_code),
          enabled: Boolean(r.enabled),
          copy_trading: Boolean(r.copy_trading),
          copy_multiplier: Number(r.copy_multiplier || 1.0),
          max_leverage: Number(r.max_leverage || 25),
          balance_usdt: balUsdt,
          wallet_balance_usdt: balUsdt,
          used_margin_usdt: usedMargin,
          available_balance_usdt: availBal,
          unrealized_pnl: 0,
          open_trades_count: 0,
          status: r.status === 'paused' ? 'paused' : r.status === 'error' ? 'error' : 'connected',
          last_sync: String(r.last_sync),
          is_testnet: Boolean(r.is_testnet),
        };
      });
    } catch {
      return [];
    }
  }

  private upsertExchangeAccountInternal(acc: any) {
    const balUsdt =
      Number.isFinite(Number(acc.balance_usdt)) && Number(acc.balance_usdt) > 0
        ? Number(acc.balance_usdt)
        : 1000;
    const usedMargin = sanitizeWalletUsedMarginUsdt(
      Number(acc.used_margin_usdt || 0),
      balUsdt,
      0,
      Number(acc.open_trades_count ?? 1)
    );
    const rawAvail = Number(acc.available_balance_usdt || 0);
    const availBal =
      rawAvail > 0 && rawAvail <= balUsdt - usedMargin + 0.5
        ? rawAvail
        : Math.max(0, balUsdt - usedMargin);
    const stmt = this.db.prepare(`
      INSERT INTO exchange_accounts (
        id, name, owner_label, exchange, market_type, api_key_masked,
        has_passphrase, is_owner, client_access_code, enabled,
        copy_trading, copy_multiplier, max_leverage, balance_usdt,
        status, last_sync, api_key_raw, api_secret_raw, passphrase_raw, connected_at, is_testnet, user_id,
        used_margin_usdt, available_balance_usdt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        is_testnet = excluded.is_testnet,
        user_id = excluded.user_id,
        used_margin_usdt = excluded.used_margin_usdt,
        available_balance_usdt = excluded.available_balance_usdt,
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
      balUsdt,
      acc.status || 'connected',
      acc.last_sync,
      acc.api_key_raw ?? null,
      acc.api_secret_raw ?? null,
      acc.passphrase_raw ?? null,
      acc.connected_at || Date.now(),
      acc.is_testnet ? 1 : 0,
      acc.user_id || 'owner',
      usedMargin,
      availBal
    );
  }

  public upsertExchangeAccount(acc: any) {
    try {
      this.upsertExchangeAccountInternal(acc);
      this.syncAccountsBackupFile();
    } catch (e) {
      console.error('upsertExchangeAccount error:', e);
    }
  }

  public deleteExchangeAccount(id: string) {
    try {
      this.db.prepare(`DELETE FROM exchange_accounts WHERE id = ?`).run(id);
      this.syncAccountsBackupFile(true);
    } catch {
      // ignore
    }
  }

  public clearExchangeAccountsForUser(userId: string, explicitUserClear = false) {
    try {
      this.db
        .prepare(`DELETE FROM exchange_accounts WHERE COALESCE(user_id, 'owner') = ?`)
        .run(userId);
      if (userId === 'owner') {
        this.db.prepare(`DELETE FROM signals`).run();
        this.db.prepare(`DELETE FROM bot_levels WHERE manual_override = 0`).run();
      }
      this.syncAccountsBackupFile(explicitUserClear);
    } catch {
      // ignore
    }
  }

  public clearAllExchangeAccounts(explicitUserClear = false) {
    try {
      this.db.prepare(`DELETE FROM exchange_accounts`).run();
      this.db.prepare(`DELETE FROM signals`).run();
      this.db.prepare(`DELETE FROM bot_levels WHERE manual_override = 0`).run();
      this.syncAccountsBackupFile(explicitUserClear);
    } catch {
      // ignore
    }
  }

  /**
   * Одноразовая миграция: заменяет session_secret, утёкший вместе с trades.sqlite,
   * и общеизвестный пароль admin123, если владелец его так и не сменил.
   */
  private migrateLeakedAuthSecrets() {
    try {
      const row = this.db
        .prepare(`SELECT owner_login, password_changed, secret_version FROM site_auth WHERE id = 1`)
        .get() as any;
      if (!row) return;
      if (Number(row.secret_version || 0) >= SESSION_SECRET_VERSION) return;

      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const envLogin = readEnvSecret('OWNER_LOGIN');
      const envPass = readEnvSecret('OWNER_PASSWORD');
      if (!envPass && !Number(row.password_changed)) {
        const newPass = generateRandomOwnerPassword();
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(newPass, salt, 64).toString('hex');
        this.db
          .prepare(`UPDATE site_auth SET password_hash = ?, password_salt = ? WHERE id = 1`)
          .run(hash, salt);
        announceGeneratedOwnerPassword(envLogin || String(row.owner_login || 'admin'), newPass);
      }

      // Инвайт-ссылки и коды клиентов хранились в той же утёкшей базе и дают вход без пароля —
      // перевыпускаем их (владелец увидит новые значения в интерфейсе и разошлёт заново).
      const invites = this.db.prepare(`SELECT id FROM invite_links`).all() as any[];
      const updInvite = this.db.prepare(`UPDATE invite_links SET token = ? WHERE id = ?`);
      for (const inv of invites) {
        updInvite.run(crypto.randomBytes(24).toString('base64url'), inv.id);
      }
      const accounts = this.db.prepare(`SELECT id, exchange FROM exchange_accounts`).all() as any[];
      const updAcc = this.db.prepare(`UPDATE exchange_accounts SET client_access_code = ? WHERE id = ?`);
      for (const acc of accounts) {
        updAcc.run(
          `${String(acc.exchange || 'BYBIT').toUpperCase()}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
          acc.id
        );
      }

      this.db
        .prepare(`UPDATE site_auth SET session_secret = ?, secret_version = ?, updated_at = ? WHERE id = 1`)
        .run(crypto.randomBytes(32).toString('hex'), SESSION_SECRET_VERSION, now);
      console.warn(
        `site_auth: секрет подписи сессий заменён — все ранее выданные токены недействительны, войдите заново. ` +
          `Перевыпущено инвайт-ссылок: ${invites.length}, кодов доступа клиентов: ${accounts.length}.`
      );
      if (accounts.length > 0) {
        this.syncAccountsBackupFile();
      }
    } catch (e) {
      console.error('site_auth secret migration error:', e);
    }
  }

  /**
   * Ключ подписи токенов. Основа — SESSION_SECRET из окружения или session_secret из БД.
   * В ключ подмешаны логин и хеш пароля владельца (и OWNER_LOGIN/OWNER_PASSWORD из окружения),
   * поэтому любая смена логина или пароля сразу делает все выданные ранее токены недействительными.
   */
  private getSessionSigningKey(): string {
    const row = this.db
      .prepare(`SELECT session_secret, owner_login, password_hash FROM site_auth WHERE id = 1`)
      .get() as any;
    const base = readEnvSecret('SESSION_SECRET') || String(row?.session_secret || '');
    if (!base) {
      throw new Error('session secret is not initialized');
    }
    const envLogin = readEnvSecret('OWNER_LOGIN').toLowerCase();
    const envPass = readEnvSecret('OWNER_PASSWORD');
    return crypto
      .createHash('sha256')
      .update(
        [base, String(row?.owner_login || ''), String(row?.password_hash || ''), envLogin, envPass].join('\u0000')
      )
      .digest('hex');
  }

  public getSiteAuthConfig(): {
    owner_login: string;
    password_changed: boolean;
    require_login: boolean;
    has_env_secrets: boolean;
  } {
    const envLogin = readEnvSecret('OWNER_LOGIN');
    const envPass = readEnvSecret('OWNER_PASSWORD');
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
        // Закрытый сайт: вход обязателен всегда (только по паролю владельца или пригласительной ссылке)
        require_login: true,
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
      const envLogin = readEnvSecret('OWNER_LOGIN');
      const envPass = readEnvSecret('OWNER_PASSWORD');

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
      if (!cleanCode || cleanCode.length < 6) return null;
      const row = this.db
        .prepare(
          `SELECT * FROM exchange_accounts
           WHERE UPPER(client_access_code) = ?
             AND COALESCE(user_id, 'owner') != 'owner'
             AND COALESCE(is_owner, 0) = 0`
        )
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

      // Отключить обязательный вход нельзя: без него любой посетитель получал права владельца
      const nextRequire = 1;
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
    userId?: string;
  }): string {
    try {
      const secret = this.getSessionSigningKey();
      const data = JSON.stringify({
        role: payload.role,
        login: payload.login,
        accountId: payload.accountId || '',
        inviteId: payload.inviteId || '',
        userId: payload.userId || '',
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
    userId?: string;
  } {
    try {
      if (!token || !token.includes('.')) return { valid: false };
      const [b64, sig] = token.split('.');
      if (!b64 || !sig) return { valid: false };
      const secret = this.getSessionSigningKey();
      const expectedSig = crypto.createHmac('sha256', secret).update(b64).digest();
      const providedSig = Buffer.from(sig, 'base64url');
      if (
        providedSig.length !== expectedSig.length ||
        !crypto.timingSafeEqual(providedSig, expectedSig)
      ) {
        return { valid: false };
      }
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
        userId: parsed.userId ? String(parsed.userId) : undefined,
      };
    } catch {
      return { valid: false };
    }
  }
}
