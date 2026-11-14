import crypto from 'crypto';
import type { ExchangePositionItem, ExchangeClosedPnlItem } from './exchangeConnector.ts';

export interface LiveWsTicker {
  pair: string;
  symbol: string;
  price: number;
  markPrice: number;
  bestBid?: number;
  bestAsk?: number;
  indexPrice?: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  updatedAt: number;
  source: 'bybit_ws' | 'binance_ws';
  marketType?: 'futures' | 'spot';
}

export interface LiveWsKline {
  pair: string;
  symbol: string;
  interval: string;
  time: number; // seconds (unix timestamp)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  confirmed: boolean;
  updatedAt: number;
  source: 'bybit_ws' | 'binance_ws';
}

export interface WsAccountLiveState {
  apiKey: string;
  exchange: 'binance' | 'bybit';
  isTestnet: boolean;
  networkLabel: string;
  walletBalanceUsdt: number;
  unrealizedPnlUsdt: number;
  equityUsdt: number;
  availableBalanceUsdt: number;
  usedMarginUsdt: number;
  canTrade: boolean;
  dualSidePosition?: boolean;
  positions: ExchangePositionItem[];
  closedPnl: ExchangeClosedPnlItem[];
  wsConnected: boolean;
  updatedAt: number;
  lastRestBootstrapAt: number;
}

export interface WsOrderFillEvent {
  exchange: 'binance' | 'bybit';
  apiKey: string;
  orderId: string;
  symbol: string;
  pair: string;
  side: 'BUY' | 'SELL';
  isShort: boolean;
  avgPrice: number;
  qty: number;
  fee: number;
  realizedPnl?: number;
  closedSize?: number;
  isCloseFill: boolean;
  tradeTime: number;
}

export interface WsPositionClosedEvent {
  exchange: 'binance' | 'bybit';
  apiKey: string;
  symbol: string;
  pair: string;
  isShort: boolean;
  closedTime: number;
}

type TickerUpdateCallback = (ticker: LiveWsTicker) => void;
type KlineUpdateCallback = (kline: LiveWsKline) => void;
type AccountUpdateCallback = (state: WsAccountLiveState) => void;
type ExecutionUpdateCallback = (evt: WsOrderFillEvent) => void;
type PositionClosedCallback = (evt: WsPositionClosedEvent) => void;

const wsTickersBySymbol = new Map<string, LiveWsTicker>();
const wsTickersByExchangeAndSymbol = new Map<string, LiveWsTicker>();
const wsAccountStateByKey = new Map<string, WsAccountLiveState>();

const tickerListeners: TickerUpdateCallback[] = [];
const klineListeners: KlineUpdateCallback[] = [];
const accountListeners: AccountUpdateCallback[] = [];
const executionListeners: ExecutionUpdateCallback[] = [];
const positionClosedListeners: PositionClosedCallback[] = [];

// Subscribed symbols, orderbooks and kline topics
const subscribedBybitTickers = new Set<string>();
const subscribedBybitOrderbooks = new Set<string>(); // e.g. orderbook.1.BTCUSDT
const subscribedBybitKlines = new Set<string>(); // e.g. kline.60.BTCUSDT
const subscribedBinanceStreams = new Set<string>(); // e.g. btcusdt@kline_1h, btcusdt@bookTicker

let bybitPublicWs: WebSocket | null = null;
let bybitPublicWsReady = false;
let bybitPingTimer: ReturnType<typeof setInterval> | null = null;
let bybitReconnectTimer: ReturnType<typeof setTimeout> | null = null;

let binancePublicWs: WebSocket | null = null;
let binancePublicWsReady = false;
let binancePingTimer: ReturnType<typeof setInterval> | null = null;
let binanceReconnectTimer: ReturnType<typeof setTimeout> | null = null;

let publicStreamsStarted = false;
let totalWsTickerEvents = 0;
let totalWsKlineEvents = 0;
let totalWsRpcCalls = 0;
let lastWsEventTimestamp = 0;

const DEFAULT_CORE_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'SUIUSDT',
  'DOTUSDT',
  'LTCUSDT',
  'NEARUSDT',
  'APTUSDT',
  'ARBUSDT',
  'OPUSDT',
  'INJUSDT',
  'FETUSDT',
  'WIFUSDT',
  'PEPEUSDT',
  'TONUSDT',
  'TRXUSDT',
  'ATOMUSDT',
  'UNIUSDT',
  'AAVEUSDT',
  'FILUSDT',
  'TIAUSDT',
  'SEIUSDT',
  'ORDIUSDT',
  'RENDERUSDT',
];

export function isSupportedFuturesSymbol(rawSymbol: string): boolean {
  const s = String(rawSymbol || '')
    .trim()
    .toUpperCase()
    .replace('-SWAP', '')
    .replace('_UMCBL', '');
  return (
    s.endsWith('USDT') ||
    s.endsWith('USDC') ||
    s.includes('-USDT') ||
    s.includes('-USDC') ||
    s.includes('/USDT') ||
    s.includes('/USDC')
  );
}

export function cleanSymbolToPair(rawSymbol: string): string {
  const s = String(rawSymbol || '')
    .trim()
    .toUpperCase()
    .replace('-SWAP', '')
    .replace('_UMCBL', '');
  if (s.includes('/')) {
    if (s.includes(':USDT') || s.includes(':USDC')) return s;
    if (s.endsWith('/USDC') || s.includes('/USDC')) return `${s}:USDC`;
    return `${s}:USDT`;
  }
  if (s.includes('-USDC')) {
    const base = s.split('-USDC')[0];
    return `${base}/USDC:USDC`;
  }
  if (s.includes('-USDT')) {
    const base = s.split('-USDT')[0];
    return `${base}/USDT:USDT`;
  }
  if (s.endsWith('USDC') && s.length > 4) {
    const base = s.slice(0, -4);
    return `${base}/USDC:USDC`;
  }
  if (s.endsWith('USDT') && s.length > 4) {
    const base = s.slice(0, -4);
    return `${base}/USDT:USDT`;
  }
  return `${s}/USDT:USDT`;
}

export function pairToSymbol(pair: string): string {
  return String(pair || 'ETH/USDT:USDT')
    .toUpperCase()
    .split(':')[0]
    .replace(/[^A-Z0-9]/g, '');
}

function mapIntervalToBybitWs(interval: string): string {
  const map: Record<string, string> = {
    '1m': '1',
    '3m': '3',
    '5m': '5',
    '15m': '15',
    '30m': '30',
    '1h': '60',
    '2h': '120',
    '4h': '240',
    '6h': '360',
    '12h': '720',
    '1d': 'D',
    '1w': 'W',
  };
  return map[interval] || '60';
}

function mapBybitWsToInterval(bybitInt: string): string {
  const map: Record<string, string> = {
    '1': '1m',
    '3': '3m',
    '5': '5m',
    '15': '15m',
    '30': '30m',
    '60': '1h',
    '120': '2h',
    '240': '4h',
    '360': '6h',
    '720': '12h',
    D: '1d',
    W: '1w',
  };
  return map[bybitInt] || '1h';
}

export function onWsTickerUpdate(cb: TickerUpdateCallback): void {
  tickerListeners.push(cb);
}

export function onWsKlineUpdate(cb: KlineUpdateCallback): void {
  klineListeners.push(cb);
}

export function onWsAccountUpdate(cb: AccountUpdateCallback): void {
  accountListeners.push(cb);
}

export function onWsExchangeExecution(cb: ExecutionUpdateCallback): void {
  executionListeners.push(cb);
}

export function onWsExchangePositionClosed(cb: PositionClosedCallback): void {
  positionClosedListeners.push(cb);
}

export function getLiveWsTicker(
  pairOrSymbol: string,
  preferredExchange?: string
): LiveWsTicker | undefined {
  const sym = pairToSymbol(pairOrSymbol);
  if (preferredExchange === 'binance' || preferredExchange === 'bybit') {
    const exact = wsTickersByExchangeAndSymbol.get(`${preferredExchange}:${sym}`);
    if (exact) return exact;
  }
  return wsTickersBySymbol.get(sym);
}

/**
 * Возвращает точную цену исполнения по стакану (Bid при закрытии LONG / открытии SHORT,
 * Ask при закрытии SHORT / открытии LONG) и текущую Mark-цену фьючерса для расчёта PnL 1:1 с биржей.
 */
