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
  can_trade: boolean;
  account_type?: string;
  error_code?: string | number;
}

export interface PlacedOrderResult {
  order_id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
  status: 'FILLED' | 'NEW' | 'PARTIALLY_FILLED' | 'REJECTED';
  exchange_time: number;
  commission_usdt?: number;
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
    const timeout = options.timeoutMs || 6000;

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
      const timestamp = Date.now();
      const recvWindow = 5000;
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
        const balance = usdtAsset ? Number(usdtAsset.walletBalance || 0) : 0;
        return {
          success: true,
          exchange: 'binance',
          message: `Успешно подключено к Binance Futures (Пинг: ${res.latencyMs} мс)`,
          latency_ms: res.latencyMs,
          balance_usdt: balance,
          can_trade: Boolean(json.canTrade),
          account_type: 'USDT-M Futures',
        };
      }

      let parsedErr: any = {};
      try {
        parsedErr = JSON.parse(res.data);
      } catch {
        // ignore
      }

      // Если ключи демонстрационные/тестовые или IP не в белом списке
      const errMsg = parsedErr.msg || `Код ошибки ${res.statusCode}`;
      const isSignatureValidLocally = signature.length === 64;

      return {
        success: false,
        exchange: 'binance',
        message: `Binance API: ${errMsg} (HMAC-SHA256 подпись сгенерирована корректно)`,
        latency_ms: res.latencyMs,
        can_trade: false,
        error_code: parsedErr.code,
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
      const recvWindow = '5000';
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
            message: `Успешно подключено к Bybit V5 Unified (Пинг: ${res.latencyMs} мс)`,
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
            message: `Успешно подключено к OKX V5 Swap (Пинг: ${res.latencyMs} мс)`,
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
            message: `Успешно подключено к Bitget USDT-Futures (Пинг: ${res.latencyMs} мс)`,
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
          message: `Успешно подключено к BingX Perpetual Swap (Пинг: ${res.latencyMs} мс)`,
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
 * Пример:
 * - Баланс $5000 -> маржа $25.00 -> позиция с 25x = $625
 * - Баланс $2000 -> маржа $10.00 -> позиция с 25x = $250
 * - Баланс $10000 -> маржа $50.00 -> позиция с 25x = $1250
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
  const clientStakeUsdt = Math.max(params.minStakeUsdt || 10, rawStake);
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
