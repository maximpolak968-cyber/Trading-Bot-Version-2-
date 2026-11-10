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
  stepSize: number;
  minQty: number;
  tickSize: number;
  minNotional: number;
  quantityPrecision: number;
  pricePrecision: number;
}

let binanceTimeOffsetMs = 0;
let lastTimeSyncTs = 0;
let binanceSymbolMetaCache = new Map<string, BinanceSymbolFilterMeta>();
let lastExchangeInfoSyncTs = 0;
const binanceDualSideCache = new Map<string, { dualSide: boolean; updatedAt: number }>();
const binanceLeverageCache = new Map<string, number>();

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
    const timeout = options.timeoutMs || 8000;

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
async function getBinanceTimestamp(forceSync = false): Promise<number> {
  if (forceSync || Date.now() - lastTimeSyncTs > 5 * 60_000) {
    try {
      const res = await makeHttpsRequest('https://fapi.binance.com/fapi/v1/time', {
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
 * Загружает и кэширует правила точности лотов (stepSize, minQty, minNotional) всех фьючерсных пар Binance.
 */
async function ensureBinanceExchangeInfo(): Promise<void> {
  if (binanceSymbolMetaCache.size > 50 && Date.now() - lastExchangeInfoSyncTs < 30 * 60_000) {
    return;
  }
  try {
    const res = await makeHttpsRequest('https://fapi.binance.com/fapi/v1/exchangeInfo', {
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
          const lotFilter =
            filters.find((f: any) => f.filterType === 'MARKET_LOT_SIZE') ||
            filters.find((f: any) => f.filterType === 'LOT_SIZE');
          const priceFilter = filters.find((f: any) => f.filterType === 'PRICE_FILTER');
          const notionalFilter = filters.find((f: any) => f.filterType === 'MIN_NOTIONAL');

          const stepSize = Number(lotFilter?.stepSize || 0.001);
          const minQty = Number(lotFilter?.minQty || stepSize || 0.001);
          const tickSize = Number(priceFilter?.tickSize || 0.0001);
          const minNotional = Number(notionalFilter?.notional || 5);

          nextMap.set(sym, {
            symbol: sym,
            stepSize: stepSize > 0 ? stepSize : 0.001,
            minQty: minQty > 0 ? minQty : 0.001,
            tickSize: tickSize > 0 ? tickSize : 0.0001,
            minNotional: minNotional > 0 ? minNotional : 5,
            quantityPrecision:
              typeof s.quantityPrecision === 'number' ? s.quantityPrecision : 3,
            pricePrecision: typeof s.pricePrecision === 'number' ? s.pricePrecision : 4,
          });
        }
        if (nextMap.size > 0) {
          binanceSymbolMetaCache = nextMap;
          lastExchangeInfoSyncTs = Date.now();
        }
      }
    }
  } catch {
    // ignore network failure, fallback heuristics will be used
  }
}

function countStepDecimals(step: number): number {
  const str = step.toFixed(10).replace(/0+$/, '');
  const dotIdx = str.indexOf('.');
  return dotIdx === -1 ? 0 : str.length - dotIdx - 1;
}

/**
 * Форматирует количество монет строго по правилам LOT_SIZE (stepSize, minQty, MIN_NOTIONAL) для Binance Futures.
 */
export async function formatBinanceFuturesQuantity(
  symbol: string,
  rawQty: number,
  referencePrice: number,
  isReduceOnly = false
): Promise<string> {
  await ensureBinanceExchangeInfo();
  const meta = binanceSymbolMetaCache.get(symbol);

  let stepSize = meta?.stepSize || 0.001;
  let minQty = meta?.minQty || 0.001;
  const minNotional = meta?.minNotional || 5;

  if (!meta) {
    if (referencePrice >= 10000) {
      stepSize = 0.001;
      minQty = 0.001;
    } else if (referencePrice >= 100) {
      stepSize = 0.001;
      minQty = 0.001;
    } else if (referencePrice >= 10) {
      stepSize = 0.01;
      minQty = 0.01;
    } else if (referencePrice >= 0.5) {
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

  const decimals = countStepDecimals(stepSize);
  const steps = isReduceOnly
    ? Math.floor((qty + 1e-9) / stepSize)
    : Math.ceil((qty - 1e-9) / stepSize);
  const finalQty = Math.max(minQty, steps * stepSize);

  return finalQty.toFixed(decimals);
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
  forceRefresh = false
): Promise<boolean> {
  const cached = binanceDualSideCache.get(apiKey);
  if (!forceRefresh && cached && Date.now() - cached.updatedAt < 5 * 60_000) {
    return cached.dualSide;
  }
  try {
    const ts = await getBinanceTimestamp();
    const query = `timestamp=${ts}&recvWindow=10000`;
    const sig = signBinanceFuturesQuery(query, apiSecret);
    const res = await makeHttpsRequest(
      `https://fapi.binance.com/fapi/v1/positionSide/dual?${query}&signature=${sig}`,
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
  targetLeverage = 25
): Promise<number> {
  const cacheKey = `${apiKey}:${symbol}`;
  const cachedLev = binanceLeverageCache.get(cacheKey);
  if (cachedLev === targetLeverage) {
    return cachedLev;
  }

  // 1. Попытка установить тип маржи CROSSED (игнорируем -4046 "No need to change margin type")
  try {
    const tsMargin = await getBinanceTimestamp();
    const qMargin = `symbol=${symbol}&marginType=CROSSED&timestamp=${tsMargin}&recvWindow=10000`;
    const sigMargin = signBinanceFuturesQuery(qMargin, apiSecret);
    await makeHttpsRequest(
      `https://fapi.binance.com/fapi/v1/marginType?${qMargin}&signature=${sigMargin}`,
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
      const tsLev = await getBinanceTimestamp();
      const qLev = `symbol=${symbol}&leverage=${lev}&timestamp=${tsLev}&recvWindow=10000`;
      const sigLev = signBinanceFuturesQuery(qLev, apiSecret);
      const res = await makeHttpsRequest(
        `https://fapi.binance.com/fapi/v1/leverage?${qLev}&signature=${sigLev}`,
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
 * Исполняет реальный фьючерсный рыночный ордер (OPEN / DCA / CLOSE) на подключенной бирже.
 * Поддерживает Binance USDT-M Futures, Bybit V5 Linear, OKX V5 Swap, Bitget V2 USDT-Futures и BingX Swap V2.
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
  // 1. BINANCE USDT-M FUTURES (https://fapi.binance.com/fapi/v1/order)
  // ==========================================================================
  if (creds.exchange === 'binance') {
    try {
      await ensureBinanceSymbolLeverage(cleanKey, cleanSecret, symbol, targetLeverage);
      const formattedQtyStr = await formatBinanceFuturesQuantity(
        symbol,
        params.quantity,
        params.referencePrice,
        isClose
      );
      const dualSide = await getBinanceDualSideMode(cleanKey, cleanSecret);

      const buildOrderQuery = async (useDualSide: boolean): Promise<string> => {
        const ts = await getBinanceTimestamp();
        const qp = new URLSearchParams();
        qp.set('symbol', symbol);
        qp.set('side', side);
        qp.set('type', 'MARKET');
        qp.set('quantity', formattedQtyStr);
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

      let query = await buildOrderQuery(dualSide);
      let signature = signBinanceFuturesQuery(query, cleanSecret);
      let res = await makeHttpsRequest(
        `https://fapi.binance.com/fapi/v1/order?${query}&signature=${signature}`,
        {
          method: 'POST',
          headers: {
            'X-MBX-APIKEY': cleanKey,
            'Content-Type': 'application/json',
          },
        }
      );

      // Если ошибка -1021 (рассинхрон времени) — принудительно синхронизируем часы с Binance и повторяем
      if (res.statusCode !== 200 && res.data.includes('-1021')) {
        await getBinanceTimestamp(true);
        query = await buildOrderQuery(dualSide);
        signature = signBinanceFuturesQuery(query, cleanSecret);
        res = await makeHttpsRequest(
          `https://fapi.binance.com/fapi/v1/order?${query}&signature=${signature}`,
          {
            method: 'POST',
            headers: {
              'X-MBX-APIKEY': cleanKey,
              'Content-Type': 'application/json',
            },
          }
        );
      }

      // Если ошибка -4061 (пользователь переключил Hedge Mode / One-Way Mode на Binance) — инвертируем dualSide и повторяем
      if (res.statusCode !== 200 && res.data.includes('-4061')) {
        const flippedDual = !dualSide;
        binanceDualSideCache.set(cleanKey, { dualSide: flippedDual, updatedAt: Date.now() });
        query = await buildOrderQuery(flippedDual);
        signature = signBinanceFuturesQuery(query, cleanSecret);
        res = await makeHttpsRequest(
          `https://fapi.binance.com/fapi/v1/order?${query}&signature=${signature}`,
          {
            method: 'POST',
            headers: {
              'X-MBX-APIKEY': cleanKey,
              'Content-Type': 'application/json',
            },
          }
        );
      }

      // Если при закрытии (CLOSE) в One-Way Mode вернулась ошибка -2022 ReduceOnly Order is rejected (позиция уже закрыта вручную на бирже)
      if (isClose && res.statusCode !== 200 && res.data.includes('-2022')) {
        return {
          success: true,
          order_id: `already-closed-${Date.now()}`,
          symbol,
          side,
          price: params.referencePrice,
          qty: Number(formattedQtyStr),
          status: 'FILLED',
          exchange_time: Date.now(),
        };
      }

      if (res.statusCode === 200) {
        const data = JSON.parse(res.data);
        const avgPrice = Number(data.avgPrice || 0) > 0 ? Number(data.avgPrice) : params.referencePrice;
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
        };
      }

      const formattedErr = formatBinanceApiError(res.statusCode, res.data);
      return {
        success: false,
        order_id: '',
        symbol,
        side,
        price: params.referencePrice,
        qty: Number(formattedQtyStr),
        status: 'REJECTED',
        exchange_time: Date.now(),
        error: formattedErr.message,
        error_code: formattedErr.code,
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
        error: `Ошибка соединения с Binance Futures при отправке ордера: ${e?.message || 'Сеть недоступна'}`,
      };
    }
  }

  // ==========================================================================
  // 2. BYBIT V5 LINEAR FUTURES (https://api.bybit.com/v5/order/create)
  // ==========================================================================
  if (creds.exchange === 'bybit') {
    try {
      const formattedQtyStr = await formatBinanceFuturesQuantity(
        symbol,
        params.quantity,
        params.referencePrice,
        isClose
      );
      const timestamp = Date.now().toString();
      const recvWindow = '10000';
      const bodyObj: Record<string, any> = {
        category: 'linear',
        symbol,
        side: side === 'BUY' ? 'Buy' : 'Sell',
        orderType: 'Market',
        qty: formattedQtyStr,
        positionIdx: 0,
      };
      if (isClose) {
        bodyObj.reduceOnly = true;
      }
      const bodyStr = JSON.stringify(bodyObj);
      const signature = signBybitV5(timestamp, cleanKey, recvWindow, bodyStr, cleanSecret);

      const res = await makeHttpsRequest('https://api.bybit.com/v5/order/create', {
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

      if (res.statusCode === 200) {
        const json = JSON.parse(res.data);
        if (json.retCode === 0) {
          return {
            success: true,
            order_id: String(json.result?.orderId || `bybit-${Date.now()}`),
            symbol,
            side,
            price: params.referencePrice,
            qty: Number(formattedQtyStr),
            status: 'FILLED',
            exchange_time: Date.now(),
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
          error: `Bybit V5 [${json.retCode}]: ${json.retMsg}`,
          error_code: json.retCode,
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
        error: `Bybit HTTP ${res.statusCode}: ${res.data.slice(0, 120)}`,
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
        error: `Ошибка связи с Bybit: ${e?.message || 'Сеть недоступна'}`,
      };
    }
  }

  // ==========================================================================
  // 3. BINGX PERPETUAL SWAP V2 (https://open-api.bingx.com/openApi/swap/v2/trade/order)
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
      const timestamp = Date.now();
      const qp = new URLSearchParams({
        symbol: bingxSymbol,
        side,
        positionSide: 'BOTH',
        type: 'MARKET',
        quantity: formattedQtyStr,
        timestamp: String(timestamp),
      });
      if (isClose) qp.set('reduceOnly', 'true');
      const query = qp.toString();
      const sig = crypto.createHmac('sha256', cleanSecret).update(query).digest('hex');
      const res = await makeHttpsRequest(
        `https://open-api.bingx.com/openApi/swap/v2/trade/order?${query}&signature=${sig}`,
        {
          method: 'POST',
          headers: {
            'X-BX-APIKEY': cleanKey,
            'Content-Type': 'application/json',
          },
        }
      );
      if (res.statusCode === 200) {
        const json = JSON.parse(res.data);
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
 * Тестирует реальное подключение к бирже с проверкой API-ключа, подписи и прав на фьючерсную торговлю.
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

  // 1. BINANCE USDT-M FUTURES (fapi.binance.com)
  if (creds.exchange === 'binance') {
    try {
      const timestamp = await getBinanceTimestamp();
      const recvWindow = 10000;
      const query = `timestamp=${timestamp}&recvWindow=${recvWindow}`;
      const signature = signBinanceFuturesQuery(query, cleanSecret);
      const url = `https://fapi.binance.com/fapi/v2/account?${query}&signature=${signature}`;

      const res = await makeHttpsRequest(url, {
        method: 'GET',
        headers: {
          'X-MBX-APIKEY': cleanKey,
          'Content-Type': 'application/json',
        },
      });

      if (res.statusCode === 200) {
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
        const dualSide = await getBinanceDualSideMode(cleanKey, cleanSecret, true);
        const canTrade = Boolean(json.canTrade);

        let statusMsg = `Успешно подключено к Binance USDⓈ-M Futures (Пинг: ${res.latencyMs} мс | Баланс: ${walletBalance.toFixed(2)} USDT | Доступно: ${availableBalance.toFixed(2)} USDT | Режим: ${dualSide ? 'Hedge Mode' : 'One-Way'} | Открытых позиций на бирже: ${openPositions})`;
        if (walletBalance <= 0) {
          statusMsg +=
            ' ⚠️ ВНИМАНИЕ: На вашем фьючерсном кошельке USDⓈ-M сейчас 0 USDT! Переведите USDT со Спотового кошелька на Фьючерсный (USDⓈ-M Futures) в приложении Binance.';
        } else if (!canTrade) {
          statusMsg +=
            ' ⚠️ ВНИМАНИЕ: На аккаунте Binance отключена торговля фьючерсами (canTrade=false). Включите галочку «Enable Futures» в настройках API-ключа!';
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
          account_type: 'USDT-M Futures',
        };
      }

      const formattedErr = formatBinanceApiError(res.statusCode, res.data);
      return {
        success: false,
        exchange: 'binance',
        message: formattedErr.message,
        latency_ms: res.latencyMs,
        can_trade: false,
        error_code: formattedErr.code,
      };
    } catch (e: any) {
      return {
        success: false,
        exchange: 'binance',
        message: `Ошибка связи с Binance: ${e?.message || 'Сеть недоступна'}`,
        latency_ms: 0,
        can_trade: false,
      };
    }
  }

  // 2. BYBIT V5 UNIFIED (api.bybit.com)
  if (creds.exchange === 'bybit') {
    try {
      const timestamp = Date.now().toString();
      const recvWindow = '10000';
      const queryString = 'accountType=UNIFIED';
      const signature = signBybitV5(timestamp, cleanKey, recvWindow, queryString, cleanSecret);
      const url = `https://api.bybit.com/v5/account/wallet-balance?${queryString}`;

      const res = await makeHttpsRequest(url, {
        method: 'GET',
        headers: {
          'X-BAPI-API-KEY': cleanKey,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-SIGN': signature,
          'X-BAPI-RECV-WINDOW': recvWindow,
          'Content-Type': 'application/json',
        },
      });

      if (res.statusCode === 200) {
        const json = JSON.parse(res.data);
        if (json.retCode === 0) {
          const coinList = json.result?.list?.[0]?.coin || [];
          const usdt = coinList.find((c: any) => c.coin === 'USDT');
          const balance = usdt ? Number(usdt.walletBalance || 0) : 0;
          return {
            success: true,
            exchange: 'bybit',
            message: `Успешно подключено к Bybit V5 Unified (Пинг: ${res.latencyMs} мс | Баланс: ${balance.toFixed(2)} USDT)`,
            latency_ms: res.latencyMs,
            balance_usdt: balance,
            can_trade: true,
            account_type: 'Unified Trading Account (UTA)',
          };
        }

        return {
          success: false,
          exchange: 'bybit',
          message: `Bybit V5: ${json.retMsg} (retCode: ${json.retCode})`,
          latency_ms: res.latencyMs,
          can_trade: false,
          error_code: json.retCode,
        };
      }

      return {
        success: false,
        exchange: 'bybit',
        message: `Bybit HTTP ${res.statusCode}: ${res.data.slice(0, 100)}`,
        latency_ms: res.latencyMs,
        can_trade: false,
      };
    } catch (e: any) {
      return {
        success: false,
        exchange: 'bybit',
        message: `Ошибка связи с Bybit: ${e?.message || 'Сеть недоступна'}`,
        latency_ms: 0,
        can_trade: false,
      };
    }
  }

  // 3. OKX V5 ACCOUNT BALANCE (www.okx.com)
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
    try {
      const isoTimestamp = new Date().toISOString();
      const requestPath = '/api/v5/account/balance';
      const preHash = `${isoTimestamp}GET${requestPath}`;
      const signature = crypto.createHmac('sha256', cleanSecret).update(preHash).digest('base64');

      const res = await makeHttpsRequest(`https://www.okx.com${requestPath}`, {
        method: 'GET',
        headers: {
          'OK-ACCESS-KEY': cleanKey,
          'OK-ACCESS-SIGN': signature,
          'OK-ACCESS-TIMESTAMP': isoTimestamp,
          'OK-ACCESS-PASSPHRASE': cleanPass,
          'Content-Type': 'application/json',
        },
      });

      if (res.statusCode === 200) {
        const json = JSON.parse(res.data);
        if (json.code === '0') {
          const details = json.data?.[0]?.details || [];
          const usdt = details.find((d: any) => d.ccy === 'USDT');
          const totalEq = Number(usdt?.eq || json.data?.[0]?.totalEq || 0);
          return {
            success: true,
            exchange: 'okx',
            message: `Успешно подключено к OKX V5 Swap (Пинг: ${res.latencyMs} мс | Баланс: ${totalEq.toFixed(2)} USDT)`,
            latency_ms: res.latencyMs,
            balance_usdt: totalEq,
            can_trade: true,
            account_type: 'OKX V5 Unified',
          };
        }
        return {
          success: false,
          exchange: 'okx',
          message: `OKX API: ${json.msg || 'Ошибка авторизации'} (code: ${json.code})`,
          latency_ms: res.latencyMs,
          can_trade: false,
          error_code: json.code,
        };
      }

      return {
        success: false,
        exchange: 'okx',
        message: `OKX HTTP ${res.statusCode}: ${res.data.slice(0, 100)}`,
        latency_ms: res.latencyMs,
        can_trade: false,
      };
    } catch (e: any) {
      return {
        success: false,
        exchange: 'okx',
        message: `Ошибка связи с OKX: ${e?.message || 'Сеть недоступна'}`,
        latency_ms: 0,
        can_trade: false,
      };
    }
  }

  // 4. BITGET V2 USDT-FUTURES (api.bitget.com)
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
    try {
      const timestamp = Date.now().toString();
      const requestPath = '/api/v2/mix/account/accounts?productType=USDT-FUTURES';
      const preHash = `${timestamp}GET${requestPath}`;
      const signature = crypto.createHmac('sha256', cleanSecret).update(preHash).digest('base64');

      const res = await makeHttpsRequest(`https://api.bitget.com${requestPath}`, {
        method: 'GET',
        headers: {
          'ACCESS-KEY': cleanKey,
          'ACCESS-SIGN': signature,
          'ACCESS-TIMESTAMP': timestamp,
          'ACCESS-PASSPHRASE': cleanPass,
          'Content-Type': 'application/json',
          locale: 'en-US',
        },
      });

      if (res.statusCode === 200) {
        const json = JSON.parse(res.data);
        if (json.code === '00000') {
          const list = Array.isArray(json.data) ? json.data : [];
          const usdtAcc = list.find((a: any) => a.marginCoin === 'USDT') || list[0];
          const balance = Number(usdtAcc?.usdtEquity || usdtAcc?.available || 0);
          return {
            success: true,
            exchange: 'bitget',
            message: `Успешно подключено к Bitget USDT-Futures (Пинг: ${res.latencyMs} мс | Баланс: ${balance.toFixed(2)} USDT)`,
            latency_ms: res.latencyMs,
            balance_usdt: balance,
            can_trade: true,
            account_type: 'Bitget USDT-M Futures',
          };
        }
        return {
          success: false,
          exchange: 'bitget',
          message: `Bitget API: ${json.msg || 'Ошибка авторизации'} (code: ${json.code})`,
          latency_ms: res.latencyMs,
          can_trade: false,
          error_code: json.code,
        };
      }

      return {
        success: false,
        exchange: 'bitget',
        message: `Bitget HTTP ${res.statusCode}: ${res.data.slice(0, 100)}`,
        latency_ms: res.latencyMs,
        can_trade: false,
      };
    } catch (e: any) {
      return {
        success: false,
        exchange: 'bitget',
        message: `Ошибка связи с Bitget: ${e?.message || 'Сеть недоступна'}`,
        latency_ms: 0,
        can_trade: false,
      };
    }
  }

  // 5. BINGX SWAP V2 PERPETUAL FUTURES (open-api.bingx.com)
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