export function getFuturesExecutionPrice(
  pairOrSymbol: string,
  isShort: boolean,
  isClose: boolean,
  preferredExchange?: string
): {
  markPrice: number;
  lastPrice: number;
  bestBid: number;
  bestAsk: number;
  executionPrice: number;
  source?: string;
  updatedAt: number;
} | undefined {
  const tick = getLiveWsTicker(pairOrSymbol, preferredExchange);
  if (!tick) return undefined;
  const markPrice = tick.markPrice > 0 ? tick.markPrice : tick.price;
  const lastPrice = tick.price > 0 ? tick.price : markPrice;
  const bestBid = tick.bestBid && tick.bestBid > 0 ? tick.bestBid : lastPrice;
  const bestAsk = tick.bestAsk && tick.bestAsk > 0 ? tick.bestAsk : lastPrice;
  // Закрытие LONG -> продаём в Bid; Закрытие SHORT -> откупаем по Ask
  // Открытие LONG -> покупаем по Ask; Открытие SHORT -> продаём в Bid
  const needsBid = isClose ? !isShort : isShort;
  const executionPrice = needsBid ? bestBid : bestAsk;
  return {
    markPrice,
    lastPrice,
    bestBid,
    bestAsk,
    executionPrice: executionPrice > 0 ? executionPrice : markPrice,
    source: tick.source,
    updatedAt: tick.updatedAt,
  };
}

export function getAllLiveWsTickers(): LiveWsTicker[] {
  return Array.from(wsTickersBySymbol.values());
}

export function getWebSocketEngineStatus() {
  return {
    public_streams_started: publicStreamsStarted,
    bybit_public_ws_connected: bybitPublicWsReady,
    binance_public_ws_connected: binancePublicWsReady,
    tracked_tickers_count: wsTickersBySymbol.size,
    exchange_tickers_count: wsTickersByExchangeAndSymbol.size,
    subscribed_bybit_klines: subscribedBybitKlines.size,
    subscribed_binance_klines: subscribedBinanceStreams.size,
    active_private_streams: Array.from(wsAccountStateByKey.values()).filter((s) => s.wsConnected).length,
    total_ticker_events: totalWsTickerEvents,
    total_kline_events: totalWsKlineEvents,
    total_ws_rpc_calls: totalWsRpcCalls,
    last_event_timestamp: lastWsEventTimestamp,
  };
}

function updatePositionsMarkPriceFromTicker(
  symbol: string,
  markPrice: number,
  sourceExchange: 'bybit' | 'binance'
): void {
  if (!(markPrice > 0)) return;
  for (const state of wsAccountStateByKey.values()) {
    if (state.exchange !== sourceExchange) continue;
    let changed = false;
    let totalUnrealized = 0;
    for (const pos of state.positions) {
      if (pos.symbol === symbol && pos.size > 0 && pos.entry_price > 0) {
        pos.mark_price = markPrice;
        const diff = pos.is_short ? pos.entry_price - markPrice : markPrice - pos.entry_price;
        pos.unrealized_pnl = Number((diff * pos.size).toFixed(4));
        pos.updated_time = Date.now();
        changed = true;
      }
      totalUnrealized += Number(pos.unrealized_pnl || 0);
    }
    if (changed) {
      state.unrealizedPnlUsdt = Number(totalUnrealized.toFixed(4));
      state.equityUsdt = Number((state.walletBalanceUsdt + state.unrealizedPnlUsdt).toFixed(4));
    }
  }
}

function emitTickerUpdate(ticker: LiveWsTicker): void {
  const ex: 'bybit' | 'binance' = ticker.source === 'binance_ws' ? 'binance' : 'bybit';
  const exKey = `${ex}:${ticker.symbol}`;
  const prevEx = wsTickersByExchangeAndSymbol.get(exKey);
  const merged: LiveWsTicker = {
    ...prevEx,
    ...ticker,
    bestBid: ticker.bestBid && ticker.bestBid > 0 ? ticker.bestBid : prevEx?.bestBid,
    bestAsk: ticker.bestAsk && ticker.bestAsk > 0 ? ticker.bestAsk : prevEx?.bestAsk,
    indexPrice: ticker.indexPrice && ticker.indexPrice > 0 ? ticker.indexPrice : prevEx?.indexPrice,
    markPrice: ticker.markPrice > 0 ? ticker.markPrice : prevEx?.markPrice || ticker.price,
    price: ticker.price > 0 ? ticker.price : prevEx?.price || ticker.markPrice,
    marketType: ticker.marketType || 'futures',
  };
  wsTickersByExchangeAndSymbol.set(exKey, merged);
  wsTickersBySymbol.set(merged.symbol, merged);
  totalWsTickerEvents++;
  lastWsEventTimestamp = Date.now();
  updatePositionsMarkPriceFromTicker(merged.symbol, merged.markPrice || merged.price, ex);
  for (const cb of tickerListeners) {
    try {
      cb(merged);
    } catch {
      // ignore listener error
    }
  }
}

function emitKlineUpdate(kline: LiveWsKline): void {
  totalWsKlineEvents++;
  lastWsEventTimestamp = Date.now();
  for (const cb of klineListeners) {
    try {
      cb(kline);
    } catch {
      // ignore listener error
    }
  }
}

function emitAccountUpdate(state: WsAccountLiveState): void {
  lastWsEventTimestamp = Date.now();
  for (const cb of accountListeners) {
    try {
      cb(state);
    } catch {
      // ignore listener error
    }
  }
}

function emitExecutionUpdate(evt: WsOrderFillEvent): void {
  lastWsEventTimestamp = Date.now();
  for (const cb of executionListeners) {
    try {
      cb(evt);
    } catch {
      // ignore listener error
    }
  }
}

function emitPositionClosed(evt: WsPositionClosedEvent): void {
  lastWsEventTimestamp = Date.now();
  for (const cb of positionClosedListeners) {
    try {
      cb(evt);
    } catch {
      // ignore listener error
    }
  }
}

// ============================================================================
// ORDER FILL WAITER (мгновенное получение avgPrice / fee / realizedPnl из приватного WS)
// ============================================================================

const recentOrderFillsByKey = new Map<string, { event: WsOrderFillEvent; ts: number }>();
const pendingOrderFillWaiters = new Map<
  string,
  Array<{ resolve: (evt: WsOrderFillEvent | null) => void; timer: ReturnType<typeof setTimeout> }>
>();

function recordOrderFillFromWs(evt: WsOrderFillEvent): void {
  if (!evt.orderId) return;
  const key = `${evt.exchange}:${evt.apiKey}:${evt.orderId}`;
  recentOrderFillsByKey.set(key, { event: evt, ts: Date.now() });
  if (recentOrderFillsByKey.size > 400) {
    const cutoff = Date.now() - 120_000;
    for (const [k, v] of recentOrderFillsByKey.entries()) {
      if (v.ts < cutoff) recentOrderFillsByKey.delete(k);
    }
  }
  const waiters = pendingOrderFillWaiters.get(key);
  if (waiters && waiters.length > 0) {
    pendingOrderFillWaiters.delete(key);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve(evt);
    }
  }
}

export function waitForWsOrderFill(
  exchange: 'binance' | 'bybit',
  apiKey: string,
  orderId: string,
  timeoutMs = 350
): Promise<WsOrderFillEvent | null> {
  if (!orderId) return Promise.resolve(null);
  const key = `${exchange}:${apiKey}:${orderId}`;
  const cached = recentOrderFillsByKey.get(key);
  if (cached && Date.now() - cached.ts < 30_000) {
    return Promise.resolve(cached.event);
  }
  if (!isPrivateWsStreamOpen(exchange, apiKey)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const list = pendingOrderFillWaiters.get(key);
      if (list) {
        const remaining = list.filter((w) => w.timer !== timer);
        if (remaining.length > 0) pendingOrderFillWaiters.set(key, remaining);
        else pendingOrderFillWaiters.delete(key);
      }
      resolve(recentOrderFillsByKey.get(key)?.event || null);
    }, timeoutMs);
    const existing = pendingOrderFillWaiters.get(key) || [];
    existing.push({ resolve, timer });
    pendingOrderFillWaiters.set(key, existing);
  });
}

// ============================================================================
// 1. PUBLIC FUTURES MARKET STREAMS (Bybit V5 Linear WS + Binance USD-M Futures WS)
// ============================================================================

