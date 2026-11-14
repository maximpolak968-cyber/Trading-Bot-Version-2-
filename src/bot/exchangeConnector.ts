import crypto from 'node:crypto';
import https from 'node:https';
import {
  getBinanceWsRpcClient,
  getBybitWsTradeClient,
  waitForWsOrderFill,
  stopPrivateUserStream,
  getWsAccountLiveState,
  setWsAccountLiveState,
  ensureBinancePrivateUserStream,
  ensureBybitPrivateUserStream,
  getLiveWsTicker,
  subscribePairKlineStream,
  isPrivateWsStreamOpen,
  isSupportedFuturesSymbol,
  cleanSymbolToPair,
  setBybitWsTimeOffset,
} from './exchangeWebSocket.ts';

export type SupportedExchange = 'binance' | 'bybit' | 'okx' | 'bitget' | 'bingx';

export interface ExchangeCredentials {
  exchange: SupportedExchange;
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  isTestnet?: boolean;
}

export interface ConnectionTestResult {
  success: boolean;
  exchange: SupportedExchange;
  message: string;
  latency_ms: number;
  balance_usdt?: number;
  wallet_balance_usdt?: number;
  unrealized_pnl_usdt?: number;
  equity_usdt?: number;
  available_balance_usdt?: number;
  used_margin_usdt?: number;
  can_trade: boolean;
  account_type?: string;
  dual_side_position?: boolean;
  open_positions_count?: number;
  error_code?: string | number;
  is_testnet?: boolean;
  network_label?: string;
}

export interface PlacedOrderResult {
  success: boolean;
  order_id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
  status: 'FILLED' | 'NEW' | 'PARTIALLY_FILLED' | 'REJECTED';
  exchange_time: number;
  commission_usdt?: number;
  realized_pnl_usdt?: number;
  error?: string;
  error_code?: string | number;
  is_simulated_test?: boolean;
  network_label?: string;
}

export interface ExchangeOrderParams {
  pair: string; // e.g. 'ETH/USDT:USDT'
  action: 'OPEN' | 'DCA' | 'CLOSE';
  isShort: boolean;
  quantity: number;
  referencePrice: number;
  leverage?: number;
}

interface BinanceSymbolFilterMeta {
  symbol: string;
  status: string;
  contractType: string;
  underlyingType: string;
  stepSize: number;
  minQty: number;
  maxQty: number;
  tickSize: number;
  minNotional: number;
  quantityPrecision: number;
  pricePrecision: number;
}

interface BybitSymbolFilterMeta {
  symbol: string;
  status: string;
  qtyStep: number;
  minOrderQty: number;
  maxMktOrderQty: number;
  minNotional: number;
  tickSize: number;
}

let binanceTimeOffsetMs = 0;
let lastTimeSyncTs = 0;
const binanceSymbolMetaByHost = new Map<
  string,
  { syncTs: number; symbols: Map<string, BinanceSymbolFilterMeta> }
>();
const binanceDualSideCache = new Map<string, { dualSide: boolean; updatedAt: number }>();
const binanceLeverageCache = new Map<string, number>();
const binanceHostCache = new Map<string, string>();
const binanceHostBanUntil = new Map<string, number>();
const binanceLastGoodConnCache = new Map<string, { result: ConnectionTestResult; updatedAt: number }>();
const binancePositionsCache = new Map<
  string,
  {
    timestamp: number;
    positions: ExchangePositionItem[];
    network_label: string;
    is_testnet: boolean;
  }
>();
const binanceClosedPnlCache = new Map<
  string,
  { timestamp: number; closed: ExchangeClosedPnlItem[] }
>();
const binanceSymbolTradesCache = new Map<
  string,
  { latestIncomeTs: number; items: ExchangeClosedPnlItem[] }
>();

let bybitTimeOffsetMs = 0;
let lastBybitTimeSyncTs = 0;
const bybitTimeOffsetByHost = new Map<string, { offsetMs: number; syncTs: number }>();
const bybitSymbolMetaByHost = new Map<
  string,
  { syncTs: number; symbols: Map<string, BybitSymbolFilterMeta> }
>();
const bybitHostCache = new Map<string, string>();
const bybitLeverageCache = new Map<string, number>();
const bybitHedgeModeCache = new Map<string, boolean>();

const okxDemoCache = new Map<string, boolean>();
const bitgetDemoCache = new Map<string, boolean>();

/**
 * Очищает API Key / Secret Key / Passphrase от случайных пробелов, невидимых символов и кавычек при копировании.
 */
