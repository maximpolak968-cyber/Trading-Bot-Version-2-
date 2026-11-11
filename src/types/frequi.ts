export interface ParsedCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ema_20: number | null;
  ema_50: number | null;
  sma_200: number | null;
  bb_upperband: number | null;
  bb_middleband: number | null;
  bb_lowerband: number | null;
  rsi: number | null;
  enter_long: number | null;
  enter_tag: string | null;
  exit_long: number | null;
  exit_tag: string | null;
  enter_short: number | null;
  exit_short: number | null;
}

export interface PairCandlesResponse {
  pair: string;
  timeframe: string;
  strategy: string;
  exchange_source: string;
  columns: string[];
  data: any[][];
  length: number;
  last_analyzed: number;
}

export interface TradeOrderEntry {
  id: string;
  step: number; // 0 = initial entry, 1 = DCA #1, 2 = DCA #2, etc.
  label: string;
  side: 'long' | 'short';
  price: number;
  amount: number;
  stake_amount: number;
  timestamp: number;
  date: string;
}

export interface PlannedDcaLevel {
  step: number; // 1 = DCA #1, 2 = DCA #2, etc.
  label: string;
  price: number;
  stake_amount: number;
  amount: number;
  distance_pct: number;
  manual_override?: boolean;
}

export interface BotChartLevel {
  id: string;
  pair: string;
  label: string; // e.g. "LVL 1", "LVL 2", "SUP", "RES"
  role: 'support' | 'resistance' | 'entry_trigger';
  price: number;
  touches?: number;
  bounces?: number;
  breaks?: number;
  strength_score?: number;
  source?: string;
  manual_override?: boolean;
  updated_at: string;
}

export type SupportedExchange = 'binance' | 'bybit' | 'okx' | 'bitget' | 'bingx';

export interface ExchangeAccount {
  id: string;
  name: string;
  owner_label: string;
  exchange: SupportedExchange;
  market_type: 'futures' | 'spot';
  api_key_masked: string;
  has_passphrase?: boolean;
  is_owner: boolean;
  client_access_code: string;
  enabled: boolean;
  copy_trading: boolean;
  copy_multiplier: number;
  max_leverage: number;
  balance_usdt: number;
  unrealized_pnl: number;
  open_trades_count: number;
  status: 'connected' | 'paused' | 'error';
  last_sync: string;
  is_testnet?: boolean;
  network_label?: string;
}

export type DrawingToolType =
  | 'cursor'
  | 'trendline'
  | 'ray'
  | 'hline'
  | 'channel'
  | 'fib'
  | 'rect'
  | 'long_rr'
  | 'short_rr'
  | 'text'
  | 'ruler';

export interface ChartDrawingPoint {
  timestamp: number;
  price: number;
}

export interface ChartDrawingObject {
  id: string;
  pair: string;
  tool: Exclude<DrawingToolType, 'cursor'>;
  points: ChartDrawingPoint[];
  color: string;
  text?: string;
  locked?: boolean;
  created_at: string;
}

export interface FreqtradeTrade {
  trade_id: number;
  pair: string;
  base_currency: string;
  quote_currency: string;
  is_open: boolean;
  is_short: boolean;
  exchange: string;
  account_id?: string;
  account_name?: string;
  amount: number;
  stake_amount: number;
  strategy: string;
  timeframe: string;
  enter_tag: string;
  open_date: string;
  open_timestamp: number;
  open_rate: number; // Current weighted average entry price (shifts on DCA like Bybit)
  initial_open_rate?: number; // First entry price before any DCA averaging
  dca_count?: number; // Number of completed DCA averaging steps (0 = Open, >0 = Averaged)
  last_dca_date?: string | null;
  current_rate: number;
  close_date: string | null;
  close_timestamp: number | null;
  close_rate: number | null;
  profit_ratio: number;
  profit_pct: number;
  profit_abs: number;
  take_profit_abs?: number;
  take_profit_pct?: number;
  tp_manual_override?: boolean;
  stop_loss_abs: number;
  stop_loss_pct: number;
  sl_manual_override?: boolean;
  dca_manual_override?: boolean;
  support_level?: number;
  resistance_level?: number;
  next_dca_price?: number;
  breakeven_price?: number;
  min_profitable_tp?: number;
  fee_open?: number;
  fee_close?: number;
  fee_total?: number;
  net_profit?: number;
  initial_stop_loss_abs: number;
  initial_stop_loss_pct: number;
  exit_reason: string | null;
  leverage: number;
  orders: TradeOrderEntry[];
  planned_dca_levels?: PlannedDcaLevel[];
  synced_accounts?: string[];
  campaign_id?: string;
  campaign_banked_profit?: number;
}

export interface ProfitSummary {
  profit_closed_coin: number;
  profit_closed_percent: number;
  profit_closed_fiat: number;
  profit_all_coin: number;
  profit_all_percent: number;
  profit_all_fiat: number;
  profit_open_coin: number;
  profit_open_percent?: number;
  trade_count: number;
  closed_trade_count: number;
  open_trade_count: number;
  winning_trades: number;
  losing_trades: number;
  winrate: number;
  expectancy: number;
  max_drawdown: number;
  max_drawdown_abs: number;
  best_pair: string;
  best_rate: number;
  starting_balance: number;
  current_balance: number;
}

export interface DailyRecord {
  date: string;
  abs_profit: number;
  rel_profit: number;
  fiat_value: number;
  trade_count: number;
  equity: number;
}