function connectBybitPublicWs(): void {
  if (typeof WebSocket === 'undefined') return;
  if (bybitPublicWs) {
    try {
      bybitPublicWs.close();
    } catch {
      // ignore
    }
    bybitPublicWs = null;
  }
  bybitPublicWsReady = false;

  try {
    const ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
    bybitPublicWs = ws;

    ws.onopen = () => {
      bybitPublicWsReady = true;
      for (const sym of DEFAULT_CORE_SYMBOLS) {
        subscribedBybitTickers.add(`tickers.${sym}`);
      }
      const allTopics = [
        ...Array.from(subscribedBybitTickers),
        ...Array.from(subscribedBybitOrderbooks),
        ...Array.from(subscribedBybitKlines),
      ];
      for (let i = 0; i < allTopics.length; i += 10) {
        const chunk = allTopics.slice(i, i + 10);
        if (chunk.length > 0) {
          try {
            ws.send(JSON.stringify({ op: 'subscribe', args: chunk }));
          } catch {
            // ignore
          }
        }
      }

      if (bybitPingTimer) clearInterval(bybitPingTimer);
      bybitPingTimer = setInterval(() => {
        if (bybitPublicWs && bybitPublicWsReady) {
          try {
            bybitPublicWs.send(JSON.stringify({ op: 'ping' }));
          } catch {
            // ignore
          }
        }
      }, 20_000);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (!msg || !msg.topic) return;
        const topic = String(msg.topic);

        if (topic.startsWith('tickers.')) {
          const d = msg.data;
          if (!d) return;
          const sym = String(d.symbol || topic.slice(8)).toUpperCase();
          if (!sym.endsWith('USDT')) return;
          const prev = wsTickersByExchangeAndSymbol.get(`bybit:${sym}`);
          const price = Number(d.lastPrice || prev?.price || 0);
          const markPrice = Number(d.markPrice || prev?.markPrice || price);
          if (!(price > 0) && !(markPrice > 0)) return;
          const bestBid = d.bid1Price !== undefined ? Number(d.bid1Price) : prev?.bestBid;
          const bestAsk = d.ask1Price !== undefined ? Number(d.ask1Price) : prev?.bestAsk;
          const indexPrice = d.indexPrice !== undefined ? Number(d.indexPrice) : prev?.indexPrice;
          const change24h =
            d.price24hPcnt !== undefined
              ? Number((Number(d.price24hPcnt) * 100).toFixed(2))
              : prev?.change24h ?? 0;
          const volume24h =
            d.turnover24h !== undefined ? Number(d.turnover24h) : prev?.volume24h ?? 0;
          const high24h =
            d.highPrice24h !== undefined
              ? Number(d.highPrice24h)
              : prev?.high24h ?? (price || markPrice) * 1.01;
          const low24h =
            d.lowPrice24h !== undefined
              ? Number(d.lowPrice24h)
              : prev?.low24h ?? (price || markPrice) * 0.99;

          emitTickerUpdate({
            pair: cleanSymbolToPair(sym),
            symbol: sym,
            price: price > 0 ? price : markPrice,
            markPrice: markPrice > 0 ? markPrice : price,
            bestBid: bestBid && bestBid > 0 ? bestBid : undefined,
            bestAsk: bestAsk && bestAsk > 0 ? bestAsk : undefined,
            indexPrice: indexPrice && indexPrice > 0 ? indexPrice : undefined,
            change24h,
            volume24h,
            high24h,
            low24h,
            updatedAt: Date.now(),
            source: 'bybit_ws',
            marketType: 'futures',
          });
        } else if (topic.startsWith('orderbook.1.')) {
          const d = msg.data;
          if (!d) return;
          const sym = String(d.s || topic.slice('orderbook.1.'.length)).toUpperCase();
          if (!sym.endsWith('USDT')) return;
          const prev = wsTickersByExchangeAndSymbol.get(`bybit:${sym}`);
          const bid = Array.isArray(d.b) && d.b[0] ? Number(d.b[0][0]) : prev?.bestBid || 0;
          const ask = Array.isArray(d.a) && d.a[0] ? Number(d.a[0][0]) : prev?.bestAsk || 0;
          if (!(bid > 0) && !(ask > 0)) return;
          const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
          emitTickerUpdate({
            pair: cleanSymbolToPair(sym),
            symbol: sym,
            price: prev?.price || mid,
            markPrice: prev?.markPrice || mid,
            bestBid: bid > 0 ? bid : prev?.bestBid,
            bestAsk: ask > 0 ? ask : prev?.bestAsk,
            indexPrice: prev?.indexPrice,
            change24h: prev?.change24h ?? 0,
            volume24h: prev?.volume24h ?? 0,
            high24h: prev?.high24h ?? mid * 1.01,
            low24h: prev?.low24h ?? mid * 0.99,
            updatedAt: Date.now(),
            source: 'bybit_ws',
            marketType: 'futures',
          });
        } else if (topic.startsWith('kline.')) {
          const parts = topic.split('.');
          const bybitInt = parts[1] || '60';
          const sym = (parts[2] || '').toUpperCase();
          const interval = mapBybitWsToInterval(bybitInt);
          const list = Array.isArray(msg.data) ? msg.data : [];
          for (const k of list) {
            const startMs = Number(k.start || 0);
            const open = Number(k.open || 0);
            const high = Number(k.high || 0);
            const low = Number(k.low || 0);
            const close = Number(k.close || 0);
            const volume = Number(k.volume || 0);
            if (!(startMs > 0) || !(close > 0)) continue;
            emitKlineUpdate({
              pair: cleanSymbolToPair(sym),
              symbol: sym,
              interval,
              time: Math.floor(startMs / 1000),
              open,
              high,
              low,
              close,
              volume,
              confirmed: Boolean(k.confirm),
              updatedAt: Date.now(),
              source: 'bybit_ws',
            });
          }
        }
      } catch {
        // ignore malformed message
      }
    };

    ws.onclose = () => {
      bybitPublicWsReady = false;
      if (bybitPingTimer) {
        clearInterval(bybitPingTimer);
        bybitPingTimer = null;
      }
      if (bybitReconnectTimer) clearTimeout(bybitReconnectTimer);
      bybitReconnectTimer = setTimeout(() => connectBybitPublicWs(), 2000);
    };

    ws.onerror = () => {
      // handled by onclose
    };
  } catch {
    if (bybitReconnectTimer) clearTimeout(bybitReconnectTimer);
    bybitReconnectTimer = setTimeout(() => connectBybitPublicWs(), 4000);
  }
}