export function sanitizeCredentialString(val?: string): string {
  return String(val || '')
    .replace(/[\s\u200B-\u200D\uFEFF"']/g, '')
    .trim();
}

/**
 * Фиксирует блокировку IP на стороне Binance (-1003 / HTTP 418 / HTTP 429) и извлекает точное время окончания бана (banned until <ms>).
 */
function recordBinanceRateLimitIfAny(
  baseUrl: string,
  statusCode: number,
  rawData: string
): number {
  const cleanHost = baseUrl.replace(/\/+$/, '');
  if (
    statusCode === 418 ||
    statusCode === 429 ||
    rawData.includes('-1003') ||
    rawData.toLowerCase().includes('way too many requests') ||
    rawData.toLowerCase().includes('banned until')
  ) {
    const match = rawData.match(/banned until\s+(\d{10,16})/i);
    let untilMs = match ? Number(match[1]) : Date.now() + 90_000;
    if (!Number.isFinite(untilMs) || untilMs <= Date.now()) {
      untilMs = Date.now() + 90_000;
    }
    binanceHostBanUntil.set(cleanHost, untilMs);
    return untilMs;
  }
  return 0;
}

/**
 * Проверяет, находится ли конкретный хост Binance Futures в режиме паузы из-за лимита запросов (-1003).
 */
export function isBinanceHostRateLimited(
  baseUrl = 'https://fapi.binance.com'
): { limited: boolean; untilMs: number } {
  const cleanHost = baseUrl.replace(/\/+$/, '');
  const untilMs = binanceHostBanUntil.get(cleanHost) || 0;
  if (untilMs > Date.now()) {
    return { limited: true, untilMs };
  }
  if (untilMs > 0) {
    binanceHostBanUntil.delete(cleanHost);
  }
  return { limited: false, untilMs: 0 };
}

/**
 * Проверяет, является ли ключ тестовой заглушкой из автотестов (scripts/verify-scalp-bot.ts).
 */
export function isSimulatedTestApiKey(apiKey?: string): boolean {
  const clean = String(apiKey || '').trim().toLowerCase();
  return (
    clean.startsWith('test_') ||
    clean.startsWith('mock_') ||
    clean.startsWith('sim_') ||
    clean.startsWith('ownr9988') ||
    clean.startsWith('clnt1122') ||
    clean === 'demo'
  );
}

/**
 * Преобразует пару вида 'ETH/USDT:USDT' в биржевой символ 'ETHUSDT'.
 */
export function pairToCleanSymbol(pair: string): string {
  const clean = String(pair || 'ETH/USDT:USDT').split(':')[0];
  return clean.replace('/', '').toUpperCase();
}

/**
 * Вычисляет криптографическую подпись HMAC-SHA256 для Binance USDT-M Futures.
 * Подписывается вся строка параметров (включая timestamp и recvWindow).
 */
export function signBinanceFuturesQuery(queryString: string, apiSecret: string): string {
  return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

/**
 * Вычисляет криптографическую подпись HMAC-SHA256 для Bybit V5 Unified/Futures.
 * Строка подписи формируется как: timestamp + apiKey + recvWindow + payload.
 */
export function signBybitV5(
  timestamp: string | number,
  apiKey: string,
  recvWindow: string | number,
  payload: string,
  apiSecret: string
): string {
  const preSign = `${timestamp}${apiKey}${recvWindow}${payload}`;
  return crypto.createHmac('sha256', apiSecret).update(preSign).digest('hex');
}

/**
 * Выполняет безопасный HTTPS запрос с таймаутом и сбором метрик задержки.
 */
function makeHttpsRequest(
  urlStr: string,
  options: {
    method: 'GET' | 'POST' | 'DELETE';
    headers: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }
): Promise<{ statusCode: number; data: string; latencyMs: number }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const url = new URL(urlStr);
    const timeout = options.timeoutMs || 8500;

    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ScalpBot/2.5',
          Accept: 'application/json',
          ...options.headers,
        },
        timeout,
      },
      (res) => {
        let chunks = '';
        res.on('data', (d) => {
          chunks += d;
        });
        res.on('end', () => {
          const statusCode = res.statusCode || 500;
          if (url.hostname.includes('binance')) {
            recordBinanceRateLimitIfAny(`https://${url.hostname}`, statusCode, chunks);
          }
          resolve({
            statusCode,
            data: chunks,
            latencyMs: Date.now() - start,
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Превышен таймаут ответа биржи (${timeout} мс)`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Синхронизирует время сервера с Binance Futures (защита от ошибки -1021 Timestamp outside of recvWindow).
 */
async function getBinanceTimestamp(
  forceSync = false,
  baseUrl = 'https://fapi.binance.com'
): Promise<number> {
  if (forceSync || Date.now() - lastTimeSyncTs > 10 * 60_000) {
    try {
      const wsRpc = getBinanceWsRpcClient(baseUrl);
      const wsTime = await wsRpc.request('time', {}, undefined, 3000);
      if (wsTime.status === 200 && typeof wsTime.result?.serverTime === 'number') {
        binanceTimeOffsetMs = wsTime.result.serverTime - Date.now();
        lastTimeSyncTs = Date.now();
        return Date.now() + binanceTimeOffsetMs;
      }
      if (!isBinanceHostRateLimited(baseUrl).limited) {
        const res = await makeHttpsRequest(`${baseUrl}/fapi/v1/time`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          timeoutMs: 4000,
        });
        if (res.statusCode === 200) {
          const parsed = JSON.parse(res.data);
          if (parsed && typeof parsed.serverTime === 'number') {
            binanceTimeOffsetMs = parsed.serverTime - Date.now();
            lastTimeSyncTs = Date.now();
          }
        }
      }
    } catch {
      // fallback to local clock
    }
  }
  return Date.now() + binanceTimeOffsetMs;
}

/**
 * Синхронизирует время сервера с Bybit V5 отдельно для каждого хоста (Mainnet, Testnet, Demo).
 */
async function getBybitTimestamp(
  baseUrl = 'https://api.bybit.com',
  forceSync = false
): Promise<string> {
  const cleanHost = baseUrl.replace(/\/+$/, '');
  const hostEntry = bybitTimeOffsetByHost.get(cleanHost);
  if (forceSync || !hostEntry || Date.now() - hostEntry.syncTs > 5 * 60_000) {
    try {
      const res = await makeHttpsRequest(`${cleanHost}/v5/market/time`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeoutMs: 4000,
      });
      if (res.statusCode === 200) {
        const parsed = JSON.parse(res.data);
        const serverMs = Number(
          parsed?.time ||
            (parsed?.result?.timeSecond ? Number(parsed.result.timeSecond) * 1000 : 0)
        );
        if (serverMs > 0) {
          const offsetMs = serverMs - Date.now();
          bybitTimeOffsetMs = offsetMs;
          lastBybitTimeSyncTs = Date.now();
          bybitTimeOffsetByHost.set(cleanHost, { offsetMs, syncTs: Date.now() });
          setBybitWsTimeOffset(cleanHost, offsetMs);
          return String(Date.now() + offsetMs);
        }
      }
    } catch {
      // fallback to local clock
    }
  }
  const activeOffset = hostEntry ? hostEntry.offsetMs : bybitTimeOffsetMs;
  return String(Date.now() + activeOffset);
}

/**
 * Загружает и кэширует правила точности лотов (stepSize, minQty, minNotional, quantityPrecision)
 * отдельно для каждого хоста Binance Futures (Mainnet fapi.binance.com и Testnet testnet.binancefuture.com).
 * На Testnet и Mainnet точность (quantityPrecision / stepSize) для ряда пар отличается!
 */
async function ensureBinanceExchangeInfo(
  baseUrl = 'https://fapi.binance.com',
  forceRefresh = false
): Promise<Map<string, BinanceSymbolFilterMeta>> {
  const cleanHost = baseUrl.replace(/\/+$/, '');
  const existing = binanceSymbolMetaByHost.get(cleanHost);
  if (
    !forceRefresh &&
    existing &&
    existing.symbols.size > 50 &&
    Date.now() - existing.syncTs < 60 * 60_000
  ) {
    return existing.symbols;
  }
  if (isBinanceHostRateLimited(cleanHost).limited) {
    return existing?.symbols || new Map<string, BinanceSymbolFilterMeta>();
  }
  try {
    const res = await makeHttpsRequest(`${cleanHost}/fapi/v1/exchangeInfo`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeoutMs: 7000,
    });
    if (res.statusCode === 200) {
      const data = JSON.parse(res.data);
      if (Array.isArray(data.symbols)) {
        const nextMap = new Map<string, BinanceSymbolFilterMeta>();
        for (const s of data.symbols) {
          const sym = String(s.symbol || '');
          if (!sym) continue;
          const filters = Array.isArray(s.filters) ? s.filters : [];
          const lotSizeFilter = filters.find((f: any) => f.filterType === 'LOT_SIZE');
          const marketLotFilter = filters.find((f: any) => f.filterType === 'MARKET_LOT_SIZE');
          const priceFilter = filters.find((f: any) => f.filterType === 'PRICE_FILTER');
          const notionalFilter = filters.find((f: any) => f.filterType === 'MIN_NOTIONAL');

          const rawLotStep = Number(lotSizeFilter?.stepSize || 0);
          const rawMarketStep = Number(marketLotFilter?.stepSize || 0);
          const resolvedStep = Math.max(rawLotStep, rawMarketStep);
          const stepSize = resolvedStep > 0 ? resolvedStep : 0.001;

          const rawLotMin = Number(lotSizeFilter?.minQty || 0);
          const rawMarketMin = Number(marketLotFilter?.minQty || 0);
          const resolvedMin = Math.max(rawLotMin, rawMarketMin, stepSize);
          const minQty = resolvedMin > 0 ? resolvedMin : stepSize;

          const rawLotMax = Number(lotSizeFilter?.maxQty || 0);
          const rawMarketMax = Number(marketLotFilter?.maxQty || 0);
          const validMaxes = [rawLotMax, rawMarketMax].filter((v) => v > 0);
          const maxQty = validMaxes.length > 0 ? Math.min(...validMaxes) : 1_000_000;

          const tickSize = Number(priceFilter?.tickSize || 0.0001);
          const minNotional = Number(notionalFilter?.notional || 5);

          nextMap.set(sym, {
            symbol: sym,
            status: String(s.status || 'TRADING'),
            contractType: String(s.contractType || 'PERPETUAL'),
            underlyingType: String(s.underlyingType || 'COIN'),
            stepSize,
            minQty,
            maxQty,
            tickSize: tickSize > 0 ? tickSize : 0.0001,
            minNotional: minNotional > 0 ? minNotional : 5,
            quantityPrecision:
              typeof s.quantityPrecision === 'number'
                ? s.quantityPrecision
                : countStepDecimals(stepSize),
            pricePrecision: typeof s.pricePrecision === 'number' ? s.pricePrecision : 4,
          });
        }
        if (nextMap.size > 0) {
          binanceSymbolMetaByHost.set(cleanHost, {
            syncTs: Date.now(),
            symbols: nextMap,
          });
          return nextMap;
        }
      }
    }
  } catch {
    // ignore network failure, fallback heuristics will be used
  }
  return existing?.symbols || new Map<string, BinanceSymbolFilterMeta>();
}

/**
 * Загружает и кэширует правила точности лотов Bybit V5 Linear (qtyStep, minOrderQty, minNotionalValue)
 * отдельно для каждого хоста (Mainnet api.bybit.com, Testnet api-testnet.bybit.com, Demo api-demo.bybit.com).
 */
async function ensureBybitInstrumentsInfo(
  baseUrl = 'https://api.bybit.com',
  forceRefresh = false
): Promise<Map<string, BybitSymbolFilterMeta>> {
  const cleanHost = baseUrl.replace(/\/+$/, '');
  const existing = bybitSymbolMetaByHost.get(cleanHost);
  if (
    !forceRefresh &&
    existing &&
    existing.symbols.size > 50 &&
    Date.now() - existing.syncTs < 30 * 60_000
  ) {
    return existing.symbols;
  }
  try {
    const res = await makeHttpsRequest(
      `${cleanHost}/v5/market/instruments-info?category=linear&limit=1000`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeoutMs: 7000,
      }
    );
    if (res.statusCode === 200) {
      const json = JSON.parse(res.data);
      const list = json?.result?.list;
      if (Array.isArray(list) && list.length > 0) {
        const nextMap = new Map<string, BybitSymbolFilterMeta>();
        for (const item of list) {
          const sym = String(item.symbol || '');
          if (!sym) continue;
          const lot = item.lotSizeFilter || {};
          const pf = item.priceFilter || {};
          const qtyStep = Number(lot.qtyStep || 0.01);
          const minOrderQty = Number(lot.minOrderQty || qtyStep || 0.01);
          const maxMktOrderQty = Number(lot.maxMktOrderQty || lot.maxOrderQty || 1_000_000);
          const minNotional = Number(lot.minNotionalValue || 5);
          const tickSize = Number(pf.tickSize || 0.0001);
          nextMap.set(sym, {
            symbol: sym,
            status: String(item.status || 'Trading'),
            qtyStep: qtyStep > 0 ? qtyStep : 0.01,
            minOrderQty: minOrderQty > 0 ? minOrderQty : 0.01,
            maxMktOrderQty: maxMktOrderQty > 0 ? maxMktOrderQty : 1_000_000,
            minNotional: minNotional > 0 ? minNotional : 5,
            tickSize: tickSize > 0 ? tickSize : 0.0001,
          });
        }
        if (nextMap.size > 0) {
          bybitSymbolMetaByHost.set(cleanHost, {
            syncTs: Date.now(),
            symbols: nextMap,
          });
          return nextMap;
        }
      }
    }
  } catch {
    // ignore network error, fallback heuristics will be used
  }
  return existing?.symbols || new Map<string, BybitSymbolFilterMeta>();
}

function countStepDecimals(step: number): number {
  const str = step.toFixed(10).replace(/0+$/, '');
  const dotIdx = str.indexOf('.');
  return dotIdx === -1 ? 0 : str.length - dotIdx - 1;
}

/**
 * Проверяет, доступна ли пара для реальной торговли на выбранной бирже и сети (Mainnet vs Testnet),
 * исключая отсутствующие на Testnet контракты, контракты в статусе SETTLING/PENDING_TRADING
 * и не-криптовалютные TradFi-акции (TRADIFI_PERPETUAL, например SPCXUSDT / TSLAUSDT).
 */
export async function isPairTradableOnExchange(
  pair: string,
  exchange: SupportedExchange,
  isTestnet?: boolean
): Promise<boolean> {
  const symbol = pairToCleanSymbol(pair);
  if (!symbol) return false;

  if (exchange === 'binance') {
    const baseUrl = isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
    const hostMap = await ensureBinanceExchangeInfo(baseUrl);
    if (hostMap.size > 50) {
      const meta = hostMap.get(symbol);
      if (!meta) return false;
      if (meta.status !== 'TRADING') return false;
      if (meta.contractType && meta.contractType !== 'PERPETUAL') return false;
      if (
        meta.underlyingType &&
        meta.underlyingType !== 'COIN' &&
        meta.underlyingType !== 'INDEX'
      ) {
        return false;
      }
      return true;
    }
    return true;
  }

  if (exchange === 'bybit') {
    const baseUrl = isTestnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    const hostMap = await ensureBybitInstrumentsInfo(baseUrl);
    if (hostMap.size > 50) {
      const meta = hostMap.get(symbol);
      if (!meta) return false;
      if (meta.status && meta.status !== 'Trading') return false;
      return true;
    }
    return true;
  }

  return true;
}

/**
 * Форматирует количество монет строго по правилам LOT_SIZE, MARKET_LOT_SIZE и quantityPrecision
 * для конкретного хоста Binance Futures (Mainnet fapi.binance.com или Testnet testnet.binancefuture.com).
 */
export async function formatBinanceFuturesQuantity(
  symbol: string,
  rawQty: number,
  referencePrice: number,
  isReduceOnly = false,
  baseUrl = 'https://fapi.binance.com'
): Promise<string> {
  const hostMap = await ensureBinanceExchangeInfo(baseUrl);
  let meta = hostMap.get(symbol);
  if (!meta && baseUrl !== 'https://fapi.binance.com') {
    const mainMap = await ensureBinanceExchangeInfo('https://fapi.binance.com');
    meta = mainMap.get(symbol);
  }

  let stepSize = meta?.stepSize || 0.001;
  let minQty = meta?.minQty || 0.001;
  const maxQty = meta?.maxQty || 1_000_000;
  const minNotional = meta?.minNotional || 5;

  if (!meta) {
    if (referencePrice >= 10000) {
      stepSize = 0.001;
      minQty = 0.001;
    } else if (referencePrice >= 200) {
      stepSize = 0.01;
      minQty = 0.01;
    } else if (referencePrice >= 10) {
      stepSize = 0.1;
      minQty = 0.1;
    } else {
      stepSize = 1;
      minQty = 1;
    }
  }

  let qty = Math.max(0, rawQty);

  // Для открывающих и усредняющих ордеров гарантируем выполнение MIN_NOTIONAL и minQty
  if (!isReduceOnly && referencePrice > 0) {
    const minQtyByNotional = (minNotional * 1.03) / referencePrice;
    if (qty < minQtyByNotional) {
      qty = minQtyByNotional;
    }
    if (qty < minQty) {
      qty = minQty;
    }
  }

  const stepDecimals = countStepDecimals(stepSize);
  const decimals =
    typeof meta?.quantityPrecision === 'number' && meta.quantityPrecision >= 0
      ? Math.min(stepDecimals, meta.quantityPrecision)
      : stepDecimals;
  const effectiveStep = decimals < stepDecimals ? Math.pow(10, -decimals) : stepSize;
  const effectiveMinQty = Math.max(minQty, effectiveStep);

  const steps = isReduceOnly
    ? Math.floor((qty + 1e-9) / effectiveStep)
    : Math.ceil((qty - 1e-9) / effectiveStep);
  const finalQty = Math.min(maxQty, Math.max(effectiveMinQty, steps * effectiveStep));

  const fixed = finalQty.toFixed(decimals);
  return decimals > 0 ? fixed.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1') : fixed;
}

/**
 * Форматирует количество монет строго по правилам Bybit V5 Linear (qtyStep, minOrderQty, minNotionalValue)
 * для конкретного хоста (Mainnet / Testnet / Demo).
 */
export async function formatBybitFuturesQuantity(
  symbol: string,
  rawQty: number,
  referencePrice: number,
  isReduceOnly = false,
  baseUrl = 'https://api.bybit.com'
): Promise<string> {
  const hostMap = await ensureBybitInstrumentsInfo(baseUrl);
  let meta = hostMap.get(symbol);
  if (!meta && baseUrl !== 'https://api.bybit.com') {
    const mainMap = await ensureBybitInstrumentsInfo('https://api.bybit.com');
    meta = mainMap.get(symbol);
  }

  let qtyStep = meta?.qtyStep || 0;
  let minOrderQty = meta?.minOrderQty || 0;
  const maxMktOrderQty = meta?.maxMktOrderQty || 1_000_000;
  const minNotional = meta?.minNotional || 5;

  if (!meta || qtyStep <= 0) {
    if (referencePrice >= 20000) {
      qtyStep = 0.001;
      minOrderQty = 0.001;
    } else if (referencePrice >= 500) {
      qtyStep = 0.01;
      minOrderQty = 0.01;
    } else if (referencePrice >= 15) {
      qtyStep = 0.1;
      minOrderQty = 0.1;
    } else if (referencePrice >= 1) {
      qtyStep = 0.1;
      minOrderQty = 1;
    } else {
      qtyStep = 1;
      minOrderQty = 10;
    }
  }

  let qty = Math.max(0, rawQty);
  if (!isReduceOnly && referencePrice > 0) {
    const minQtyByNotional = (minNotional * 1.04) / referencePrice;
    if (qty < minQtyByNotional) {
      qty = minQtyByNotional;
    }
    if (qty < minOrderQty) {
      qty = minOrderQty;
    }
  }

  const decimals = countStepDecimals(qtyStep);
  const steps = isReduceOnly
    ? Math.floor((qty + 1e-9) / qtyStep)
    : Math.ceil((qty - 1e-9) / qtyStep);
  const finalQty = Math.min(maxMktOrderQty, Math.max(minOrderQty, steps * qtyStep));

  const fixed = finalQty.toFixed(decimals);
  return decimals > 0 ? fixed.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1') : fixed;
}

/**
 * Форматирует человекочитаемую причину отказа Binance API на русском языке.
 */
function formatBinanceApiError(statusCode: number, rawData: string): {
  code?: number;
  message: string;
} {
  if (statusCode === 451) {
    return {
      code: 451,
      message:
        'Binance заблокировал IP-адрес американского сервера (HTTP 451). В настройках Render обязательно выберите регион Frankfurt (EU Central)!',
    };
  }
  try {
    const parsed = JSON.parse(rawData);
    const code = Number(parsed.code);
    const msg = String(parsed.msg || rawData);
    if (code === -2015) {
      return {
        code,
        message: `Binance [-2015]: Неверный ключ, IP или в настройках API-ключа на Binance не включена галочка «Enable Futures» (Включить фьючерсы)! (${msg})`,
      };
    }
    if (code === -2019) {
      return {
        code,
        message: `Binance [-2019]: Недостаточно свободной маржи USDT на фьючерсном счете USDⓈ-M! (${msg})`,
      };
    }
    if (code === -1111) {
      return {
        code,
        message: `Binance [-1111]: Превышена допустимая точность лота для данного актива (${msg})`,
      };
    }
    if (code === -4164) {
      return {
        code,
        message: `Binance [-4164]: Номинал ордера меньше минимального порога Binance для этой пары (${msg})`,
      };
    }
    if (code === -4061) {
      return {
        code,
        message: `Binance [-4061]: Несовпадение режима позиции (Hedge Mode / One-Way Mode) (${msg})`,
      };
    }
    return {
      code,
      message: `Binance [${code}]: ${msg}`,
    };
  } catch {
    return {
      code: statusCode,
      message: `Binance HTTP ${statusCode}: ${rawData.slice(0, 160)}`,
    };
  }
}

/**
 * Проверяет режим позиций на аккаунте Binance (Hedge Mode dualSidePosition=true или One-Way Mode dualSidePosition=false).
 */
async function getBinanceDualSideMode(
  apiKey: string,
  apiSecret: string,
  forceRefresh = false,
  baseUrl = 'https://fapi.binance.com'
): Promise<boolean> {
  const cacheKey = `${apiKey}:${baseUrl}`;
  const cached = binanceDualSideCache.get(cacheKey) || binanceDualSideCache.get(apiKey);
  if (!forceRefresh && cached && Date.now() - cached.updatedAt < 30 * 60_000) {
    return cached.dualSide;
  }
  if (isBinanceHostRateLimited(baseUrl).limited) {
    return cached?.dualSide ?? false;
  }
  try {
    const ts = await getBinanceTimestamp(false, baseUrl);
    const query = `timestamp=${ts}&recvWindow=10000`;
    const sig = signBinanceFuturesQuery(query, apiSecret);
    const res = await makeHttpsRequest(
      `${baseUrl}/fapi/v1/positionSide/dual?${query}&signature=${sig}`,
      {
        method: 'GET',
        headers: { 'X-MBX-APIKEY': apiKey },
      }
    );
    if (res.statusCode === 200) {
      const data = JSON.parse(res.data);
      const dual = Boolean(data.dualSidePosition);
      binanceDualSideCache.set(cacheKey, { dualSide: dual, updatedAt: Date.now() });
      binanceDualSideCache.set(apiKey, { dualSide: dual, updatedAt: Date.now() });
      return dual;
    }
  } catch {
    // ignore
  }
  return cached?.dualSide ?? false;
}

/**
 * Автоматически включает или проверяет режим хеджирования (Hedge Mode: одновременный LONG + SHORT по одной паре)
 * на подключенной бирже (Binance dualSidePosition=true, Bybit mode=3 Both Sides).
 */
export async function ensureExchangeHedgeMode(
  creds: ExchangeCredentials,
  pair: string
): Promise<{ enabled: boolean; message: string }> {
  const cleanKey = String(creds.apiKey || '').trim();
  const cleanSecret = String(creds.apiSecret || '').trim();
  const symbol = pairToCleanSymbol(pair);

  if (isSimulatedTestApiKey(cleanKey)) {
    return { enabled: true, message: 'Simulated Hedge Mode enabled' };
  }
  if (!cleanKey || !cleanSecret) {
    return { enabled: false, message: 'Missing API credentials' };
  }

  if (creds.exchange === 'binance') {
    const candidateHosts = getBinanceCandidateHosts(cleanKey, creds.isTestnet);
    for (const baseUrl of candidateHosts) {
      try {
        const currentDual = await getBinanceDualSideMode(cleanKey, cleanSecret, false, baseUrl);
        if (currentDual) {
          return { enabled: true, message: 'Binance Hedge Mode (dualSidePosition=true) уже активен' };
        }
        const ts = await getBinanceTimestamp(false, baseUrl);
        const query = `dualSidePosition=true&timestamp=${ts}&recvWindow=10000`;
        const sig = signBinanceFuturesQuery(query, cleanSecret);
        const res = await makeHttpsRequest(
          `${baseUrl}/fapi/v1/positionSide/dual?${query}&signature=${sig}`,
          {
            method: 'POST',
            headers: { 'X-MBX-APIKEY': cleanKey },
            timeoutMs: 4500,
          }
        );
        if (res.statusCode === 200 || res.data.includes('-4059')) {
          binanceDualSideCache.set(cleanKey, { dualSide: true, updatedAt: Date.now() });
          return { enabled: true, message: 'Binance Hedge Mode (dualSidePosition=true) включен' };
        }
        if (res.data.includes('-2015')) continue;
      } catch {
        // try next host
      }
    }
    const fallbackDual = binanceDualSideCache.get(cleanKey)?.dualSide ?? false;
    return {
      enabled: fallbackDual,
      message: fallbackDual
        ? 'Binance Hedge Mode активен'
        : 'Binance в режиме One-Way (переключение на Hedge Mode недоступно при открытых позициях)',
    };
  }

  if (creds.exchange === 'bybit') {
    if (bybitHedgeModeCache.get(cleanKey) === true) {
      return { enabled: true, message: 'Bybit Hedge Mode (mode=3) уже активен' };
    }
    const candidateHosts = getBybitCandidateHosts(cleanKey, creds.isTestnet);
    for (const baseUrl of candidateHosts) {
      try {
        const timestamp = await getBybitTimestamp(baseUrl, false);
        const recvWindow = '10000';
        const bodyStr = JSON.stringify({
          category: 'linear',
          symbol,
          mode: 3, // 3 = Both Sides (Hedge Mode)
        });
        const sig = signBybitV5(timestamp, cleanKey, recvWindow, bodyStr, cleanSecret);
        const res = await makeHttpsRequest(`${baseUrl}/v5/position/switch-mode`, {
          method: 'POST',
          headers: {
            'X-BAPI-API-KEY': cleanKey,
            'X-BAPI-TIMESTAMP': timestamp,
            'X-BAPI-SIGN': sig,
            'X-BAPI-RECV-WINDOW': recvWindow,
            'Content-Type': 'application/json',
          },
          body: bodyStr,
          timeoutMs: 4500,
        });
        if (res.statusCode === 200) {
          const json = JSON.parse(res.data);
          if (json.retCode === 10003 || json.retCode === 10004 || json.retCode === 33004) {
            continue;
          }
          // 0 = switched to Hedge Mode, 110025 = Position mode is not modified (already mode 3)
          if (json.retCode === 0 || json.retCode === 110025) {
            bybitHedgeModeCache.set(cleanKey, true);
            return { enabled: true, message: 'Bybit Hedge Mode (mode=3) активен' };
          }
        }
      } catch {
        // ignore
      }
    }
    return {
      enabled: bybitHedgeModeCache.get(cleanKey) ?? false,
      message: 'Bybit One-Way Mode',
    };
  }

  return { enabled: true, message: `${creds.exchange.toUpperCase()} поддерживает 2-сторонний вход` };
}

/**
 * Устанавливает кредитное плечо (25x с авто-фоллбэком до максимального доступного на паре) и тип маржи CROSSED на Binance Futures.
 */
async function ensureBinanceSymbolLeverage(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  targetLeverage = 25,
  baseUrl = 'https://fapi.binance.com'
): Promise<number> {
  const cacheKey = `${apiKey}:${symbol}`;
  const cachedLev = binanceLeverageCache.get(cacheKey);
  if (cachedLev === targetLeverage) {
    return cachedLev;
  }
  if (isBinanceHostRateLimited(baseUrl).limited) {
    return cachedLev || targetLeverage;
  }

  // 1. Попытка установить тип маржи CROSSED (игнорируем -4046 "No need to change margin type")
  try {
    const tsMargin = await getBinanceTimestamp(false, baseUrl);
    const qMargin = `symbol=${symbol}&marginType=CROSSED&timestamp=${tsMargin}&recvWindow=10000`;
    const sigMargin = signBinanceFuturesQuery(qMargin, apiSecret);
    await makeHttpsRequest(
      `${baseUrl}/fapi/v1/marginType?${qMargin}&signature=${sigMargin}`,
      {
        method: 'POST',
        headers: { 'X-MBX-APIKEY': apiKey },
      }
    );
  } catch {
    // ignore
  }

  // 2. Установка плеча (пробуем запрошенное плечо, при ошибке -4028 пробуем 20x, 15x, 10x, 5x)
  const candidates = Array.from(new Set([targetLeverage, 20, 15, 10, 5])).filter((x) => x >= 1);
  for (const lev of candidates) {
    try {
      const tsLev = await getBinanceTimestamp(false, baseUrl);
      const qLev = `symbol=${symbol}&leverage=${lev}&timestamp=${tsLev}&recvWindow=10000`;
      const sigLev = signBinanceFuturesQuery(qLev, apiSecret);
      const res = await makeHttpsRequest(
        `${baseUrl}/fapi/v1/leverage?${qLev}&signature=${sigLev}`,
        {
          method: 'POST',
          headers: { 'X-MBX-APIKEY': apiKey },
        }
      );
      if (res.statusCode === 200) {
        binanceLeverageCache.set(cacheKey, lev);
        return lev;
      }
    } catch {
      // try next fallback leverage
    }
  }
  return targetLeverage;
}

/**
 * Устанавливает кредитное плечо на Bybit V5 Linear (игнорирует 110043 "leverage not modified").
 */
async function ensureBybitSymbolLeverage(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  targetLeverage = 25,
  baseUrl = 'https://api.bybit.com'
): Promise<number> {
  const cacheKey = `${apiKey}:${symbol}:${baseUrl}`;
  const cachedLev = bybitLeverageCache.get(cacheKey);
  if (cachedLev === targetLeverage) {
    return cachedLev;
  }

  const candidates = Array.from(new Set([targetLeverage, 20, 15, 10, 5])).filter((x) => x >= 1);
  for (const lev of candidates) {
    try {
      const timestamp = await getBybitTimestamp(baseUrl);
      const recvWindow = '10000';
      const bodyStr = JSON.stringify({
        category: 'linear',
        symbol,
        buyLeverage: String(lev),
        sellLeverage: String(lev),
      });
      const sig = signBybitV5(timestamp, apiKey, recvWindow, bodyStr, apiSecret);
      const res = await makeHttpsRequest(`${baseUrl}/v5/position/set-leverage`, {
        method: 'POST',
        headers: {
          'X-BAPI-API-KEY': apiKey,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-SIGN': sig,
          'X-BAPI-RECV-WINDOW': recvWindow,
          'Content-Type': 'application/json',
        },
        body: bodyStr,
        timeoutMs: 5000,
      });
      if (res.statusCode === 200) {
        const json = JSON.parse(res.data);
        // retCode 0 = изменено, retCode 110043 = плечо уже установлено на это значение
        if (json.retCode === 0 || json.retCode === 110043) {
          bybitLeverageCache.set(cacheKey, lev);
          return lev;
        }
      }
    } catch {
      // ignore and try next candidate
    }
  }
  return targetLeverage;
}

/**
 * Определяет список хостов Bybit для проверки/отправки с учётом флага isTestnet и кэша.
 */
function getBybitCandidateHosts(apiKey: string, isTestnet?: boolean): string[] {
  const cached = bybitHostCache.get(apiKey);
  const all = isTestnet
    ? ['https://api-testnet.bybit.com', 'https://api-demo.bybit.com', 'https://api.bybit.com']
    : ['https://api.bybit.com', 'https://api-demo.bybit.com', 'https://api-testnet.bybit.com'];
  if (cached) {
    return [cached, ...all.filter((h) => h !== cached)];
  }
  return all;
}

/**
 * Определяет список хостов Binance Futures с учётом флага isTestnet, кэша и анти-бана -1003.
 */
function getBinanceCandidateHosts(apiKey: string, isTestnet?: boolean): string[] {
  const cached = binanceHostCache.get(apiKey);
  const all = isTestnet
    ? ['https://testnet.binancefuture.com', 'https://fapi.binance.com']
    : ['https://fapi.binance.com', 'https://testnet.binancefuture.com'];
  const ordered = cached ? [cached, ...all.filter((h) => h !== cached)] : all;
  // Ставим хосты без активного бана -1003 первыми, чтобы ключ Testnet мгновенно работал даже при бане Mainnet (и наоборот)
  const unbanned = ordered.filter((h) => !isBinanceHostRateLimited(h).limited);
  const banned = ordered.filter((h) => isBinanceHostRateLimited(h).limited);
  return [...unbanned, ...banned];
}

/**
 * Исполняет реальный фьючерсный рыночный ордер (OPEN / DCA / CLOSE) на подключенной бирже.
 * Поддерживает Binance USDT-M Futures (Mainnet + Testnet), Bybit V5 Linear (Mainnet + Testnet + Demo),
 * OKX V5 Swap (Mainnet + Demo), Bitget V2 USDT-Futures (Mainnet + Demo) и BingX Swap V2.
 */
export async function executeExchangeFuturesOrder(
  creds: ExchangeCredentials,
  params: ExchangeOrderParams
): Promise<PlacedOrderResult> {
  const cleanKey = sanitizeCredentialString(creds.apiKey);
  const cleanSecret = sanitizeCredentialString(creds.apiSecret);
  const symbol = pairToCleanSymbol(params.pair);
  const targetLeverage = Math.max(1, Math.round(params.leverage || 25));

  // Для локальных автотестов (verify-scalp-bot.ts), где используются ключи вида test_...
  if (isSimulatedTestApiKey(cleanKey)) {
    const orderSide: 'BUY' | 'SELL' =
      params.action === 'CLOSE'
        ? params.isShort
          ? 'BUY'
          : 'SELL'
        : params.isShort
        ? 'SELL'
        : 'BUY';
    return {
      success: true,
      order_id: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      symbol,
      side: orderSide,
      price: params.referencePrice,
      qty: params.quantity,
      status: 'FILLED',
      exchange_time: Date.now(),
      commission_usdt: Number((params.referencePrice * params.quantity * 0.0006).toFixed(4)),
      is_simulated_test: true,
    };
  }

  if (!cleanKey || !cleanSecret) {
    return {
      success: false,
      order_id: '',
      symbol,
      side: params.isShort ? 'SELL' : 'BUY',
      price: params.referencePrice,
      qty: params.quantity,
      status: 'REJECTED',
      exchange_time: Date.now(),
      error: 'Отсутствуют API Key или Secret Key для отправки ордера на биржу',
    };
  }

  const isClose = params.action === 'CLOSE';
  // Для открытия и усреднения (OPEN / DCA): LONG -> BUY, SHORT -> SELL
  // Для закрытия (CLOSE): закрытие LONG -> SELL, закрытие SHORT -> BUY
  const side: 'BUY' | 'SELL' = isClose
    ? params.isShort
      ? 'BUY'
      : 'SELL'
    : params.isShort
    ? 'SELL'
    : 'BUY';

  // ==========================================================================
  // 1. BINANCE USDT-M FUTURES (Mainnet fapi.binance.com + Testnet testnet.binancefuture.com)
  // ==========================================================================
  if (creds.exchange === 'binance') {
    const candidateHosts = getBinanceCandidateHosts(cleanKey, creds.isTestnet);
    let lastFormattedErr: { code?: number; message: string } = {
      code: 0,
      message: 'Ошибка Binance Futures',
    };

    for (const baseUrl of candidateHosts) {
      try {
        if (!isClose) {
          await ensureBinanceSymbolLeverage(cleanKey, cleanSecret, symbol, targetLeverage, baseUrl);
        }
        let formattedQtyStr = await formatBinanceFuturesQuantity(
          symbol,
          params.quantity,
          params.referencePrice,
          isClose,
          baseUrl
        );
        let activeDualSide = await getBinanceDualSideMode(cleanKey, cleanSecret, false, baseUrl);

        const buildOrderParamsObj = async (
          useDualSide: boolean,
          qtyStr = formattedQtyStr
        ): Promise<Record<string, string | number>> => {
          const ts = await getBinanceTimestamp(false, baseUrl);
          const p: Record<string, string | number> = {
            apiKey: cleanKey,
            symbol,
            side,
            type: 'MARKET',
            quantity: qtyStr,
            newOrderRespType: 'RESULT',
            timestamp: ts,
            recvWindow: 10000,
          };
          if (useDualSide) {
            p.positionSide = params.isShort ? 'SHORT' : 'LONG';
          } else if (isClose) {
            p.reduceOnly = 'true';
          }
          return p;
        };

        const buildOrderQuery = async (useDualSide: boolean, qtyStr = formattedQtyStr): Promise<string> => {
          const ts = await getBinanceTimestamp(false, baseUrl);
          const qp = new URLSearchParams();
          qp.set('symbol', symbol);
          qp.set('side', side);
          qp.set('type', 'MARKET');
          qp.set('quantity', qtyStr);
          qp.set('newOrderRespType', 'RESULT');
          if (useDualSide) {
            qp.set('positionSide', params.isShort ? 'SHORT' : 'LONG');
          } else if (isClose) {
            qp.set('reduceOnly', 'true');
          }
          qp.set('timestamp', String(ts));
          qp.set('recvWindow', '10000');
          return qp.toString();
        };

        const wsRpc = getBinanceWsRpcClient(baseUrl);
        const sendBinanceMarketOrder = async (
          useDualSide: boolean,
          qtyStr = formattedQtyStr
        ): Promise<{ statusCode: number; data: string; latencyMs: number }> => {
          const wsOrdParams = await buildOrderParamsObj(useDualSide, qtyStr);
          const wsOrdRes = await wsRpc.request('order.place', wsOrdParams, cleanSecret, 5500);
          if (wsOrdRes.status === 200 && wsOrdRes.result) {
            return {
              statusCode: 200,
              data: JSON.stringify(wsOrdRes.result),
              latencyMs: wsOrdRes.latencyMs,
            };
          }
          if (wsOrdRes.error && wsOrdRes.status !== 503 && wsOrdRes.status !== 408) {
            return {
              statusCode: wsOrdRes.status,
              data: JSON.stringify(wsOrdRes.error),
              latencyMs: wsOrdRes.latencyMs,
            };
          }
          const query = await buildOrderQuery(useDualSide, qtyStr);
          const signature = signBinanceFuturesQuery(query, cleanSecret);
          return makeHttpsRequest(`${baseUrl}/fapi/v1/order?${query}&signature=${signature}`, {
            method: 'POST',
            headers: {
              'X-MBX-APIKEY': cleanKey,
              'Content-Type': 'application/json',
            },
          });
        };

        let res = await sendBinanceMarketOrder(activeDualSide, formattedQtyStr);

        // Если ошибка -1021 (рассинхрон времени) — принудительно синхронизируем часы и повторяем
        if (res.statusCode !== 200 && res.data.includes('-1021')) {
          await getBinanceTimestamp(true, baseUrl);
          res = await sendBinanceMarketOrder(activeDualSide, formattedQtyStr);
        }

        // Если ошибка -2015 (ключ от Testnet отправлен на Mainnet или наоборот) — пробуем следующий хост
        if (res.statusCode !== 200 && res.data.includes('-2015')) {
          lastFormattedErr = formatBinanceApiError(res.statusCode, res.data);
          continue;
        }

        // Если ошибка -4061 (Hedge Mode / One-Way Mode) — инвертируем dualSide и повторяем
        if (res.statusCode !== 200 && res.data.includes('-4061')) {
          activeDualSide = !activeDualSide;
          binanceDualSideCache.set(cleanKey, { dualSide: activeDualSide, updatedAt: Date.now() });
          res = await sendBinanceMarketOrder(activeDualSide, formattedQtyStr);
        }

        // Если ошибка -1111 (Precision is over the maximum defined for this asset) —
        // принудительно обновляем exchangeInfo для этого baseUrl и повторяем с точной/целочисленной точностью
        if (res.statusCode !== 200 && res.data.includes('-1111')) {
          await ensureBinanceExchangeInfo(baseUrl, true);
          let refreshedQty = await formatBinanceFuturesQuantity(
            symbol,
            params.quantity,
            params.referencePrice,
            isClose,
            baseUrl
          );
          if (refreshedQty === formattedQtyStr && refreshedQty.includes('.')) {
            refreshedQty = String(
              Math.max(
                1,
                isClose ? Math.floor(Number(formattedQtyStr)) : Math.ceil(Number(formattedQtyStr))
              )
            );
          }
          formattedQtyStr = refreshedQty;
          res = await sendBinanceMarketOrder(activeDualSide, formattedQtyStr);

          // Если всё ещё -1111 и есть дробная часть — округляем до целого числа контрактов (0 знаков после запятой)
          if (res.statusCode !== 200 && res.data.includes('-1111') && formattedQtyStr.includes('.')) {
            formattedQtyStr = String(
              Math.max(
                1,
                isClose ? Math.floor(Number(formattedQtyStr)) : Math.ceil(Number(formattedQtyStr))
              )
            );
            res = await sendBinanceMarketOrder(activeDualSide, formattedQtyStr);
          }
        }

        // Если при закрытии (CLOSE) вернулась ошибка -2022 ReduceOnly Order is rejected
        if (isClose && res.statusCode !== 200 && res.data.includes('-2022')) {
          binanceHostCache.set(cleanKey, baseUrl);
          return {
            success: true,
            order_id: `already-closed-${Date.now()}`,
            symbol,
            side,
            price: params.referencePrice,
            qty: Number(formattedQtyStr),
            status: 'FILLED',
            exchange_time: Date.now(),
            network_label: baseUrl.includes('testnet') ? 'Binance Testnet' : 'Binance Mainnet',
          };
        }

        if (res.statusCode === 200) {
          binanceHostCache.set(cleanKey, baseUrl);
          binancePositionsCache.delete(cleanKey);
          binanceClosedPnlCache.delete(cleanKey);
          const data = JSON.parse(res.data);
          const orderIdStr = String(data.orderId || `bn-${Date.now()}`);
          let avgPrice =
            Number(data.avgPrice || 0) > 0 ? Number(data.avgPrice) : params.referencePrice;
          let executedQty =
            Number(data.executedQty || 0) > 0 ? Number(data.executedQty) : Number(formattedQtyStr);
          let commissionUsdt = Number((avgPrice * executedQty * 0.0005).toFixed(4));
          let realizedPnlUsdt: number | undefined;
          let exchangeTime = Number(data.updateTime || Date.now());

          // 1. Сначала мгновенно ждём отчёт исполнения из приватного WS (ORDER_TRADE_UPDATE, 0 REST-веса)
          const wsFill = data.orderId
            ? await waitForWsOrderFill('binance', cleanKey, orderIdStr, isClose ? 240 : 120)
            : null;
          if (wsFill && wsFill.avgPrice > 0 && wsFill.qty > 0) {
            avgPrice = Number(wsFill.avgPrice.toPrecision(8));
            executedQty = Number(wsFill.qty.toFixed(6));
            if (wsFill.fee > 0) {
              commissionUsdt = Number(wsFill.fee.toFixed(4));
            }
            if (typeof wsFill.realizedPnl === 'number') {
              realizedPnlUsdt = Number(wsFill.realizedPnl.toFixed(4));
            }
            if (wsFill.tradeTime > 0) {
              exchangeTime = wsFill.tradeTime;
            }
          } else if (data.orderId && !isBinanceHostRateLimited(baseUrl).limited) {
            // 2. Если приватный WS ещё не доставил событие — точечный REST fallback /fapi/v1/userTrades
            try {
              const tTs = await getBinanceTimestamp(false, baseUrl);
              const tQuery = `symbol=${symbol}&orderId=${encodeURIComponent(orderIdStr)}&timestamp=${tTs}&recvWindow=10000`;
              const tSig = signBinanceFuturesQuery(tQuery, cleanSecret);
              const tRes = await makeHttpsRequest(
                `${baseUrl}/fapi/v1/userTrades?${tQuery}&signature=${tSig}`,
                {
                  method: 'GET',
                  headers: { 'X-MBX-APIKEY': cleanKey },
                  timeoutMs: 4000,
                }
              );
              if (tRes.statusCode === 200) {
                const fills = JSON.parse(tRes.data);
                if (Array.isArray(fills) && fills.length > 0) {
                  let totalQty = 0;
                  let totalNotional = 0;
                  let totalFee = 0;
                  let totalRealized = 0;
                  let latestTime = exchangeTime;
                  for (const f of fills) {
                    const fQty = Math.abs(Number(f.qty || 0));
                    const fPrice = Number(f.price || 0);
                    if (fQty > 0 && fPrice > 0) {
                      totalQty += fQty;
                      totalNotional += fQty * fPrice;
                    }
                    totalFee += Math.abs(Number(f.commission || 0));
                    totalRealized += Number(f.realizedPnl || 0);
                    if (Number(f.time || 0) > latestTime) {
                      latestTime = Number(f.time);
                    }
                  }
                  if (totalQty > 0 && totalNotional > 0) {
                    avgPrice = Number((totalNotional / totalQty).toPrecision(8));
                    executedQty = Number(totalQty.toFixed(6));
                  }
                  if (totalFee > 0) {
                    commissionUsdt = Number(totalFee.toFixed(4));
                  }
                  if (isClose || Math.abs(totalRealized) > 0) {
                    realizedPnlUsdt = Number(totalRealized.toFixed(4));
                  }
                  exchangeTime = latestTime;
                }
              }
            } catch {
              // ignore userTrades lookup failure and use order response
            }
          }

          return {
            success: true,
            order_id: orderIdStr,
            symbol,
            side,
            price: avgPrice,
            qty: executedQty,
            status: 'FILLED',
            exchange_time: exchangeTime,
            commission_usdt: commissionUsdt,
            realized_pnl_usdt: realizedPnlUsdt,
            network_label: baseUrl.includes('testnet') ? 'Binance Testnet' : 'Binance Mainnet',
          };
        }

        lastFormattedErr = formatBinanceApiError(res.statusCode, res.data);
        if (
          lastFormattedErr.code === -1003 ||
          lastFormattedErr.code === -2015 ||
          lastFormattedErr.code === -2014 ||
          res.statusCode === 418 ||
          res.statusCode === 429
        ) {
          continue;
        }
        break;
      } catch (e: any) {
        lastFormattedErr = {
          code: 500,
          message: `Ошибка соединения с Binance Futures при отправке ордера: ${e?.message || 'Сеть недоступна'}`,
        };
      }
    }

    return {
      success: false,
      order_id: '',
      symbol,
      side,
      price: params.referencePrice,
      qty: params.quantity,
      status: 'REJECTED',
      exchange_time: Date.now(),
      error: lastFormattedErr.message,
      error_code: lastFormattedErr.code,
    };
  }

  // ==========================================================================
  // 2. BYBIT V5 LINEAR FUTURES (Mainnet api.bybit.com + Testnet api-testnet.bybit.com + Demo api-demo.bybit.com)
  // ==========================================================================
  if (creds.exchange === 'bybit') {
    const candidateHosts = getBybitCandidateHosts(cleanKey, creds.isTestnet);
    let lastErrorMsg = 'Ошибка отправки ордера Bybit V5';
    let lastErrorCode: string | number | undefined;

    for (const baseUrl of candidateHosts) {
      try {
        if (!isClose) {
          await ensureBybitSymbolLeverage(cleanKey, cleanSecret, symbol, targetLeverage, baseUrl);
        }
        let formattedQtyStr = await formatBybitFuturesQuantity(
          symbol,
          params.quantity,
          params.referencePrice,
          isClose,
          baseUrl
        );

        const bybitWsTrade = getBybitWsTradeClient(cleanKey, cleanSecret, baseUrl);
        const sendBybitOrder = async (
          positionIdx: 0 | 1 | 2,
          forceTimeSync = false,
          qtyOverride = formattedQtyStr
        ) => {
          const timestamp = await getBybitTimestamp(baseUrl, forceTimeSync);
          const recvWindow = '10000';
          const bodyObj: Record<string, any> = {
            category: 'linear',
            symbol,
            side: side === 'BUY' ? 'Buy' : 'Sell',
            orderType: 'Market',
            qty: qtyOverride,
            positionIdx,
          };
          if (isClose) {
            bodyObj.reduceOnly = true;
          }

          // 1. Отправка через постоянный Bybit V5 WebSocket Trade API (субсекундная задержка)
          const wsTradeRes = await bybitWsTrade.placeOrder(timestamp, recvWindow, bodyObj, 3500);
          if (wsTradeRes.status === 200) {
            return {
              statusCode: 200,
              data: JSON.stringify({
                retCode: wsTradeRes.retCode ?? 0,
                retMsg: wsTradeRes.retMsg || 'OK',
                result: wsTradeRes.result || {},
              }),
              latencyMs: wsTradeRes.latencyMs,
            };
          }

          // 2. Прозрачный HTTPS REST fallback (если WS Trade недоступен на Demo/сети)
          const bodyStr = JSON.stringify(bodyObj);
          const signature = signBybitV5(timestamp, cleanKey, recvWindow, bodyStr, cleanSecret);
          return makeHttpsRequest(`${baseUrl}/v5/order/create`, {
            method: 'POST',
            headers: {
              'X-BAPI-API-KEY': cleanKey,
              'X-BAPI-TIMESTAMP': timestamp,
              'X-BAPI-SIGN': signature,
              'X-BAPI-RECV-WINDOW': recvWindow,
              'Content-Type': 'application/json',
            },
            body: bodyStr,
          });
        };

        const cachedHedge = bybitHedgeModeCache.get(cleanKey) === true;
        let activePosIdx: 0 | 1 | 2 = cachedHedge ? (params.isShort ? 2 : 1) : 0;
        let res = await sendBybitOrder(activePosIdx, false);

        if (res.statusCode === 200) {
          let json = JSON.parse(res.data);

          // При рассинхроне времени (retCode 10002) синхронизируем часы и повторяем
          if (json.retCode === 10002) {
            res = await sendBybitOrder(activePosIdx, true);
            if (res.statusCode === 200) {
              json = JSON.parse(res.data);
            }
          }

          // Если ключ принадлежит другой среде (Testnet vs Mainnet vs Demo: retCode 10003 / 10004 / 33004) — пробуем следующий хост
          if (json.retCode === 10003 || json.retCode === 10004 || json.retCode === 33004) {
            lastErrorCode = json.retCode;
            lastErrorMsg = `Bybit V5 [${json.retCode}]: ${json.retMsg}`;
            continue;
          }

          // Если на аккаунте Bybit включен Hedge Mode или наоборот One-Way Mode (retCode 10001: position idx not match position mode)
          if (
            json.retCode === 10001 &&
            String(json.retMsg || '')
              .toLowerCase()
              .includes('position idx')
          ) {
            if (activePosIdx === 0) {
              activePosIdx = params.isShort ? 2 : 1;
              bybitHedgeModeCache.set(cleanKey, true);
            } else {
              activePosIdx = 0;
              bybitHedgeModeCache.set(cleanKey, false);
            }
            const retryRes = await sendBybitOrder(activePosIdx, false);
            if (retryRes.statusCode === 200) {
              json = JSON.parse(retryRes.data);
            }
          }

          // Если ошибка точности лота Bybit (10001 qty invalid / step) — обновляем instruments-info и повторяем
          if (
            json.retCode === 10001 &&
            (String(json.retMsg || '').toLowerCase().includes('qty') ||
              String(json.retMsg || '').toLowerCase().includes('precision'))
          ) {
            await ensureBybitInstrumentsInfo(baseUrl, true);
            let retryBybitQty = await formatBybitFuturesQuantity(
              symbol,
              params.quantity,
              params.referencePrice,
              isClose,
              baseUrl
            );
            if (retryBybitQty === formattedQtyStr && retryBybitQty.includes('.')) {
              retryBybitQty = String(
                Math.max(
                  1,
                  isClose ? Math.floor(Number(formattedQtyStr)) : Math.ceil(Number(formattedQtyStr))
                )
              );
            }
            formattedQtyStr = retryBybitQty;
            const retryQtyRes = await sendBybitOrder(activePosIdx, false, formattedQtyStr);
            if (retryQtyRes.statusCode === 200) {
              json = JSON.parse(retryQtyRes.data);
            }
          }

          // Если при закрытии (CLOSE) позиция на бирже уже была закрыта вручную (110017 / current position is zero)
          if (
            isClose &&
            (json.retCode === 110017 ||
              String(json.retMsg || '')
                .toLowerCase()
                .includes('current position is zero') ||
              String(json.retMsg || '')
                .toLowerCase()
                .includes('reduce-only'))
          ) {
            bybitHostCache.set(cleanKey, baseUrl);
            const netLabel = baseUrl.includes('testnet')
              ? 'Bybit Testnet'
              : baseUrl.includes('demo')
              ? 'Bybit Demo'
              : 'Bybit Mainnet';
            return {
              success: true,
              order_id: `bybit-closed-${Date.now()}`,
              symbol,
              side,
              price: params.referencePrice,
              qty: Number(formattedQtyStr),
              status: 'FILLED',
              exchange_time: Date.now(),
              network_label: netLabel,
            };
          }

          if (json.retCode === 0) {
            bybitHostCache.set(cleanKey, baseUrl);
            const netLabel = baseUrl.includes('testnet')
              ? 'Bybit Testnet'
              : baseUrl.includes('demo')
              ? 'Bybit Demo'
              : 'Bybit Mainnet';
            const orderId = String(json.result?.orderId || `bybit-${Date.now()}`);

            let actualAvgPrice = params.referencePrice;
            let actualExecQty = Number(formattedQtyStr);
            let actualExecFee = Number(
              (params.referencePrice * Number(formattedQtyStr) * 0.00055).toFixed(4)
            );
            let actualExchangeTime = Date.now();

            // 1. Сначала мгновенно ждём отчёт об исполнении из приватного Bybit WS (execution/order)
            const wsFill = json.result?.orderId
              ? await waitForWsOrderFill('bybit', cleanKey, orderId, 280)
              : null;

            if (wsFill && wsFill.avgPrice > 0 && wsFill.qty > 0) {
              actualAvgPrice = wsFill.avgPrice;
              actualExecQty = wsFill.qty;
              if (wsFill.fee > 0) {
                actualExecFee = wsFill.fee;
              }
              if (wsFill.tradeTime > 0) {
                actualExchangeTime = wsFill.tradeTime;
              }
            } else if (json.result?.orderId) {
              // 2. Fallback на REST API, если приватный WS не успел доставить событие
              try {
                await new Promise((r) => setTimeout(r, 120));
                const qTs = await getBybitTimestamp(baseUrl, false);
                const recvWindow = '10000';
                const qStr = `category=linear&symbol=${symbol}&orderId=${encodeURIComponent(orderId)}`;
                const qSig = signBybitV5(qTs, cleanKey, recvWindow, qStr, cleanSecret);
                const ordRes = await makeHttpsRequest(`${baseUrl}/v5/order/realtime?${qStr}`, {
                  method: 'GET',
                  headers: {
                    'X-BAPI-API-KEY': cleanKey,
                    'X-BAPI-TIMESTAMP': qTs,
                    'X-BAPI-SIGN': qSig,
                    'X-BAPI-RECV-WINDOW': recvWindow,
                  },
                  timeoutMs: 4000,
                });
                let ordItem: any = null;
                if (ordRes.statusCode === 200) {
                  const ordJson = JSON.parse(ordRes.data);
                  ordItem = ordJson?.result?.list?.[0] || null;
                }
                if (!ordItem || !(Number(ordItem.avgPrice || 0) > 0)) {
                  const hTs = await getBybitTimestamp(baseUrl, false);
                  const hSig = signBybitV5(hTs, cleanKey, recvWindow, qStr, cleanSecret);
                  const histRes = await makeHttpsRequest(`${baseUrl}/v5/order/history?${qStr}`, {
                    method: 'GET',
                    headers: {
                      'X-BAPI-API-KEY': cleanKey,
                      'X-BAPI-TIMESTAMP': hTs,
                      'X-BAPI-SIGN': hSig,
                      'X-BAPI-RECV-WINDOW': recvWindow,
                    },
                    timeoutMs: 4000,
                  });
                  if (histRes.statusCode === 200) {
                    const histJson = JSON.parse(histRes.data);
                    ordItem = histJson?.result?.list?.[0] || ordItem;
                  }
                }
                if (ordItem) {
                  if (Number(ordItem.avgPrice || 0) > 0) {
                    actualAvgPrice = Number(ordItem.avgPrice);
                  }
                  if (Number(ordItem.cumExecQty || 0) > 0) {
                    actualExecQty = Number(ordItem.cumExecQty);
                  }
                  if (Number(ordItem.cumExecFee || 0) > 0) {
                    actualExecFee = Math.abs(Number(ordItem.cumExecFee));
                  } else {
                    actualExecFee = Number((actualAvgPrice * actualExecQty * 0.00055).toFixed(4));
                  }
                  if (Number(ordItem.updatedTime || ordItem.createdTime || 0) > 0) {
                    actualExchangeTime = Number(ordItem.updatedTime || ordItem.createdTime);
                  }
                }
              } catch {
                // fallback to referencePrice if detail lookup times out
              }
            }

            return {
              success: true,
              order_id: orderId,
              symbol,
              side,
              price: actualAvgPrice,
              qty: actualExecQty,
              status: 'FILLED',
              exchange_time: actualExchangeTime,
              commission_usdt: actualExecFee,
              network_label: netLabel,
            };
          }

          lastErrorCode = json.retCode;
          lastErrorMsg = `Bybit V5 [${json.retCode}]: ${json.retMsg}`;
          break;
        } else {
          lastErrorCode = res.statusCode;
          lastErrorMsg = `Bybit HTTP ${res.statusCode}: ${res.data.slice(0, 120)}`;
          if (res.statusCode === 401 || res.statusCode === 403) {
            continue;
          }
        }
      } catch (e: any) {
        lastErrorMsg = `Ошибка связи с Bybit: ${e?.message || 'Сеть недоступна'}`;
      }
    }

    return {
      success: false,
      order_id: '',
      symbol,
      side,
      price: params.referencePrice,
      qty: params.quantity,
      status: 'REJECTED',
      exchange_time: Date.now(),
      error: lastErrorMsg,
      error_code: lastErrorCode,
    };
  }

  // ==========================================================================
  // 3. OKX V5 PERPETUAL SWAP (https://www.okx.com/api/v5/trade/order)
  // ==========================================================================
  if (creds.exchange === 'okx') {
    const cleanPass = String(creds.passphrase || '').trim();
    if (!cleanPass) {
      return {
        success: false,
        order_id: '',
        symbol,
        side,
        price: params.referencePrice,
        qty: params.quantity,
        status: 'REJECTED',
        exchange_time: Date.now(),
        error: 'Для отправки ордера на OKX требуется API Passphrase',
      };
    }
    try {
      const cleanBase = String(params.pair || 'ETH/USDT:USDT').split(':')[0].split('/')[0];
      const instId = `${cleanBase}-USDT-SWAP`;
      const formattedQtyStr = await formatBybitFuturesQuantity(
        symbol,
        params.quantity,
        params.referencePrice,
        isClose
      );
      const isDemo = creds.isTestnet ?? okxDemoCache.get(cleanKey) ?? false;

      const sendOkxOrder = async (withPosSide: boolean, simulatedFlag: boolean) => {
        const isoTimestamp = new Date().toISOString();
        const requestPath = '/api/v5/trade/order';
        const bodyObj: Record<string, any> = {
          instId,
          tdMode: 'cross',
          side: side === 'BUY' ? 'buy' : 'sell',
          ordType: 'market',
          sz: formattedQtyStr,
        };
        if (withPosSide) {
          bodyObj.posSide = params.isShort ? 'short' : 'long';
        } else if (isClose) {
          bodyObj.reduceOnly = true;
        }
        const bodyStr = JSON.stringify(bodyObj);
        const preHash = `${isoTimestamp}POST${requestPath}${bodyStr}`;
        const signature = crypto.createHmac('sha256', cleanSecret).update(preHash).digest('base64');
        const headers: Record<string, string> = {
          'OK-ACCESS-KEY': cleanKey,
          'OK-ACCESS-SIGN': signature,
          'OK-ACCESS-TIMESTAMP': isoTimestamp,
          'OK-ACCESS-PASSPHRASE': cleanPass,
          'Content-Type': 'application/json',
        };
        if (simulatedFlag) {
          headers['x-simulated-trading'] = '1';
        }
        return makeHttpsRequest(`https://www.okx.com${requestPath}`, {
          method: 'POST',
          headers,
          body: bodyStr,
        });
      };

      let res = await sendOkxOrder(false, isDemo);
      if (res.statusCode === 200) {
        let json = JSON.parse(res.data);
        // Если ключ от Demo Trading (50101), повторяем с флагом x-simulated-trading: 1
        if (json.code === '50101' || json.code === '50119') {
          okxDemoCache.set(cleanKey, !isDemo);
          res = await sendOkxOrder(false, !isDemo);
          if (res.statusCode === 200) json = JSON.parse(res.data);
        }
        // Если аккаунт в режиме Long/Short (51000 posSide error), повторяем с posSide
        if (json.code === '51000') {
          res = await sendOkxOrder(true, okxDemoCache.get(cleanKey) ?? isDemo);
          if (res.statusCode === 200) json = JSON.parse(res.data);
        }
        if (json.code === '0') {
          const ordId = String(json.data?.[0]?.ordId || `okx-${Date.now()}`);
          return {
            success: true,
            order_id: ordId,
            symbol,
            side,
            price: params.referencePrice,
            qty: Number(formattedQtyStr),
            status: 'FILLED',
            exchange_time: Date.now(),
            network_label: (okxDemoCache.get(cleanKey) ?? isDemo) ? 'OKX Demo' : 'OKX Mainnet',
          };
        }
        return {
          success: false,
          order_id: '',
          symbol,
          side,
          price: params.referencePrice,
          qty: Number(formattedQtyStr),
          status: 'REJECTED',
          exchange_time: Date.now(),
          error: `OKX V5 [${json.code}]: ${json.data?.[0]?.sMsg || json.msg}`,
          error_code: json.code,
        };
      }
      return {
        success: false,
        order_id: '',
        symbol,
        side,
        price: params.referencePrice,
        qty: params.quantity,
        status: 'REJECTED',
        exchange_time: Date.now(),
        error: `OKX HTTP ${res.statusCode}: ${res.data.slice(0, 120)}`,
      };
    } catch (e: any) {
      return {
        success: false,
        order_id: '',
        symbol,
        side,
        price: params.referencePrice,
        qty: params.quantity,
        status: 'REJECTED',
        exchange_time: Date.now(),
        error: `Ошибка связи с OKX: ${e?.message || 'Сеть недоступна'}`,
      };
    }
  }

  // ==========================================================================
  // 4. BITGET V2 USDT-FUTURES (https://api.bitget.com/api/v2/mix/order/place-order)
  // ==========================================================================
  if (creds.exchange === 'bitget') {
    const cleanPass = String(creds.passphrase || '').trim();
    if (!cleanPass) {
      return {
        success: false,
        order_id: '',
        symbol,
        side,
        price: params.referencePrice,
        qty: params.quantity,
        status: 'REJECTED',
        exchange_time: Date.now(),
        error: 'Для отправки ордера на Bitget требуется API Passphrase',
      };
    }
    try {
      const formattedQtyStr = await formatBinanceFuturesQuantity(
        symbol,
        params.quantity,
        params.referencePrice,
        isClose
      );
      const isDemo = creds.isTestnet ?? bitgetDemoCache.get(cleanKey) ?? false;

      const sendBitgetOrder = async (useTradeSide: boolean, demoFlag: boolean) => {
        const timestamp = Date.now().toString();
        const requestPath = '/api/v2/mix/order/place-order';
        const bodyObj: Record<string, any> = {
          symbol,
          productType: 'USDT-FUTURES',
          marginMode: 'crossed',
          marginCoin: 'USDT',
          size: formattedQtyStr,
          side: useTradeSide
            ? params.isShort
              ? 'sell'
              : 'buy'
            : side === 'BUY'
            ? 'buy'
            : 'sell',
          orderType: 'market',
        };
        if (useTradeSide) {
          bodyObj.tradeSide = isClose ? 'close' : 'open';
        } else if (isClose) {
          bodyObj.reduceOnly = 'YES';
        }
        const bodyStr = JSON.stringify(bodyObj);
        const preHash = `${timestamp}POST${requestPath}${bodyStr}`;
        const signature = crypto.createHmac('sha256', cleanSecret).update(preHash).digest('base64');
        const headers: Record<string, string> = {
          'ACCESS-KEY': cleanKey,
          'ACCESS-SIGN': signature,
          'ACCESS-TIMESTAMP': timestamp,
          'ACCESS-PASSPHRASE': cleanPass,
          'Content-Type': 'application/json',
          locale: 'en-US',
        };
        if (demoFlag) {
          headers.paptrading = '1';
        }
        return makeHttpsRequest(`https://api.bitget.com${requestPath}`, {
          method: 'POST',
          headers,
          body: bodyStr,
        });
      };

      let res = await sendBitgetOrder(true, isDemo);
      if (res.statusCode === 200) {
        let json = JSON.parse(res.data);
        // Если аккаунт Bitget в One-Way Mode (ошибка 40774), повторяем без tradeSide
        if (json.code !== '00000') {
          const retryOneWay = await sendBitgetOrder(false, isDemo);
          if (retryOneWay.statusCode === 200) {
            const retryJson = JSON.parse(retryOneWay.data);
            if (retryJson.code === '00000') {
              json = retryJson;
            }
          }
        }
        if (json.code === '00000') {
          return {
            success: true,
            order_id: String(json.data?.orderId || `bg-${Date.now()}`),
            symbol,
            side,
            price: params.referencePrice,
            qty: Number(formattedQtyStr),
            status: 'FILLED',
            exchange_time: Date.now(),
            network_label: isDemo ? 'Bitget Demo' : 'Bitget Mainnet',
          };
        }
        return {
          success: false,
          order_id: '',
          symbol,
          side,
          price: params.referencePrice,
          qty: Number(formattedQtyStr),
          status: 'REJECTED',
          exchange_time: Date.now(),
          error: `Bitget V2 [${json.code}]: ${json.msg}`,
          error_code: json.code,
        };
      }
      return {
        success: false,
        order_id: '',
        symbol,
        side,
        price: params.referencePrice,
        qty: params.quantity,
        status: 'REJECTED',
        exchange_time: Date.now(),
        error: `Bitget HTTP ${res.statusCode}: ${res.data.slice(0, 120)}`,
      };
    } catch (e: any) {
      return {
        success: false,
        order_id: '',
        symbol,
        side,
        price: params.referencePrice,
        qty: params.quantity,
        status: 'REJECTED',
        exchange_time: Date.now(),
        error: `Ошибка связи с Bitget: ${e?.message || 'Сеть недоступна'}`,
      };
    }
  }

  // ==========================================================================
  // 5. BINGX PERPETUAL SWAP V2 (https://open-api.bingx.com/openApi/swap/v2/trade/order)
  // ==========================================================================
  if (creds.exchange === 'bingx') {
    try {
      const cleanBase = String(params.pair || 'ETH/USDT:USDT').split(':')[0].split('/')[0];
      const bingxSymbol = `${cleanBase}-USDT`;
      const formattedQtyStr = await formatBinanceFuturesQuantity(
        symbol,
        params.quantity,
        params.referencePrice,
        isClose
      );

      const sendBingxOrder = async (positionSide: 'BOTH' | 'LONG' | 'SHORT') => {
        const timestamp = Date.now();
        const qp = new URLSearchParams({
          symbol: bingxSymbol,
          side,
          positionSide,
          type: 'MARKET',
          quantity: formattedQtyStr,
          timestamp: String(timestamp),
        });
        if (isClose && positionSide === 'BOTH') qp.set('reduceOnly', 'true');
        const query = qp.toString();
        const sig = crypto.createHmac('sha256', cleanSecret).update(query).digest('hex');
        return makeHttpsRequest(
          `https://open-api.bingx.com/openApi/swap/v2/trade/order?${query}&signature=${sig}`,
          {
            method: 'POST',
            headers: {
              'X-BX-APIKEY': cleanKey,
              'Content-Type': 'application/json',
            },
          }
        );
      };

      let res = await sendBingxOrder('BOTH');
      if (res.statusCode === 200) {
        let json = JSON.parse(res.data);
        // Если на BingX включен Hedge Mode, повторяем с LONG / SHORT
        if (json.code !== 0) {
          const hedgeSide: 'LONG' | 'SHORT' = params.isShort ? 'SHORT' : 'LONG';
          const retryRes = await sendBingxOrder(hedgeSide);
          if (retryRes.statusCode === 200) {
            const retryJson = JSON.parse(retryRes.data);
            if (retryJson.code === 0) {
              json = retryJson;
            }
          }
        }
        if (json.code === 0) {
          return {
            success: true,
            order_id: String(json.data?.order?.orderId || `bx-${Date.now()}`),
            symbol,
            side,
            price: params.referencePrice,
            qty: Number(formattedQtyStr),
            status: 'FILLED',
            exchange_time: Date.now(),
            network_label: 'BingX Swap V2',
          };
        }
        return {
          success: false,
          order_id: '',
          symbol,
          side,
          price: params.referencePrice,
          qty: Number(formattedQtyStr),
          status: 'REJECTED',
          exchange_time: Date.now(),
          error: `BingX [${json.code}]: ${json.msg}`,
          error_code: json.code,
        };
      }
      return {
        success: false,
        order_id: '',
        symbol,
        side,
        price: params.referencePrice,
        qty: params.quantity,
        status: 'REJECTED',
        exchange_time: Date.now(),
        error: `BingX HTTP ${res.statusCode}: ${res.data.slice(0, 120)}`,
      };
    } catch (e: any) {
      return {
        success: false,
        order_id: '',
        symbol,
        side,
        price: params.referencePrice,
        qty: params.quantity,
        status: 'REJECTED',
        exchange_time: Date.now(),
        error: `Ошибка связи с BingX: ${e?.message || 'Сеть недоступна'}`,
      };
    }
  }

  return {
    success: false,
    order_id: '',
    symbol,
    side: params.isShort ? 'SELL' : 'BUY',
    price: params.referencePrice,
    qty: params.quantity,
    status: 'REJECTED',
    exchange_time: Date.now(),
    error: `Биржа ${String(creds.exchange || '').toUpperCase()} не поддерживается для отправки реальных фьючерсных ордеров`,
  };
}

