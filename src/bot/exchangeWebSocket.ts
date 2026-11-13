import crypto from 'crypto';
import type { ExchangePositionItem, ExchangeClosedPnlItem } from './exchangeConnector.ts';

export interface LiveWsTicker {
  pair: string;
  symbol: string;
  price: number;
  markPrice: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  updatedAt: number;
  source: 'bybit_ws' | 'binance_ws';
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

type TickerUpdateCallback = (ticker: LiveWsTicker) => void;
type KlineUpdateCallback = (kline: LiveWsKline) => void;
type AccountUpdateCallback = (state: WsAccountLiveState) => void;

const wsTickersBySymbol = new Map<string, LiveWsTicker>();
const wsAccountStateByKey = new Map<string, WsAccountLiveState>();

const tickerListeners: TickerUpdateCallback[] = [];
const klineListeners: KlineUpdateCallback[] = [];
const accountListeners: AccountUpdateCallback[] = [];

// Subscribed symbols and kline topics
const subscribedBybitTickers = new Set<string>();
const subscribedBybitKlines = new Set<string>(); // e.g. kline.60.BTCUSDT
const subscribedBinanceKlines = new Set<string>(); // e.g. btcusdt@kline_1h

let bybitPublicWs: WebSocket | null = null;
let bybitPublicWsReady = false;
let bybitPingTimer: ReturnType<typeof setInterval> | null = null;
let bybitReconnectTimer: ReturnType<typeof setTimeout> | null = null;

let binancePublicWs: WebSocket | null = null;
let binancePublicWsReady = false;
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

export function cleanSymbolToPair(rawSymbol: string): string {
  const s = String(rawSymbol || '')
    .trim()
    .toUpperCase()
    .replace('-SWAP', '')
    .replace('_UMCBL', '');
  if (s.includes('/')) {
    return s.includes(':USDT') ? s : `${s}:USDT`;
  }
  if (s.includes('-USDT')) {
    const base = s.split('-USDT')[0];
    return `${base}/USDT:USDT`;
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

export function getLiveWsTicker(pairOrSymbol: string): LiveWsTicker | undefined {
  const sym = pairToSymbol(pairOrSymbol);
  return wsTickersBySymbol.get(sym);
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
    subscribed_bybit_klines: subscribedBybitKlines.size,
    subscribed_binance_klines: subscribedBinanceKlines.size,
    active_private_streams: Array.from(wsAccountStateByKey.values()).filter((s) => s.wsConnected).length,
    total_ticker_events: totalWsTickerEvents,
    total_kline_events: totalWsKlineEvents,
    total_ws_rpc_calls: totalWsRpcCalls,
    last_event_timestamp: lastWsEventTimestamp,
  };
}

function updatePositionsMarkPriceFromTicker(symbol: string, price: number): void {
  if (!(price > 0)) return;
  for (const state of wsAccountStateByKey.values()) {
    let changed = false;
    let totalUnrealized = 0;
    for (const pos of state.positions) {
      if (pos.symbol === symbol && pos.size > 0 && pos.entry_price > 0) {
        pos.mark_price = price;
        const diff = pos.is_short ? pos.entry_price - price : price - pos.entry_price;
        pos.unrealized_pnl = Number((diff * pos.size).toFixed(4));
        pos.updated_time = Date.now();
        changed = true;
      }
      totalUnrealized += Number(pos.unrealized_pnl || 0);
    }
    if (changed) {
      state.unrealizedPnlUsdt = Number(totalUnrealized.toFixed(4));
      state.equityUsdt = Number((state.walletBalanceUsdt + state.unrealizedPnlUsdt).toFixed(4));
      state.updatedAt = Date.now();
    }
  }
}

function emitTickerUpdate(ticker: LiveWsTicker): void {
  wsTickersBySymbol.set(ticker.symbol, ticker);
  totalWsTickerEvents++;
  lastWsEventTimestamp = Date.now();
  updatePositionsMarkPriceFromTicker(ticker.symbol, ticker.markPrice || ticker.price);
  for (const cb of tickerListeners) {
    try {
      cb(ticker);
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

// ============================================================================
// 1. PUBLIC MARKET STREAMS (Bybit V5 Linear WS + Binance Market WS)
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
        ...Array.from(subscribedBybitKlines),
      ];
      // Bybit allows up to 10 args per subscribe packet for maximum reliability
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
          const prev = wsTickersBySymbol.get(sym);
          const price = Number(d.lastPrice || prev?.price || 0);
          if (!(price > 0)) return;
          const markPrice = Number(d.markPrice || price);
          const change24h =
            d.price24hPcnt !== undefined
              ? Number((Number(d.price24hPcnt) * 100).toFixed(2))
              : prev?.change24h ?? 0;
          const volume24h =
            d.turnover24h !== undefined ? Number(d.turnover24h) : prev?.volume24h ?? 0;
          const high24h =
            d.highPrice24h !== undefined ? Number(d.highPrice24h) : prev?.high24h ?? price * 1.01;
          const low24h =
            d.lowPrice24h !== undefined ? Number(d.lowPrice24h) : prev?.low24h ?? price * 0.99;

          emitTickerUpdate({
            pair: cleanSymbolToPair(sym),
            symbol: sym,
            price,
            markPrice,
            change24h,
            volume24h,
            high24h,
            low24h,
            updatedAt: Date.now(),
            source: 'bybit_ws',
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
      bybitReconnectTimer = setTimeout(() => connectBybitPublicWs(), 3000);
    };

    ws.onerror = () => {
      // handled by onclose
    };
  } catch {
    if (bybitReconnectTimer) clearTimeout(bybitReconnectTimer);
    bybitReconnectTimer = setTimeout(() => connectBybitPublicWs(), 5000);
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
    // stream.binance.com:9443/ws streams !miniTicker@arr & klines globally without fapi REST IP bans
    const ws = new WebSocket('wss://stream.binance.com:9443/ws');
    binancePublicWs = ws;

    ws.onopen = () => {
      binancePublicWsReady = true;
      const params = ['!miniTicker@arr', ...Array.from(subscribedBinanceKlines)];
      try {
        ws.send(
          JSON.stringify({
            method: 'SUBSCRIBE',
            params: params.slice(0, 50),
            id: Date.now(),
          })
        );
      } catch {
        // ignore
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (!msg) return;

        // 1. Array of 24hrMiniTicker from !miniTicker@arr
        if (Array.isArray(msg)) {
          const now = Date.now();
          for (const item of msg) {
            if (item?.e !== '24hrMiniTicker') continue;
            const sym = String(item.s || '').toUpperCase();
            if (!sym.endsWith('USDT')) continue;
            const close = Number(item.c || 0);
            const open = Number(item.o || close);
            const high = Number(item.h || close);
            const low = Number(item.l || close);
            const quoteVol = Number(item.q || 0);
            if (!(close > 0)) continue;
            const change24h =
              open > 0 ? Number((((close - open) / open) * 100).toFixed(2)) : 0;

            emitTickerUpdate({
              pair: cleanSymbolToPair(sym),
              symbol: sym,
              price: close,
              markPrice: close,
              change24h,
              volume24h: quoteVol,
              high24h: high,
              low24h: low,
              updatedAt: now,
              source: 'binance_ws',
            });
          }
          return;
        }

        // 2. Live Kline event
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
      if (binanceReconnectTimer) clearTimeout(binanceReconnectTimer);
      binanceReconnectTimer = setTimeout(() => connectBinancePublicWs(), 3500);
    };

    ws.onerror = () => {
      // handled by onclose
    };
  } catch {
    if (binanceReconnectTimer) clearTimeout(binanceReconnectTimer);
    binanceReconnectTimer = setTimeout(() => connectBinancePublicWs(), 5000);
  }
}

export function startPublicMarketWebSockets(): void {
  if (publicStreamsStarted) return;
  publicStreamsStarted = true;
  connectBybitPublicWs();
  connectBinancePublicWs();
}

/**
 * Подписывает пару и таймфрейм на live WebSocket поток свечей и тикеров (Bybit + Binance),
 * чтобы свечи и цены обновлялись в реальном времени без повторных HTTP REST-запросов.
 */
export function subscribePairKlineStream(pair: string, interval = '1h'): void {
  if (!publicStreamsStarted) {
    startPublicMarketWebSockets();
  }
  const sym = pairToSymbol(pair);
  if (!sym.endsWith('USDT')) return;

  // 1. Bybit ticker & kline subscription
  const tickerTopic = `tickers.${sym}`;
  const bybitInt = mapIntervalToBybitWs(interval);
  const klineTopic = `kline.${bybitInt}.${sym}`;
  const newBybitTopics: string[] = [];

  if (!subscribedBybitTickers.has(tickerTopic)) {
    subscribedBybitTickers.add(tickerTopic);
    newBybitTopics.push(tickerTopic);
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

  // 2. Binance kline subscription
  const bnKlineTopic = `${sym.toLowerCase()}@kline_${interval}`;
  if (!subscribedBinanceKlines.has(bnKlineTopic)) {
    subscribedBinanceKlines.add(bnKlineTopic);
    if (binancePublicWs && binancePublicWsReady) {
      try {
        binancePublicWs.send(
          JSON.stringify({
            method: 'SUBSCRIBE',
            params: [bnKlineTopic],
            id: Date.now(),
          })
        );
      } catch {
        // ignore
      }
    }
  }
}

// ============================================================================
// 2. BINANCE FUTURES WEBSOCKET API (wss://ws-fapi.binance.com/ws-fapi/v1)
//    Обходит баны REST IP (-1003) на fapi.binance.com и не тратит лимит на ордера!
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

export function getWsAccountLiveState(
  apiKey: string,
  maxAgeMs = 180_000
): WsAccountLiveState | undefined {
  const state = wsAccountStateByKey.get(apiKey);
  if (!state) return undefined;
  if (Date.now() - state.updatedAt > maxAgeMs && !state.wsConnected) {
    return undefined;
  }
  return state;
}

export function setWsAccountLiveState(state: WsAccountLiveState): void {
  wsAccountStateByKey.set(state.apiKey, state);
  // Subscribe all open position pairs to public ticker stream so their mark_price updates every second
  for (const pos of state.positions) {
    subscribePairKlineStream(pos.pair, '1h');
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
  const existing = activePrivateSockets.get(`binance:${apiKey}`);
  if (existing) return;

  const rpc = getBinanceWsRpcClient(baseUrl);
  const startRes = await rpc.request('userDataStream.start', { apiKey }, undefined, 5000);
  const listenKey = startRes.result?.listenKey;
  if (!listenKey) return;

  const isTestnet = baseUrl.includes('testnet');
  const streamUrl = isTestnet
    ? `wss://stream.binancefuture.com/ws/${listenKey}`
    : `wss://fstream.binance.com/ws/${listenKey}`;

  try {
    const ws = new WebSocket(streamUrl);
    const keepaliveTimer = setInterval(() => {
      rpc.request('userDataStream.ping', { apiKey }, undefined, 5000).catch(() => {});
    }, 25 * 60_000);

    activePrivateSockets.set(`binance:${apiKey}`, { ws, keepaliveTimer });

    ws.onopen = () => {
      const state = wsAccountStateByKey.get(apiKey);
      if (state) {
        state.wsConnected = true;
        state.updatedAt = Date.now();
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (!msg || !msg.e) return;
        const state = wsAccountStateByKey.get(apiKey);
        if (!state) return;

        if (msg.e === 'ACCOUNT_UPDATE' && msg.a) {
          // 1. Update USDT balance
          if (Array.isArray(msg.a.B)) {
            const usdtBal = msg.a.B.find((b: any) => b.a === 'USDT');
            if (usdtBal) {
              const wb = Number(usdtBal.wb ?? state.walletBalanceUsdt);
              const cw = Number(usdtBal.cw ?? wb);
              if (wb >= 0) {
                state.walletBalanceUsdt = wb;
                state.availableBalanceUsdt = cw > 0 ? cw : wb;
              }
            }
          }

          // 2. Update positions
          if (Array.isArray(msg.a.P)) {
            const posMap = new Map<string, ExchangePositionItem>();
            for (const p of state.positions) {
              posMap.set(`${p.symbol}:${p.is_short ? 'SHORT' : 'LONG'}`, p);
            }

            for (const rawP of msg.a.P) {
              const sym = String(rawP.s || '').toUpperCase();
              if (!sym.endsWith('USDT')) continue;
              const rawAmt = Number(rawP.pa || 0);
              const size = Math.abs(rawAmt);
              const entryPrice = Number(rawP.ep || 0);
              const unrealizedPnl = Number(rawP.up || 0);
              const ps = String(rawP.ps || 'BOTH').toUpperCase();
              const isShort = ps === 'SHORT' || (ps === 'BOTH' && rawAmt < 0);
              const key = `${sym}:${isShort ? 'SHORT' : 'LONG'}`;

              if (size <= 0 || entryPrice <= 0) {
                posMap.delete(key);
                if (ps === 'BOTH') {
                  posMap.delete(`${sym}:LONG`);
                  posMap.delete(`${sym}:SHORT`);
                }
              } else {
                const prevPos = posMap.get(key);
                const liveTick = wsTickersBySymbol.get(sym);
                const markPrice = liveTick?.markPrice || prevPos?.mark_price || entryPrice;
                const lev = prevPos?.leverage || 25;
                const marginUsdt = Number(((size * entryPrice) / lev).toFixed(2));
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
            state.equityUsdt = Number(
              (state.walletBalanceUsdt + state.unrealizedPnlUsdt).toFixed(4)
            );
          }

          state.wsConnected = true;
          state.updatedAt = Date.now();
          emitAccountUpdate(state);
        } else if (msg.e === 'ORDER_TRADE_UPDATE' && msg.o) {
          const o = msg.o;
          if (o.X === 'FILLED' || o.x === 'TRADE') {
            const sym = String(o.s || '').toUpperCase();
            const realizedPnl = Number(o.rp || 0);
            const qty = Math.abs(Number(o.z || o.l || 0));
            const avgPrice = Number(o.ap || o.L || 0);
            const fee = Math.abs(Number(o.n || 0));
            const tradeTime = Number(o.T || msg.E || Date.now());
            if (sym.endsWith('USDT') && Math.abs(realizedPnl) > 1e-8 && qty > 0 && avgPrice > 0) {
              const side = String(o.S || '').toUpperCase();
              const ps = String(o.ps || '').toUpperCase();
              const isShort = ps === 'SHORT' ? true : ps === 'LONG' ? false : side === 'BUY';
              const rawEntry = isShort
                ? avgPrice + realizedPnl / qty
                : avgPrice - realizedPnl / qty;
              const entryPrice = rawEntry > 0 ? rawEntry : avgPrice;
              const openFee = Number((fee > 0 ? fee : entryPrice * qty * 0.0005).toFixed(4));
              const closeFee = Number((fee > 0 ? fee : avgPrice * qty * 0.0005).toFixed(4));
              const item: ExchangeClosedPnlItem = {
                order_id: String(o.i || `${sym}-${tradeTime}`),
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
      const entry = activePrivateSockets.get(`binance:${apiKey}`);
      if (entry?.keepaliveTimer) clearInterval(entry.keepaliveTimer);
      activePrivateSockets.delete(`binance:${apiKey}`);
      const state = wsAccountStateByKey.get(apiKey);
      if (state) state.wsConnected = false;
    };

    ws.onerror = () => {
      // handled by onclose
    };
  } catch {
    activePrivateSockets.delete(`binance:${apiKey}`);
  }
}

/**
 * Запускает приватный WebSocket поток Bybit V5 (wss://stream.bybit.com/v5/private / Testnet / Demo).
 * Авторизуется по HMAC-SHA256 и подписывается на ['position', 'wallet', 'execution'].
 */
export function ensureBybitPrivateUserStream(
  apiKey: string,
  apiSecret: string,
  baseUrl: string
): void {
  if (!apiKey || !apiSecret || typeof WebSocket === 'undefined') return;
  const sockKey = `bybit:${apiKey}`;
  if (activePrivateSockets.has(sockKey)) return;

  const wsUrl = baseUrl.includes('testnet')
    ? 'wss://stream-testnet.bybit.com/v5/private'
    : baseUrl.includes('demo')
    ? 'wss://stream-demo.bybit.com/v5/private'
    : 'wss://stream.bybit.com/v5/private';

  try {
    const ws = new WebSocket(wsUrl);
    const keepaliveTimer = setInterval(() => {
      try {
        ws.send(JSON.stringify({ op: 'ping' }));
      } catch {
        // ignore
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
          const state = wsAccountStateByKey.get(apiKey);
          if (state) {
            state.wsConnected = true;
            state.updatedAt = Date.now();
          }
          ws.send(
            JSON.stringify({
              op: 'subscribe',
              args: ['position', 'wallet', 'execution'],
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
            const usdt = coins.find((c: any) => c.coin === 'USDT');
            const walletBal = Number(
              usdt?.walletBalance || acc.totalWalletBalance || state.walletBalanceUsdt
            );
            const unrealized = Number(
              usdt?.unrealisedPnl ?? acc.totalPerpUPL ?? state.unrealizedPnlUsdt
            );
            const equity = Number(usdt?.equity || acc.totalEquity || walletBal + unrealized);
            const usedMargin = Number(usdt?.totalPositionIM || acc.totalInitialMargin || 0);
            const avail = Number(
              usdt?.availableToWithdraw ||
                acc.totalAvailableBalance ||
                Math.max(0, walletBal - usedMargin)
            );
            if (walletBal >= 0) {
              state.walletBalanceUsdt = walletBal;
              state.unrealizedPnlUsdt = unrealized;
              state.equityUsdt = equity;
              state.usedMarginUsdt = usedMargin;
              state.availableBalanceUsdt = avail;
              state.wsConnected = true;
              state.updatedAt = Date.now();
              emitAccountUpdate(state);
            }
          }
        } else if (msg.topic === 'position' && Array.isArray(msg.data)) {
          const posMap = new Map<string, ExchangePositionItem>();
          for (const p of state.positions) {
            posMap.set(`${p.symbol}:${p.is_short ? 'SHORT' : 'LONG'}`, p);
          }

          for (const rawP of msg.data) {
            const sym = String(rawP.symbol || '').toUpperCase();
            if (!sym.endsWith('USDT')) continue;
            const size = Math.abs(Number(rawP.size || 0));
            const entryPrice = Number(rawP.entryPrice || rawP.avgPrice || 0);
            const sideStr = String(rawP.side || '').toLowerCase();
            const isShort = sideStr === 'sell' || Number(rawP.positionIdx) === 2;
            const key = `${sym}:${isShort ? 'SHORT' : 'LONG'}`;

            if (!(size > 0) || !(entryPrice > 0)) {
              posMap.delete(key);
              if (Number(rawP.positionIdx || 0) === 0) {
                posMap.delete(`${sym}:LONG`);
                posMap.delete(`${sym}:SHORT`);
              }
            } else {
              const markPrice = Number(rawP.markPrice || entryPrice);
              const lev = Math.max(1, Math.round(Number(rawP.leverage || 25)));
              const rawIm = Number(rawP.positionIM || rawP.positionBalance || 0);
              const marginUsdt =
                rawIm > 0 ? Number(rawIm.toFixed(2)) : Number(((size * entryPrice) / lev).toFixed(2));
              const tp = Number(rawP.takeProfit || 0);
              const sl = Number(rawP.stopLoss || 0);
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
                unrealized_pnl: Number(rawP.unrealisedPnl || 0),
                take_profit: tp > 0 ? tp : undefined,
                stop_loss: sl > 0 ? sl : undefined,
                created_time: Number(rawP.createdTime || uTime),
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
          state.equityUsdt = Number(
            (state.walletBalanceUsdt + state.unrealizedPnlUsdt).toFixed(4)
          );
          state.wsConnected = true;
          state.updatedAt = Date.now();
          emitAccountUpdate(state);
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
    };

    ws.onerror = () => {
      // handled by onclose
    };
  } catch {
    activePrivateSockets.delete(sockKey);
  }
}