function connectBinancePublicWs(): void {
  if (typeof WebSocket === 'undefined') return;
  if (binancePublicWs) {
    try {
      binancePublicWs.close();
    } catch {
      // ignore
    }
    binancePublicWs = null;
  }
  binancePublicWsReady = false;

  try {
    // Binance USD-M Futures WebSocket (wss://fstream.binance.com/ws):
    // !markPrice@arr@1s + !ticker@arr + bookTicker + futures klines — 1:1 с фьючерсным терминалом биржи
    const ws = new WebSocket('wss://fstream.binance.com/ws');
    binancePublicWs = ws;

    ws.onopen = () => {
      binancePublicWsReady = true;
      for (const sym of DEFAULT_CORE_SYMBOLS.slice(0, 15)) {
        subscribedBinanceStreams.add(`${sym.toLowerCase()}@bookTicker`);
      }
      const params = [
        '!markPrice@arr@1s',
        '!ticker@arr',
        ...Array.from(subscribedBinanceStreams),
      ];
      for (let i = 0; i < params.length; i += 40) {
        const chunk = params.slice(i, i + 40);
        try {
          ws.send(
            JSON.stringify({
              method: 'SUBSCRIBE',
              params: chunk,
              id: Date.now() + i,
            })
          );
        } catch {
          // ignore
        }
      }

      if (binancePingTimer) clearInterval(binancePingTimer);
      binancePingTimer = setInterval(() => {
        if (binancePublicWs && binancePublicWsReady && binancePublicWs.readyState === 1) {
          try {
            // Binance fstream accepts standard empty control or stays alive via traffic
            binancePublicWs.send(JSON.stringify({ method: 'LIST_SUBSCRIPTIONS', id: Date.now() }));
          } catch {
            // ignore
          }
        }
      }, 120_000);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (!msg) return;

        // 1. Array events: !markPrice@arr@1s or !ticker@arr
        if (Array.isArray(msg)) {
          const now = Date.now();
          for (const item of msg) {
            const ev = item?.e;
            const sym = String(item?.s || '').toUpperCase();
            if (!sym.endsWith('USDT')) continue;

            if (ev === 'markPriceUpdate') {
              const mark = Number(item.p || 0);
              const idx = Number(item.i || 0);
              if (!(mark > 0)) continue;
              const prev = wsTickersByExchangeAndSymbol.get(`binance:${sym}`);
              emitTickerUpdate({
                pair: cleanSymbolToPair(sym),
                symbol: sym,
                price: prev?.price || mark,
                markPrice: mark,
                bestBid: prev?.bestBid,
                bestAsk: prev?.bestAsk,
                indexPrice: idx > 0 ? idx : prev?.indexPrice,
                change24h: prev?.change24h ?? 0,
                volume24h: prev?.volume24h ?? 0,
                high24h: prev?.high24h ?? mark * 1.01,
                low24h: prev?.low24h ?? mark * 0.99,
                updatedAt: now,
                source: 'binance_ws',
                marketType: 'futures',
              });
            } else if (ev === '24hrTicker' || ev === '24hrMiniTicker') {
              const close = Number(item.c || 0);
              const open = Number(item.o || close);
              const high = Number(item.h || close);
              const low = Number(item.l || close);
              const quoteVol = Number(item.q || 0);
              if (!(close > 0)) continue;
              const prev = wsTickersByExchangeAndSymbol.get(`binance:${sym}`);
              const change24h =
                item.P !== undefined
                  ? Number(Number(item.P).toFixed(2))
                  : open > 0
                  ? Number((((close - open) / open) * 100).toFixed(2))
                  : prev?.change24h ?? 0;

              emitTickerUpdate({
                pair: cleanSymbolToPair(sym),
                symbol: sym,
                price: close,
                markPrice: prev?.markPrice || close,
                bestBid: prev?.bestBid,
                bestAsk: prev?.bestAsk,
                indexPrice: prev?.indexPrice,
                change24h,
                volume24h: quoteVol,
                high24h: high,
                low24h: low,
                updatedAt: now,
                source: 'binance_ws',
                marketType: 'futures',
              });
            }
          }
          return;
        }

        // 2. Futures best bid/ask bookTicker event (sub-50ms)
        if ((msg.e === 'bookTicker' || (msg.u && msg.b && msg.a)) && msg.s) {
          const sym = String(msg.s).toUpperCase();
          if (!sym.endsWith('USDT')) return;
          const bestBid = Number(msg.b || 0);
          const bestAsk = Number(msg.a || 0);
          if (!(bestBid > 0) && !(bestAsk > 0)) return;
          const prev = wsTickersByExchangeAndSymbol.get(`binance:${sym}`);
          const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
          emitTickerUpdate({
            pair: cleanSymbolToPair(sym),
            symbol: sym,
            price: prev?.price || mid,
            markPrice: prev?.markPrice || mid,
            bestBid: bestBid > 0 ? bestBid : prev?.bestBid,
            bestAsk: bestAsk > 0 ? bestAsk : prev?.bestAsk,
            indexPrice: prev?.indexPrice,
            change24h: prev?.change24h ?? 0,
            volume24h: prev?.volume24h ?? 0,
            high24h: prev?.high24h ?? mid * 1.01,
            low24h: prev?.low24h ?? mid * 0.99,
            updatedAt: Date.now(),
            source: 'binance_ws',
            marketType: 'futures',
          });
          return;
        }

        // 3. Live Futures Kline event
        if (msg.e === 'kline' && msg.k) {
          const k = msg.k;
          const sym = String(k.s || msg.s || '').toUpperCase();
          const interval = String(k.i || '1h');
          const startMs = Number(k.t || 0);
          const open = Number(k.o || 0);
          const high = Number(k.h || 0);
          const low = Number(k.l || 0);
          const close = Number(k.c || 0);
          const volume = Number(k.v || 0);
          if (!(startMs > 0) || !(close > 0)) return;

          emitKlineUpdate({
            pair: cleanSymbolToPair(sym),
            symbol: sym,
            interval,
            time: Math.floor(startMs / 1000),
            open,
            high,
            low,
            close,
            volume,
            confirmed: Boolean(k.x),
            updatedAt: Date.now(),
            source: 'binance_ws',
          });
        }
      } catch {
        // ignore parse error
      }
    };

    ws.onclose = () => {
      binancePublicWsReady = false;
      if (binancePingTimer) {
        clearInterval(binancePingTimer);
        binancePingTimer = null;
      }
      if (binanceReconnectTimer) clearTimeout(binanceReconnectTimer);
      binanceReconnectTimer = setTimeout(() => connectBinancePublicWs(), 2000);
    };

    ws.onerror = () => {
      // handled by onclose
    };
  } catch {
    if (binanceReconnectTimer) clearTimeout(binanceReconnectTimer);
    binanceReconnectTimer = setTimeout(() => connectBinancePublicWs(), 4000);
  }
}

export function startPublicMarketWebSockets(): void {
  if (publicStreamsStarted) return;
  publicStreamsStarted = true;
  connectBybitPublicWs();
  connectBinancePublicWs();
}

/**
 * Подписывает пару и таймфрейм на live WebSocket поток свечей, тикеров и L1 стакана (Bybit + Binance Futures),
 * чтобы свечи, Mark Price и Bid/Ask обновлялись в реальном времени без HTTP REST-запросов.
 */
export function subscribePairKlineStream(pair: string, interval = '1h'): void {
  if (!publicStreamsStarted) {
    startPublicMarketWebSockets();
  }
  const sym = pairToSymbol(pair);
  if (!sym.endsWith('USDT')) return;

  // 1. Bybit ticker, orderbook.1 & kline subscription
  const tickerTopic = `tickers.${sym}`;
  const obTopic = `orderbook.1.${sym}`;
  const bybitInt = mapIntervalToBybitWs(interval);
  const klineTopic = `kline.${bybitInt}.${sym}`;
  const newBybitTopics: string[] = [];

  if (!subscribedBybitTickers.has(tickerTopic)) {
    subscribedBybitTickers.add(tickerTopic);
    newBybitTopics.push(tickerTopic);
  }
  if (!subscribedBybitOrderbooks.has(obTopic)) {
    subscribedBybitOrderbooks.add(obTopic);
    newBybitTopics.push(obTopic);
  }
  if (!subscribedBybitKlines.has(klineTopic)) {
    subscribedBybitKlines.add(klineTopic);
    newBybitTopics.push(klineTopic);
  }

  if (newBybitTopics.length > 0 && bybitPublicWs && bybitPublicWsReady) {
    try {
      bybitPublicWs.send(JSON.stringify({ op: 'subscribe', args: newBybitTopics }));
    } catch {
      // ignore
    }
  }

  // 2. Binance Futures bookTicker & kline subscription
  const bnKlineTopic = `${sym.toLowerCase()}@kline_${interval}`;
  const bnBookTopic = `${sym.toLowerCase()}@bookTicker`;
  const newBinanceTopics: string[] = [];
  if (!subscribedBinanceStreams.has(bnKlineTopic)) {
    subscribedBinanceStreams.add(bnKlineTopic);
    newBinanceTopics.push(bnKlineTopic);
  }
  if (!subscribedBinanceStreams.has(bnBookTopic)) {
    subscribedBinanceStreams.add(bnBookTopic);
    newBinanceTopics.push(bnBookTopic);
  }
  if (newBinanceTopics.length > 0 && binancePublicWs && binancePublicWsReady) {
    try {
      binancePublicWs.send(
        JSON.stringify({
          method: 'SUBSCRIBE',
          params: newBinanceTopics,
          id: Date.now(),
        })
      );
    } catch {
      // ignore
    }
  }
}

// ============================================================================
// 2. BINANCE FUTURES WEBSOCKET API (wss://ws-fapi.binance.com/ws-fapi/v1)
// ============================================================================