/**
 * Тестирует реальное подключение к бирже с проверкой API-ключа, подписи, баланса и прав на фьючерсную торговлю.
 * Автоматически определяет Mainnet / Testnet / Demo Trading для Bybit, Binance, OKX и Bitget.
 */
export async function testExchangeConnection(
  creds: ExchangeCredentials,
  _disableCrossExchangeProbe = false
): Promise<ConnectionTestResult> {
  const cleanKey = sanitizeCredentialString(creds.apiKey);
  const cleanSecret = sanitizeCredentialString(creds.apiSecret);

  if (!cleanKey || !cleanSecret) {
    return {
      success: false,
      exchange: creds.exchange,
      message: 'API Key и Secret Key не могут быть пустыми',
      latency_ms: 0,
      can_trade: false,
    };
  }

  // ==========================================================================
  // 1. BINANCE USDT-M FUTURES (WebSocket API wss://ws-fapi.binance.com/ws-fapi/v1 + User Data Stream + REST fallback)
  // ==========================================================================
  if (creds.exchange === 'binance') {
    // 1A. Если у нас уже есть живое WebSocket-состояние аккаунта (открытый User Data Stream + свежий REST bootstrap), отдаём его мгновенно!
    const liveWsState = getWsAccountLiveState(cleanKey, 90_000);
    if (
      liveWsState &&
      liveWsState.exchange === 'binance' &&
      liveWsState.wsConnected &&
      isPrivateWsStreamOpen('binance', cleanKey) &&
      Date.now() - liveWsState.lastRestBootstrapAt < 90_000
    ) {
      const statusMsg = `Успешно подключено к ${liveWsState.networkLabel} [WebSocket Live] (Пинг: 1 мс | Баланс: ${liveWsState.walletBalanceUsdt.toFixed(2)} USDT | Плавающий PnL: ${liveWsState.unrealizedPnlUsdt >= 0 ? '+' : ''}${liveWsState.unrealizedPnlUsdt.toFixed(2)} USDT | Доступно: ${liveWsState.availableBalanceUsdt.toFixed(2)} USDT | Открытых позиций: ${liveWsState.positions.length})`;
      return {
        success: true,
        exchange: 'binance',
        message: statusMsg,
        latency_ms: 1,
        balance_usdt: liveWsState.walletBalanceUsdt,
        wallet_balance_usdt: liveWsState.walletBalanceUsdt,
        unrealized_pnl_usdt: liveWsState.unrealizedPnlUsdt,
        equity_usdt: liveWsState.equityUsdt,
        available_balance_usdt: liveWsState.availableBalanceUsdt,
        used_margin_usdt: liveWsState.usedMarginUsdt,
        can_trade: liveWsState.canTrade,
        dual_side_position: liveWsState.dualSidePosition,
        open_positions_count: liveWsState.positions.length,
        account_type: `${liveWsState.networkLabel} (WS)`,
        is_testnet: liveWsState.isTestnet,
        network_label: liveWsState.networkLabel,
      };
    }

    const candidateHosts = getBinanceCandidateHosts(cleanKey, creds.isTestnet);
    let primaryErrorRes: ConnectionTestResult | null = null;
    let lastErrorRes: ConnectionTestResult | null = null;

    for (const baseUrl of candidateHosts) {
      try {
        // 1B. Сначала запрашиваем статус счёта и позиции через Binance Futures WebSocket API (wss://ws-fapi.binance.com/ws-fapi/v1),
        // который НЕ блокируется баном IP -1003 на REST fapi.binance.com!
        const wsRpc = getBinanceWsRpcClient(baseUrl);
        const wsTs = await getBinanceTimestamp(false, baseUrl);
        let wsAccRes = await wsRpc.request(
          'v2/account.status',
          { apiKey: cleanKey, timestamp: wsTs, recvWindow: 10000 },
          cleanSecret,
          5500
        );
        if (wsAccRes.status !== 200 && wsAccRes.error?.code === -1021) {
          const retryWsTs = await getBinanceTimestamp(true, baseUrl);
          wsAccRes = await wsRpc.request(
            'v2/account.status',
            { apiKey: cleanKey, timestamp: retryWsTs, recvWindow: 15000 },
            cleanSecret,
            5500
          );
        }

        let res: { statusCode: number; data: string; latencyMs: number } | null = null;
        if (wsAccRes.status === 200 && wsAccRes.result) {
          res = {
            statusCode: 200,
            data: JSON.stringify(wsAccRes.result),
            latencyMs: wsAccRes.latencyMs,
          };
        } else if (wsAccRes.error && wsAccRes.status !== 503 && wsAccRes.status !== 408) {
          res = {
            statusCode: wsAccRes.status,
            data: JSON.stringify(wsAccRes.error),
            latencyMs: wsAccRes.latencyMs,
          };
        } else {
          // Резервный REST-запрос только если WebSocket порт недоступен
          const rateLimit = isBinanceHostRateLimited(baseUrl);
          if (rateLimit.limited) {
            const cachedHost = binanceHostCache.get(cleanKey);
            const lastGood = binanceLastGoodConnCache.get(cleanKey);
            if (lastGood && (!cachedHost || cachedHost === baseUrl)) {
              return {
                ...lastGood.result,
                latency_ms: 1,
              };
            }
            const remainSec = Math.max(1, Math.ceil((rateLimit.untilMs - Date.now()) / 1000));
            const banErr: ConnectionTestResult = {
              success: false,
              exchange: 'binance',
              message: `Binance [-1003]: Пауза анти-спама IP на ${
                baseUrl.includes('testnet') ? 'Testnet' : 'Mainnet'
              } (осталось ~${remainSec} сек до авто-разблокировки)`,
              latency_ms: 0,
              can_trade: false,
              error_code: -1003,
              is_testnet: baseUrl.includes('testnet'),
            };
            if (!lastErrorRes) lastErrorRes = banErr;
            continue;
          }

          const timestamp = await getBinanceTimestamp(false, baseUrl);
          const recvWindow = 10000;
          const query = `timestamp=${timestamp}&recvWindow=${recvWindow}`;
          const signature = signBinanceFuturesQuery(query, cleanSecret);
          const url = `${baseUrl}/fapi/v2/account?${query}&signature=${signature}`;

          res = await makeHttpsRequest(url, {
            method: 'GET',
            headers: {
              'X-MBX-APIKEY': cleanKey,
              'Content-Type': 'application/json',
            },
          });

          if (res.statusCode !== 200 && res.data.includes('-1021')) {
            const retryTs = await getBinanceTimestamp(true, baseUrl);
            const retryQuery = `timestamp=${retryTs}&recvWindow=15000`;
            const retrySig = signBinanceFuturesQuery(retryQuery, cleanSecret);
            const retryRes = await makeHttpsRequest(
              `${baseUrl}/fapi/v2/account?${retryQuery}&signature=${retrySig}`,
              {
                method: 'GET',
                headers: {
                  'X-MBX-APIKEY': cleanKey,
                  'Content-Type': 'application/json',
                },
              }
            );
            if (retryRes.statusCode === 200) {
              res.statusCode = 200;
              res.data = retryRes.data;
              res.latencyMs = retryRes.latencyMs;
            }
          }
        }

        if (res.statusCode === 200) {
          binanceHostCache.set(cleanKey, baseUrl);
          const isTestnetHost = baseUrl.includes('testnet');
          const netLabel = isTestnetHost ? 'Binance Futures Testnet' : 'Binance USDⓈ-M Mainnet';
          const json = JSON.parse(res.data);
          const stableAssets = Array.isArray(json.assets)
            ? json.assets.filter((a: any) => a.asset === 'USDT' || a.asset === 'USDC')
            : [];
          const usdtAsset = stableAssets.find((a: any) => a.asset === 'USDT') || stableAssets[0];
          const walletBalance =
            Number(json.totalWalletBalance || 0) > 0
              ? Number(json.totalWalletBalance)
              : stableAssets.reduce((s: number, a: any) => s + Number(a.walletBalance || 0), 0);
          const unrealizedPnl =
            stableAssets.length > 0
              ? stableAssets.reduce((s: number, a: any) => s + Number(a.unrealizedProfit || 0), 0)
              : Number(json.totalUnrealizedProfit || 0);
          const marginBalance =
            Number(json.totalMarginBalance || 0) > 0
              ? Number(json.totalMarginBalance)
              : walletBalance + unrealizedPnl;
          const availableBalance =
            Number(json.availableBalance || 0) > 0
              ? Number(json.availableBalance)
              : stableAssets.reduce((s: number, a: any) => s + Number(a.availableBalance || 0), 0) || walletBalance;
          let usedMargin =
            Number(json.totalInitialMargin || 0) > 0
              ? Number(json.totalInitialMargin)
              : stableAssets.reduce((s: number, a: any) => s + Number(a.initialMargin || 0), 0);

          // Кэшируем открытые позиции (USDT и USDC) прямо из /fapi/v2/account / v2/account.status
          const parsedPositions: ExchangePositionItem[] = [];
          if (Array.isArray(json.positions)) {
            for (const p of json.positions) {
              const rawAmt = Number(p.positionAmt || 0);
              const size = Math.abs(rawAmt);
              if (!(size > 0)) continue;
              const sym = String(p.symbol || '').toUpperCase();
              if (!isSupportedFuturesSymbol(sym)) continue;
              const liveTick = getLiveWsTicker(sym, 'binance');
              const entryPrice = Number(
                p.entryPrice || p.markPrice || p.breakEvenPrice || liveTick?.markPrice || liveTick?.price || 0
              );
              if (!(entryPrice > 0)) continue;
              const markPrice = Number(p.markPrice || liveTick?.markPrice || liveTick?.price || entryPrice);
              const lev = Math.max(1, Math.round(Number(p.leverage || 25)));
              const posSide = String(p.positionSide || '').toUpperCase();
              const isShort = posSide === 'SHORT' || rawAmt < 0;
              const notional = size * entryPrice;
              const initMargin = Number(
                p.initialMargin || p.positionInitialMargin || p.isolatedMargin || p.isolatedWallet || 0
              );
              const marginUsdt =
                initMargin > 0 ? Number(initMargin.toFixed(2)) : Number((notional / lev).toFixed(2));
              const uTime = Number(p.updateTime || Date.now());
              parsedPositions.push({
                pair: symbolToFreqtradePair(sym),
                symbol: sym,
                is_short: isShort,
                size,
                entry_price: entryPrice,
                mark_price: markPrice > 0 ? markPrice : entryPrice,
                leverage: lev,
                margin_usdt: marginUsdt,
                unrealized_pnl: Number(p.unrealizedProfit ?? p.unRealizedProfit ?? 0),
                created_time: uTime,
                updated_time: uTime,
              });
            }
          }
          const posMarginSum = Number(
            parsedPositions.reduce((s, p) => s + Number(p.margin_usdt || 0), 0).toFixed(2)
          );
          if (usedMargin <= 0 && posMarginSum > 0) {
            usedMargin = posMarginSum;
          }
          const effectiveAvailableBalance =
            availableBalance > 0 && usedMargin === 0
              ? availableBalance
              : usdtAsset && Number(usdtAsset.availableBalance || 0) > 0
              ? availableBalance
              : Math.max(0, walletBalance - usedMargin);

          const hasPositionsArray = Array.isArray(json.positions);
          if (hasPositionsArray) {
            binancePositionsCache.set(cleanKey, {
              timestamp: Date.now(),
              positions: parsedPositions,
              network_label: netLabel,
              is_testnet: isTestnetHost,
            });
          }

          const openPositions = parsedPositions.length;
          // Определяем Hedge Mode прямо из позиций в ответе v2/account (если есть LONG/SHORT positionSide), чтобы не делать лишний REST запрос!
          const inferredDualSide = hasPositionsArray
            ? json.positions.some((p: any) => {
                const ps = String(p.positionSide || '').toUpperCase();
                return ps === 'LONG' || ps === 'SHORT';
              })
            : false;
          const cachedDual = binanceDualSideCache.get(cleanKey);
          const dualSide = cachedDual ? cachedDual.dualSide : inferredDualSide;
          if (!cachedDual) {
            binanceDualSideCache.set(cleanKey, { dualSide, updatedAt: Date.now() });
          }
          const canTrade = Boolean(json.canTrade);

          // Сохраняем состояние в WebSocket-движок и запускаем постоянный User Data Stream (listenKey WS)
          const existingWsState = getWsAccountLiveState(cleanKey, 86_400_000);
          setWsAccountLiveState({
            apiKey: cleanKey,
            exchange: 'binance',
            isTestnet: isTestnetHost,
            networkLabel: netLabel,
            walletBalanceUsdt: walletBalance,
            unrealizedPnlUsdt: unrealizedPnl,
            equityUsdt: marginBalance,
            availableBalanceUsdt: effectiveAvailableBalance,
            usedMarginUsdt: Number(usedMargin.toFixed(2)),
            canTrade,
            dualSidePosition: dualSide,
            positions: hasPositionsArray ? parsedPositions : existingWsState?.positions || [],
            closedPnl: existingWsState?.closedPnl || [],
            wsConnected: isPrivateWsStreamOpen('binance', cleanKey),
            positionsSynced: hasPositionsArray || Boolean(existingWsState?.positionsSynced),
            updatedAt: Date.now(),
            lastRestBootstrapAt: hasPositionsArray ? Date.now() : existingWsState?.lastRestBootstrapAt || 0,
          });
          ensureBinancePrivateUserStream(cleanKey, cleanSecret, baseUrl).catch(() => {});

          let statusMsg = `Успешно подключено к ${netLabel} [WebSocket] (Пинг: ${res.latencyMs} мс | Баланс: ${walletBalance.toFixed(2)} USDT | Плавающий PnL: ${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2)} USDT | Доступно: ${availableBalance.toFixed(2)} USDT | Режим: ${dualSide ? 'Hedge Mode' : 'One-Way'} | Открытых позиций: ${openPositions})`;
          if (walletBalance <= 0) {
            statusMsg +=
              ' ⚠️ На фьючерсном кошельке USDⓈ-M сейчас 0 USDT! Переведите USDT со Спотового кошелька на Фьючерсный (USDⓈ-M Futures).';
          }

          const successResult: ConnectionTestResult = {
            success: true,
            exchange: 'binance',
            message: statusMsg,
            latency_ms: res.latencyMs,
            balance_usdt: walletBalance,
            wallet_balance_usdt: walletBalance,
            unrealized_pnl_usdt: unrealizedPnl,
            equity_usdt: marginBalance,
            available_balance_usdt: availableBalance,
            used_margin_usdt: usedMargin,
            can_trade: canTrade,
            dual_side_position: dualSide,
            open_positions_count: openPositions,
            account_type: netLabel,
            is_testnet: isTestnetHost,
            network_label: netLabel,
          };
          binanceLastGoodConnCache.set(cleanKey, {
            result: successResult,
            updatedAt: Date.now(),
          });
          return successResult;
        }

        const formattedErr = formatBinanceApiError(res.statusCode, res.data);
        const errObj: ConnectionTestResult = {
          success: false,
          exchange: 'binance',
          message: formattedErr.message,
          latency_ms: res.latencyMs,
          can_trade: false,
          error_code: formattedErr.code,
          is_testnet: baseUrl.includes('testnet'),
        };
        if (formattedErr.code !== -1003 && !primaryErrorRes) {
          primaryErrorRes = errObj;
        }
        lastErrorRes = errObj;
        // Всегда пробуем второй хост (например, Testnet, если Mainnet вернул -1003 или -2015)
        if (
          formattedErr.code === -2015 ||
          formattedErr.code === -2014 ||
          formattedErr.code === -1003 ||
          res.statusCode === 418 ||
          res.statusCode === 429
        ) {
          continue;
        }
        break;
      } catch (e: any) {
        lastErrorRes = {
          success: false,
          exchange: 'binance',
          message: `Ошибка связи с Binance: ${e?.message || 'Сеть недоступна'}`,
          latency_ms: 0,
          can_trade: false,
        };
      }
    }

    // Если все хосты вернули -1003, но у нас есть последний успешный снимок баланса — возвращаем его без сбоя
    const cachedGood = binanceLastGoodConnCache.get(cleanKey);
    if (cachedGood && (lastErrorRes?.error_code === -1003 || primaryErrorRes?.error_code === -1003)) {
      return {
        ...cachedGood.result,
        latency_ms: 1,
      };
    }

    // Авто-определение: если пользователь случайно оставил выбранным Binance, но вставил ключ от Bybit (18-36 символов)
    if (
      !_disableCrossExchangeProbe &&
      !creds.passphrase &&
      cleanKey.length >= 16 &&
      cleanKey.length <= 40
    ) {
      const bybitProbe = await testExchangeConnection(
        { ...creds, exchange: 'bybit' },
        true
      );
      if (bybitProbe.success) {
        return bybitProbe;
      }
    }

    return (
      primaryErrorRes ||
      lastErrorRes || {
        success: false,
        exchange: 'binance',
        message: 'Не удалось подключиться к Binance Futures',
        latency_ms: 0,
        can_trade: false,
      }
    );
  }

  // ==========================================================================
  // 2. BYBIT V5 (Private WebSocket wss://stream.bybit.com/v5/private + Mainnet/Testnet/Demo REST bootstrap)
  // ==========================================================================
  if (creds.exchange === 'bybit') {
    const liveBybitWs = getWsAccountLiveState(cleanKey, 90_000);
    if (
      liveBybitWs &&
      liveBybitWs.exchange === 'bybit' &&
      liveBybitWs.wsConnected &&
      isPrivateWsStreamOpen('bybit', cleanKey) &&
      Date.now() - liveBybitWs.lastRestBootstrapAt < 90_000
    ) {
      const msg = `Успешно подключено к ${liveBybitWs.networkLabel} [WebSocket Live] (Пинг: 1 мс | Баланс: ${liveBybitWs.walletBalanceUsdt.toFixed(2)} USDT | Плавающий PnL: ${liveBybitWs.unrealizedPnlUsdt >= 0 ? '+' : ''}${liveBybitWs.unrealizedPnlUsdt.toFixed(2)} USDT | Открытых позиций: ${liveBybitWs.positions.length})`;
      return {
        success: true,
        exchange: 'bybit',
        message: msg,
        latency_ms: 1,
        balance_usdt: liveBybitWs.walletBalanceUsdt,
        wallet_balance_usdt: liveBybitWs.walletBalanceUsdt,
        unrealized_pnl_usdt: liveBybitWs.unrealizedPnlUsdt,
        equity_usdt: liveBybitWs.equityUsdt,
        available_balance_usdt: liveBybitWs.availableBalanceUsdt,
        used_margin_usdt: liveBybitWs.usedMarginUsdt,
        can_trade: true,
        open_positions_count: liveBybitWs.positions.length,
        account_type: `${liveBybitWs.networkLabel} (WS)`,
        is_testnet: liveBybitWs.isTestnet,
        network_label: liveBybitWs.networkLabel,
      };
    }

    // Если пользователь вставил 64-символьный ключ Binance, забыв переключить вкладку с Bybit на Binance —
    // сначала быстро проверим Bybit, а при отказе автоматически проверим Binance!
    const candidateHosts = getBybitCandidateHosts(cleanKey, creds.isTestnet);
    let specificApiErrorRes: ConnectionTestResult | null = null;
    let lastErrorRes: ConnectionTestResult | null = null;
    const checkedHostLabels: string[] = [];

    const queryBybitEndpoint = async (
      baseUrl: string,
      pathWithQuery: string,
      forceTimeSync = false
    ) => {
      const [pathname, queryString = ''] = pathWithQuery.split('?');
      const timestamp = await getBybitTimestamp(baseUrl, forceTimeSync);
      const recvWindow = '15000';
      const signature = signBybitV5(timestamp, cleanKey, recvWindow, queryString, cleanSecret);
      return makeHttpsRequest(`${baseUrl}${pathname}${queryString ? `?${queryString}` : ''}`, {
        method: 'GET',
        headers: {
          'X-BAPI-API-KEY': cleanKey,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-SIGN': signature,
          'X-BAPI-RECV-WINDOW': recvWindow,
          'Content-Type': 'application/json',
        },
      });
    };

    for (const baseUrl of candidateHosts) {
      try {
        const netLabel = baseUrl.includes('testnet')
          ? 'Bybit Testnet'
          : baseUrl.includes('demo')
          ? 'Bybit Demo Trading'
          : 'Bybit Mainnet';
        checkedHostLabels.push(netLabel);
        const isTestnetHost = baseUrl !== 'https://api.bybit.com';

        let res = await queryBybitEndpoint(
          baseUrl,
          '/v5/account/wallet-balance?accountType=UNIFIED',
          false
        );

        if (res.statusCode === 200) {
          let json = JSON.parse(res.data);

          // Если рассинхрон времени (retCode 10002), синхронизируем часы и повторяем
          if (json.retCode === 10002) {
            res = await queryBybitEndpoint(
              baseUrl,
              '/v5/account/wallet-balance?accountType=UNIFIED',
              true
            );
            if (res.statusCode === 200) {
              json = JSON.parse(res.data);
            }
          }

          // Если ключ не подходит к этому окружению (retCode 10003 / 10004 / 33004) — запоминаем детальную ошибку и проверяем остальные хосты
          if (json.retCode === 10003 || json.retCode === 10004 || json.retCode === 33004) {
            const errObj: ConnectionTestResult = {
              success: false,
              exchange: 'bybit',
              message:
                json.retCode === 10004
                  ? `${netLabel}: Неверный Secret Key (ошибка подписи HMAC, код 10004)`
                  : `${netLabel}: Неверный API Key или истек срок действия (${json.retMsg}, код ${json.retCode})`,
              latency_ms: res.latencyMs,
              can_trade: false,
              error_code: json.retCode,
              is_testnet: isTestnetHost,
              network_label: netLabel,
            };
            // Ошибка 10004 означает, что сам API Key найден именно на этом хосте, но Secret Key не подошел!
            if (json.retCode === 10004 || !specificApiErrorRes) {
              specificApiErrorRes = errObj;
            }
            lastErrorRes = errObj;
            continue;
          }

          let resolvedBalance = 0;
          let resolvedEquity = 0;
          let resolvedUnrealizedPnl = 0;
          let resolvedAvailable = 0;
          let resolvedUsedMargin = 0;
          let walletTypeLabel = 'Unified Trading (UTA)';

          const extractBybitWalletBalance = (
            payload: any
          ): {
            walletBal: number;
            equity: number;
            unrealizedPnl: number;
            avail: number;
            usedMargin: number;
          } => {
            const acc = payload?.result?.list?.[0];
            if (!acc) {
              return { walletBal: 0, equity: 0, unrealizedPnl: 0, avail: 0, usedMargin: 0 };
            }
            const coins = Array.isArray(acc.coin) ? acc.coin : [];
            const stableCoins = coins.filter((c: any) => c.coin === 'USDT' || c.coin === 'USDC');
            const usdt = coins.find((c: any) => c.coin === 'USDT');
            const sumStableWallet = stableCoins.reduce((s: number, c: any) => s + Number(c.walletBalance || 0), 0);
            const sumStableUpl = stableCoins.reduce((s: number, c: any) => s + Number(c.unrealisedPnl || 0), 0);
            const sumStableIm = stableCoins.reduce((s: number, c: any) => s + Number(c.totalPositionIM || 0), 0);
            const usdtWallet = Number(
              acc.totalWalletBalance || sumStableWallet || usdt?.walletBalance || usdt?.equity || acc.totalEquity || 0
            );
            const usdtUnrealized = Number(
              acc.totalPerpUPL ?? (stableCoins.length > 0 ? sumStableUpl : 0)
            );
            const usdtEquity = Number(
              acc.totalEquity || usdt?.equity || usdtWallet + usdtUnrealized
            );
            const usdtUsedMargin = Number(
              acc.totalInitialMargin || sumStableIm || usdt?.totalPositionIM || 0
            );
            const usdtAvail = Number(
              acc.totalAvailableBalance ||
                usdt?.availableToWithdraw ||
                Math.max(0, usdtWallet - usdtUsedMargin)
            );
            return {
              walletBal: Number.isFinite(usdtWallet) ? usdtWallet : 0,
              equity: Number.isFinite(usdtEquity) ? usdtEquity : 0,
              unrealizedPnl: Number.isFinite(usdtUnrealized) ? usdtUnrealized : 0,
              avail: Number.isFinite(usdtAvail) && usdtAvail >= 0 ? usdtAvail : Math.max(0, usdtWallet - usdtUsedMargin),
              usedMargin: Number.isFinite(usdtUsedMargin) ? usdtUsedMargin : 0,
            };
          };

          if (json.retCode === 0) {
            const extracted = extractBybitWalletBalance(json);
            resolvedBalance = extracted.walletBal;
            resolvedEquity = extracted.equity;
            resolvedUnrealizedPnl = extracted.unrealizedPnl;
            resolvedAvailable = extracted.avail;
            resolvedUsedMargin = extracted.usedMargin;
          }

          // Если на UNIFIED балансе 0 или аккаунт классический (CONTRACT), проверяем также accountType=CONTRACT
          if (resolvedBalance <= 0) {
            try {
              const contractRes = await queryBybitEndpoint(
                baseUrl,
                '/v5/account/wallet-balance?accountType=CONTRACT',
                false
              );
              if (contractRes.statusCode === 200) {
                const contractJson = JSON.parse(contractRes.data);
                if (contractJson.retCode === 0) {
                  const extractedContract = extractBybitWalletBalance(contractJson);
                  if (extractedContract.walletBal > resolvedBalance) {
                    resolvedBalance = extractedContract.walletBal;
                    resolvedEquity = extractedContract.equity;
                    resolvedUnrealizedPnl = extractedContract.unrealizedPnl;
                    resolvedAvailable = extractedContract.avail;
                    resolvedUsedMargin = extractedContract.usedMargin;
                    walletTypeLabel = 'Contract (Derivatives)';
                  }
                }
              }
            } catch {
              // ignore CONTRACT fallback error
            }
          }

          // Если всё ещё 0 и json.retCode === 0, проверяем также Funding кошелёк (FUND), чтобы подсказать пользователю или учесть баланс
          let fundBalance = 0;
          if (resolvedBalance <= 0 && json.retCode === 0) {
            try {
              const fundRes = await queryBybitEndpoint(
                baseUrl,
                '/v5/asset/transfer/query-account-coins-balance?accountType=FUND&coin=USDT',
                false
              );
              if (fundRes.statusCode === 200) {
                const fundJson = JSON.parse(fundRes.data);
                const fundCoin = fundJson?.result?.balance?.find((c: any) => c.coin === 'USDT');
                fundBalance = Number(fundCoin?.walletBalance || fundCoin?.transferBalance || 0);
              }
            } catch {
              // ignore FUND query error
            }
          }

          if (json.retCode === 0 || resolvedBalance > 0) {
            bybitHostCache.set(cleanKey, baseUrl);

            // Запрашиваем ВСЕ открытые линейные позиции на Bybit с пагинацией по USDT и USDC
            const parsedBybitPositions: ExchangePositionItem[] = [];
            const seenBybitPos = new Set<string>();
            let posUnrealizedSum = 0;
            let posMarginSum = 0;
            let bybitPosFetchOk = false;
            try {
              for (const settleCoin of ['USDT', 'USDC']) {
                let cursor = '';
                for (let page = 0; page < 5; page++) {
                  const qs = `category=linear&settleCoin=${settleCoin}&limit=200${
                    cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
                  }`;
                  let posRes = await queryBybitEndpoint(baseUrl, `/v5/position/list?${qs}`, false);
                  if (posRes.statusCode !== 200) break;
                  let posJson = JSON.parse(posRes.data);
                  if (posJson.retCode === 10002) {
                    posRes = await queryBybitEndpoint(baseUrl, `/v5/position/list?${qs}`, true);
                    if (posRes.statusCode !== 200) break;
                    posJson = JSON.parse(posRes.data);
                  }
                  if (posJson.retCode !== 0 || !Array.isArray(posJson.result?.list)) break;
                  bybitPosFetchOk = true;
                  for (const p of posJson.result.list) {
                    const size = Math.abs(Number(p.size || 0));
                    if (!(size > 0)) continue;
                    const sym = String(p.symbol || '').toUpperCase();
                    if (!isSupportedFuturesSymbol(sym)) continue;
                    const liveTick = getLiveWsTicker(sym, 'bybit');
                    const entryPrice = Number(
                      p.avgPrice || p.entryPrice || p.markPrice || liveTick?.markPrice || liveTick?.price || 0
                    );
                    if (!(entryPrice > 0)) continue;
                    const markPrice = Number(p.markPrice || liveTick?.markPrice || entryPrice);
                    const lev = Math.max(1, Math.round(Number(p.leverage || 25)));
                    const sideStr = String(p.side || '').toLowerCase();
                    const isShort = sideStr === 'sell' || Number(p.positionIdx) === 2;
                    const posKey = `${sym}:${isShort ? 'S' : 'L'}`;
                    if (seenBybitPos.has(posKey)) continue;
                    seenBybitPos.add(posKey);
                    const notional = size * entryPrice;
                    const rawIm = Number(p.positionIM || p.positionBalance || 0);
                    const marginUsdt =
                      rawIm > 0 ? Number(rawIm.toFixed(2)) : Number((notional / lev).toFixed(2));
                    const unreal = Number(p.unrealisedPnl || 0);
                    posUnrealizedSum += unreal;
                    posMarginSum += marginUsdt;
                    const tp = Number(p.takeProfit || 0);
                    const sl = Number(p.stopLoss || 0);
                    const cTime = Number(p.createdTime || p.updatedTime || Date.now());
                    const uTime = Number(p.updatedTime || cTime);
                    const posItem: ExchangePositionItem = {
                      pair: symbolToFreqtradePair(sym),
                      symbol: sym,
                      is_short: isShort,
                      size,
                      entry_price: entryPrice,
                      mark_price: markPrice > 0 ? markPrice : entryPrice,
                      leverage: lev,
                      margin_usdt: marginUsdt,
                      unrealized_pnl: unreal,
                      take_profit: tp > 0 ? tp : undefined,
                      stop_loss: sl > 0 ? sl : undefined,
                      created_time: cTime,
                      updated_time: uTime,
                    };
                    parsedBybitPositions.push(posItem);
                    subscribePairKlineStream(posItem.pair, '1h');
                  }
                  const nextCursor = String(posJson.result?.nextPageCursor || '').trim();
                  if (!nextCursor) break;
                  cursor = nextCursor;
                }
              }
            } catch {
              // ignore
            }
            const openPositions = parsedBybitPositions.length;

            if (openPositions > 0 && Math.abs(posUnrealizedSum) > 0) {
              resolvedUnrealizedPnl = posUnrealizedSum;
              resolvedEquity = resolvedBalance + resolvedUnrealizedPnl;
            }
            if (openPositions > 0 && posMarginSum > 0 && resolvedUsedMargin <= 0) {
              resolvedUsedMargin = posMarginSum;
            }

            const finalWalletBal = resolvedBalance > 0 ? resolvedBalance : fundBalance;
            const finalEquity =
              resolvedEquity > 0 ? resolvedEquity : finalWalletBal + resolvedUnrealizedPnl;
            const finalAvail =
              resolvedAvailable > 0
                ? resolvedAvailable
                : Math.max(0, finalWalletBal - resolvedUsedMargin);

            // Сохраняем ПОЛНЫЙ снимок позиций и маржи Bybit в WebSocket-движок только если список позиций реально получен
            const prevBybitWs = getWsAccountLiveState(cleanKey, 86_400_000);
            setWsAccountLiveState({
              apiKey: cleanKey,
              exchange: 'bybit',
              isTestnet: isTestnetHost,
              networkLabel: netLabel,
              walletBalanceUsdt: finalWalletBal,
              unrealizedPnlUsdt: resolvedUnrealizedPnl,
              equityUsdt: finalEquity,
              availableBalanceUsdt: Number(finalAvail.toFixed(2)),
              usedMarginUsdt: Number(resolvedUsedMargin.toFixed(2)),
              canTrade: true,
              positions: bybitPosFetchOk ? parsedBybitPositions : prevBybitWs?.positions || [],
              closedPnl: prevBybitWs?.closedPnl || [],
              wsConnected: isPrivateWsStreamOpen('bybit', cleanKey),
              positionsSynced: bybitPosFetchOk || Boolean(prevBybitWs?.positionsSynced),
              updatedAt: Date.now(),
              lastRestBootstrapAt: bybitPosFetchOk ? Date.now() : prevBybitWs?.lastRestBootstrapAt || 0,
            });
            ensureBybitPrivateUserStream(cleanKey, cleanSecret, baseUrl);

            let msg = `Успешно подключено к ${netLabel} [${walletTypeLabel} + WebSocket] (Пинг: ${res.latencyMs} мс | Баланс: ${finalWalletBal.toFixed(2)} USDT | Плавающий PnL: ${resolvedUnrealizedPnl >= 0 ? '+' : ''}${resolvedUnrealizedPnl.toFixed(2)} USDT | Открытых позиций: ${openPositions})`;
            if (resolvedBalance <= 0 && fundBalance > 0) {
              msg += ` ⚠️ На торговом кошельке 0 USDT, но на кошельке Финансирования (Funding) найдено ${fundBalance.toFixed(2)} USDT — переведите их на Unified Trading (Единый торговый аккаунт) в Bybit!`;
            } else if (resolvedBalance <= 0) {
              msg += ` ⚠️ На торговом счете ${netLabel} сейчас 0 USDT. Получите тестовые USDT на Unified Trading / Contract кошелёк!`;
            }

            return {
              success: true,
              exchange: 'bybit',
              message: msg,
              latency_ms: res.latencyMs,
              balance_usdt: finalWalletBal,
              wallet_balance_usdt: finalWalletBal,
              unrealized_pnl_usdt: resolvedUnrealizedPnl,
              equity_usdt: finalEquity,
              available_balance_usdt: finalAvail,
              used_margin_usdt: resolvedUsedMargin,
              can_trade: true,
              open_positions_count: openPositions,
              account_type: `${netLabel} (${walletTypeLabel})`,
              is_testnet: isTestnetHost,
              network_label: netLabel,
            };
          }

          const errObj: ConnectionTestResult = {
            success: false,
            exchange: 'bybit',
            message: `${netLabel}: ${json.retMsg} (retCode: ${json.retCode})`,
            latency_ms: res.latencyMs,
            can_trade: false,
            error_code: json.retCode,
            is_testnet: isTestnetHost,
            network_label: netLabel,
          };
          specificApiErrorRes = errObj;
          lastErrorRes = errObj;
          break;
        }

        const httpErrObj: ConnectionTestResult = {
          success: false,
          exchange: 'bybit',
          message:
            res.statusCode === 401 || res.statusCode === 403
              ? `Bybit V5: API-ключ не найден ни на одном из серверов (${checkedHostLabels.join(', ')} — HTTP ${res.statusCode}). Проверьте правильность API Key / Secret Key или выбранную биржу.`
              : `${netLabel} HTTP ${res.statusCode}: ${res.data.slice(0, 100)}`,
          latency_ms: res.latencyMs,
          can_trade: false,
          is_testnet: isTestnetHost,
          network_label: netLabel,
        };
        lastErrorRes = httpErrObj;
      } catch (e: any) {
        lastErrorRes = {
          success: false,
          exchange: 'bybit',
          message: `Ошибка связи с Bybit: ${e?.message || 'Сеть недоступна'}`,
          latency_ms: 0,
          can_trade: false,
        };
      }
    }

    // Авто-определение: если пользователь оставил выбранным Bybit (по умолчанию), но вставил ключ от Binance!
    if (!_disableCrossExchangeProbe && !creds.passphrase && !specificApiErrorRes) {
      const binanceProbe = await testExchangeConnection(
        { ...creds, exchange: 'binance' },
        true
      );
      if (binanceProbe.success || binanceProbe.error_code === -1003) {
        return binanceProbe;
      }
    }

    return (
      specificApiErrorRes ||
      lastErrorRes || {
        success: false,
        exchange: 'bybit',
        message: 'Не удалось подключиться к Bybit V5',
        latency_ms: 0,
        can_trade: false,
      }
    );
  }

  // ==========================================================================
  // 3. OKX V5 ACCOUNT BALANCE (Mainnet + Demo Trading x-simulated-trading: 1)
  // ==========================================================================
  if (creds.exchange === 'okx') {
    const cleanPass = String(creds.passphrase || '').trim();
    if (!cleanPass) {
      return {
        success: false,
        exchange: 'okx',
        message: 'Для OKX API обязательно требуется указать API Passphrase (кодовую фразу)',
        latency_ms: 0,
        can_trade: false,
      };
    }

    const demoModes = creds.isTestnet ? [true, false] : [false, true];
    let lastErrorRes: ConnectionTestResult | null = null;

    for (const isDemo of demoModes) {
      try {
        const isoTimestamp = new Date().toISOString();
        const requestPath = '/api/v5/account/balance';
        const preHash = `${isoTimestamp}GET${requestPath}`;
        const signature = crypto.createHmac('sha256', cleanSecret).update(preHash).digest('base64');

        const headers: Record<string, string> = {
          'OK-ACCESS-KEY': cleanKey,
          'OK-ACCESS-SIGN': signature,
          'OK-ACCESS-TIMESTAMP': isoTimestamp,
          'OK-ACCESS-PASSPHRASE': cleanPass,
          'Content-Type': 'application/json',
        };
        if (isDemo) {
          headers['x-simulated-trading'] = '1';
        }

        const res = await makeHttpsRequest(`https://www.okx.com${requestPath}`, {
          method: 'GET',
          headers,
        });

        if (res.statusCode === 200) {
          const json = JSON.parse(res.data);
          if (json.code === '0') {
            okxDemoCache.set(cleanKey, isDemo);
            const netLabel = isDemo ? 'OKX Demo Trading' : 'OKX V5 Mainnet';
            const details = json.data?.[0]?.details || [];
            const usdt = details.find((d: any) => d.ccy === 'USDT');
            const walletBal = Number(usdt?.cashBal || usdt?.eq || json.data?.[0]?.totalEq || 0);
            const unrealizedPnl = Number(usdt?.upl || json.data?.[0]?.upl || 0);
            const totalEq = Number(usdt?.eq || json.data?.[0]?.totalEq || walletBal + unrealizedPnl);
            const availBal = Number(usdt?.availEq || usdt?.availBal || walletBal);
            const usedMargin = Number(usdt?.frozenBal || usdt?.imr || Math.max(0, walletBal - availBal));
            return {
              success: true,
              exchange: 'okx',
              message: `Успешно подключено к ${netLabel} (Пинг: ${res.latencyMs} мс | Баланс: ${walletBal.toFixed(2)} USDT | Плавающий PnL: ${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2)} USDT)`,
              latency_ms: res.latencyMs,
              balance_usdt: walletBal,
              wallet_balance_usdt: walletBal,
              unrealized_pnl_usdt: unrealizedPnl,
              equity_usdt: totalEq,
              available_balance_usdt: availBal,
              used_margin_usdt: usedMargin,
              can_trade: true,
              account_type: netLabel,
              is_testnet: isDemo,
              network_label: netLabel,
            };
          }
          lastErrorRes = {
            success: false,
            exchange: 'okx',
            message: `OKX API: ${json.msg || 'Ошибка авторизации'} (code: ${json.code})`,
            latency_ms: res.latencyMs,
            can_trade: false,
            error_code: json.code,
          };
          if (json.code === '50101' || json.code === '50119') {
            continue;
          }
          break;
        }

        lastErrorRes = {
          success: false,
          exchange: 'okx',
          message: `OKX HTTP ${res.statusCode}: ${res.data.slice(0, 100)}`,
          latency_ms: res.latencyMs,
          can_trade: false,
        };
      } catch (e: any) {
        lastErrorRes = {
          success: false,
          exchange: 'okx',
          message: `Ошибка связи с OKX: ${e?.message || 'Сеть недоступна'}`,
          latency_ms: 0,
          can_trade: false,
        };
      }
    }

    return (
      lastErrorRes || {
        success: false,
        exchange: 'okx',
        message: 'Не удалось подключиться к OKX API',
        latency_ms: 0,
        can_trade: false,
      }
    );
  }

  // ==========================================================================
  // 4. BITGET V2 USDT-FUTURES (Mainnet + Demo paptrading: 1)
  // ==========================================================================
  if (creds.exchange === 'bitget') {
    const cleanPass = String(creds.passphrase || '').trim();
    if (!cleanPass) {
      return {
        success: false,
        exchange: 'bitget',
        message: 'Для Bitget API обязательно требуется указать API Passphrase (кодовую фразу)',
        latency_ms: 0,
        can_trade: false,
      };
    }

    const demoModes = creds.isTestnet ? [true, false] : [false, true];
    let lastErrorRes: ConnectionTestResult | null = null;

    for (const isDemo of demoModes) {
      try {
        const timestamp = Date.now().toString();
        const requestPath = '/api/v2/mix/account/accounts?productType=USDT-FUTURES';
        const preHash = `${timestamp}GET${requestPath}`;
        const signature = crypto.createHmac('sha256', cleanSecret).update(preHash).digest('base64');

        const headers: Record<string, string> = {
          'ACCESS-KEY': cleanKey,
          'ACCESS-SIGN': signature,
          'ACCESS-TIMESTAMP': timestamp,
          'ACCESS-PASSPHRASE': cleanPass,
          'Content-Type': 'application/json',
          locale: 'en-US',
        };
        if (isDemo) {
          headers.paptrading = '1';
        }

        const res = await makeHttpsRequest(`https://api.bitget.com${requestPath}`, {
          method: 'GET',
          headers,
        });

        if (res.statusCode === 200) {
          const json = JSON.parse(res.data);
          if (json.code === '00000') {
            bitgetDemoCache.set(cleanKey, isDemo);
            const netLabel = isDemo ? 'Bitget Demo Futures' : 'Bitget USDT-Futures Mainnet';
            const list = Array.isArray(json.data) ? json.data : [];
            const usdtAcc =
              list.find((a: any) => a.marginCoin === 'USDT' || a.marginCoin === 'SUSDT') || list[0];
            const walletBal = Number(
              usdtAcc?.accountBalance || usdtAcc?.usdtEquity || usdtAcc?.available || 0
            );
            const unrealizedPnl = Number(usdtAcc?.unrealizedPL || 0);
            const equity = Number(usdtAcc?.usdtEquity || walletBal + unrealizedPnl);
            const availBal = Number(
              usdtAcc?.available || usdtAcc?.crossedMaxAvailable || walletBal
            );
            const usedMargin = Number(usdtAcc?.locked || Math.max(0, walletBal - availBal));
            return {
              success: true,
              exchange: 'bitget',
              message: `Успешно подключено к ${netLabel} (Пинг: ${res.latencyMs} мс | Баланс: ${walletBal.toFixed(2)} USDT | Плавающий PnL: ${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2)} USDT)`,
              latency_ms: res.latencyMs,
              balance_usdt: walletBal,
              wallet_balance_usdt: walletBal,
              unrealized_pnl_usdt: unrealizedPnl,
              equity_usdt: equity,
              available_balance_usdt: availBal,
              used_margin_usdt: usedMargin,
              can_trade: true,
              account_type: netLabel,
              is_testnet: isDemo,
              network_label: netLabel,
            };
          }
          lastErrorRes = {
            success: false,
            exchange: 'bitget',
            message: `Bitget API: ${json.msg || 'Ошибка авторизации'} (code: ${json.code})`,
            latency_ms: res.latencyMs,
            can_trade: false,
            error_code: json.code,
          };
          continue;
        }

        lastErrorRes = {
          success: false,
          exchange: 'bitget',
          message: `Bitget HTTP ${res.statusCode}: ${res.data.slice(0, 100)}`,
          latency_ms: res.latencyMs,
          can_trade: false,
        };
      } catch (e: any) {
        lastErrorRes = {
          success: false,
          exchange: 'bitget',
          message: `Ошибка связи с Bitget: ${e?.message || 'Сеть недоступна'}`,
          latency_ms: 0,
          can_trade: false,
        };
      }
    }

    return (
      lastErrorRes || {
        success: false,
        exchange: 'bitget',
        message: 'Не удалось подключиться к Bitget API',
        latency_ms: 0,
        can_trade: false,
      }
    );
  }

  // ==========================================================================
  // 5. BINGX SWAP V2 PERPETUAL FUTURES (open-api.bingx.com)
  // ==========================================================================
  try {
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', cleanSecret).update(query).digest('hex');
    const url = `https://open-api.bingx.com/openApi/swap/v2/user/balance?${query}&signature=${signature}`;

    const res = await makeHttpsRequest(url, {
      method: 'GET',
      headers: {
        'X-BX-APIKEY': cleanKey,
        'Content-Type': 'application/json',
      },
    });

    if (res.statusCode === 200) {
      const json = JSON.parse(res.data);
      if (json.code === 0) {
        const balanceObj = json.data?.balance;
        const walletBal = Number(balanceObj?.balance || balanceObj?.equity || 0);
        const unrealizedPnl = Number(balanceObj?.unrealizedProfit || 0);
        const equity = Number(balanceObj?.equity || walletBal + unrealizedPnl);
        const availBal = Number(balanceObj?.availableMargin || walletBal);
        const usedMargin = Number(balanceObj?.usedMargin || Math.max(0, walletBal - availBal));
        return {
          success: true,
          exchange: 'bingx',
          message: `Успешно подключено к BingX Perpetual Swap (Пинг: ${res.latencyMs} мс | Баланс: ${walletBal.toFixed(2)} USDT | Плавающий PnL: ${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2)} USDT)`,
          latency_ms: res.latencyMs,
          balance_usdt: walletBal,
          wallet_balance_usdt: walletBal,
          unrealized_pnl_usdt: unrealizedPnl,
          equity_usdt: equity,
          available_balance_usdt: availBal,
          used_margin_usdt: usedMargin,
          can_trade: true,
          account_type: 'BingX Swap Futures',
          is_testnet: Boolean(creds.isTestnet),
          network_label: creds.isTestnet ? 'BingX VST / Testnet' : 'BingX Swap Mainnet',
        };
      }
      return {
        success: false,
        exchange: 'bingx',
        message: `BingX API: ${json.msg || 'Ошибка ключа или подписи'} (code: ${json.code})`,
        latency_ms: res.latencyMs,
        can_trade: false,
        error_code: json.code,
      };
    }

    return {
      success: false,
      exchange: 'bingx',
      message: `BingX HTTP ${res.statusCode}: ${res.data.slice(0, 100)}`,
      latency_ms: res.latencyMs,
      can_trade: false,
    };
  } catch (e: any) {
    return {
      success: false,
      exchange: 'bingx',
      message: `Ошибка связи с BingX: ${e?.message || 'Сеть недоступна'}`,
      latency_ms: 0,
      can_trade: false,
    };
  }
}