export interface BalanceCurrency {
  currency: string;
  free: number;
  used: number;
  balance: number;
  est_stake: number;
  stake: string;
}

export interface BalanceResponse {
  currencies: BalanceCurrency[];
  total: number;
  symbol: number | string;
  value: number;
  starting_capital: number;
  starting_capital_ratio: number;
}

export interface PairMetric {
  pair: string;
  price: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
}

export interface WhitelistResponse {
  whitelist: string[];
  length: number;
  method: string[];
  pair_metrics: PairMetric[];
}

export interface PairPerformance {
  pair: string;
  profit_pct: number;
  profit_abs: number;
  count: number;
}

export interface PairLock {
  id: number;
  pair: string;
  lock_time: string;
  lock_end_time: string;
  reason: string;
  side: string;
  active: boolean;
}

export interface BotLogEntry {
  timestamp: string;
  epoch: number;
  logger: string;
  level: 'INFO' | 'DEBUG' | 'WARNING' | 'ERROR';
  message: string;
}

export interface BotConfig {
  version: string;
  strategy_version: string;
  api_version: number;
  dry_run: boolean;
  runmode: string;
  state: 'running' | 'stopped' | 'paused';
  bot_name: string;
  strategy: string;
  timeframe: string;
  exchange: string;
  stake_currency: string;
  stake_amount: number;
  max_open_trades: number;
  stoploss: number;
  trailing_stop: boolean;
  trailing_stop_positive: number;
  trailing_stop_positive_offset: number;
  minimal_roi: Record<string, number>;
  starting_balance: number;
  available_strategies: string[];
  available_timeframes: string[];
}

export interface PlotConfig {
  showCandles: boolean;
  showVolume: boolean;
  showEntry: boolean;
  showExit: boolean;
  showTrades: boolean;
  showChartAreas: boolean;
  heikinAshi: boolean;
  showEma20: boolean;
  showEma50: boolean;
  showSma200?: boolean;
  showBollinger: boolean;
  showVwap?: boolean;
  showVolumeProfile?: boolean;
  showRsi?: boolean;
  showMacd?: boolean;
  showQuickOrderButtons?: boolean;
}

export function fmtComma(val: number, maxDecimals = 3, minDecimals = 0): string {
  if (!Number.isFinite(val)) return '0';
  return val
    .toLocaleString('ru-RU', {
      minimumFractionDigits: minDecimals,
      maximumFractionDigits: maxDecimals,
      useGrouping: false,
    })
    .replace('.', ',');
}

export function fmtProfitPct(val: number): string {
  if (!Number.isFinite(val)) return '0,00%';
  return `${val.toFixed(2).replace('.', ',')}%`;
}

export function parseDataframeToCandles(df: PairCandlesResponse | null): ParsedCandle[] {
  if (!df || !Array.isArray(df.columns) || !Array.isArray(df.data)) return [];
  const idx = (col: string) => df.columns.indexOf(col);
  const iDate = idx('date');
  const iOpen = idx('open');
  const iHigh = idx('high');
  const iLow = idx('low');
  const iClose = idx('close');
  const iVol = idx('volume');
  const iEma20 = idx('ema_20');
  const iEma50 = idx('ema_50');
  const iSma200 = idx('sma_200');
  const iBbUp = idx('bb_upperband');
  const iBbMid = idx('bb_middleband');
  const iBbLow = idx('bb_lowerband');
  const iRsi = idx('rsi');
  const iEnterLong = idx('enter_long');
  const iEnterTag = idx('enter_tag');
  const iExitLong = idx('exit_long');
  const iExitTag = idx('exit_tag');
  const iEnterShort = idx('enter_short');
  const iExitShort = idx('exit_short');

  return df.data.map((row) => ({
    timestamp: Number(row[iDate]),
    open: Number(row[iOpen]),
    high: Number(row[iHigh]),
    low: Number(row[iLow]),
    close: Number(row[iClose]),
    volume: Number(row[iVol]),
    ema_20: iEma20 >= 0 && row[iEma20] !== null ? Number(row[iEma20]) : null,
    ema_50: iEma50 >= 0 && row[iEma50] !== null ? Number(row[iEma50]) : null,
    sma_200: iSma200 >= 0 && row[iSma200] !== null ? Number(row[iSma200]) : null,
    bb_upperband: iBbUp >= 0 && row[iBbUp] !== null ? Number(row[iBbUp]) : null,
    bb_middleband: iBbMid >= 0 && row[iBbMid] !== null ? Number(row[iBbMid]) : null,
    bb_lowerband: iBbLow >= 0 && row[iBbLow] !== null ? Number(row[iBbLow]) : null,
    rsi: iRsi >= 0 && row[iRsi] !== null ? Number(row[iRsi]) : null,
    enter_long: iEnterLong >= 0 && row[iEnterLong] !== null ? Number(row[iEnterLong]) : null,
    enter_tag: iEnterTag >= 0 ? row[iEnterTag] : null,
    exit_long: iExitLong >= 0 && row[iExitLong] !== null ? Number(row[iExitLong]) : null,
    exit_tag: iExitTag >= 0 ? row[iExitTag] : null,
    enter_short: iEnterShort >= 0 && row[iEnterShort] !== null ? Number(row[iEnterShort]) : null,
    exit_short: iExitShort >= 0 && row[iExitShort] !== null ? Number(row[iExitShort]) : null,
  }));
}