interface PendingWsRpc {
  resolve: (val: {
    status: number;
    result?: any;
    error?: { code: number; msg: string };
    latencyMs: number;
  }) => void;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

class BinanceWsRpcConnection {
  private wsUrl: string;
  private ws: WebSocket | null = null;
  private isReady = false;
  private connectingPromise: Promise<boolean> | null = null;
  private pending = new Map<string, PendingWsRpc>();

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  private async ensureConnected(timeoutMs = 5000): Promise<boolean> {
    if (this.ws && this.isReady) return true;
    if (this.connectingPromise) return this.connectingPromise;

    this.connectingPromise = new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.connectingPromise = null;
          resolve(false);
        }
      }, timeoutMs);

      try {
        const sock = new WebSocket(this.wsUrl);
        this.ws = sock;

        sock.onopen = () => {
          this.isReady = true;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            this.connectingPromise = null;
            resolve(true);
          }
        };

        sock.onmessage = (event) => {
          try {
            const data = JSON.parse(String(event.data));
            const reqId = String(data?.id || '');
            if (reqId && this.pending.has(reqId)) {
              const item = this.pending.get(reqId)!;
              this.pending.delete(reqId);
              clearTimeout(item.timer);
              item.resolve({
                status: Number(data.status || (data.error ? 400 : 200)),
                result: data.result,
                error: data.error,
                latencyMs: Math.max(1, Date.now() - item.startedAt),
              });
            }
          } catch {
            // ignore
          }
        };

        sock.onclose = () => {
          this.isReady = false;
          this.ws = null;
          this.connectingPromise = null;
          for (const [id, item] of this.pending.entries()) {
            this.pending.delete(id);
            clearTimeout(item.timer);
            item.resolve({
              status: 503,
              error: { code: -1001, msg: 'WebSocket connection closed' },
              latencyMs: Math.max(1, Date.now() - item.startedAt),
            });
          }
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(false);
          }
        };

        sock.onerror = () => {
          // handled by onclose
        };
      } catch {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.connectingPromise = null;
          resolve(false);
        }
      }
    });

    return this.connectingPromise;
  }

  public async request(
    method: string,
    params: Record<string, string | number | boolean> = {},
    apiSecret?: string,
    timeoutMs = 6000
  ): Promise<{
    status: number;
    result?: any;
    error?: { code: number; msg: string };
    latencyMs: number;
  }> {
    const connected = await this.ensureConnected(Math.min(4500, timeoutMs));
    if (!connected || !this.ws) {
      return {
        status: 503,
        error: { code: -1001, msg: 'Unable to open Binance Futures WebSocket API' },
        latencyMs: 0,
      };
    }

    const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const finalParams: Record<string, string | number | boolean> = { ...params };

    if (apiSecret) {
      const sortedQuery = Object.keys(finalParams)
        .filter((k) => k !== 'signature' && finalParams[k] !== undefined)
        .sort()
        .map((k) => `${k}=${finalParams[k]}`)
        .join('&');
      finalParams.signature = crypto
        .createHmac('sha256', apiSecret)
        .update(sortedQuery)
        .digest('hex');
    }

    totalWsRpcCalls++;
    lastWsEventTimestamp = Date.now();

    return new Promise((resolve) => {
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        if (this.pending.has(reqId)) {
          this.pending.delete(reqId);
          resolve({
            status: 408,
            error: { code: -1007, msg: 'Timeout waiting for Binance WebSocket API response' },
            latencyMs: timeoutMs,
          });
        }
      }, timeoutMs);

      this.pending.set(reqId, { resolve, startedAt, timer });

      try {
        this.ws!.send(
          JSON.stringify({
            id: reqId,
            method,
            params: Object.keys(finalParams).length > 0 ? finalParams : undefined,
          })
        );
      } catch (e: any) {
        this.pending.delete(reqId);
        clearTimeout(timer);
        resolve({
          status: 500,
          error: { code: -1001, msg: e?.message || 'WebSocket send error' },
          latencyMs: Date.now() - startedAt,
        });
      }
    });
  }
}

const binanceMainnetWsRpc = new BinanceWsRpcConnection('wss://ws-fapi.binance.com/ws-fapi/v1');
const binanceTestnetWsRpc = new BinanceWsRpcConnection(
  'wss://testnet.binancefuture.com/ws-fapi/v1'
);

export function getBinanceWsRpcClient(baseUrl: string): BinanceWsRpcConnection {
  return baseUrl.includes('testnet') ? binanceTestnetWsRpc : binanceMainnetWsRpc;
}

// ============================================================================
// 2B. BYBIT V5 WEBSOCKET TRADE API (wss://stream.bybit.com/v5/trade)
//     Отправка ордеров по постоянному WS без задержек HTTPS-рукопожатия
// ============================================================================

interface PendingBybitTradeReq {
  resolve: (val: {
    status: number;
    retCode?: number;
    retMsg?: string;
    result?: any;
    latencyMs: number;
  }) => void;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

class BybitWsTradeConnection {
  private wsUrl: string;
  private apiKey: string;
  private apiSecret: string;
  private ws: WebSocket | null = null;
  private isAuthenticated = false;
  private authFailedUntil = 0;
  private connectingPromise: Promise<boolean> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pending = new Map<string, PendingBybitTradeReq>();

  constructor(wsUrl: string, apiKey: string, apiSecret: string) {
    this.wsUrl = wsUrl;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  private async ensureReady(timeoutMs = 3500): Promise<boolean> {
    if (Date.now() < this.authFailedUntil) return false;
    if (this.ws && this.isAuthenticated && this.ws.readyState === 1) return true;
    if (this.connectingPromise) return this.connectingPromise;

    this.connectingPromise = new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.connectingPromise = null;
          resolve(ok);
        }
      };
      const timer = setTimeout(() => done(false), timeoutMs);

      try {
        const sock = new WebSocket(this.wsUrl);
        this.ws = sock;

        sock.onopen = () => {
          const expires = Date.now() + 10_000;
          const signature = crypto
            .createHmac('sha256', this.apiSecret)
            .update(`GET/realtime${expires}`)
            .digest('hex');
          try {
            sock.send(
              JSON.stringify({
                op: 'auth',
                args: [this.apiKey, expires, signature],
              })
            );
          } catch {
            done(false);
          }
        };

        sock.onmessage = (event) => {
          try {
            const msg = JSON.parse(String(event.data));
            if (msg?.op === 'auth') {
              if (msg.retCode === 0 || msg.success === true) {
                this.isAuthenticated = true;
                if (this.pingTimer) clearInterval(this.pingTimer);
                this.pingTimer = setInterval(() => {
                  if (this.ws && this.ws.readyState === 1) {
                    try {
                      this.ws.send(JSON.stringify({ op: 'ping' }));
                    } catch {
                      // ignore
                    }
                  }
                }, 20_000);
                done(true);
              } else {
                this.authFailedUntil = Date.now() + 60_000;
                done(false);
              }
              return;
            }
            const reqId = String(msg?.reqId || '');
            if (reqId && this.pending.has(reqId)) {
              const item = this.pending.get(reqId)!;
              this.pending.delete(reqId);
              clearTimeout(item.timer);
              item.resolve({
                status: 200,
                retCode: Number(msg.retCode ?? -1),
                retMsg: String(msg.retMsg || ''),
                result: msg.data,
                latencyMs: Math.max(1, Date.now() - item.startedAt),
              });
            }
          } catch {
            // ignore
          }
        };

        sock.onclose = () => {
          this.isAuthenticated = false;
          this.ws = null;
          if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
          }
          for (const [id, item] of this.pending.entries()) {
            this.pending.delete(id);
            clearTimeout(item.timer);
            item.resolve({
              status: 503,
              retCode: -1,
              retMsg: 'Bybit WS trade connection closed',
              latencyMs: Math.max(1, Date.now() - item.startedAt),
            });
          }
          done(false);
        };