/**
 * Рассчитывает пропорциональный объем сделки для подключенного аккаунта клиента:
 * Строго 0.5% от депозита клиента при 25x плече.
 */
export function calculateClientProportionalOrder(params: {
  clientBalanceUsdt: number;
  entryPrice: number;
  leverage: number;
  stakePercent?: number; // по умолчанию 0.5% (0.005)
  minStakeUsdt?: number;
}): {
  clientStakeUsdt: number;
  notionalUsdt: number;
  coinAmount: number;
} {
  const percent = params.stakePercent || 0.005;
  const rawStake = Number((params.clientBalanceUsdt * percent).toFixed(2));
  const clientStakeUsdt = Math.max(params.minStakeUsdt || 5, rawStake);
  const leverage = Math.max(1, Math.round(params.leverage || 25));
  const notionalUsdt = Number((clientStakeUsdt * leverage).toFixed(2));
  const safeEntryPrice = Math.max(1e-8, params.entryPrice);
  const coinAmount = Number((notionalUsdt / safeEntryPrice).toFixed(4));

  return {
    clientStakeUsdt,
    notionalUsdt,
    coinAmount,
  };
}

/**
 * Возвращает реальную ставку комиссии Taker для фьючерсов конкретной биржи:
 * - Bybit V5 Linear Futures: 0.055% (0.00055)
 * - Binance USDⓈ-M Futures: 0.05% (0.0005)
 * - OKX V5 Perpetual Swap: 0.05% (0.0005)
 * - Bitget V2 USDT-Futures: 0.06% (0.0006)
 * - BingX Perpetual Swap: 0.05% (0.0005)
 */
