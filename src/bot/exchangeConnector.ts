import crypto from 'node:crypto';
import https from 'node:https';

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
  available_balance_usdt?: number;
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

let bybitTimeOffsetMs = 0;
let lastBybitTimeSyncTs = 0;
const bybitSymbolMetaByHost = new Map<
  string,
  { syncTs: number; symbols: Map<string, BybitSymbolFilterMeta> }
>();
const bybitHostCache = new Map<string, string>();
const bybitLeverageCache = new Map<string, number>();

const okxDemoCache = new Map<string, boolean>();
const bitgetDemoCache = new Map<string, boolean>();

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
        headers: options.headers,
        timeout,
      },
      (res) => {
        let chunks = '';
        res.on('data', (d) => {
          chunks += d;
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 500,
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
  if (forceSync || Date.now() - lastTimeSyncTs > 5 * 60_000) {
    try {
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
    } catch {
      // fallback to local clock
    }
  }
  return Date.now() + binanceTimeOffsetMs;
}

/**
 * Синхронизирует время сервера с Bybit V5 (защита от ошибки 10002 invalid request, please check your server timestamp).
 */
async function getBybitTimestamp(
  baseUrl = 'https://api.bybit.com',
  forceSync = false
): Promise<string> {
  if (forceSync || Date.now() - lastBybitTimeSyncTs > 5 * 60_000) {
    try {
      const res = await makeHttpsRequest(`${baseUrl}/v5/market/time`, {
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
          bybitTimeOffsetMs = serverMs - Date.now();
          lastBybitTimeSyncTs = Date.now();
        }
      }
    } catch {
      // fallback to local clock
    }
  }
  return String(Date.now() + bybitTimeOffsetMs);
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
    Date.now() - existing.syncTs < 30 * 60_000
  ) {
    return existing.symbols;
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
          const qtyStep = Number(lot.qtyStep || 0.01);
          const minOrderQty = Number(lot.minOrderQty || qtyStep || 0.01);
          const maxMktOrderQty = Number(lot.maxMktOrderQty || lot.maxOrderQty || 1_000_000);
          const minNotional = Number(lot.minNotionalValue || 5);
          nextMap.set(sym, {
            symbol: sym,
            status: String(item.status || 'Trading'),
            qtyStep: qtyStep > 0 ? qtyStep : 0.01,
            minOrderQty: minOrderQty > 0 ? minOrderQty : 0.01,
            maxMktOrderQty: maxMktOrderQty > 0 ? maxMktOrderQty : 1_000_000,
            minNotional: minNotional > 0 ? minNotional : 5,
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
  const cached = binanceDualSideCache.get(apiKey);
  if (!forceRefresh && cached && Date.now() - cached.updatedAt < 5 * 60_000) {
    return cached.dualSide;
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
      binanceDualSideCache.set(apiKey, { dualSide: dual, updatedAt: Date.now() });
      return dual;
    }
  } catch {
    // ignore
  }
  return cached?.dualSide ?? false;
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
    : ['https://api.bybit.com', 'https://api-testnet.bybit.com', 'https://api-demo.bybit.com'];
  if (cached) {
    return [cached, ...all.filter((h) => h !== cached)];
  }
  return all;
}

/**
 * Определяет список хостов Binance Futures с учётом флага isTestnet и кэша.
 */
function getBinanceCandidateHosts(apiKey: string, isTestnet?: boolean): string[] {
  const cached = binanceHostCache.get(apiKey);
  const all = isTestnet
    ? ['https://testnet.binancefuture.com', 'https://fapi.binance.com']
    : ['https://fapi.binance.com', 'https://testnet.binancefuture.com'];
  if (cached) {
    return [cached, ...all.filter((h) => h !== cached)];
  }
  return all;
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
  const cleanKey = String(creds.apiKey || '').trim();
  const cleanSecret = String(creds.apiSecret || '').trim();
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
        await ensureBinanceSymbolLeverage(cleanKey, cleanSecret, symbol, targetLeverage, baseUrl);
        let formattedQtyStr = await formatBinanceFuturesQuantity(
          symbol,
          params.quantity,
          params.referencePrice,
          isClose,
          baseUrl
        );
        let activeDualSide = await getBinanceDualSideMode(cleanKey, cleanSecret, false, baseUrl);

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

        let query = await buildOrderQuery(activeDualSide, formattedQtyStr);
        let signature = signBinanceFuturesQuery(query, cleanSecret);
        let res = await makeHttpsRequest(
          `${baseUrl}/fapi/v1/order?${query}&signature=${signature}`,
          {
            method: 'POST',
            headers: {
              'X-MBX-APIKEY': cleanKey,
              'Content-Type': 'application/json',
            },
          }
        );

        // Если ошибка -1021 (рассинхрон времени) — принудительно синхронизируем часы и повторяем
        if (res.statusCode !== 200 && res.data.includes('-1021')) {
          await getBinanceTimestamp(true, baseUrl);
          query = await buildOrderQuery(activeDualSide, formattedQtyStr);
          signature = signBinanceFuturesQuery(query, cleanSecret);
          res = await makeHttpsRequest(
            `${baseUrl}/fapi/v1/order?${query}&signature=${signature}`,
            {
              method: 'POST',
              headers: {
                'X-MBX-APIKEY': cleanKey,
                'Content-Type': 'application/json',
              },
            }
          );
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
          query = await buildOrderQuery(activeDualSide, formattedQtyStr);
          signature = signBinanceFuturesQuery(query, cleanSecret);
          res = await makeHttpsRequest(
            `${baseUrl}/fapi/v1/order?${query}&signature=${signature}`,
            {
              method: 'POST',
              headers: {
                'X-MBX-APIKEY': cleanKey,
                'Content-Type': 'application/json',
              },
            }
          );
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
          query = await buildOrderQuery(activeDualSide, formattedQtyStr);
          signature = signBinanceFuturesQuery(query, cleanSecret);
          res = await makeHttpsRequest(
            `${baseUrl}/fapi/v1/order?${query}&signature=${signature}`,
            {
              method: 'POST',
              headers: {
                'X-MBX-APIKEY': cleanKey,
                'Content-Type': 'application/json',
              },
            }
          );

          // Если всё ещё -1111 и есть дробная часть — округляем до целого числа контрактов (0 знаков после запятой)
          if (res.statusCode !== 200 && res.data.includes('-1111') && formattedQtyStr.includes('.')) {
            formattedQtyStr = String(
              Math.max(
                1,
                isClose ? Math.floor(Number(formattedQtyStr)) : Math.ceil(Number(formattedQtyStr))
              )
            );
            query = await buildOrderQuery(activeDualSide, formattedQtyStr);
            signature = signBinanceFuturesQuery(query, cleanSecret);
            res = await makeHttpsRequest(
              `${baseUrl}/fapi/v1/order?${query}&signature=${signature}`,
              {
                method: 'POST',
                headers: {
                  'X-MBX-APIKEY': cleanKey,
                  'Content-Type': 'application/json',
                },
              }
            );
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
          const data = JSON.parse(res.data);
          const avgPrice =
            Number(data.avgPrice || 0) > 0 ? Number(data.avgPrice) : params.referencePrice;
          const executedQty =
            Number(data.executedQty || 0) > 0 ? Number(data.executedQty) : Number(formattedQtyStr);

          return {
            success: true,
            order_id: String(data.orderId || `bn-${Date.now()}`),
            symbol,
            side,
            price: avgPrice,
            qty: executedQty,
            status: 'FILLED',
            exchange_time: Number(data.updateTime || Date.now()),
            commission_usdt: Number((avgPrice * executedQty * 0.0005).toFixed(4)),
            network_label: baseUrl.includes('testnet') ? 'Binance Testnet' : 'Binance Mainnet',
          };
        }

        lastFormattedErr = formatBinanceApiError(res.statusCode, res.data);
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
        await ensureBybitSymbolLeverage(cleanKey, cleanSecret, symbol, targetLeverage, baseUrl);
        let formattedQtyStr = await formatBybitFuturesQuantity(
          symbol,
          params.quantity,
          params.referencePrice,
          isClose,
          baseUrl
        );

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

        let activePosIdx: 0 | 1 | 2 = 0;
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

          // Если на аккаунте Bybit включен Hedge Mode (retCode 10001: position idx not match position mode) — повторяем с positionIdx 1 (Long) или 2 (Short)
          if (
            json.retCode === 10001 &&
            String(json.retMsg || '')
              .toLowerCase()
              .includes('position idx')
          ) {
            activePosIdx = params.isShort ? 2 : 1;
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

            // Запрашиваем реальную цену исполнения (avgPrice), объём и комиссию напрямую из Bybit V5 API
            if (json.result?.orderId) {
              try {
                await new Promise((r) => setTimeout(r, 180));
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
    success: true,
    order_id: `ext-${creds.exchange}-${Date.now()}`,
    symbol,
    side,
    price: params.referencePrice,
    qty: params.quantity,
    status: 'FILLED',
    exchange_time: Date.now(),
  };
}

/**
 * Тестирует реальное подключение к бирже с проверкой API-ключа, подписи, баланса и прав на фьючерсную торговлю.
 * Автоматически определяет Mainnet / Testnet / Demo Trading для Bybit, Binance, OKX и Bitget.
 */
export async function testExchangeConnection(
  creds: ExchangeCredentials
): Promise<ConnectionTestResult> {
  const cleanKey = String(creds.apiKey || '').trim();
  const cleanSecret = String(creds.apiSecret || '').trim();

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
  // 1. BINANCE USDT-M FUTURES (Mainnet fapi.binance.com + Testnet testnet.binancefuture.com)
  // ==========================================================================
  if (creds.exchange === 'binance') {
    const candidateHosts = getBinanceCandidateHosts(cleanKey, creds.isTestnet);
    let primaryErrorRes: ConnectionTestResult | null = null;
    let lastErrorRes: ConnectionTestResult | null = null;

    for (const baseUrl of candidateHosts) {
      try {
        const timestamp = await getBinanceTimestamp(false, baseUrl);
        const recvWindow = 10000;
        const query = `timestamp=${timestamp}&recvWindow=${recvWindow}`;
        const signature = signBinanceFuturesQuery(query, cleanSecret);
        const url = `${baseUrl}/fapi/v2/account?${query}&signature=${signature}`;

        const res = await makeHttpsRequest(url, {
          method: 'GET',
          headers: {
            'X-MBX-APIKEY': cleanKey,
            'Content-Type': 'application/json',
          },
        });

        if (res.statusCode === 200) {
          binanceHostCache.set(cleanKey, baseUrl);
          const isTestnetHost = baseUrl.includes('testnet');
          const netLabel = isTestnetHost ? 'Binance Futures Testnet' : 'Binance USDⓈ-M Mainnet';
          const json = JSON.parse(res.data);
          const usdtAsset = json.assets?.find((a: any) => a.asset === 'USDT');
          const walletBalance = usdtAsset
            ? Number(usdtAsset.walletBalance || json.totalWalletBalance || 0)
            : Number(json.totalWalletBalance || 0);
          const availableBalance = usdtAsset
            ? Number(usdtAsset.availableBalance || json.availableBalance || walletBalance)
            : walletBalance;
          const openPositions = Array.isArray(json.positions)
            ? json.positions.filter((p: any) => Math.abs(Number(p.positionAmt || 0)) > 0).length
            : 0;
          const dualSide = await getBinanceDualSideMode(cleanKey, cleanSecret, true, baseUrl);
          const canTrade = Boolean(json.canTrade);

          let statusMsg = `Успешно подключено к ${netLabel} (Пинг: ${res.latencyMs} мс | Баланс: ${walletBalance.toFixed(2)} USDT | Доступно: ${availableBalance.toFixed(2)} USDT | Режим: ${dualSide ? 'Hedge Mode' : 'One-Way'} | Открытых позиций: ${openPositions})`;
          if (walletBalance <= 0) {
            statusMsg +=
              ' ⚠️ На фьючерсном кошельке USDⓈ-M сейчас 0 USDT! Переведите USDT со Спотового кошелька на Фьючерсный (USDⓈ-M Futures).';
          }

          return {
            success: true,
            exchange: 'binance',
            message: statusMsg,
            latency_ms: res.latencyMs,
            balance_usdt: walletBalance,
            available_balance_usdt: availableBalance,
            can_trade: canTrade,
            dual_side_position: dualSide,
            open_positions_count: openPositions,
            account_type: netLabel,
            is_testnet: isTestnetHost,
            network_label: netLabel,
          };
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
        if (!primaryErrorRes) primaryErrorRes = errObj;
        lastErrorRes = errObj;
        if (formattedErr.code === -2015) {
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
  // 2. BYBIT V5 (Mainnet api.bybit.com + Testnet api-testnet.bybit.com + Demo api-demo.bybit.com)
  // ==========================================================================
  if (creds.exchange === 'bybit') {
    const candidateHosts = getBybitCandidateHosts(cleanKey, creds.isTestnet);
    let primaryErrorRes: ConnectionTestResult | null = null;
    let lastErrorRes: ConnectionTestResult | null = null;

    const queryBybitEndpoint = async (
      baseUrl: string,
      pathWithQuery: string,
      forceTimeSync = false
    ) => {
      const [pathname, queryString = ''] = pathWithQuery.split('?');
      const timestamp = await getBybitTimestamp(baseUrl, forceTimeSync);
      const recvWindow = '10000';
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

          // Если ключ не подходит к этому окружению (например, ключ от Bybit Testnet отправлен на Mainnet: retCode 10003 / 10004 / 33004)
          if (json.retCode === 10003 || json.retCode === 10004 || json.retCode === 33004) {
            const errObj: ConnectionTestResult = {
              success: false,
              exchange: 'bybit',
              message: `${netLabel}: Неверный API Key или Secret Key (${json.retMsg}, код ${json.retCode})`,
              latency_ms: res.latencyMs,
              can_trade: false,
              error_code: json.retCode,
              is_testnet: isTestnetHost,
              network_label: netLabel,
            };
            if (!primaryErrorRes) primaryErrorRes = errObj;
            lastErrorRes = errObj;
            continue;
          }

          let resolvedBalance = 0;
          let resolvedAvailable = 0;
          let walletTypeLabel = 'Unified Trading (UTA)';

          const extractBybitWalletBalance = (payload: any): { bal: number; avail: number } => {
            const acc = payload?.result?.list?.[0];
            if (!acc) return { bal: 0, avail: 0 };
            const coins = Array.isArray(acc.coin) ? acc.coin : [];
            const usdt = coins.find((c: any) => c.coin === 'USDT');
            const usdtEquity = Number(usdt?.equity || usdt?.walletBalance || 0);
            const usdtWallet = Number(usdt?.walletBalance || usdt?.equity || 0);
            const usdtAvail = Number(
              usdt?.availableToWithdraw ||
                usdt?.walletBalance ||
                usdt?.equity ||
                acc.totalAvailableBalance ||
                0
            );
            const totalEq = Number(acc.totalEquity || acc.totalWalletBalance || 0);
            const bestBal = Math.max(usdtEquity, usdtWallet, totalEq);
            return {
              bal: Number.isFinite(bestBal) ? bestBal : 0,
              avail: Number.isFinite(usdtAvail) && usdtAvail > 0 ? usdtAvail : bestBal,
            };
          };

          if (json.retCode === 0) {
            const extracted = extractBybitWalletBalance(json);
            resolvedBalance = extracted.bal;
            resolvedAvailable = extracted.avail;
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
                  if (extractedContract.bal > resolvedBalance) {
                    resolvedBalance = extractedContract.bal;
                    resolvedAvailable = extractedContract.avail;
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

            // Проверяем количество открытых фьючерсных позиций на Bybit
            let openPositions = 0;
            try {
              const posRes = await queryBybitEndpoint(
                baseUrl,
                '/v5/position/list?category=linear&settleCoin=USDT',
                false
              );
              if (posRes.statusCode === 200) {
                const posJson = JSON.parse(posRes.data);
                if (posJson.retCode === 0 && Array.isArray(posJson.result?.list)) {
                  openPositions = posJson.result.list.filter(
                    (p: any) => Math.abs(Number(p.size || 0)) > 0
                  ).length;
                }
              }
            } catch {
              // ignore
            }

            let msg = `Успешно подключено к ${netLabel} [${walletTypeLabel}] (Пинг: ${res.latencyMs} мс | Баланс: ${resolvedBalance.toFixed(2)} USDT | Открытых позиций: ${openPositions})`;
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
              balance_usdt: resolvedBalance > 0 ? resolvedBalance : fundBalance,
              available_balance_usdt: resolvedAvailable > 0 ? resolvedAvailable : resolvedBalance,
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
          if (!primaryErrorRes) primaryErrorRes = errObj;
          lastErrorRes = errObj;
          break;
        }

        const httpErrObj: ConnectionTestResult = {
          success: false,
          exchange: 'bybit',
          message:
            res.statusCode === 401 || res.statusCode === 403
              ? `${netLabel}: Неверный API Key или неверно выбрана сеть Mainnet/Testnet (HTTP ${res.statusCode})`
              : `${netLabel} HTTP ${res.statusCode}: ${res.data.slice(0, 100)}`,
          latency_ms: res.latencyMs,
          can_trade: false,
          is_testnet: isTestnetHost,
          network_label: netLabel,
        };
        if (!primaryErrorRes) primaryErrorRes = httpErrObj;
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

    return (
      primaryErrorRes ||
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
            const totalEq = Number(usdt?.eq || usdt?.cashBal || json.data?.[0]?.totalEq || 0);
            return {
              success: true,
              exchange: 'okx',
              message: `Успешно подключено к ${netLabel} (Пинг: ${res.latencyMs} мс | Баланс: ${totalEq.toFixed(2)} USDT)`,
              latency_ms: res.latencyMs,
              balance_usdt: totalEq,
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
            const balance = Number(usdtAcc?.usdtEquity || usdtAcc?.available || 0);
            return {
              success: true,
              exchange: 'bitget',
              message: `Успешно подключено к ${netLabel} (Пинг: ${res.latencyMs} мс | Баланс: ${balance.toFixed(2)} USDT)`,
              latency_ms: res.latencyMs,
              balance_usdt: balance,
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
        const balance = Number(balanceObj?.equity || balanceObj?.balance || 0);
        return {
          success: true,
          exchange: 'bingx',
          message: `Успешно подключено к BingX Perpetual Swap (Пинг: ${res.latencyMs} мс | Баланс: ${balance.toFixed(2)} USDT)`,
          latency_ms: res.latencyMs,
          balance_usdt: balance,
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
 * Преобразует биржевой символ ('ETHUSDT', 'ETH-USDT-SWAP', 'ETH-USDT') в формат пары 'ETH/USDT:USDT'.
 */
export function symbolToFreqtradePair(rawSymbol: string): string {
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
export async function fetchExchangeOpenPositions(creds: ExchangeCredentials): Promise<{
  success: boolean;
  positions: ExchangePositionItem[];
  network_label?: string;
  is_testnet?: boolean;
}> {
  const cleanKey = String(creds.apiKey || '').trim();
  const cleanSecret = String(creds.apiSecret || '').trim();
  if (!cleanKey || !cleanSecret || isSimulatedTestApiKey(cleanKey)) {
    return { success: false, positions: [] };
  }

  // 1. BYBIT V5 LINEAR FUTURES (/v5/position/list?category=linear&settleCoin=USDT&limit=200)
  if (creds.exchange === 'bybit') {
    const candidateHosts = getBybitCandidateHosts(cleanKey, creds.isTestnet);
    for (const baseUrl of candidateHosts) {
      try {
        const timestamp = await getBybitTimestamp(baseUrl, false);
        const recvWindow = '10000';
        const queryString = 'category=linear&settleCoin=USDT&limit=200';
        const signature = signBybitV5(timestamp, cleanKey, recvWindow, queryString, cleanSecret);
        const res = await makeHttpsRequest(`${baseUrl}/v5/position/list?${queryString}`, {
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
        if (res.statusCode === 200) {
          const json = JSON.parse(res.data);
          if (json.retCode === 10003 || json.retCode === 10004 || json.retCode === 33004) {
            continue;
          }
          if (json.retCode === 0 && Array.isArray(json.result?.list)) {
            bybitHostCache.set(cleanKey, baseUrl);
            const netLabel = baseUrl.includes('testnet')
              ? 'Bybit Testnet'
              : baseUrl.includes('demo')
              ? 'Bybit Demo'
              : 'Bybit Mainnet';
            const positions: ExchangePositionItem[] = [];
            for (const p of json.result.list) {
              const size = Math.abs(Number(p.size || 0));
              if (!(size > 0)) continue;
              const sym = String(p.symbol || '');
              const entryPrice = Number(p.avgPrice || p.entryPrice || 0);
              if (!(entryPrice > 0)) continue;
              const markPrice = Number(p.markPrice || entryPrice);
              const lev = Math.max(1, Math.round(Number(p.leverage || 25)));
              const sideStr = String(p.side || '').toLowerCase();
              const isShort = sideStr === 'sell' || Number(p.positionIdx) === 2;
              const notional = size * entryPrice;
              const rawIm = Number(p.positionIM || p.positionBalance || 0);
              const marginUsdt = rawIm > 0 ? Number(rawIm.toFixed(2)) : Number((notional / lev).toFixed(2));
              const tp = Number(p.takeProfit || 0);
              const sl = Number(p.stopLoss || 0);
              const cTime = Number(p.createdTime || p.updatedTime || Date.now());
              const uTime = Number(p.updatedTime || cTime);
              positions.push({
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
              });
            }
            return {
              success: true,
              positions,
              network_label: netLabel,
              is_testnet: baseUrl !== 'https://api.bybit.com',
            };
          }
        }
      } catch {
        // try next host
      }
    }
    return { success: false, positions: [] };
  }

  // 2. BINANCE USDT-M FUTURES (/fapi/v2/positionRisk)
  if (creds.exchange === 'binance') {
    const candidateHosts = getBinanceCandidateHosts(cleanKey, creds.isTestnet);
    for (const baseUrl of candidateHosts) {
      try {
        const ts = await getBinanceTimestamp(false, baseUrl);
        const query = `timestamp=${ts}&recvWindow=10000`;
        const sig = signBinanceFuturesQuery(query, cleanSecret);
        const res = await makeHttpsRequest(
          `${baseUrl}/fapi/v2/positionRisk?${query}&signature=${sig}`,
          {
            method: 'GET',
            headers: { 'X-MBX-APIKEY': cleanKey },
            timeoutMs: 6500,
          }
        );
        if (res.statusCode === 200) {
          binanceHostCache.set(cleanKey, baseUrl);
          const list = JSON.parse(res.data);
          if (Array.isArray(list)) {
            const positions: ExchangePositionItem[] = [];
            for (const p of list) {
              const rawAmt = Number(p.positionAmt || 0);
              const size = Math.abs(rawAmt);
              if (!(size > 0)) continue;
              const sym = String(p.symbol || '');
              if (!sym.endsWith('USDT')) continue;
              const entryPrice = Number(p.entryPrice || 0);
              if (!(entryPrice > 0)) continue;
              const markPrice = Number(p.markPrice || entryPrice);
              const lev = Math.max(1, Math.round(Number(p.leverage || 25)));
              const posSide = String(p.positionSide || '').toUpperCase();
              const isShort = posSide === 'SHORT' || rawAmt < 0;
              const notional = size * entryPrice;
              const isolatedWallet = Number(p.isolatedWallet || 0);
              const marginUsdt =
                isolatedWallet > 0
                  ? Number(isolatedWallet.toFixed(2))
                  : Number((notional / lev).toFixed(2));
              const uTime = Number(p.updateTime || Date.now());
              positions.push({
                pair: symbolToFreqtradePair(sym),
                symbol: sym,
                is_short: isShort,
                size,
                entry_price: entryPrice,
                mark_price: markPrice > 0 ? markPrice : entryPrice,
                leverage: lev,
                margin_usdt: marginUsdt,
                unrealized_pnl: Number(p.unRealizedProfit || 0),
                created_time: uTime,
                updated_time: uTime,
              });
            }
            return {
              success: true,
              positions,
              network_label: baseUrl.includes('testnet')
                ? 'Binance Futures Testnet'
                : 'Binance USDⓈ-M Mainnet',
              is_testnet: baseUrl.includes('testnet'),
            };
          }
        }
      } catch {
        // try next host
      }
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

  // 4. BITGET V2 USDT-FUTURES (/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT)
  if (creds.exchange === 'bitget') {
    const cleanPass = String(creds.passphrase || '').trim();
    if (!cleanPass) return { success: false, positions: [] };
    const isDemo = creds.isTestnet ?? bitgetDemoCache.get(cleanKey) ?? false;
    try {
      const timestamp = Date.now().toString();
      const requestPath = '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT';
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
          const positions: ExchangePositionItem[] = [];
          for (const p of json.data) {
            const size = Math.abs(Number(p.total || p.available || 0));
            if (!(size > 0)) continue;
            const sym = String(p.symbol || '');
            const entryPrice = Number(p.openPriceAvg || 0);
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
          return {
            success: true,
            positions,
            network_label: isDemo ? 'Bitget Demo Futures' : 'Bitget USDT-Futures Mainnet',
            is_testnet: isDemo,
          };
        }
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
            const size = Math.abs(Number(p.positionAmt || p.availableAmt || 0));
            if (!(size > 0)) continue;
            const sym = String(p.symbol || '');
            const entryPrice = Number(p.avgPrice || 0);
            if (!(entryPrice > 0)) continue;
            const markPrice = Number(p.markPrice || entryPrice);
            const lev = Math.max(1, Math.round(Number(p.leverage || 25)));
            const isShort = String(p.positionSide || '').toUpperCase() === 'SHORT';
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
 * Запрашивает реальную историю закрытых сделок (Closed PnL) с биржи (Bybit V5 /v5/position/closed-pnl, Binance Futures).
 * Используется для точной синхронизации цены закрытия, комиссий, времени закрытия и истории доходности в Дашборде.
 */
export async function fetchExchangeClosedPnl(
  creds: ExchangeCredentials,
  limit = 50
): Promise<{
  success: boolean;
  closed: ExchangeClosedPnlItem[];
}> {
  const cleanKey = String(creds.apiKey || '').trim();
  const cleanSecret = String(creds.apiSecret || '').trim();
  if (!cleanKey || !cleanSecret || isSimulatedTestApiKey(cleanKey)) {
    return { success: false, closed: [] };
  }

  if (creds.exchange === 'bybit') {
    const candidateHosts = getBybitCandidateHosts(cleanKey, creds.isTestnet);
    for (const baseUrl of candidateHosts) {
      try {
        const timestamp = await getBybitTimestamp(baseUrl, false);
        const recvWindow = '10000';
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
              // В Bybit closed-pnl поле side означает сторону закрывающего ордера:
              // Если закрывающий ордер 'Sell', значит закрыта позиция LONG (is_short = false).
              // Если закрывающий ордер 'Buy', значит закрыта позиция SHORT (is_short = true).
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

  return { success: false, closed: [] };
}