        sock.onerror = () => {
          // handled by onclose
        };
      } catch {
        done(false);
      }
    });

    return this.connectingPromise;
  }

  public async placeOrder(
    timestamp: string,
    recvWindow: string,
    orderArgs: Record<string, any>,
    timeoutMs = 4000
  ): Promise<{
    status: number;
    retCode?: number;
    retMsg?: string;
    result?: any;
    latencyMs: number;
  }> {
    const ready = await this.ensureReady(Math.min(3000, timeoutMs));
    if (!ready || !this.ws || this.ws.readyState !== 1) {
      return {
        status: 503,
        retCode: -1,
        retMsg: 'Bybit WS Trade unavailable',
        latencyMs: 0,
      };
    }

    const reqId = `byb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    totalWsRpcCalls++;
    lastWsEventTimestamp = Date.now();

    return new Promise((resolve) => {
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        if (this.pending.has(reqId)) {
          this.pending.delete(reqId);
          resolve({
            status: 408,
            retCode: -1,
            retMsg: 'Timeout waiting for Bybit WS order response',
            latencyMs: timeoutMs,
          });
        }
      }, timeoutMs);

      this.pending.set(reqId, { resolve, startedAt, timer });
      try {
        this.ws!.send(
          JSON.stringify({
            reqId,
            header: {
              'X-BAPI-TIMESTAMP': timestamp,
              'X-BAPI-RECV-WINDOW': recvWindow,
            },
            op: 'order.create',
            args: [orderArgs],
          })
        );
      } catch (e: any) {
        this.pending.delete(reqId);
        clearTimeout(timer);
        resolve({
          status: 500,
          retCode: -1,
          retMsg: e?.message || 'Bybit WS send error',
          latencyMs: Date.now() - startedAt,
        });
      }
    });
  }
}

const bybitWsTradeClients = new Map<string, BybitWsTradeConnection>();

export function getBybitWsTradeClient(
  apiKey: string,
  apiSecret: string,
  baseUrl: string
): BybitWsTradeConnection {
  const wsUrl = baseUrl.includes('testnet')
    ? 'wss://stream-testnet.bybit.com/v5/trade'
    : baseUrl.includes('demo')
    ? 'wss://stream-demo.bybit.com/v5/trade'
    : 'wss://stream.bybit.com/v5/trade';
  const key = `${wsUrl}:${apiKey}`;
  let client = bybitWsTradeClients.get(key);
  if (!client) {
    client = new BybitWsTradeConnection(wsUrl, apiKey, apiSecret);
    bybitWsTradeClients.set(key, client);
  }
  return client;
}

// ============================================================================
// 3. PRIVATE ACCOUNT & POSITION STREAMS (Binance UserDataStream + Bybit V5 Private WS)
// ============================================================================

const activePrivateSockets = new Map<
  string,
  {
    ws: WebSocket;
    keepaliveTimer?: ReturnType<typeof setInterval>;
    reconnectTimer?: ReturnType<typeof setTimeout>;
  }
>();

const registeredPrivateStreams = new Map<
  string,
  {
    exchange: 'binance' | 'bybit';
    apiKey: string;
    apiSecret: string;
    baseUrl: string;
    retries: number;
  }
>();

export function stopPrivateUserStream(exchange: 'binance' | 'bybit', apiKey: string): void {
  const sockKey = `${exchange}:${apiKey}`;
  registeredPrivateStreams.delete(sockKey);
  const existing = activePrivateSockets.get(sockKey);
  if (existing) {
    if (existing.keepaliveTimer) clearInterval(existing.keepaliveTimer);
    if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
    try {
      existing.ws.close();
    } catch {
      // ignore
    }
    activePrivateSockets.delete(sockKey);
  }
}

export function isPrivateWsStreamOpen(
  exchange: 'binance' | 'bybit',
  apiKey: string
): boolean {
  const entry = activePrivateSockets.get(`${exchange}:${apiKey}`);
  if (!entry || !entry.ws) return false;
  return entry.ws.readyState === 1;
}

export function getWsAccountLiveState(
  apiKey: string,
  maxAgeMs = 180_000
): WsAccountLiveState | undefined {
  const state = wsAccountStateByKey.get(apiKey);
  if (!state) return undefined;
  const streamOpen = state.wsConnected && isPrivateWsStreamOpen(state.exchange, apiKey);
  if (!streamOpen && Date.now() - state.updatedAt > maxAgeMs) {
    return undefined;
  }
  if (Date.now() - state.lastRestBootstrapAt > Math.max(maxAgeMs, 180_000) && !streamOpen) {
    return undefined;
  }
  return state;
}

export function setWsAccountLiveState(state: WsAccountLiveState): void {
  wsAccountStateByKey.set(state.apiKey, state);
  for (const pos of state.positions) {
    subscribePairKlineStream(pos.pair, '1h');
  }
}

function schedulePrivateReconnect(sockKey: string): void {
  const reg = registeredPrivateStreams.get(sockKey);
  if (!reg) return;
  const delayMs = Math.min(20_000, Math.round(1500 * Math.pow(1.5, reg.retries)));
  reg.retries = Math.min(8, reg.retries + 1);
  const existing = activePrivateSockets.get(sockKey);
  if (existing?.reconnectTimer) clearTimeout(existing.reconnectTimer);
  const timer = setTimeout(() => {
    const current = registeredPrivateStreams.get(sockKey);
    if (!current) return;
    if (current.exchange === 'binance') {
      ensureBinancePrivateUserStream(current.apiKey, current.apiSecret, current.baseUrl).catch(
        () => {}
      );
    } else {
      ensureBybitPrivateUserStream(current.apiKey, current.apiSecret, current.baseUrl);
    }
  }, delayMs);
  if (existing) {
    existing.reconnectTimer = timer;
  } else {
    // Store minimal holder only for timer cleanup if stopped before connect
    setTimeout(() => {}, 0);
  }
}

/**
 * Запускает приватный WebSocket поток User Data Stream для Binance Futures (listenKey через ws-fapi).
 * Мгновенно получает обновления баланса (ACCOUNT_UPDATE), открытых позиций и исполненных ордеров (ORDER_TRADE_UPDATE).
 */
export async function ensureBinancePrivateUserStream(
  apiKey: string,
  apiSecret: string,
  baseUrl: string
): Promise<void> {
  if (!apiKey || !apiSecret || typeof WebSocket === 'undefined') return;
  const sockKey = `binance:${apiKey}`;
  const existing = activePrivateSockets.get(sockKey);
  if (existing && (existing.ws.readyState === 0 || existing.ws.readyState === 1)) return;

  registeredPrivateStreams.set(sockKey, {
    exchange: 'binance',
    apiKey,
    apiSecret,
    baseUrl,
    retries: registeredPrivateStreams.get(sockKey)?.retries ?? 0,
  });

  const rpc = getBinanceWsRpcClient(baseUrl);
  const startRes = await rpc.request('userDataStream.start', { apiKey }, undefined, 5000);
  const listenKey = startRes.result?.listenKey;
  if (!listenKey) {
    schedulePrivateReconnect(sockKey);
    return;
  }

  const isTestnet = baseUrl.includes('testnet');
  const streamUrl = isTestnet
    ? `wss://stream.binancefuture.com/ws/${listenKey}`
    : `wss://fstream.binance.com/ws/${listenKey}`;

  try {
    const ws = new WebSocket(streamUrl);
    const keepaliveTimer = setInterval(() => {
      rpc.request('userDataStream.ping', { apiKey }, undefined, 5000).catch(() => {});
    }, 25 * 60_000);

    activePrivateSockets.set(sockKey, { ws, keepaliveTimer });

    ws.onopen = () => {
      const reg = registeredPrivateStreams.get(sockKey);
      if (reg) reg.retries = 0;
      const state = wsAccountStateByKey.get(apiKey);
      if (state) {
        state.wsConnected = true;
        state.updatedAt = Date.now();
        emitAccountUpdate(state);
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (!msg || !msg.e) return;

        if (msg.e === 'listenKeyExpired') {
          try {
            ws.close();
          } catch {
            // ignore
          }
          return;
        }

        const state = wsAccountStateByKey.get(apiKey);
        if (!state) return;

        if (msg.e === 'ACCOUNT_UPDATE' && msg.a) {
          // 1. Update USDT + USDC wallet balance
          if (Array.isArray(msg.a.B)) {
            const stableBals = msg.a.B.filter(
              (b: any) => b.a === 'USDT' || b.a === 'USDC'
            );
            if (stableBals.length > 0) {
              const totalWb = stableBals.reduce((sum: number, b: any) => sum + Number(b.wb || 0), 0);
              if (totalWb >= 0) {
                state.walletBalanceUsdt = Number(totalWb.toFixed(4));
              }
            }
          }

          // 2. Update positions (USDT and USDC futures)
          if (Array.isArray(msg.a.P)) {
            const posMap = new Map<string, ExchangePositionItem>();
            for (const p of state.positions) {
              posMap.set(`${p.symbol}:${p.is_short ? 'SHORT' : 'LONG'}`, p);
            }
            const closedList: WsPositionClosedEvent[] = [];

            for (const rawP of msg.a.P) {
              const sym = String(rawP.s || '').toUpperCase();
              if (!isSupportedFuturesSymbol(sym)) continue;
              const rawAmt = Number(rawP.pa || 0);
              const size = Math.abs(rawAmt);
              const ps = String(rawP.ps || 'BOTH').toUpperCase();
              const isShort = ps === 'SHORT' || (ps === 'BOTH' && rawAmt < 0);
              const key = `${sym}:${isShort ? 'SHORT' : 'LONG'}`;
              const prevPos = posMap.get(key);
              const liveTick = getLiveWsTicker(sym, 'binance');
              const entryPrice =
                Number(rawP.ep || 0) ||
                prevPos?.entry_price ||
                liveTick?.markPrice ||
                liveTick?.price ||
                0;

              if (size <= 0) {
                const hadLong = posMap.has(`${sym}:LONG`);
                const hadShort = posMap.has(`${sym}:SHORT`);
                posMap.delete(key);
                if (ps === 'BOTH') {
                  posMap.delete(`${sym}:LONG`);
                  posMap.delete(`${sym}:SHORT`);
                }
                if (prevPos || (ps === 'BOTH' && (hadLong || hadShort))) {
                  closedList.push({
                    exchange: 'binance',
                    apiKey,
                    symbol: sym,
                    pair: cleanSymbolToPair(sym),
                    isShort: prevPos ? prevPos.is_short : hadShort && !hadLong,
                    closedTime: Number(msg.E || Date.now()),
                  });
                }
              } else if (entryPrice > 0) {
                const markPrice = liveTick?.markPrice || prevPos?.mark_price || entryPrice;
                const lev = prevPos?.leverage || 25;
                const prevSizeChanged = !prevPos || Math.abs(prevPos.size - size) > 1e-6;
                const rawIw = Number(rawP.iw || 0);
                const marginUsdt =
                  rawIw > 0
                    ? Number(rawIw.toFixed(2))
                    : !prevSizeChanged && prevPos?.margin_usdt && prevPos.margin_usdt > 0
                    ? prevPos.margin_usdt
                    : Number(((size * entryPrice) / lev).toFixed(2));
                const unrealizedPnl = Number(rawP.up ?? prevPos?.unrealized_pnl ?? 0);
                const updatedPos: ExchangePositionItem = {
                  pair: cleanSymbolToPair(sym),
                  symbol: sym,
                  is_short: isShort,
                  size,
                  entry_price: entryPrice,
                  mark_price: markPrice,
                  leverage: lev,
                  margin_usdt: marginUsdt,
                  unrealized_pnl: unrealizedPnl,
                  created_time: prevPos?.created_time || Number(msg.E || Date.now()),
                  updated_time: Number(msg.E || Date.now()),
                };
                posMap.set(key, updatedPos);
                subscribePairKlineStream(updatedPos.pair, '1h');
              }
            }

            state.positions = Array.from(posMap.values());
            state.unrealizedPnlUsdt = Number(
              state.positions.reduce((s, p) => s + Number(p.unrealized_pnl || 0), 0).toFixed(4)
            );
            state.usedMarginUsdt = Number(
              state.positions.reduce((s, p) => s + Number(p.margin_usdt || 0), 0).toFixed(2)
            );
            state.availableBalanceUsdt = Number(
              Math.max(0, state.walletBalanceUsdt - state.usedMarginUsdt).toFixed(2)
            );
            state.equityUsdt = Number(
              (state.walletBalanceUsdt + state.unrealizedPnlUsdt).toFixed(4)
            );

            state.wsConnected = true;
            state.updatedAt = Date.now();
            emitAccountUpdate(state);
            for (const cEvt of closedList) {
              emitPositionClosed(cEvt);
            }
            return;
          }

          state.wsConnected = true;
          state.updatedAt = Date.now();
          emitAccountUpdate(state);
        } else if (msg.e === 'ORDER_TRADE_UPDATE' && msg.o) {
          const o = msg.o;
          if (o.X === 'FILLED' || o.x === 'TRADE') {
            const sym = String(o.s || '').toUpperCase();
            const orderId = String(o.i || `${sym}-${msg.E || Date.now()}`);
            const realizedPnl = Number(o.rp || 0);
            const qty = Math.abs(Number(o.z || o.l || 0));
            const avgPrice = Number(o.ap || o.L || 0);
            const fee = Math.abs(Number(o.n || 0));
            const tradeTime = Number(o.T || msg.E || Date.now());
            const side = String(o.S || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
            const ps = String(o.ps || '').toUpperCase();
            const isReduceOnly = Boolean(o.R) || o.cp === true || Math.abs(realizedPnl) > 1e-8;
            const isShort =
              ps === 'SHORT'
                ? true
                : ps === 'LONG'
                ? false
                : isReduceOnly
                ? side === 'BUY'
                : side === 'SELL';

            if (isSupportedFuturesSymbol(sym) && qty > 0 && avgPrice > 0) {
              const fillEvt: WsOrderFillEvent = {
                exchange: 'binance',
                apiKey,
                orderId,
                symbol: sym,
                pair: cleanSymbolToPair(sym),
                side,
                isShort,
                avgPrice,
                qty,
                fee,
                realizedPnl: Math.abs(realizedPnl) > 1e-8 || isReduceOnly ? realizedPnl : undefined,
                isCloseFill: isReduceOnly,
                tradeTime,
              };
              if (o.X === 'FILLED') {
                recordOrderFillFromWs(fillEvt);
                emitExecutionUpdate(fillEvt);
              }
            }

            if (isSupportedFuturesSymbol(sym) && Math.abs(realizedPnl) > 1e-8 && qty > 0 && avgPrice > 0) {
              const rawEntry = isShort
                ? avgPrice + realizedPnl / qty
                : avgPrice - realizedPnl / qty;
              const entryPrice = rawEntry > 0 ? rawEntry : avgPrice;
              const openFee = Number((fee > 0 ? fee : entryPrice * qty * 0.0005).toFixed(4));
              const closeFee = Number((fee > 0 ? fee : avgPrice * qty * 0.0005).toFixed(4));
              const item: ExchangeClosedPnlItem = {
                order_id: orderId,
                pair: cleanSymbolToPair(sym),
                symbol: sym,
                is_short: isShort,
                qty,
                entry_price: Number(entryPrice.toPrecision(8)),
                exit_price: Number(avgPrice.toPrecision(8)),
                leverage: 25,
                closed_pnl: Number((realizedPnl - openFee - closeFee).toFixed(4)),
                open_fee: openFee,
                close_fee: closeFee,
                created_time: tradeTime - 60_000,
                updated_time: tradeTime,
              };
              state.closedPnl = [
                item,
                ...state.closedPnl.filter((c) => c.order_id !== item.order_id),
              ].slice(0, 150);
              state.updatedAt = Date.now();
              emitAccountUpdate(state);
            }
          }
        }
      } catch {
        // ignore parse error
      }
    };

    ws.onclose = () => {
      const entry = activePrivateSockets.get(sockKey);
      if (entry?.keepaliveTimer) clearInterval(entry.keepaliveTimer);
      activePrivateSockets.delete(sockKey);
      const state = wsAccountStateByKey.get(apiKey);
      if (state) state.wsConnected = false;
      schedulePrivateReconnect(sockKey);
    };

    ws.onerror = () => {
      // handled by onclose
    };
  } catch {
    activePrivateSockets.delete(sockKey);
    schedulePrivateReconnect(sockKey);
  }
}

/**
 * Запускает приватный WebSocket поток Bybit V5 (wss://stream.bybit.com/v5/private / Testnet / Demo).
 * Авторизуется по HMAC-SHA256 и подписывается на ['position', 'wallet', 'execution', 'order'].
 */
export function ensureBybitPrivateUserStream(
  apiKey: string,
  apiSecret: string,
  baseUrl: string
): void {
  if (!apiKey || !apiSecret || typeof WebSocket === 'undefined') return;
  const sockKey = `bybit:${apiKey}`;
  const existing = activePrivateSockets.get(sockKey);
  if (existing && (existing.ws.readyState === 0 || existing.ws.readyState === 1)) return;

  registeredPrivateStreams.set(sockKey, {
    exchange: 'bybit',
    apiKey,
    apiSecret,
    baseUrl,
    retries: registeredPrivateStreams.get(sockKey)?.retries ?? 0,
  });

  const wsUrl = baseUrl.includes('testnet')
    ? 'wss://stream-testnet.bybit.com/v5/private'
    : baseUrl.includes('demo')
    ? 'wss://stream-demo.bybit.com/v5/private'
    : 'wss://stream.bybit.com/v5/private';

  try {
    const ws = new WebSocket(wsUrl);
    const keepaliveTimer = setInterval(() => {
      if (ws.readyState === 1) {
        try {
          ws.send(JSON.stringify({ op: 'ping' }));
        } catch {
          // ignore
        }
      }
    }, 20_000);

    activePrivateSockets.set(sockKey, { ws, keepaliveTimer });

    ws.onopen = () => {
      const expires = Date.now() + 10_000;
      const signature = crypto
        .createHmac('sha256', apiSecret)
        .update(`GET/realtime${expires}`)
        .digest('hex');
      try {
        ws.send(JSON.stringify({ op: 'auth', args: [apiKey, expires, signature] }));
      } catch {
        // ignore
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (!msg) return;

        if (msg.op === 'auth' && msg.success === true) {
          const reg = registeredPrivateStreams.get(sockKey);
          if (reg) reg.retries = 0;
          const state = wsAccountStateByKey.get(apiKey);
          if (state) {
            state.wsConnected = true;
            state.updatedAt = Date.now();
            emitAccountUpdate(state);
          }
          ws.send(
            JSON.stringify({
              op: 'subscribe',
              args: ['position', 'wallet', 'execution', 'order'],
            })
          );
          return;
        }

        const state = wsAccountStateByKey.get(apiKey);
        if (!state) return;

        if (msg.topic === 'wallet' && Array.isArray(msg.data)) {
          const acc = msg.data[0];
          if (acc) {
            const coins = Array.isArray(acc.coin) ? acc.coin : [];
            const stableCoins = coins.filter((c: any) => c.coin === 'USDT' || c.coin === 'USDC');
            const usdt = coins.find((c: any) => c.coin === 'USDT');
            const sumWallet = stableCoins.reduce((s: number, c: any) => s + Number(c.walletBalance || 0), 0);
            const sumUpl = stableCoins.reduce((s: number, c: any) => s + Number(c.unrealisedPnl || 0), 0);
            const sumIm = stableCoins.reduce((s: number, c: any) => s + Number(c.totalPositionIM || 0), 0);
            const walletBal = Number(
              acc.totalWalletBalance || sumWallet || usdt?.walletBalance || state.walletBalanceUsdt
            );
            const unrealized = Number(
              acc.totalPerpUPL ?? (stableCoins.length > 0 ? sumUpl : state.unrealizedPnlUsdt)
            );
            const equity = Number(acc.totalEquity || walletBal + unrealized);
            const posMarginSum = Number(
              state.positions.reduce((s, p) => s + Number(p.margin_usdt || 0), 0).toFixed(2)
            );
            const rawUsedMargin = Number(acc.totalInitialMargin || sumIm || usdt?.totalPositionIM || 0);
            const usedMargin = rawUsedMargin > 0 ? rawUsedMargin : posMarginSum;
            const avail = Number(
              acc.totalAvailableBalance ||
                usdt?.availableToWithdraw ||
                Math.max(0, walletBal - usedMargin)
            );
            if (walletBal >= 0) {
              state.walletBalanceUsdt = walletBal;
              state.unrealizedPnlUsdt = unrealized;
              state.equityUsdt = equity;
              state.usedMarginUsdt = Number(usedMargin.toFixed(2));
              state.availableBalanceUsdt = Number(avail.toFixed(2));
              state.wsConnected = true;
              state.updatedAt = Date.now();
              emitAccountUpdate(state);
            }
          }
        } else if (msg.topic === 'order' && Array.isArray(msg.data)) {
          for (const o of msg.data) {
            if (String(o.category || 'linear') !== 'linear') continue;
            const status = String(o.orderStatus || '');
            const avgPrice = Number(o.avgPrice || 0);
            const qty = Math.abs(Number(o.cumExecQty || 0));
            const fee = Math.abs(Number(o.cumExecFee || 0));
            const orderId = String(o.orderId || '');
            const sym = String(o.symbol || '').toUpperCase();
            if (status === 'Filled' && orderId && avgPrice > 0 && qty > 0 && isSupportedFuturesSymbol(sym)) {
              const side = String(o.side || '').toLowerCase() === 'sell' ? 'SELL' : 'BUY';
              const isReduce = Boolean(o.reduceOnly);
              const posIdx = Number(o.positionIdx || 0);
              const isShort =
                posIdx === 2 ? true : posIdx === 1 ? false : isReduce ? side === 'BUY' : side === 'SELL';
              const evt: WsOrderFillEvent = {
                exchange: 'bybit',
                apiKey,
                orderId,
                symbol: sym,
                pair: cleanSymbolToPair(sym),
                side,
                isShort,
                avgPrice,
                qty,
                fee,
                isCloseFill: isReduce,
                tradeTime: Number(o.updatedTime || o.createdTime || Date.now()),
              };
              recordOrderFillFromWs(evt);
              emitExecutionUpdate(evt);
            }
          }
        } else if (msg.topic === 'execution' && Array.isArray(msg.data)) {
          for (const e of msg.data) {
            if (e.category && String(e.category) !== 'linear') continue;
            const sym = String(e.symbol || '').toUpperCase();
            if (!isSupportedFuturesSymbol(sym)) continue;
            const orderId = String(e.orderId || '');
            const execPrice = Number(e.execPrice || 0);
            const execQty = Math.abs(Number(e.execQty || 0));
            const execFee = Math.abs(Number(e.execFee || 0));
            const closedSize = Math.abs(Number(e.closedSize || 0));
            const leavesQty = Number(e.leavesQty || 0);
            const side = String(e.side || '').toLowerCase() === 'sell' ? 'SELL' : 'BUY';
            const isCloseFill = closedSize > 0;
            const isShort = isCloseFill ? side === 'BUY' : side === 'SELL';
            const execTime = Number(e.execTime || Date.now());

            if (orderId && execPrice > 0 && execQty > 0 && leavesQty <= 1e-8) {
              const evt: WsOrderFillEvent = {
                exchange: 'bybit',
                apiKey,
                orderId,
                symbol: sym,
                pair: cleanSymbolToPair(sym),
                side,
                isShort,
                avgPrice: execPrice,
                qty: execQty,
                fee: execFee,
                closedSize,
                isCloseFill,
                tradeTime: execTime,
              };
              recordOrderFillFromWs(evt);
              emitExecutionUpdate(evt);
            }
          }
        } else if (msg.topic === 'position' && Array.isArray(msg.data)) {
          const posMap = new Map<string, ExchangePositionItem>();
          for (const p of state.positions) {
            posMap.set(`${p.symbol}:${p.is_short ? 'SHORT' : 'LONG'}`, p);
          }
          const closedList: WsPositionClosedEvent[] = [];

          for (const rawP of msg.data) {
            const sym = String(rawP.symbol || '').toUpperCase();
            if (!isSupportedFuturesSymbol(sym)) continue;
            const size = Math.abs(Number(rawP.size || 0));
            const sideStr = String(rawP.side || '').toLowerCase();
            const isShort = sideStr === 'sell' || Number(rawP.positionIdx) === 2;
            const key = `${sym}:${isShort ? 'SHORT' : 'LONG'}`;
            const prevPos = posMap.get(key);
            const liveTick = getLiveWsTicker(sym, 'bybit');
            const entryPrice =
              Number(rawP.entryPrice || rawP.avgPrice || 0) ||
              prevPos?.entry_price ||
              Number(rawP.markPrice || 0) ||
              liveTick?.markPrice ||
              0;

            if (!(size > 0)) {
              const hadLong = posMap.has(`${sym}:LONG`);
              const hadShort = posMap.has(`${sym}:SHORT`);
              posMap.delete(key);
              if (Number(rawP.positionIdx || 0) === 0) {
                posMap.delete(`${sym}:LONG`);
                posMap.delete(`${sym}:SHORT`);
              }
              if (prevPos || (Number(rawP.positionIdx || 0) === 0 && (hadLong || hadShort))) {
                closedList.push({
                  exchange: 'bybit',
                  apiKey,
                  symbol: sym,
                  pair: cleanSymbolToPair(sym),
                  isShort: prevPos ? prevPos.is_short : hadShort && !hadLong,
                  closedTime: Number(rawP.updatedTime || Date.now()),
                });
              }
            } else if (entryPrice > 0) {
              const markPrice = Number(rawP.markPrice || liveTick?.markPrice || entryPrice);
              const lev = Math.max(1, Math.round(Number(rawP.leverage || prevPos?.leverage || 25)));
              const rawIm = Number(rawP.positionIM || rawP.positionBalance || 0);
              const prevSizeChanged = !prevPos || Math.abs(prevPos.size - size) > 1e-6;
              const marginUsdt =
                rawIm > 0
                  ? Number(rawIm.toFixed(2))
                  : !prevSizeChanged && prevPos?.margin_usdt && prevPos.margin_usdt > 0
                  ? prevPos.margin_usdt
                  : Number(((size * entryPrice) / lev).toFixed(2));
              const tp = Number(rawP.takeProfit || prevPos?.take_profit || 0);
              const sl = Number(rawP.stopLoss || prevPos?.stop_loss || 0);
              const uTime = Number(rawP.updatedTime || Date.now());
              const updatedPos: ExchangePositionItem = {
                pair: cleanSymbolToPair(sym),
                symbol: sym,
                is_short: isShort,
                size,
                entry_price: entryPrice,
                mark_price: markPrice > 0 ? markPrice : entryPrice,
                leverage: lev,
                margin_usdt: marginUsdt,
                unrealized_pnl: Number(rawP.unrealisedPnl ?? prevPos?.unrealized_pnl ?? 0),
                take_profit: tp > 0 ? tp : undefined,
                stop_loss: sl > 0 ? sl : undefined,
                created_time: Number(rawP.createdTime || prevPos?.created_time || uTime),
                updated_time: uTime,
              };
              posMap.set(key, updatedPos);
              subscribePairKlineStream(updatedPos.pair, '1h');
            }
          }

          state.positions = Array.from(posMap.values());
          state.unrealizedPnlUsdt = Number(
            state.positions.reduce((s, p) => s + Number(p.unrealized_pnl || 0), 0).toFixed(4)
          );
          state.usedMarginUsdt = Number(
            state.positions.reduce((s, p) => s + Number(p.margin_usdt || 0), 0).toFixed(2)
          );
          state.availableBalanceUsdt = Number(
            Math.max(0, state.walletBalanceUsdt - state.usedMarginUsdt).toFixed(2)
          );
          state.equityUsdt = Number(
            (state.walletBalanceUsdt + state.unrealizedPnlUsdt).toFixed(4)
          );
          state.wsConnected = true;
          state.updatedAt = Date.now();
          emitAccountUpdate(state);
          for (const cEvt of closedList) {
            emitPositionClosed(cEvt);
          }
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      const entry = activePrivateSockets.get(sockKey);
      if (entry?.keepaliveTimer) clearInterval(entry.keepaliveTimer);
      activePrivateSockets.delete(sockKey);
      const state = wsAccountStateByKey.get(apiKey);
      if (state) state.wsConnected = false;
      schedulePrivateReconnect(sockKey);
    };

    ws.onerror = () => {
      // handled by onclose
    };
  } catch {
    activePrivateSockets.delete(sockKey);
    schedulePrivateReconnect(sockKey);
  }
}