export function getExchangeTakerFeeRate(exchange?: string): number {
  const clean = String(exchange || 'bybit').trim().toLowerCase();
  if (clean === 'bybit') return 0.00055;
  if (clean === 'binance') return 0.0005;
  if (clean === 'okx') return 0.0005;
  if (clean === 'bingx') return 0.0005;
  return 0.0006;
}

/**
 * Преобразует биржевой символ ('ETHUSDT', 'ETHUSDC', 'ETH-USDT-SWAP', 'ETH-USDC-SWAP') в формат пары 'ETH/USDT:USDT' или 'ETH/USDC:USDC'.
 */
export function symbolToFreqtradePair(rawSymbol: string): string {
  return cleanSymbolToPair(rawSymbol);
}

export interface ExchangePositionItem {
  pair: string;
  symbol: string;
  is_short: boolean;
  size: number;
  entry_price: number;
  mark_price: number;
  leverage: number;
  margin_usdt: number;
  unrealized_pnl: number;
  take_profit?: number;
  stop_loss?: number;
  created_time: number;
  updated_time: number;
}

export interface ExchangeClosedPnlItem {
  order_id: string;
  pair: string;
  symbol: string;
  is_short: boolean;
  qty: number;
  entry_price: number;
  exit_price: number;
  leverage: number;
  closed_pnl: number;
  open_fee: number;
  close_fee: number;
  created_time: number;
  updated_time: number;
}

/**
 * Запрашивает ВСЕ реально открытые фьючерсные позиции на аккаунте биржи (Bybit, Binance, OKX, Bitget, BingX).
 * Позволяет боту видеть уже открытые сделки после обновления кода/перезапуска или ручного открытия на бирже,
 * не открывать дубликаты и вести существующие позиции по стратегии.
 */
export async function fetchExchangeOpenPositions(
  creds: ExchangeCredentials,
  forceFresh = false
): Promise<{
  success: boolean;
  positions: ExchangePositionItem[];
  network_label?: string;
  is_testnet?: boolean;
}> {
  const cleanKey = sanitizeCredentialString(creds.apiKey);
  const cleanSecret = sanitizeCredentialString(creds.apiSecret);
  if (!cleanKey || !cleanSecret || isSimulatedTestApiKey(cleanKey)) {
    return { success: false, positions: [] };
  }

  // 1. BYBIT V5 LINEAR FUTURES (WebSocket Private Stream + paginated /v5/position/list bootstrap USDT+USDC)
  if (creds.exchange === 'bybit') {
    const liveBybitWs = !forceFresh ? getWsAccountLiveState(cleanKey, 60_000) : undefined;
    if (
      liveBybitWs &&
      liveBybitWs.exchange === 'bybit' &&
      liveBybitWs.positionsSynced &&
      liveBybitWs.wsConnected &&
      isPrivateWsStreamOpen('bybit', cleanKey) &&
      Date.now() - liveBybitWs.lastRestBootstrapAt < 90_000
    ) {
      for (const pos of liveBybitWs.positions) {
        const tick = getLiveWsTicker(pos.symbol, 'bybit');
        if (tick && tick.markPrice > 0) {
          pos.mark_price = tick.markPrice;
          const diff = pos.is_short
            ? pos.entry_price - tick.markPrice
            : tick.markPrice - pos.entry_price;
          pos.unrealized_pnl = Number((diff * pos.size).toFixed(4));
        }
      }
      return {
        success: true,
        positions: liveBybitWs.positions,
        network_label: liveBybitWs.networkLabel,
        is_testnet: liveBybitWs.isTestnet,
      };
    }

    const candidateHosts = getBybitCandidateHosts(cleanKey, creds.isTestnet);
    for (const baseUrl of candidateHosts) {
      try {
        const positions: ExchangePositionItem[] = [];
        const seenPosKeys = new Set<string>();
        let hostAuthenticated = false;
        let invalidKeyOnHost = false;

        const queryBybitPos = async (queryString: string, forceTimeSync = false) => {
          const timestamp = await getBybitTimestamp(baseUrl, forceTimeSync);
          const recvWindow = '15000';
          const signature = signBybitV5(timestamp, cleanKey, recvWindow, queryString, cleanSecret);
          return makeHttpsRequest(`${baseUrl}/v5/position/list?${queryString}`, {
            method: 'GET',
            headers: {
              'X-BAPI-API-KEY': cleanKey,
              'X-BAPI-TIMESTAMP': timestamp,
              'X-BAPI-SIGN': signature,
              'X-BAPI-RECV-WINDOW': recvWindow,
              'Content-Type': 'application/json',
            },
            timeoutMs: 6500,
          });
        };

        for (const settleCoin of ['USDT', 'USDC']) {
          let cursor = '';
          for (let page = 0; page < 5; page++) {
            const queryString = `category=linear&settleCoin=${settleCoin}&limit=200${
              cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
            }`;
            let res = await queryBybitPos(queryString, false);
            if (res.statusCode === 401 || res.statusCode === 403) {
              invalidKeyOnHost = true;
              break;
            }
            if (res.statusCode !== 200) break;
            let json = JSON.parse(res.data);
            if (json.retCode === 10002) {
              res = await queryBybitPos(queryString, true);
              if (res.statusCode !== 200) break;
              json = JSON.parse(res.data);
            }
            if (json.retCode === 10003 || json.retCode === 10004 || json.retCode === 33004) {
              invalidKeyOnHost = true;
              hostAuthenticated = false;
              break;
            }
            if (json.retCode !== 0 || !Array.isArray(json.result?.list)) break;
            hostAuthenticated = true;

            for (const p of json.result.list) {
              const size = Math.abs(Number(p.size || 0));
              if (!(size > 0)) continue;
              const sym = String(p.symbol || '').toUpperCase();
              if (!isSupportedFuturesSymbol(sym)) continue;
              const liveTick = getLiveWsTicker(sym, 'bybit');
              const entryPrice = Number(
                p.avgPrice || p.entryPrice || p.markPrice || liveTick?.markPrice || liveTick?.price || 0
              );
              if (!(entryPrice > 0)) continue;
              const markPrice = Number(p.markPrice || liveTick?.markPrice || entryPrice);
              const lev = Math.max(1, Math.round(Number(p.leverage || 25)));
              const sideStr = String(p.side || '').toLowerCase();
              const isShort = sideStr === 'sell' || Number(p.positionIdx) === 2;
              const posKey = `${sym}:${isShort ? 'S' : 'L'}`;
              if (seenPosKeys.has(posKey)) continue;
              seenPosKeys.add(posKey);
              const notional = size * entryPrice;
              const rawIm = Number(p.positionIM || p.positionBalance || 0);
              const marginUsdt =
                rawIm > 0 ? Number(rawIm.toFixed(2)) : Number((notional / lev).toFixed(2));
              const tp = Number(p.takeProfit || 0);
              const sl = Number(p.stopLoss || 0);
              const cTime = Number(p.createdTime || p.updatedTime || Date.now());
              const uTime = Number(p.updatedTime || cTime);
              const posItem: ExchangePositionItem = {
                pair: symbolToFreqtradePair(sym),
                symbol: sym,
                is_short: isShort,
                size,
                entry_price: entryPrice,
                mark_price: markPrice > 0 ? markPrice : entryPrice,
                leverage: lev,
                margin_usdt: marginUsdt,
                unrealized_pnl: Number(p.unrealisedPnl || 0),
                take_profit: tp > 0 ? tp : undefined,
                stop_loss: sl > 0 ? sl : undefined,
                created_time: cTime,
                updated_time: uTime,
              };
              positions.push(posItem);
              subscribePairKlineStream(posItem.pair, '1h');
            }
            const nextCursor = String(json.result?.nextPageCursor || '').trim();
            if (!nextCursor) break;
            cursor = nextCursor;
          }
          if (invalidKeyOnHost) break;
        }

        if (hostAuthenticated) {
          bybitHostCache.set(cleanKey, baseUrl);
          const netLabel = baseUrl.includes('testnet')
            ? 'Bybit Testnet'
            : baseUrl.includes('demo')
            ? 'Bybit Demo'
            : 'Bybit Mainnet';
          const isTestnetHost = baseUrl !== 'https://api.bybit.com';
          const existingBybitWs = getWsAccountLiveState(cleanKey, 86_400_000);
          if (existingBybitWs) {
            existingBybitWs.positions = positions;
            existingBybitWs.positionsSynced = true;
            existingBybitWs.usedMarginUsdt = Number(
              positions.reduce((s, p) => s + Number(p.margin_usdt || 0), 0).toFixed(2)
            );
            existingBybitWs.unrealizedPnlUsdt = Number(
              positions.reduce((s, p) => s + Number(p.unrealized_pnl || 0), 0).toFixed(4)
            );
            existingBybitWs.updatedAt = Date.now();
            existingBybitWs.lastRestBootstrapAt = Date.now();
          } else {
            setWsAccountLiveState({
              apiKey: cleanKey,
              exchange: 'bybit',
              isTestnet: isTestnetHost,
              networkLabel: netLabel,
              walletBalanceUsdt: 0,
              unrealizedPnlUsdt: Number(
                positions.reduce((s, p) => s + Number(p.unrealized_pnl || 0), 0).toFixed(4)
              ),
              equityUsdt: 0,
              availableBalanceUsdt: 0,
              usedMarginUsdt: Number(
                positions.reduce((s, p) => s + Number(p.margin_usdt || 0), 0).toFixed(2)
              ),
              canTrade: true,
              positions,
              closedPnl: [],
              wsConnected: isPrivateWsStreamOpen('bybit', cleanKey),
              positionsSynced: true,
              updatedAt: Date.now(),
              lastRestBootstrapAt: Date.now(),
            });
          }
          ensureBybitPrivateUserStream(cleanKey, cleanSecret, baseUrl);
          return {
            success: true,
            positions,
            network_label: netLabel,
            is_testnet: isTestnetHost,
          };
        }
      } catch {
        // try next host
      }
    }
    return { success: false, positions: [] };
  }

  // 2. BINANCE USDT-M + USDC-M FUTURES (WebSocket User Data Stream + ws-fapi v2/account.position + REST fallback + кэш)
  if (creds.exchange === 'binance') {
    const liveWsState = !forceFresh ? getWsAccountLiveState(cleanKey, 90_000) : undefined;
    if (
      liveWsState &&
      liveWsState.exchange === 'binance' &&
      liveWsState.positionsSynced &&
      liveWsState.wsConnected &&
      isPrivateWsStreamOpen('binance', cleanKey) &&
      Date.now() - liveWsState.lastRestBootstrapAt < 90_000
    ) {
      for (const pos of liveWsState.positions) {
        const tick = getLiveWsTicker(pos.symbol, 'binance');
        if (tick && tick.markPrice > 0) {
          pos.mark_price = tick.markPrice;
          const diff = pos.is_short
            ? pos.entry_price - tick.markPrice
            : tick.markPrice - pos.entry_price;
          pos.unrealized_pnl = Number((diff * pos.size).toFixed(4));
        }
      }
      return {
        success: true,
        positions: liveWsState.positions,
        network_label: liveWsState.networkLabel,
        is_testnet: liveWsState.isTestnet,
      };
    }

    const cachedPos = binancePositionsCache.get(cleanKey);
    if (!forceFresh && cachedPos && Date.now() - cachedPos.timestamp < 75_000) {
      for (const pos of cachedPos.positions) {
        const tick = getLiveWsTicker(pos.symbol, 'binance');
        if (tick && tick.markPrice > 0) {
          pos.mark_price = tick.markPrice;
          const diff = pos.is_short
            ? pos.entry_price - tick.markPrice
            : tick.markPrice - pos.entry_price;
          pos.unrealized_pnl = Number((diff * pos.size).toFixed(4));
        }
      }
      return {
        success: true,
        positions: cachedPos.positions,
        network_label: cachedPos.network_label,
        is_testnet: cachedPos.is_testnet,
      };
    }

    const candidateHosts = getBinanceCandidateHosts(cleanKey, creds.isTestnet);
    for (const baseUrl of candidateHosts) {
      try {
        // 2A. Сначала запрашиваем открытые позиции через WebSocket API (wss://ws-fapi.binance.com/ws-fapi/v1) без бана IP -1003!
        const wsRpc = getBinanceWsRpcClient(baseUrl);
        const wsTs = await getBinanceTimestamp(false, baseUrl);
        let wsPosRes = await wsRpc.request(
          'v2/account.position',
          { apiKey: cleanKey, timestamp: wsTs, recvWindow: 10000 },
          cleanSecret,
          5500
        );
        if (wsPosRes.status !== 200 && wsPosRes.error?.code === -1021) {
          const retryWsTs = await getBinanceTimestamp(true, baseUrl);
          wsPosRes = await wsRpc.request(
            'v2/account.position',
            { apiKey: cleanKey, timestamp: retryWsTs, recvWindow: 15000 },
            cleanSecret,
            5500
          );
        }

        let list: any[] | null = null;
        if (wsPosRes.status === 200 && Array.isArray(wsPosRes.result)) {
          list = wsPosRes.result;
        } else if (!isBinanceHostRateLimited(baseUrl).limited) {
          // Резервный REST /fapi/v2/positionRisk при ЛЮБОЙ ошибке ws-fapi (вкл. 400/-1021/таймаут)
          const ts = await getBinanceTimestamp(false, baseUrl);
          const query = `timestamp=${ts}&recvWindow=10000`;
          const sig = signBinanceFuturesQuery(query, cleanSecret);
          let res = await makeHttpsRequest(
            `${baseUrl}/fapi/v2/positionRisk?${query}&signature=${sig}`,
            {
              method: 'GET',
              headers: { 'X-MBX-APIKEY': cleanKey },
              timeoutMs: 6500,
            }
          );
          if (res.statusCode !== 200 && res.data.includes('-1021')) {
            const retryTs = await getBinanceTimestamp(true, baseUrl);
            const retryQuery = `timestamp=${retryTs}&recvWindow=15000`;
            const retrySig = signBinanceFuturesQuery(retryQuery, cleanSecret);
            res = await makeHttpsRequest(
              `${baseUrl}/fapi/v2/positionRisk?${retryQuery}&signature=${retrySig}`,
              {
                method: 'GET',
                headers: { 'X-MBX-APIKEY': cleanKey },
                timeoutMs: 6500,
              }
            );
          }
          if (res.statusCode === 200) {
            const parsed = JSON.parse(res.data);
            if (Array.isArray(parsed)) list = parsed;
          }
        }

        if (Array.isArray(list)) {
          binanceHostCache.set(cleanKey, baseUrl);
          const positions: ExchangePositionItem[] = [];
          for (const p of list) {
            const rawAmt = Number(p.positionAmt || 0);
            const size = Math.abs(rawAmt);
            if (!(size > 0)) continue;
            const sym = String(p.symbol || '').toUpperCase();
            if (!isSupportedFuturesSymbol(sym)) continue;
            const liveTick = getLiveWsTicker(sym, 'binance');
            const entryPrice = Number(
              p.entryPrice || p.markPrice || p.breakEvenPrice || liveTick?.markPrice || liveTick?.price || 0
            );
            if (!(entryPrice > 0)) continue;
            const markPrice = Number(p.markPrice || liveTick?.markPrice || entryPrice);
            const lev = Math.max(1, Math.round(Number(p.leverage || 25)));
            const posSide = String(p.positionSide || '').toUpperCase();
            const isShort = posSide === 'SHORT' || rawAmt < 0;
            const notional = size * entryPrice;
            const initialMargin = Number(
              p.initialMargin || p.positionInitialMargin || p.isolatedMargin || p.isolatedWallet || 0
            );
            const marginUsdt =
              initialMargin > 0
                ? Number(initialMargin.toFixed(2))
                : Number((notional / lev).toFixed(2));
            const uTime = Number(p.updateTime || Date.now());
            const posItem: ExchangePositionItem = {
              pair: symbolToFreqtradePair(sym),
              symbol: sym,
              is_short: isShort,
              size,
              entry_price: entryPrice,
              mark_price: markPrice > 0 ? markPrice : entryPrice,
              leverage: lev,
              margin_usdt: marginUsdt,
              unrealized_pnl: Number(p.unRealizedProfit ?? p.unrealizedProfit ?? 0),
              created_time: uTime,
              updated_time: uTime,
            };
            positions.push(posItem);
            subscribePairKlineStream(posItem.pair, '1h');
          }
          const netLabel = baseUrl.includes('testnet')
            ? 'Binance Futures Testnet'
            : 'Binance USDⓈ-M Mainnet';
          const isTestnetHost = baseUrl.includes('testnet');
          binancePositionsCache.set(cleanKey, {
            timestamp: Date.now(),
            positions,
            network_label: netLabel,
            is_testnet: isTestnetHost,
          });
          const existingBinanceWs = getWsAccountLiveState(cleanKey, 86_400_000);
          if (existingBinanceWs) {
            existingBinanceWs.positions = positions;
            existingBinanceWs.positionsSynced = true;
            existingBinanceWs.usedMarginUsdt = Number(
              positions.reduce((s, p) => s + Number(p.margin_usdt || 0), 0).toFixed(2)
            );
            existingBinanceWs.availableBalanceUsdt = Number(
              Math.max(0, existingBinanceWs.walletBalanceUsdt - existingBinanceWs.usedMarginUsdt).toFixed(2)
            );
            existingBinanceWs.updatedAt = Date.now();
            existingBinanceWs.lastRestBootstrapAt = Date.now();
          }
          ensureBinancePrivateUserStream(cleanKey, cleanSecret, baseUrl).catch(() => {});
          return {
            success: true,
            positions,
            network_label: netLabel,
            is_testnet: isTestnetHost,
          };
        }
      } catch {
        // try next host
      }
    }
    if (!forceFresh && cachedPos) {
      return {
        success: true,
        positions: cachedPos.positions,
        network_label: cachedPos.network_label,
        is_testnet: cachedPos.is_testnet,
      };
    }
    return { success: false, positions: [] };
  }

  // 3. OKX V5 SWAP (/api/v5/account/positions?instType=SWAP)
  if (creds.exchange === 'okx') {
    const cleanPass = String(creds.passphrase || '').trim();
    if (!cleanPass) return { success: false, positions: [] };
    const isDemo = creds.isTestnet ?? okxDemoCache.get(cleanKey) ?? false;
    try {
      const isoTimestamp = new Date().toISOString();
      const requestPath = '/api/v5/account/positions?instType=SWAP';
      const preHash = `${isoTimestamp}GET${requestPath}`;
      const signature = crypto.createHmac('sha256', cleanSecret).update(preHash).digest('base64');
      const headers: Record<string, string> = {
        'OK-ACCESS-KEY': cleanKey,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': isoTimestamp,
        'OK-ACCESS-PASSPHRASE': cleanPass,
        'Content-Type': 'application/json',
      };
      if (isDemo) headers['x-simulated-trading'] = '1';
      const res = await makeHttpsRequest(`https://www.okx.com${requestPath}`, {
        method: 'GET',
        headers,
        timeoutMs: 6500,
      });
      if (res.statusCode === 200) {
        const json = JSON.parse(res.data);
        if (json.code === '0' && Array.isArray(json.data)) {
          const positions: ExchangePositionItem[] = [];
          for (const p of json.data) {
            const rawPos = Number(p.pos || 0);
            const size = Math.abs(rawPos);
            if (!(size > 0)) continue;
            const instId = String(p.instId || '');
            const entryPrice = Number(p.avgPx || 0);
            if (!(entryPrice > 0)) continue;
            const markPrice = Number(p.markPx || entryPrice);
            const lev = Math.max(1, Math.round(Number(p.lever || 25)));
            const isShort = String(p.posSide || '').toLowerCase() === 'short' || rawPos < 0;
            const marginUsdt = Number(p.margin || p.imr || (size * entryPrice) / lev);
            positions.push({
              pair: symbolToFreqtradePair(instId),
              symbol: instId,
              is_short: isShort,
              size,
              entry_price: entryPrice,
              mark_price: markPrice,
              leverage: lev,
              margin_usdt: Number(marginUsdt.toFixed(2)),
              unrealized_pnl: Number(p.upl || 0),
              created_time: Number(p.cTime || Date.now()),
              updated_time: Number(p.uTime || Date.now()),
            });
          }
          return {
            success: true,
            positions,
            network_label: isDemo ? 'OKX Demo Trading' : 'OKX V5 Mainnet',
            is_testnet: isDemo,
          };
        }
      }
    } catch {
      // ignore
    }
    return { success: false, positions: [] };
  }

  // 4. BITGET V2 FUTURES (USDT-FUTURES + USDC-FUTURES)
  if (creds.exchange === 'bitget') {
    const cleanPass = String(creds.passphrase || '').trim();
    if (!cleanPass) return { success: false, positions: [] };
    const isDemo = creds.isTestnet ?? bitgetDemoCache.get(cleanKey) ?? false;
    try {
      const positions: ExchangePositionItem[] = [];
      let anyOk = false;
      for (const cfg of [
        { productType: 'USDT-FUTURES', marginCoin: 'USDT' },
        { productType: 'USDC-FUTURES', marginCoin: 'USDC' },
      ]) {
        const timestamp = Date.now().toString();
        const requestPath = `/api/v2/mix/position/all-position?productType=${cfg.productType}&marginCoin=${cfg.marginCoin}`;
        const preHash = `${timestamp}GET${requestPath}`;
        const signature = crypto.createHmac('sha256', cleanSecret).update(preHash).digest('base64');
        const headers: Record<string, string> = {
          'ACCESS-KEY': cleanKey,
          'ACCESS-SIGN': signature,
          'ACCESS-TIMESTAMP': timestamp,
          'ACCESS-PASSPHRASE': cleanPass,
          'Content-Type': 'application/json',
          locale: 'en-US',
        };
        if (isDemo) headers.paptrading = '1';
        const res = await makeHttpsRequest(`https://api.bitget.com${requestPath}`, {
          method: 'GET',
          headers,
          timeoutMs: 6500,
        });
        if (res.statusCode === 200) {
          const json = JSON.parse(res.data);
          if (json.code === '00000' && Array.isArray(json.data)) {
            anyOk = true;
            for (const p of json.data) {
              const size = Math.abs(Number(p.total || p.available || 0));
              if (!(size > 0)) continue;
              const sym = String(p.symbol || '');
              const entryPrice = Number(p.openPriceAvg || p.markPrice || 0);
              if (!(entryPrice > 0)) continue;
              const markPrice = Number(p.markPrice || entryPrice);
              const lev = Math.max(1, Math.round(Number(p.leverage || 25)));
              const isShort = String(p.holdSide || '').toLowerCase() === 'short';
              const marginUsdt = Number(p.marginSize || (size * entryPrice) / lev);
              positions.push({
                pair: symbolToFreqtradePair(sym),
                symbol: sym,
                is_short: isShort,
                size,
                entry_price: entryPrice,
                mark_price: markPrice,
                leverage: lev,
                margin_usdt: Number(marginUsdt.toFixed(2)),
                unrealized_pnl: Number(p.unrealizedPL || 0),
                created_time: Number(p.cTime || Date.now()),
                updated_time: Number(p.uTime || Date.now()),
              });
            }
          }
        }
      }
      if (anyOk) {
        return {
          success: true,
          positions,
          network_label: isDemo ? 'Bitget Demo Futures' : 'Bitget Futures Mainnet',
          is_testnet: isDemo,
        };
      }
    } catch {
      // ignore
    }
    return { success: false, positions: [] };
  }

  // 5. BINGX SWAP V2 (/openApi/swap/v2/user/positions)
  if (creds.exchange === 'bingx') {
    try {
      const timestamp = Date.now();
      const query = `timestamp=${timestamp}`;
      const signature = crypto.createHmac('sha256', cleanSecret).update(query).digest('hex');
      const res = await makeHttpsRequest(
        `https://open-api.bingx.com/openApi/swap/v2/user/positions?${query}&signature=${signature}`,
        {
          method: 'GET',
          headers: { 'X-BX-APIKEY': cleanKey },
          timeoutMs: 6500,
        }
      );
      if (res.statusCode === 200) {
        const json = JSON.parse(res.data);
        if (json.code === 0 && Array.isArray(json.data)) {
          const positions: ExchangePositionItem[] = [];
          for (const p of json.data) {
            const rawAmt = Number(p.positionAmt || p.availableAmt || 0);
            const size = Math.abs(rawAmt);
            if (!(size > 0)) continue;
            const sym = String(p.symbol || '');
            const entryPrice = Number(p.avgPrice || 0);
            if (!(entryPrice > 0)) continue;
            const markPrice = Number(p.markPrice || entryPrice);
            const lev = Math.max(1, Math.round(Number(p.leverage || 25)));
            const posSide = String(p.positionSide || '').toUpperCase();
            const isShort = posSide === 'SHORT' || (posSide !== 'LONG' && rawAmt < 0);
            const marginUsdt = Number(p.margin || (size * entryPrice) / lev);
            positions.push({
              pair: symbolToFreqtradePair(sym),
              symbol: sym,
              is_short: isShort,
              size,
              entry_price: entryPrice,
              mark_price: markPrice,
              leverage: lev,
              margin_usdt: Number(marginUsdt.toFixed(2)),
              unrealized_pnl: Number(p.unrealizedProfit || 0),
              created_time: Number(p.updateTime || Date.now()),
              updated_time: Number(p.updateTime || Date.now()),
            });
          }
          return {
            success: true,
            positions,
            network_label: 'BingX Swap V2',
          };
        }
      }
    } catch {
      // ignore
    }
    return { success: false, positions: [] };
  }

  return { success: false, positions: [] };
}

/**
 * Запрашивает реальную историю закрытых сделок (Closed PnL) и комиссий со всех 5 бирж:
 * Bybit V5 (/v5/position/closed-pnl), Binance Futures (/fapi/v1/income + /fapi/v1/userTrades),
 * OKX V5 (/api/v5/account/positions-history), Bitget V2 (/api/v2/mix/position/history-position),
 * BingX V2 (/openApi/swap/v2/trade/allOrders).
 */
export async function fetchExchangeClosedPnl(
  creds: ExchangeCredentials,
  limit = 50,
  knownSymbols: string[] = [],
  forceRefresh = false
): Promise<{
  success: boolean;
  closed: ExchangeClosedPnlItem[];
}> {
  const cleanKey = sanitizeCredentialString(creds.apiKey);
  const cleanSecret = sanitizeCredentialString(creds.apiSecret);
  if (!cleanKey || !cleanSecret || isSimulatedTestApiKey(cleanKey)) {
    return { success: false, closed: [] };
  }

  // 1. BYBIT V5 (/v5/position/closed-pnl)
  if (creds.exchange === 'bybit') {
    const candidateHosts = getBybitCandidateHosts(cleanKey, creds.isTestnet);
    for (const baseUrl of candidateHosts) {
      try {
        const timestamp = await getBybitTimestamp(baseUrl, false);
        const recvWindow = '15000';
        const queryString = `category=linear&limit=${Math.min(100, Math.max(10, limit))}`;
        const signature = signBybitV5(timestamp, cleanKey, recvWindow, queryString, cleanSecret);
        const res = await makeHttpsRequest(`${baseUrl}/v5/position/closed-pnl?${queryString}`, {
          method: 'GET',
          headers: {
            'X-BAPI-API-KEY': cleanKey,
            'X-BAPI-TIMESTAMP': timestamp,
            'X-BAPI-SIGN': signature,
            'X-BAPI-RECV-WINDOW': recvWindow,
            'Content-Type': 'application/json',
          },
          timeoutMs: 6500,
        });
        if (res.statusCode === 401 || res.statusCode === 403) {
          continue;
        }
        if (res.statusCode === 200) {
          const json = JSON.parse(res.data);
          if (json.retCode === 10003 || json.retCode === 10004 || json.retCode === 33004) {
            continue;
          }
          if (json.retCode === 0 && Array.isArray(json.result?.list)) {
            bybitHostCache.set(cleanKey, baseUrl);
            const closed: ExchangeClosedPnlItem[] = [];
            for (const item of json.result.list) {
              const sym = String(item.symbol || '');
              const qty = Math.abs(Number(item.qty || item.closedSize || 0));
              const entryPrice = Number(item.avgEntryPrice || item.orderPrice || 0);
              const exitPrice = Number(item.avgExitPrice || item.execPrice || 0);
              if (!sym || !(qty > 0) || !(entryPrice > 0) || !(exitPrice > 0)) continue;
              const closingSide = String(item.side || '').toLowerCase();
              const isShort = closingSide === 'buy';
              const lev = Math.max(1, Math.round(Number(item.leverage || 25)));
              const closedPnl = Number(item.closedPnl || 0);
              const openFee = Math.abs(
                Number(item.openFee || entryPrice * qty * 0.00055)
              );
              const closeFee = Math.abs(
                Number(item.closeFee || exitPrice * qty * 0.00055)
              );
              const cTime = Number(item.createdTime || item.updatedTime || Date.now());
              const uTime = Number(item.updatedTime || cTime);
              closed.push({
                order_id: String(item.orderId || `${sym}-${uTime}`),
                pair: symbolToFreqtradePair(sym),
                symbol: sym,
                is_short: isShort,
                qty,
                entry_price: entryPrice,
                exit_price: exitPrice,
                leverage: lev,
                closed_pnl: Number(closedPnl.toFixed(4)),
                open_fee: Number(openFee.toFixed(4)),
                close_fee: Number(closeFee.toFixed(4)),
                created_time: cTime,
                updated_time: uTime,
              });
            }
            return { success: true, closed };
          }
        }
      } catch {
        // try next host
      }
    }
    return { success: false, closed: [] };
  }

  // 2. BINANCE USDT-M FUTURES (WebSocket ORDER_TRADE_UPDATE + кэш 10 мин, чтобы не вызывать /fapi/v1/income каждые 30 сек)
  if (creds.exchange === 'binance') {
    const liveWsState = getWsAccountLiveState(cleanKey, 600_000);
    const cachedClosed = !forceRefresh ? binanceClosedPnlCache.get(cleanKey) : undefined;
    if (cachedClosed && Date.now() - cachedClosed.timestamp < 600_000) {
      const merged = [
        ...(liveWsState?.closedPnl || []),
        ...cachedClosed.closed.filter(
          (c) => !(liveWsState?.closedPnl || []).some((w) => w.order_id === c.order_id)
        ),
      ];
      return { success: true, closed: merged };
    }
    if (!forceRefresh && liveWsState && liveWsState.closedPnl.length > 0) {
      return { success: true, closed: liveWsState.closedPnl };
    }

    const candidateHosts = getBinanceCandidateHosts(cleanKey, creds.isTestnet);
    for (const baseUrl of candidateHosts) {
      if (isBinanceHostRateLimited(baseUrl).limited) {
        continue;
      }
      try {
        const ts = await getBinanceTimestamp(false, baseUrl);
        const pnlQuery = `incomeType=REALIZED_PNL&limit=200&timestamp=${ts}&recvWindow=10000`;
        const pnlSig = signBinanceFuturesQuery(pnlQuery, cleanSecret);

        const incRes = await makeHttpsRequest(
          `${baseUrl}/fapi/v1/income?${pnlQuery}&signature=${pnlSig}`,
          {
            method: 'GET',
            headers: { 'X-MBX-APIKEY': cleanKey },
            timeoutMs: 6500,
          }
        );

        if (incRes.statusCode !== 200) {
          if (
            incRes.data.includes('-2015') ||
            incRes.data.includes('-2014') ||
            incRes.data.includes('-1003') ||
            incRes.statusCode === 418 ||
            incRes.statusCode === 429
          ) {
            continue;
          }
          break;
        }
        binanceHostCache.set(cleanKey, baseUrl);
        const incomeList = JSON.parse(incRes.data);
        const commList: any[] = [];

        const latestIncomeBySym = new Map<string, number>();
        if (Array.isArray(incomeList)) {
          for (const inc of incomeList) {
            const sym = String(inc.symbol || '').trim().toUpperCase();
            const incTime = Number(inc.time || 0);
            if (sym && sym.endsWith('USDT')) {
              const prev = latestIncomeBySym.get(sym) || 0;
              if (incTime > prev) latestIncomeBySym.set(sym, incTime);
            }
          }
        }
        const priorityCleanSymbols = new Set<string>();
        for (const rawSym of knownSymbols.slice(0, 10)) {
          const cleanSym = pairToCleanSymbol(rawSym);
          if (cleanSym.endsWith('USDT') || cleanSym.endsWith('USDC')) {
            priorityCleanSymbols.add(cleanSym);
            if (!latestIncomeBySym.has(cleanSym)) {
              latestIncomeBySym.set(cleanSym, Date.now());
            }
          }
        }

        const closed: ExchangeClosedPnlItem[] = [];
        const coveredSymbolsWithUserTrades = new Set<string>();
        const uncachedSymbols: string[] = [];

        for (const [sym, latestTs] of latestIncomeBySym.entries()) {
          const symCacheKey = `${cleanKey}:${baseUrl}:${sym}`;
          const cachedSym = binanceSymbolTradesCache.get(symCacheKey);
          if (cachedSym && cachedSym.latestIncomeTs >= latestTs && !priorityCleanSymbols.has(sym)) {
            if (cachedSym.items.length > 0) {
              coveredSymbolsWithUserTrades.add(sym);
              closed.push(...cachedSym.items);
            }
          } else {
            uncachedSymbols.push(sym);
          }
        }

        // Ставим запрошенные известные символы (disappearedTrades) в абсолютный приоритет
        uncachedSymbols.sort((a, b) => {
          const aPrio = priorityCleanSymbols.has(a) ? 1 : 0;
          const bPrio = priorityCleanSymbols.has(b) ? 1 : 0;
          if (aPrio !== bPrio) return bPrio - aPrio;
          return (latestIncomeBySym.get(b) || 0) - (latestIncomeBySym.get(a) || 0);
        });

        const symbolArr = uncachedSymbols.slice(0, 6);
        const batchSize = 3;
        for (let i = 0; i < symbolArr.length; i += batchSize) {
          const batch = symbolArr.slice(i, i + batchSize);
          await Promise.all(
            batch.map(async (sym) => {
              try {
                if (isBinanceHostRateLimited(baseUrl).limited) return;
                const uTs = await getBinanceTimestamp(false, baseUrl);
                const uQuery = `symbol=${sym}&limit=100&timestamp=${uTs}&recvWindow=10000`;
                const uSig = signBinanceFuturesQuery(uQuery, cleanSecret);
                const uRes = await makeHttpsRequest(
                  `${baseUrl}/fapi/v1/userTrades?${uQuery}&signature=${uSig}`,
                  {
                    method: 'GET',
                    headers: { 'X-MBX-APIKEY': cleanKey },
                    timeoutMs: 5000,
                  }
                );
                if (uRes.statusCode !== 200) return;
                const trades = JSON.parse(uRes.data);
                if (!Array.isArray(trades) || trades.length === 0) {
                  binanceSymbolTradesCache.set(`${cleanKey}:${baseUrl}:${sym}`, {
                    latestIncomeTs: latestIncomeBySym.get(sym) || Date.now(),
                    items: [],
                  });
                  return;
                }

                const sortedTrades = [...trades].sort(
                  (a, b) => Number(a.time || 0) - Number(b.time || 0)
                );

                // Группируем закрывающие сделки (realizedPnl !== 0) по orderId и суммируем фактическую комиссию входа
                const byOrder = new Map<
                  string,
                  {
                    orderId: string;
                    symbol: string;
                    side: string;
                    positionSide: string;
                    qty: number;
                    notional: number;
                    grossPnl: number;
                    openFee: number;
                    closeFee: number;
                    openTime: number;
                    time: number;
                  }
                >();

                let pendingOpenFee = 0;
                let pendingOpenTime = 0;

                for (const t of sortedTrades) {
                  const rPnl = Number(t.realizedPnl || 0);
                  const qty = Math.abs(Number(t.qty || 0));
                  const price = Number(t.price || 0);
                  const fee = Math.abs(Number(t.commission || 0));
                  const time = Number(t.time || Date.now());

                  if (Math.abs(rPnl) < 1e-8) {
                    pendingOpenFee += fee;
                    if (!pendingOpenTime || time < pendingOpenTime) {
                      pendingOpenTime = time;
                    }
                    continue;
                  }

                  const ordId = String(t.orderId || t.id || `${sym}-${time}`);
                  const existing = byOrder.get(ordId);
                  if (existing) {
                    existing.qty += qty;
                    existing.notional += qty * price;
                    existing.grossPnl += rPnl;
                    existing.closeFee += fee;
                    if (time > existing.time) existing.time = time;
                  } else {
                    byOrder.set(ordId, {
                      orderId: ordId,
                      symbol: sym,
                      side: String(t.side || '').toUpperCase(),
                      positionSide: String(t.positionSide || '').toUpperCase(),
                      qty,
                      notional: qty * price,
                      grossPnl: rPnl,
                      openFee: pendingOpenFee,
                      closeFee: fee,
                      openTime: pendingOpenTime > 0 ? pendingOpenTime : time - 60_000,
                      time,
                    });
                    pendingOpenFee = 0;
                    pendingOpenTime = 0;
                  }
                }

                const symItems: ExchangeClosedPnlItem[] = [];
                for (const grp of byOrder.values()) {
                  if (!(grp.qty > 0) || !(grp.notional > 0)) continue;
                  coveredSymbolsWithUserTrades.add(sym);
                  const exitPrice = grp.notional / grp.qty;
                  const isShort =
                    grp.positionSide === 'SHORT'
                      ? true
                      : grp.positionSide === 'LONG'
                      ? false
                      : grp.side === 'BUY';
                  const rawEntryPrice = isShort
                    ? exitPrice + grp.grossPnl / grp.qty
                    : exitPrice - grp.grossPnl / grp.qty;
                  const entryPrice = rawEntryPrice > 0 ? rawEntryPrice : exitPrice;
                  const openFee = Number(
                    (grp.openFee > 0 ? grp.openFee : entryPrice * grp.qty * 0.0005).toFixed(4)
                  );
                  const closeFee = Number(
                    (grp.closeFee > 0 ? grp.closeFee : exitPrice * grp.qty * 0.0005).toFixed(4)
                  );
                  const netClosedPnl = grp.grossPnl - openFee - closeFee;
                  const itemObj: ExchangeClosedPnlItem = {
                    order_id: grp.orderId,
                    pair: symbolToFreqtradePair(sym),
                    symbol: sym,
                    is_short: isShort,
                    qty: Number(grp.qty.toFixed(6)),
                    entry_price: Number(entryPrice.toPrecision(8)),
                    exit_price: Number(exitPrice.toPrecision(8)),
                    leverage: 25,
                    closed_pnl: Number(netClosedPnl.toFixed(4)),
                    open_fee: openFee,
                    close_fee: closeFee,
                    created_time: grp.openTime,
                    updated_time: grp.time,
                  };
                  symItems.push(itemObj);
                  closed.push(itemObj);
                }
                binanceSymbolTradesCache.set(`${cleanKey}:${baseUrl}:${sym}`, {
                  latestIncomeTs: latestIncomeBySym.get(sym) || Date.now(),
                  items: symItems,
                });
              } catch {
                // ignore symbol error
              }
            })
          );
        }

        // Резервное восстановление из /fapi/v1/income (REALIZED_PNL), если по каким-то символам userTrades не вернул детали:
        // НИКОГДА не подставляем вымышленные entry_price: 100 / exit_price: 100+pnl — передаём 0, чтобы использовались реальные цены сделки!
        if (Array.isArray(incomeList)) {
          const commByKey = new Map<string, number>();
          if (Array.isArray(commList)) {
            for (const c of commList) {
              const cSym = String(c.symbol || '').toUpperCase();
              const cBucket = Math.floor(Number(c.time || 0) / 5000);
              const k = `${cSym}:${cBucket}`;
              commByKey.set(k, (commByKey.get(k) || 0) + Math.abs(Number(c.income || 0)));
            }
          }

          const incGroups = new Map<
            string,
            { sym: string; grossPnl: number; time: number; tranId: string }
          >();
          for (const inc of incomeList) {
            const sym = String(inc.symbol || '').trim().toUpperCase();
            const gross = Number(inc.income || 0);
            const time = Number(inc.time || 0);
            if (!sym || (!sym.endsWith('USDT') && !sym.endsWith('USDC')) || Math.abs(gross) < 1e-8) continue;
            if (coveredSymbolsWithUserTrades.has(sym)) continue;
            const bucket = Math.floor(time / 5000);
            const gKey = `${sym}:${bucket}`;
            const ex = incGroups.get(gKey);
            if (ex) {
              ex.grossPnl += gross;
              if (time > ex.time) ex.time = time;
            } else {
              incGroups.set(gKey, {
                sym,
                grossPnl: gross,
                time,
                tranId: String(inc.tranId || inc.tradeId || `${sym}-${time}`),
              });
            }
          }

          for (const [gKey, grp] of incGroups.entries()) {
            const closeFee = Number((commByKey.get(gKey) || Math.abs(grp.grossPnl) * 0.04).toFixed(4));
            const openFee = closeFee;
            const netClosedPnl = grp.grossPnl - openFee - closeFee;
            closed.push({
              order_id: `inc-${grp.tranId}`,
              pair: symbolToFreqtradePair(grp.sym),
              symbol: grp.sym,
              is_short: false,
              qty: 0,
              entry_price: 0,
              exit_price: 0,
              leverage: 25,
              closed_pnl: Number(netClosedPnl.toFixed(4)),
              open_fee: openFee,
              close_fee: closeFee,
              created_time: grp.time - 60_000,
              updated_time: grp.time,
            });
          }
        }

        closed.sort((a, b) => b.updated_time - a.updated_time);
        const slicedClosed = closed.slice(0, Math.max(limit, 100));
        binanceClosedPnlCache.set(cleanKey, {
          timestamp: Date.now(),
          closed: slicedClosed,
        });
        return { success: true, closed: slicedClosed };
      } catch {
        // try next host
      }
    }
    if (cachedClosed) {
      return { success: true, closed: cachedClosed.closed };
    }
    return { success: false, closed: [] };
  }

  // 3. OKX V5 (/api/v5/account/positions-history?instType=SWAP)
  if (creds.exchange === 'okx') {
    const cleanPass = String(creds.passphrase || '').trim();
    if (!cleanPass) return { success: false, closed: [] };
    const isDemo = creds.isTestnet ?? okxDemoCache.get(cleanKey) ?? false;
    try {
      const isoTimestamp = new Date().toISOString();
      const requestPath = `/api/v5/account/positions-history?instType=SWAP&limit=${Math.min(100, Math.max(10, limit))}`;
      const preHash = `${isoTimestamp}GET${requestPath}`;
      const signature = crypto.createHmac('sha256', cleanSecret).update(preHash).digest('base64');
      const headers: Record<string, string> = {
        'OK-ACCESS-KEY': cleanKey,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': isoTimestamp,
        'OK-ACCESS-PASSPHRASE': cleanPass,
        'Content-Type': 'application/json',
      };
      if (isDemo) headers['x-simulated-trading'] = '1';
      const res = await makeHttpsRequest(`https://www.okx.com${requestPath}`, {
        method: 'GET',
        headers,
        timeoutMs: 6500,
      });
      if (res.statusCode === 200) {
        const json = JSON.parse(res.data);
        if (json.code === '0' && Array.isArray(json.data)) {
          const closed: ExchangeClosedPnlItem[] = [];
          for (const item of json.data) {
            const instId = String(item.instId || '');
            const qty = Math.abs(Number(item.closeTotalPos || item.openMaxPos || 0));
            const entryPrice = Number(item.openAvgPx || 0);
            const exitPrice = Number(item.closeAvgPx || 0);
            if (!instId || !(qty > 0) || !(entryPrice > 0) || !(exitPrice > 0)) continue;
            const isShort = String(item.direction || '').toLowerCase() === 'short';
            const lev = Math.max(1, Math.round(Number(item.lever || 25)));
            const closedPnl = Number(item.realizedPnl || item.pnl || 0);
            const totalFee = Math.abs(Number(item.fee || (entryPrice + exitPrice) * qty * 0.0005));
            const cTime = Number(item.cTime || Date.now());
            const uTime = Number(item.uTime || cTime);
            closed.push({
              order_id: String(item.posId || `${instId}-${uTime}`),
              pair: symbolToFreqtradePair(instId),
              symbol: instId,
              is_short: isShort,
              qty,
              entry_price: entryPrice,
              exit_price: exitPrice,
              leverage: lev,
              closed_pnl: Number(closedPnl.toFixed(4)),
              open_fee: Number((totalFee / 2).toFixed(4)),
              close_fee: Number((totalFee / 2).toFixed(4)),
              created_time: cTime,
              updated_time: uTime,
            });
          }
          return { success: true, closed };
        }
      }
    } catch {
      // ignore
    }
    return { success: false, closed: [] };
  }

  // 4. BITGET V2 (/api/v2/mix/position/history-position?productType=USDT-FUTURES)
  if (creds.exchange === 'bitget') {
    const cleanPass = String(creds.passphrase || '').trim();
    if (!cleanPass) return { success: false, closed: [] };
    const isDemo = creds.isTestnet ?? bitgetDemoCache.get(cleanKey) ?? false;
    try {
      const timestamp = Date.now().toString();
      const requestPath = `/api/v2/mix/position/history-position?productType=USDT-FUTURES&limit=${Math.min(100, Math.max(10, limit))}`;
      const preHash = `${timestamp}GET${requestPath}`;
      const signature = crypto.createHmac('sha256', cleanSecret).update(preHash).digest('base64');
      const headers: Record<string, string> = {
        'ACCESS-KEY': cleanKey,
        'ACCESS-SIGN': signature,
        'ACCESS-TIMESTAMP': timestamp,
        'ACCESS-PASSPHRASE': cleanPass,
        'Content-Type': 'application/json',
        locale: 'en-US',
      };
      if (isDemo) headers.paptrading = '1';
      const res = await makeHttpsRequest(`https://api.bitget.com${requestPath}`, {
        method: 'GET',
        headers,
        timeoutMs: 6500,
      });
      if (res.statusCode === 200) {
        const json = JSON.parse(res.data);
        const list = json.data?.list || json.data;
        if (json.code === '00000' && Array.isArray(list)) {
          const closed: ExchangeClosedPnlItem[] = [];
          for (const item of list) {
            const sym = String(item.symbol || '');
            const qty = Math.abs(Number(item.closeTotalPos || item.openTotalPos || 0));
            const entryPrice = Number(item.openAvgPrice || 0);
            const exitPrice = Number(item.closeAvgPrice || 0);
            if (!sym || !(qty > 0) || !(entryPrice > 0) || !(exitPrice > 0)) continue;
            const isShort = String(item.holdSide || '').toLowerCase() === 'short';
            const closedPnl = Number(item.netProfit || item.pnl || 0);
            const openFee = Math.abs(Number(item.openFee || entryPrice * qty * 0.0006));
            const closeFee = Math.abs(Number(item.closeFee || exitPrice * qty * 0.0006));
            const cTime = Number(item.ctime || item.cTime || Date.now());
            const uTime = Number(item.utime || item.uTime || cTime);
            closed.push({
              order_id: String(item.positionId || `${sym}-${uTime}`),
              pair: symbolToFreqtradePair(sym),
              symbol: sym,
              is_short: isShort,
              qty,
              entry_price: entryPrice,
              exit_price: exitPrice,
              leverage: 25,
              closed_pnl: Number(closedPnl.toFixed(4)),
              open_fee: Number(openFee.toFixed(4)),
              close_fee: Number(closeFee.toFixed(4)),
              created_time: cTime,
              updated_time: uTime,
            });
          }
          return { success: true, closed };
        }
      }
    } catch {
      // ignore
    }
    return { success: false, closed: [] };
  }

  // 5. BINGX SWAP V2 (/openApi/swap/v2/trade/allOrders)
  if (creds.exchange === 'bingx') {
    try {
      const timestamp = Date.now();
      const query = `limit=${Math.min(100, Math.max(10, limit))}&timestamp=${timestamp}`;
      const signature = crypto.createHmac('sha256', cleanSecret).update(query).digest('hex');
      const res = await makeHttpsRequest(
        `https://open-api.bingx.com/openApi/swap/v2/trade/allOrders?${query}&signature=${signature}`,
        {
          method: 'GET',
          headers: { 'X-BX-APIKEY': cleanKey },
          timeoutMs: 6500,
        }
      );
      if (res.statusCode === 200) {
        const json = JSON.parse(res.data);
        const orders = json.data?.orders || json.data;
        if (json.code === 0 && Array.isArray(orders)) {
          const closed: ExchangeClosedPnlItem[] = [];
          for (const o of orders) {
            const profit = Number(o.profit || 0);
            if (Math.abs(profit) < 1e-8) continue;
            const sym = String(o.symbol || '');
            const qty = Math.abs(Number(o.executedQty || o.origQty || 0));
            const exitPrice = Number(o.avgPrice || o.price || 0);
            if (!sym || !(qty > 0) || !(exitPrice > 0)) continue;
            const posSide = String(o.positionSide || '').toUpperCase();
            const side = String(o.side || '').toUpperCase();
            const isShort = posSide === 'SHORT' ? true : posSide === 'LONG' ? false : side === 'BUY';
            const rawEntry = isShort ? exitPrice + profit / qty : exitPrice - profit / qty;
            const entryPrice = rawEntry > 0 ? rawEntry : exitPrice;
            const closeFee = Math.abs(Number(o.commission || exitPrice * qty * 0.0005));
            const openFee = Number((entryPrice * qty * 0.0005).toFixed(4));
            const netClosed = profit - openFee - closeFee;
            const uTime = Number(o.updateTime || o.time || Date.now());
            closed.push({
              order_id: String(o.orderId || `${sym}-${uTime}`),
              pair: symbolToFreqtradePair(sym),
              symbol: sym,
              is_short: isShort,
              qty,
              entry_price: Number(entryPrice.toPrecision(8)),
              exit_price: Number(exitPrice.toPrecision(8)),
              leverage: Math.max(1, Math.round(Number(o.leverage || 25))),
              closed_pnl: Number(netClosed.toFixed(4)),
              open_fee: openFee,
              close_fee: Number(closeFee.toFixed(4)),
              created_time: Number(o.time || uTime - 60_000),
              updated_time: uTime,
            });
          }
          return { success: true, closed };
        }
      }
    } catch {
      // ignore
    }
    return { success: false, closed: [] };
  }

  return { success: false, closed: [] };
}

/**
 * Выставляет или обновляет биржевой ордер Take-Profit напрямую на позиции биржи (Bybit V5 /v5/position/trading-stop, Binance /fapi/v1/order TAKE_PROFIT_MARKET).
 * Обеспечивает закрытие позиции на стороне биржи без сетевой задержки и расхождения цен.
 */
export async function placeOrUpdateExchangeTakeProfitOrder(
  creds: ExchangeCredentials,
  params: {
    pair: string;
    isShort: boolean;
    quantity: number;
    takeProfitPrice: number;
  }
): Promise<{
  success: boolean;
  exchange: string;
  symbol: string;
  take_profit_price: number;
  message?: string;
}> {
  const cleanKey = sanitizeCredentialString(creds.apiKey);
  const cleanSecret = sanitizeCredentialString(creds.apiSecret);
  const symbol = String(params.pair || '')
    .toUpperCase()
    .split(':')[0]
    .replace(/[^A-Z0-9]/g, '');
  const tpNum = Number(params.takeProfitPrice || 0);

  if (!cleanKey || !cleanSecret || !(tpNum > 0)) {
    return {
      success: false,
      exchange: creds.exchange,
      symbol,
      take_profit_price: tpNum,
      message: 'Invalid credentials or takeProfitPrice',
    };
  }

  // Форматируем цену TP строго по биржевому шагу цены (tickSize / pricePrecision) конкретной пары
  const formatTpPriceForHost = async (
    exchange: SupportedExchange,
    rawPrice: number,
    baseUrl?: string
  ): Promise<string> => {
    let tickSize = 0;
    let maxPrecision: number | undefined;

    if (exchange === 'bybit') {
      const host = baseUrl || 'https://api.bybit.com';
      const hostMap = await ensureBybitInstrumentsInfo(host);
      let meta = hostMap.get(symbol);
      if (!meta && host !== 'https://api.bybit.com') {
        const mainMap = await ensureBybitInstrumentsInfo('https://api.bybit.com');
        meta = mainMap.get(symbol);
      }
      if (meta && meta.tickSize > 0) {
        tickSize = meta.tickSize;
      }
    } else if (exchange === 'binance') {
      const host = baseUrl || 'https://fapi.binance.com';
      const hostMap = await ensureBinanceExchangeInfo(host);
      let meta = hostMap.get(symbol);
      if (!meta && host !== 'https://fapi.binance.com') {
        const mainMap = await ensureBinanceExchangeInfo('https://fapi.binance.com');
        meta = mainMap.get(symbol);
      }
      if (meta && meta.tickSize > 0) {
        tickSize = meta.tickSize;
        if (typeof meta.pricePrecision === 'number' && meta.pricePrecision >= 0) {
          maxPrecision = meta.pricePrecision;
        }
      }
    }

    if (!(tickSize > 0)) {
      if (rawPrice >= 10000) tickSize = 0.1;
      else if (rawPrice >= 50) tickSize = 0.01;
      else if (rawPrice >= 1) tickSize = 0.001;
      else if (rawPrice >= 0.1) tickSize = 0.0001;
      else if (rawPrice >= 0.005) tickSize = 0.00001;
      else tickSize = 0.000001;
    }

    const tickDecimals = countStepDecimals(tickSize);
    const decimals =
      maxPrecision !== undefined ? Math.min(tickDecimals, maxPrecision) : tickDecimals;
    const effectiveTick = decimals < tickDecimals ? Math.pow(10, -decimals) : tickSize;
    const steps = params.isShort
      ? Math.floor((rawPrice + 1e-12) / effectiveTick)
      : Math.ceil((rawPrice - 1e-12) / effectiveTick);
    const aligned = Math.max(effectiveTick, steps * effectiveTick);
    return aligned.toFixed(decimals);
  };

  let formattedTp = await formatTpPriceForHost(creds.exchange, tpNum);

  // 1. BYBIT V5 (/v5/position/trading-stop)
  if (creds.exchange === 'bybit') {
    const candidateHosts = getBybitCandidateHosts(cleanKey, creds.isTestnet);
    for (const baseUrl of candidateHosts) {
      try {
        formattedTp = await formatTpPriceForHost('bybit', tpNum, baseUrl);
        const sendBybitTradingStop = async (
          positionIdx: 0 | 1 | 2,
          tpPriceStr = formattedTp,
          forceTimeSync = false
        ) => {
          const timestamp = await getBybitTimestamp(baseUrl, forceTimeSync);
          const recvWindow = '15000';
          const bodyObj = {
            category: 'linear',
            symbol,
            takeProfit: tpPriceStr,
            tpTriggerBy: 'MarkPrice',
            tpslMode: 'Full',
            tpOrderType: 'Market',
            positionIdx,
          };
          const bodyStr = JSON.stringify(bodyObj);
          const signature = signBybitV5(timestamp, cleanKey, recvWindow, bodyStr, cleanSecret);
          return makeHttpsRequest(`${baseUrl}/v5/position/trading-stop`, {
            method: 'POST',
            headers: {
              'X-BAPI-API-KEY': cleanKey,
              'X-BAPI-TIMESTAMP': timestamp,
              'X-BAPI-SIGN': signature,
              'X-BAPI-RECV-WINDOW': recvWindow,
              'Content-Type': 'application/json',
            },
            body: bodyStr,
            timeoutMs: 6000,
          });
        };

        const cachedHedge = bybitHedgeModeCache.get(cleanKey) === true;
        let activePosIdx: 0 | 1 | 2 = cachedHedge ? (params.isShort ? 2 : 1) : 0;
        let res = await sendBybitTradingStop(activePosIdx, formattedTp, false);
        if (res.statusCode === 200) {
          let json = JSON.parse(res.data);
          if (json.retCode === 10002) {
            res = await sendBybitTradingStop(activePosIdx, formattedTp, true);
            if (res.statusCode === 200) {
              json = JSON.parse(res.data);
            }
          }
          // Если аккаунт Bybit в Hedge Mode или наоборот One-Way Mode (retCode 10001: positionIdx not match position mode)
          if (
            json.retCode === 10001 &&
            String(json.retMsg || '')
              .toLowerCase()
              .includes('position')
          ) {
            if (activePosIdx === 0) {
              activePosIdx = params.isShort ? 2 : 1;
              bybitHedgeModeCache.set(cleanKey, true);
            } else {
              activePosIdx = 0;
              bybitHedgeModeCache.set(cleanKey, false);
            }
            const retryRes = await sendBybitTradingStop(activePosIdx, formattedTp, false);
            if (retryRes.statusCode === 200) {
              json = JSON.parse(retryRes.data);
            }
          }
          // Если ошибка шага цены tickSize — обновляем справочник инструментов Bybit и повторяем
          if (json.retCode === 10001) {
            await ensureBybitInstrumentsInfo(baseUrl, true);
            formattedTp = await formatTpPriceForHost('bybit', tpNum, baseUrl);
            const retryTickRes = await sendBybitTradingStop(activePosIdx, formattedTp, false);
            if (retryTickRes.statusCode === 200) {
              json = JSON.parse(retryTickRes.data);
            }
          }
          // retCode 0 = успех, retCode 34040 = "not modified" (уже стоит такой же TP)
          if (json.retCode === 0 || json.retCode === 34040) {
            bybitHostCache.set(cleanKey, baseUrl);
            return {
              success: true,
              exchange: 'bybit',
              symbol,
              take_profit_price: Number(formattedTp),
              message: `Bybit TP установлен: ${formattedTp}`,
            };
          }
          if (json.retCode === 10003 || json.retCode === 10004 || json.retCode === 33004) {
            continue;
          }
          return {
            success: false,
            exchange: 'bybit',
            symbol,
            take_profit_price: Number(formattedTp),
            message: `Bybit TP [${json.retCode}]: ${json.retMsg}`,
          };
        }
      } catch {
        // ignore and try next host
      }
    }
    return {
      success: false,
      exchange: 'bybit',
      symbol,
      take_profit_price: Number(formattedTp),
    };
  }

  // 2. BINANCE USDⓈ-M FUTURES (WebSocket API ws-fapi order.place TAKE_PROFIT_MARKET + REST & AlgoOrder fallback)
  if (creds.exchange === 'binance') {
    const candidateHosts = getBinanceCandidateHosts(cleanKey, creds.isTestnet);
    for (const baseUrl of candidateHosts) {
      try {
        formattedTp = await formatTpPriceForHost('binance', tpNum, baseUrl);
        let dualSide = await getBinanceDualSideMode(cleanKey, cleanSecret, false, baseUrl);
        const side = params.isShort ? 'BUY' : 'SELL';
        const targetPosSide = params.isShort ? 'SHORT' : 'LONG';

        // Отменяем старые открытые TP-ордера по этому символу/стороне перед установкой нового TP (иначе Binance даёт -4130 или дублирует ордер)
        try {
          if (!isBinanceHostRateLimited(baseUrl).limited) {
            const openTs = await getBinanceTimestamp(false, baseUrl);
            const openQuery = `symbol=${encodeURIComponent(symbol)}&timestamp=${openTs}&recvWindow=10000`;
            const openSig = signBinanceFuturesQuery(openQuery, cleanSecret);
            const openRes = await makeHttpsRequest(
              `${baseUrl}/fapi/v1/openOrders?${openQuery}&signature=${openSig}`,
              {
                method: 'GET',
                headers: { 'X-MBX-APIKEY': cleanKey },
                timeoutMs: 5000,
              }
            );
            if (openRes.statusCode === 200) {
              const openList = JSON.parse(openRes.data);
              if (Array.isArray(openList)) {
                const staleTpOrders = openList.filter((o: any) => {
                  const ordType = String(o.type || '').toUpperCase();
                  if (!ordType.includes('TAKE_PROFIT')) return false;
                  if (dualSide && o.positionSide) {
                    return String(o.positionSide).toUpperCase() === targetPosSide;
                  }
                  return String(o.side || '').toUpperCase() === side;
                });
                const wsRpcCancel = getBinanceWsRpcClient(baseUrl);
                for (const staleOrd of staleTpOrders) {
                  const ordId = staleOrd.orderId;
                  if (!ordId) continue;
                  const cTs = await getBinanceTimestamp(false, baseUrl);
                  const wsCancelRes = await wsRpcCancel
                    .request(
                      'order.cancel',
                      { apiKey: cleanKey, symbol, orderId: ordId, timestamp: cTs, recvWindow: 10000 },
                      cleanSecret,
                      4000
                    )
                    .catch(() => null);
                  if (!wsCancelRes || wsCancelRes.status !== 200) {
                    const cQuery = `symbol=${encodeURIComponent(symbol)}&orderId=${ordId}&timestamp=${cTs}&recvWindow=10000`;
                    const cSig = signBinanceFuturesQuery(cQuery, cleanSecret);
                    await makeHttpsRequest(`${baseUrl}/fapi/v1/order?${cQuery}&signature=${cSig}`, {
                      method: 'DELETE',
                      headers: { 'X-MBX-APIKEY': cleanKey },
                      timeoutMs: 5000,
                    }).catch(() => {});
                  }
                }
              }
            }
          }
        } catch {
          // best-effort cancel before placing updated TP
        }

        const wsRpc = getBinanceWsRpcClient(baseUrl);
        const tryWsTpOrder = async (useDual: boolean, stopPriceStr: string) => {
          const ts = await getBinanceTimestamp(false, baseUrl);
          const wsTpParams: Record<string, string | number> = {
            apiKey: cleanKey,
            symbol,
            side,
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: stopPriceStr,
            closePosition: 'true',
            workingType: 'MARK_PRICE',
            timestamp: ts,
            recvWindow: 10000,
          };
          if (useDual) {
            wsTpParams.positionSide = targetPosSide;
          }
          return wsRpc.request('order.place', wsTpParams, cleanSecret, 5500);
        };

        let wsTpRes = await tryWsTpOrder(dualSide, formattedTp);
        if (wsTpRes.status !== 200 && wsTpRes.error?.code === -4061) {
          dualSide = !dualSide;
          binanceDualSideCache.set(cleanKey, { dualSide, updatedAt: Date.now() });
          wsTpRes = await tryWsTpOrder(dualSide, formattedTp);
        }
        if (
          wsTpRes.status !== 200 &&
          (wsTpRes.error?.code === -1111 || wsTpRes.error?.code === -4014)
        ) {
          await ensureBinanceExchangeInfo(baseUrl, true);
          formattedTp = await formatTpPriceForHost('binance', tpNum, baseUrl);
          wsTpRes = await tryWsTpOrder(dualSide, formattedTp);
        }
        if (wsTpRes.status === 200) {
          binanceHostCache.set(cleanKey, baseUrl);
          return {
            success: true,
            exchange: 'binance',
            symbol,
            take_profit_price: Number(formattedTp),
            message: `Binance TP установлен [WS]: ${formattedTp}`,
          };
        }

        if (isBinanceHostRateLimited(baseUrl).limited) continue;

        const sendRestTpOrder = async (useDual: boolean, stopPriceStr: string) => {
          const ts = await getBinanceTimestamp(false, baseUrl);
          const qp = new URLSearchParams({
            symbol,
            side,
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: stopPriceStr,
            closePosition: 'true',
            workingType: 'MARK_PRICE',
            timestamp: String(ts),
            recvWindow: '10000',
          });
          if (useDual) {
            qp.set('positionSide', targetPosSide);
          }
          const query = qp.toString();
          const sig = signBinanceFuturesQuery(query, cleanSecret);
          return makeHttpsRequest(`${baseUrl}/fapi/v1/order?${query}&signature=${sig}`, {
            method: 'POST',
            headers: {
              'X-MBX-APIKEY': cleanKey,
              'Content-Type': 'application/json',
            },
            timeoutMs: 6000,
          });
        };

        let res = await sendRestTpOrder(dualSide, formattedTp);
        if (res.statusCode !== 200 && res.data.includes('-4061')) {
          dualSide = !dualSide;
          binanceDualSideCache.set(cleanKey, { dualSide, updatedAt: Date.now() });
          res = await sendRestTpOrder(dualSide, formattedTp);
        }
        if (res.statusCode !== 200 && (res.data.includes('-1111') || res.data.includes('-4014'))) {
          await ensureBinanceExchangeInfo(baseUrl, true);
          formattedTp = await formatTpPriceForHost('binance', tpNum, baseUrl);
          res = await sendRestTpOrder(dualSide, formattedTp);
        }
        // Если Binance требует Algo Order API (-4120) для условного TAKE_PROFIT_MARKET
        if (res.statusCode !== 200 && res.data.includes('-4120')) {
          const algoTs = await getBinanceTimestamp(false, baseUrl);
          const algoQp = new URLSearchParams({
            algoType: 'CONDITIONAL',
            symbol,
            side,
            type: 'TAKE_PROFIT_MARKET',
            triggerPrice: formattedTp,
            closePosition: 'true',
            workingType: 'MARK_PRICE',
            timestamp: String(algoTs),
            recvWindow: '10000',
          });
          if (dualSide) {
            algoQp.set('positionSide', targetPosSide);
          }
          const algoQuery = algoQp.toString();
          const algoSig = signBinanceFuturesQuery(algoQuery, cleanSecret);
          res = await makeHttpsRequest(
            `${baseUrl}/fapi/v1/algoOrder?${algoQuery}&signature=${algoSig}`,
            {
              method: 'POST',
              headers: {
                'X-MBX-APIKEY': cleanKey,
                'Content-Type': 'application/json',
              },
              timeoutMs: 6000,
            }
          );
        }
        if (res.statusCode === 200) {
          binanceHostCache.set(cleanKey, baseUrl);
          return {
            success: true,
            exchange: 'binance',
            symbol,
            take_profit_price: Number(formattedTp),
            message: `Binance TP установлен: ${formattedTp}`,
          };
        }
      } catch {
        // ignore
      }
    }
    return {
      success: false,
      exchange: 'binance',
      symbol,
      take_profit_price: Number(formattedTp),
    };
  }

  return {
    success: true,
    exchange: creds.exchange,
    symbol,
    take_profit_price: Number(formattedTp),
  };
}

export function stopExchangePrivateStream(exchange: SupportedExchange, apiKey: string): void {
  const cleanKey = sanitizeCredentialString(apiKey);
  if (!cleanKey) return;
  if (exchange === 'binance' || exchange === 'bybit') {
    stopPrivateUserStream(exchange, cleanKey);
  }
}

/**
 * Прогревает кэши точности лотов, режима позиций (Hedge/One-Way), часового сдвига
 * и приватный WebSocket-поток сразу при старте/добавлении аккаунта, чтобы закрытие срабатывало без задержки.
 */
export async function prewarmExchangeAccountCaches(creds: ExchangeCredentials): Promise<void> {
  const cleanKey = sanitizeCredentialString(creds.apiKey);
  const cleanSecret = sanitizeCredentialString(creds.apiSecret);
  if (!cleanKey || !cleanSecret || isSimulatedTestApiKey(cleanKey)) return;

  if (creds.exchange === 'binance') {
    const baseUrl = getBinanceCandidateHosts(cleanKey, creds.isTestnet)[0];
    await Promise.allSettled([
      getBinanceTimestamp(false, baseUrl),
      ensureBinanceExchangeInfo(baseUrl),
      getBinanceDualSideMode(cleanKey, cleanSecret, false, baseUrl),
      ensureBinancePrivateUserStream(cleanKey, cleanSecret, baseUrl),
    ]);
  } else if (creds.exchange === 'bybit') {
    const baseUrl = getBybitCandidateHosts(cleanKey, creds.isTestnet)[0];
    await Promise.allSettled([
      getBybitTimestamp(baseUrl, false),
      ensureBybitInstrumentsInfo(baseUrl),
    ]);
    ensureBybitPrivateUserStream(cleanKey, cleanSecret, baseUrl);
    // Warm Bybit WS Trade connection proactively
    getBybitWsTradeClient(cleanKey, cleanSecret, baseUrl);
  }
}




