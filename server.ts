import 'dotenv/config';
import express from 'express';
import http from 'http';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  DEFAULT_SCALPBOT_CONFIG,
  analyzeMultiTimeframe,
  findStrongestDcaLevel,
  detectMarketStructure,
  isHedgeEntryCandidate,
  checkBtcMarketHealth,
  evaluateScalpingStrategy,
  canExecuteDca,
  calculateDynamicDcaAmount,
  checkCandleRejection,
  checkRsiCondition,
  isKnifeDrop,
  isPumpExhaustion,
  calculateWaveTrend,
} from './src/bot/scalpBotEngine.ts';
import { SqliteBotDatabase } from './src/bot/sqliteStore.ts';
import {
  testExchangeConnection,
  calculateClientProportionalOrder,
  executeExchangeFuturesOrder,
  isSimulatedTestApiKey,
  getExchangeTakerFeeRate,
  fetchExchangeOpenPositions,
  fetchExchangeClosedPnl,
  ExchangeOrderParams,
  PlacedOrderResult,
} from './src/bot/exchangeConnector.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const sqliteDb = new SqliteBotDatabase();

interface RawCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const PINNED_PAIRS = [
  'ETH/USDT:USDT',
  'DOT/USDT:USDT',
  'AVAX/USDT:USDT',
  'LINK/USDT:USDT',
  'XRP/USDT:USDT',
  'BTC/USDT:USDT',
  'SOL/USDT:USDT',
  'DOGE/USDT:USDT',
  'ADA/USDT:USDT',
];

const EXCLUDED_BASE_ASSETS = new Set([
  'USDC',
  'FDUSD',
  'TUSD',
  'USDP',
  'BUSD',
  'DAI',
  'USD1',
  'RLUSD',
  'USDE',
  'USDD',
  'PYUSD',
  'U',
  'EUR',
  'EURI',
  'GBP',
  'AEUR',
  'TRY',
  'BRL',
  'ARS',
  'JPY',
  'PLN',
  'RON',
  'UAH',
  'ZAR',
  'SOXL',
  'KORU',
  'SKHYNIX',
  'SNDK',
  'NVDA',
  'TSLA',
  'AAPL',
  'MSFT',
  'AMZN',
  'GOOG',
  'META',
  'COIN',
  'MSTR',
  'SPY',
  'QQQ',
]);

let marketPairsCache: { timestamp: number; pairs: string[] } = {
  timestamp: 0,
  pairs: [...PINNED_PAIRS],
};

function pairToBinanceSymbol(pair: string): string {
  const clean = pair.split(':')[0]; // strip :USDT futures suffix
  return clean.replace('/', '').toUpperCase();
}

const candleCache = new Map<string, { timestamp: number; candles: RawCandle[]; source: string }>();
const tickerCache = new Map<string, { price: number; change24h: number; volume24h: number; high24h: number; low24h: number; updatedAt: number }>();

async function fetchWithTimeout(url: string, timeoutMs = 6000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Freqtrade/2025.2 FreqUI',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllMarketPairs(): Promise<string[]> {
  if (marketPairsCache.pairs.length > PINNED_PAIRS.length && Date.now() - marketPairsCache.timestamp < 60_000) {
    return marketPairsCache.pairs;
  }

  const endpoints = [
    'https://data-api.binance.vision/api/v3/ticker/24hr',
    'https://api.binance.com/api/v3/ticker/24hr',
  ];

  for (const url of endpoints) {
    try {
      const res = await fetchWithTimeout(url, 6500);
      if (res.ok) {
        const tickers = await res.json();
        if (Array.isArray(tickers) && tickers.length > 0) {
          const usdtTickers = tickers
            .filter((t: any) => {
              const sym = String(t.symbol || '');
              if (!sym.endsWith('USDT')) return false;
              const base = sym.slice(0, -4);
              if (!base || EXCLUDED_BASE_ASSETS.has(base)) return false;
              if (base.endsWith('UP') || base.endsWith('DOWN') || base.endsWith('BULL') || base.endsWith('BEAR')) {
                return false;
              }
              const lastPrice = parseFloat(t.lastPrice);
              const quoteVol = parseFloat(t.quoteVolume);
              return lastPrice > 0 && quoteVol > 100_000;
            })
            .sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));

          const discoveredPairs: string[] = [...PINNED_PAIRS];
          const seen = new Set<string>(PINNED_PAIRS);

          for (const t of usdtTickers) {
            const base = String(t.symbol).slice(0, -4);
            const formattedPair = `${base}/USDT:USDT`;
            tickerCache.set(formattedPair, {
              price: parseFloat(t.lastPrice) || 0,
              change24h: Number((parseFloat(t.priceChangePercent) || 0).toFixed(2)),
              volume24h: parseFloat(t.quoteVolume) || 0,
              high24h: parseFloat(t.highPrice) || 0,
              low24h: parseFloat(t.lowPrice) || 0,
              updatedAt: Date.now(),
            });
            if (!seen.has(formattedPair)) {
              seen.add(formattedPair);
              discoveredPairs.push(formattedPair);
            }
          }

          marketPairsCache = {
            timestamp: Date.now(),
            pairs: discoveredPairs,
          };
          return discoveredPairs;
        }
      }
    } catch {
      // try next endpoint
    }
  }

  return marketPairsCache.pairs;
}

let volatilePairsCache: { timestamp: number; pairs: string[] } = {
  timestamp: 0,
  pairs: [...PINNED_PAIRS],
};

async function fetchTopVolatileFuturesPairs(minVolumeUsdt = 50_000_000): Promise<string[]> {
  if (volatilePairsCache.pairs.length > PINNED_PAIRS.length && Date.now() - volatilePairsCache.timestamp < 60_000) {
    return volatilePairsCache.pairs;
  }

  // 1. Try Bybit V5 Linear USDT Perpetual Futures first (fast, unblocked globally, pure USDT-M futures)
  try {
    const bybitRes = await fetchWithTimeout('https://api.bybit.com/v5/market/tickers?category=linear', 6000);
    if (bybitRes.ok) {
      const bybitJson = await bybitRes.json();
      const list = bybitJson?.result?.list;
      if (Array.isArray(list) && list.length > 0) {
        const volatileList = list
          .filter((t: any) => {
            const sym = String(t.symbol || '');
            if (!sym.endsWith('USDT')) return false;
            const base = sym.slice(0, -4);
            if (!base || EXCLUDED_BASE_ASSETS.has(base)) return false;
            const turnover24h = parseFloat(t.turnover24h) || 0;
            const lastPrice = parseFloat(t.lastPrice) || 0;
            return turnover24h >= minVolumeUsdt && lastPrice > 0;
          })
          .map((t: any) => {
            const high = parseFloat(t.highPrice24h) || 0;
            const low = parseFloat(t.lowPrice24h) || 0;
            const lastPrice = parseFloat(t.lastPrice) || 0;
            const turnover24h = parseFloat(t.turnover24h) || 0;
            const changePct = (parseFloat(t.price24hPcnt) || 0) * 100;
            const swingPct = low > 0 ? ((high - low) / low) * 100 : 0;
            const base = String(t.symbol).slice(0, -4);
            const formattedPair = `${base}/USDT:USDT`;
            tickerCache.set(formattedPair, {
              price: lastPrice,
              change24h: Number(changePct.toFixed(2)),
              volume24h: turnover24h,
              high24h: high,
              low24h: low,
              updatedAt: Date.now(),
            });
            return { pair: formattedPair, swingPct, volume: turnover24h };
          })
          .sort((a: any, b: any) => b.swingPct - a.swingPct);

        if (volatileList.length > 0) {
          const result: string[] = [];
          const seen = new Set<string>();
          for (const item of volatileList) {
            if (!seen.has(item.pair)) {
              seen.add(item.pair);
              result.push(item.pair);
            }
          }
          for (const p of PINNED_PAIRS) {
            if (!seen.has(p)) {
              seen.add(p);
              result.push(p);
            }
          }
          volatilePairsCache = {
            timestamp: Date.now(),
            pairs: result,
          };
          return result;
        }
      }
    }
  } catch {
    // fallback to Binance endpoints below
  }

  // 2. Fallback to Binance Futures / Vision 24hr tickers
  const endpoints = [
    'https://fapi.binance.com/fapi/v1/ticker/24hr',
    'https://data-api.binance.vision/api/v3/ticker/24hr',
  ];

  for (const url of endpoints) {
    try {
      const res = await fetchWithTimeout(url, 6500);
      if (res.ok) {
        const tickers = await res.json();
        if (Array.isArray(tickers) && tickers.length > 0) {
          const volatileList = tickers
            .filter((t: any) => {
              const sym = String(t.symbol || '');
              if (!sym.endsWith('USDT')) return false;
              const base = sym.slice(0, -4);
              if (!base || EXCLUDED_BASE_ASSETS.has(base)) return false;
              if (base.endsWith('UP') || base.endsWith('DOWN') || base.endsWith('BULL') || base.endsWith('BEAR')) {
                return false;
              }
              const quoteVol = parseFloat(t.quoteVolume) || 0;
              const lastPrice = parseFloat(t.lastPrice) || 0;
              return quoteVol >= minVolumeUsdt && lastPrice > 0;
            })
            .map((t: any) => {
              const high = parseFloat(t.highPrice) || 0;
              const low = parseFloat(t.lowPrice) || 0;
              const swingPct = low > 0 ? ((high - low) / low) * 100 : 0;
              const base = String(t.symbol).slice(0, -4);
              const formattedPair = `${base}/USDT:USDT`;
              tickerCache.set(formattedPair, {
                price: parseFloat(t.lastPrice) || 0,
                change24h: Number((parseFloat(t.priceChangePercent) || 0).toFixed(2)),
                volume24h: parseFloat(t.quoteVolume) || 0,
                high24h: high,
                low24h: low,
                updatedAt: Date.now(),
              });
              return { pair: formattedPair, swingPct, volume: parseFloat(t.quoteVolume) || 0 };
            })
            .sort((a: any, b: any) => b.swingPct - a.swingPct);

          const result: string[] = [];
          const seen = new Set<string>();
          for (const item of volatileList) {
            if (!seen.has(item.pair)) {
              seen.add(item.pair);
              result.push(item.pair);
            }
          }
          for (const p of PINNED_PAIRS) {
            if (!seen.has(p)) {
              seen.add(p);
              result.push(p);
            }
          }

          volatilePairsCache = {
            timestamp: Date.now(),
            pairs: result,
          };
          return result;
        }
      }
    } catch {
      // try next endpoint
    }
  }

  return volatilePairsCache.pairs.length > 0 ? volatilePairsCache.pairs : [...PINNED_PAIRS];
}

async function fetchRealCandles(
  pair: string,
  timeframe: string,
  limit = 1000,
  endTime?: number
): Promise<{ candles: RawCandle[]; source: string }> {
  const safeLimit = Math.min(1000, Math.max(50, limit));
  const normTf = String(timeframe || '1h').trim().toLowerCase();
  const validIntervals: Record<string, string> = {
    '1m': '1m',
    '3m': '3m',
    '5m': '5m',
    '15m': '15m',
    '30m': '30m',
    '1h': '1h',
    '2h': '2h',
    '4h': '4h',
    '6h': '6h',
    '8h': '8h',
    '12h': '12h',
    '1d': '1d',
    '1w': '1w',
  };
  const interval = validIntervals[normTf] || '1h';
  const cacheKey = `${pair}_${interval}_${safeLimit}_${endTime || 'latest'}`;
  const cached = candleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 5000) {
    return { candles: cached.candles, source: cached.source };
  }

  const symbol = pairToBinanceSymbol(pair);
  const cleanPair = pair.split(':')[0].toUpperCase();
  const [baseAsset = 'ETH', quoteAsset = 'USDT'] = cleanPair.split('/');
  const endTimeMs = endTime && Number.isFinite(endTime) ? Math.floor(endTime) : undefined;
  const endTimeParam = endTimeMs ? `&endTime=${endTimeMs}` : '';

  const bybitIntervals: Record<string, string> = {
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
  const okxBars: Record<string, string> = {
    '1m': '1m',
    '3m': '3m',
    '5m': '5m',
    '15m': '15m',
    '30m': '30m',
    '1h': '1H',
    '2h': '2H',
    '4h': '4H',
    '6h': '6HUTC',
    '12h': '12HUTC',
    '1d': '1DUTC',
    '1w': '1WUTC',
  };
  const bitgetGrans: Record<string, string> = {
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '30m': '30m',
    '1h': '1H',
    '4h': '4H',
    '6h': '6H',
    '12h': '12H',
    '1d': '1D',
    '1w': '1W',
  };

  interface KlineProvider {
    id: SupportedExchange;
    name: string;
    url: string;
    parse: (raw: any) => RawCandle[];
  }

  const allProviders: KlineProvider[] = [
    {
      id: 'binance',
      name: `Binance (${interval})`,
      url: `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${safeLimit}${endTimeParam}`,
      parse: (raw: any) =>
        Array.isArray(raw)
          ? raw.map((k: any[]) => ({
              timestamp: Number(k[0]),
              open: parseFloat(k[1]),
              high: parseFloat(k[2]),
              low: parseFloat(k[3]),
              close: parseFloat(k[4]),
              volume: parseFloat(k[5]),
            }))
          : [],
    },
    {
      id: 'binance',
      name: `Binance Futures (${interval})`,
      url: `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${safeLimit}${endTimeParam}`,
      parse: (raw: any) =>
        Array.isArray(raw)
          ? raw.map((k: any[]) => ({
              timestamp: Number(k[0]),
              open: parseFloat(k[1]),
              high: parseFloat(k[2]),
              low: parseFloat(k[3]),
              close: parseFloat(k[4]),
              volume: parseFloat(k[5]),
            }))
          : [],
    },
    ...(bybitIntervals[interval]
      ? [
          ...(exchangeAccountsStore.some((a) => a.enabled && a.exchange === 'bybit' && a.is_testnet)
            ? [
                {
                  id: 'bybit' as SupportedExchange,
                  name: `Bybit Testnet (${interval})`,
                  url: `https://api-testnet.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitIntervals[interval]}&limit=${safeLimit}${
                    endTimeMs ? `&end=${endTimeMs}` : ''
                  }`,
                  parse: (raw: any) => {
                    const list = raw?.result?.list;
                    if (!Array.isArray(list)) return [];
                    return list
                      .map((k: any[]) => ({
                        timestamp: Number(k[0]),
                        open: parseFloat(k[1]),
                        high: parseFloat(k[2]),
                        low: parseFloat(k[3]),
                        close: parseFloat(k[4]),
                        volume: parseFloat(k[5]),
                      }))
                      .sort((a, b) => a.timestamp - b.timestamp);
                  },
                },
              ]
            : []),
          {
            id: 'bybit' as SupportedExchange,
            name: `Bybit Futures (${interval})`,
            url: `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitIntervals[interval]}&limit=${safeLimit}${
              endTimeMs ? `&end=${endTimeMs}` : ''
            }`,
            parse: (raw: any) => {
              const list = raw?.result?.list;
              if (!Array.isArray(list)) return [];
              return list
                .map((k: any[]) => ({
                  timestamp: Number(k[0]),
                  open: parseFloat(k[1]),
                  high: parseFloat(k[2]),
                  low: parseFloat(k[3]),
                  close: parseFloat(k[4]),
                  volume: parseFloat(k[5]),
                }))
                .sort((a, b) => a.timestamp - b.timestamp);
            },
          },
        ]
      : []),
    ...(okxBars[interval]
      ? [
          {
            id: 'okx' as SupportedExchange,
            name: `OKX Swap (${interval})`,
            url: `https://www.okx.com/api/v5/market/candles?instId=${baseAsset}-${quoteAsset}-SWAP&bar=${okxBars[interval]}&limit=${Math.min(
              300,
              safeLimit
            )}${endTimeMs ? `&after=${endTimeMs}` : ''}`,
            parse: (raw: any) => {
              const list = raw?.data;
              if (!Array.isArray(list)) return [];
              return list
                .map((k: any[]) => ({
                  timestamp: Number(k[0]),
                  open: parseFloat(k[1]),
                  high: parseFloat(k[2]),
                  low: parseFloat(k[3]),
                  close: parseFloat(k[4]),
                  volume: parseFloat(k[5]),
                }))
                .sort((a, b) => a.timestamp - b.timestamp);
            },
          },
        ]
      : []),
    ...(bitgetGrans[interval]
      ? [
          {
            id: 'bitget' as SupportedExchange,
            name: `Bitget Futures (${interval})`,
            url: `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${bitgetGrans[interval]}&limit=${Math.min(
              1000,
              safeLimit
            )}${endTimeParam}`,
            parse: (raw: any) => {
              const list = raw?.data;
              if (!Array.isArray(list)) return [];
              return list
                .map((k: any[]) => ({
                  timestamp: Number(k[0]),
                  open: parseFloat(k[1]),
                  high: parseFloat(k[2]),
                  low: parseFloat(k[3]),
                  close: parseFloat(k[4]),
                  volume: parseFloat(k[5]),
                }))
                .sort((a, b) => a.timestamp - b.timestamp);
            },
          },
        ]
      : []),
    {
      id: 'bingx',
      name: `BingX Swap (${interval})`,
      url: `https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${baseAsset}-${quoteAsset}&interval=${interval}&limit=${Math.min(
        1000,
        safeLimit
      )}${endTimeParam}`,
      parse: (raw: any) => {
        const list = raw?.data;
        if (!Array.isArray(list)) return [];
        return list
          .map((k: any) => ({
            timestamp: Number(k.time),
            open: parseFloat(k.open),
            high: parseFloat(k.high),
            low: parseFloat(k.low),
            close: parseFloat(k.close),
            volume: parseFloat(k.volume),
          }))
          .sort((a, b) => a.timestamp - b.timestamp);
      },
    },
    {
      id: 'binance',
      name: `Binance Spot (${interval})`,
      url: `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${safeLimit}${endTimeParam}`,
      parse: (raw: any) =>
        Array.isArray(raw)
          ? raw.map((k: any[]) => ({
              timestamp: Number(k[0]),
              open: parseFloat(k[1]),
              high: parseFloat(k[2]),
              low: parseFloat(k[3]),
              close: parseFloat(k[4]),
              volume: parseFloat(k[5]),
            }))
          : [],
    },
  ];

  // Prioritize the active exchange account if configured by the user
  const preferredExchange = exchangeAccountsStore.find((a) => a.enabled)?.exchange;
  const orderedProviders = preferredExchange
    ? [
        ...allProviders.filter((p) => p.id === preferredExchange),
        ...allProviders.filter((p) => p.id !== preferredExchange),
      ]
    : allProviders;

  for (const provider of orderedProviders) {
    try {
      const res = await fetchWithTimeout(provider.url, 5500);
      if (res.ok) {
        const raw = await res.json();
        const candles = provider
          .parse(raw)
          .filter((c) => Number.isFinite(c.timestamp) && Number.isFinite(c.close) && c.close > 0);
        if (candles.length > 5) {
          if (!endTimeMs) {
            const latest = candles[candles.length - 1];
            const existingTicker = tickerCache.get(pair);
            const target24hAgo = latest.timestamp - 86_400_000;
            const candle24h =
              candles.find((c) => c.timestamp >= target24hAgo) || candles[0];
            const computedChange24h = candle24h
              ? Number((((latest.close - candle24h.open) / candle24h.open) * 100).toFixed(2))
              : 0;

            tickerCache.set(pair, {
              price: latest.close,
              change24h:
                existingTicker && existingTicker.change24h !== 0
                  ? existingTicker.change24h
                  : computedChange24h,
              volume24h:
                existingTicker?.volume24h ||
                candles.reduce((acc, c) => acc + c.volume * c.close, 0),
              high24h:
                existingTicker?.high24h ||
                Math.max(...candles.slice(-24).map((c) => c.high)),
              low24h:
                existingTicker?.low24h ||
                Math.min(...candles.slice(-24).map((c) => c.low)),
              updatedAt: Date.now(),
            });
          }
          candleCache.set(cacheKey, {
            timestamp: Date.now(),
            candles,
            source: provider.name,
          });
          return { candles, source: provider.name };
        }
      }
    } catch {
      // try next exchange provider
    }
  }

  // No synthetic/demo candles: if all 5 exchanges are unreachable, return last cached real candles if available, otherwise empty
  const staleCached = candleCache.get(cacheKey);
  if (staleCached && staleCached.candles.length > 0) {
    return { candles: staleCached.candles, source: `${staleCached.source} (Cached)` };
  }
  return { candles: [], source: 'Offline' };
}

function buildFreqtradeDataframe(
  pair: string,
  timeframe: string,
  strategy: string,
  candles: RawCandle[],
  source: string
) {
  const columns = [
    'date',
    'open',
    'high',
    'low',
    'close',
    'volume',
    'enter_long',
    'enter_tag',
    'exit_long',
    'exit_tag',
    'enter_short',
    'exit_short',
  ];

  // Compute real ScalpingStrategy WaveTrend + Market Structure signals on this timeframe's candles
  const { wt1, wt2 } = calculateWaveTrend(candles);
  const ms = candles.length >= 20 ? detectMarketStructure(candles, Math.min(80, candles.length)) : null;
  const sup = ms?.nearest_support || 0;
  const res = ms?.nearest_resistance || 0;

  const data: any[][] = candles.map((c, idx) => {
    let enterLong: number | null = null;
    let enterTag: string | null = null;
    let exitLong: number | null = null;
    let exitTag: string | null = null;
    let enterShort: number | null = null;
    let exitShort: number | null = null;

    if (idx >= 22) {
      const prevWt1 = wt1[idx - 1];
      const prevWt2 = wt2[idx - 1];
      const curWt1 = wt1[idx];
      const curWt2 = wt2[idx];
      const crossedUp = prevWt1 <= prevWt2 && curWt1 > curWt2;
      const crossedDown = prevWt1 >= prevWt2 && curWt1 < curWt2;
      const nearSup = sup > 0 && Math.abs(c.low - sup) / sup <= 0.012;
      const nearRes = res > 0 && Math.abs(c.high - res) / res <= 0.012;

      if (crossedUp && (curWt2 <= -45 || nearSup) && c.close > c.open) {
        enterLong = c.low;
        enterTag = `WT_LONG_${timeframe.toUpperCase()}`;
      } else if (crossedDown && (curWt2 >= 45 || nearRes) && c.close < c.open) {
        enterShort = c.high;
        exitLong = c.high;
        exitTag = `WT_SHORT_${timeframe.toUpperCase()}`;
        exitShort = c.low;
      }
    }

    return [
      c.timestamp,
      c.open,
      c.high,
      c.low,
      c.close,
      c.volume,
      enterLong,
      enterTag,
      exitLong,
      exitTag,
      enterShort,
      exitShort,
    ];
  });

  return {
    pair,
    timeframe,
    strategy,
    exchange_source: source,
    columns,
    data,
    length: data.length,
    last_analyzed: Date.now(),
  };
}

// ============================================================================
// FREQTRADE BOT STATE MATCHING USER SCREENSHOTS + LIVE EXCHANGE CANDLES
// ============================================================================

interface TradeOrderEntry {
  id: string;
  step: number;
  label: string;
  side: 'long' | 'short';
  price: number;
  amount: number;
  stake_amount: number;
  timestamp: number;
  date: string;
}

interface PlannedDcaLevel {
  step: number;
  label: string;
  price: number;
  stake_amount: number;
  amount: number;
  distance_pct: number;
  manual_override?: boolean;
}

interface BotChartLevel {
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
  updated_at: string;
}

interface FreqtradeTrade {
  trade_id: number;
  pair: string;
  base_currency: string;
  quote_currency: string;
  is_open: boolean;
  is_short: boolean;
  exchange: string;
  account_id?: string;
  account_name?: string;
  parent_trade_id?: number;
  synced_accounts?: string[];
  amount: number;
  initial_amount?: number;
  stake_amount: number;
  initial_stake?: number;
  strategy: string;
  timeframe: string;
  enter_tag: string;
  open_date: string;
  open_timestamp: number;
  open_rate: number;
  initial_open_rate: number;
  dca_count: number;
  last_dca_date: string | null;
  current_rate: number;
  close_date: string | null;
  close_timestamp: number | null;
  close_rate: number | null;
  profit_ratio: number;
  profit_pct: number;
  profit_abs: number;
  take_profit_abs: number;
  take_profit_pct: number;
  tp_manual_override?: boolean;
  stop_loss_abs: number;
  stop_loss_pct: number;
  sl_manual_override?: boolean;
  dca_manual_override?: boolean;
  initial_stop_loss_abs: number;
  initial_stop_loss_pct: number;
  exit_reason: string | null;
  leverage: number;
  support_level?: number;
  resistance_level?: number;
  next_dca_price?: number;
  trade_state?: string;
  pullback_min_profit_pct?: number;
  plan_notes?: string;
  campaign_id?: string;
  campaign_banked_profit?: number;
  fee_open?: number;
  fee_close?: number;
  fee_total?: number;
  gross_profit?: number;
  net_profit?: number;
  net_profit_percent?: number;
  breakeven_price?: number;
  min_profitable_tp?: number;
  dca_history?: any[];
  orders: TradeOrderEntry[];
  planned_dca_levels: PlannedDcaLevel[];
}

// Стандартная комиссия биржи Taker 0.06% (0.0006) на открытие, каждый шаг DCA и закрытие сделки
const TAKER_FEE_RATE = 0.0006;
// Минимальный чистый профит над точкой безубытка (0.20% движения цены = +5% чистого ROI на плече 25x после вычета всех комиссий)
const MIN_NET_PROFIT_PRICE_BUFFER = 0.002;

function roundPrice(val: number): number {
  if (!Number.isFinite(val) || val <= 0) return 0;
  if (val >= 1000) return Number(val.toFixed(2));
  if (val >= 1) return Number(val.toFixed(4));
  return Number(val.toFixed(6));
}

// Load freqtrade/config.json from ported repository if available
let rawFreqtradeJson: Record<string, any> = {};
try {
  const cfgPath = path.resolve(process.cwd(), 'freqtrade/config.json');
  if (fs.existsSync(cfgPath)) {
    rawFreqtradeJson = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  }
} catch {
  rawFreqtradeJson = {};
}

const scalpBotConfig = {
  ...DEFAULT_SCALPBOT_CONFIG,
  ...rawFreqtradeJson,
};

function recalculateTradeMetrics(trade: FreqtradeTrade, resetLevels = false) {
  const lev = trade.leverage || scalpBotConfig.leverage || 25;
  const openRate = trade.open_rate > 0 ? trade.open_rate : 1;
  const refRate = trade.is_open ? trade.current_rate : (trade.close_rate ?? trade.current_rate);
  const totalAmount = Math.max(1e-8, trade.amount || 0);
  const exchangeFeeRate = getExchangeTakerFeeRate(trade.exchange || 'bybit');

  // Суммируем комиссию на открытие по всем реально исполненным ордерам (Начальный вход + все шаги DCA) по реальной ставке Taker биржи
  let openFeeSum = 0;
  if (Array.isArray(trade.orders) && trade.orders.length > 0) {
    for (const ord of trade.orders) {
      const ordNotional = (Number(ord.price) || openRate) * (Number(ord.amount) || 0);
      openFeeSum += ordNotional * exchangeFeeRate;
    }
  }
  if (openFeeSum <= 0) {
    openFeeSum = openRate * totalAmount * exchangeFeeRate;
  }

  const exitNotional = refRate * totalAmount;
  trade.fee_open = Number(openFeeSum.toFixed(4));
  // Если сделка уже закрыта и биржа вернула точную комиссию закрытия, сохраняем её
  if (trade.is_open || !trade.fee_close || trade.fee_close <= 0) {
    trade.fee_close = Number((exitNotional * exchangeFeeRate).toFixed(4));
  }
  trade.fee_total = Number((trade.fee_open + trade.fee_close).toFixed(4));

  const grossProfit = (trade.is_short ? openRate - refRate : refRate - openRate) * totalAmount;
  const netProfit = grossProfit - trade.fee_total;
  trade.gross_profit = Number(grossProfit.toFixed(4));
  trade.net_profit = Number(netProfit.toFixed(4));
  trade.net_profit_percent = Number(
    ((netProfit / Math.max(1e-8, trade.stake_amount)) * 100).toFixed(2)
  );

  // Вся статистика и условия выхода опираются строго на ЧИСТЫЙ профит (после вычета fee_open + всех DCA + fee_close)
  trade.profit_ratio = Number((trade.net_profit_percent / 100).toFixed(4));
  trade.profit_pct = trade.net_profit_percent;
  trade.profit_abs = Number(netProfit.toFixed(3));

  const feeOpenPerCoin = trade.fee_open / totalAmount;
  const exactBreakeven = trade.is_short
    ? (openRate - feeOpenPerCoin) / (1 + exchangeFeeRate)
    : (openRate + feeOpenPerCoin) / (1 - exchangeFeeRate);
  trade.breakeven_price = roundPrice(exactBreakeven);

  const rawMinProfitableTp = trade.is_short
    ? exactBreakeven * (1 - MIN_NET_PROFIT_PRICE_BUFFER)
    : exactBreakeven * (1 + MIN_NET_PROFIT_PRICE_BUFFER);
  trade.min_profitable_tp = roundPrice(rawMinProfitableTp);

  // Fast Scalp TP target (+0.8% after DCA or +1.2% initial 1H scalp target)
  const tpMove = (trade.dca_count || 0) > 0 ? 0.008 : 0.012;

  // Защита ручного TP: если пользователь сам перетащил TP (tp_manual_override === true), бот НИКОГДА не сбрасывает его в фоновых циклах!
  if (trade.tp_manual_override && trade.take_profit_abs > 0) {
    // Оставляем ровно тот TP, который выставил пользователь
  } else {
    const isTpBelowMinProfitable = trade.is_short
      ? (trade.take_profit_abs || 0) <= 0 || (trade.take_profit_abs || 0) > trade.min_profitable_tp
      : (trade.take_profit_abs || 0) <= 0 || (trade.take_profit_abs || 0) < trade.min_profitable_tp;

    if (resetLevels || !trade.take_profit_abs || trade.take_profit_abs <= 0) {
      const defaultTp = roundPrice(
        trade.is_short ? openRate * (1 - tpMove) : openRate * (1 + tpMove)
      );
      trade.take_profit_abs = trade.is_short
        ? Math.min(defaultTp, trade.min_profitable_tp)
        : Math.max(defaultTp, trade.min_profitable_tp);
    } else if (isTpBelowMinProfitable) {
      trade.take_profit_abs = trade.min_profitable_tp;
    }
  }

  // Чистый ожидаемый профит на уровне TP (за вычетом всех комиссий 0.06%)
  const tpExitFee = trade.take_profit_abs * totalAmount * TAKER_FEE_RATE;
  const tpGross =
    (trade.is_short ? openRate - trade.take_profit_abs : trade.take_profit_abs - openRate) *
    totalAmount;
  const tpNet = tpGross - (trade.fee_open + tpExitFee);
  trade.take_profit_pct = Number(
    ((tpNet / Math.max(1e-8, trade.stake_amount)) * 100).toFixed(2)
  );

  trade.stop_loss_abs = 0;
  trade.stop_loss_pct = 0;
  trade.pullback_min_profit_pct = 3.0;

  if (!trade.is_open) {
    trade.planned_dca_levels = [];
    return;
  }

  const dist1 = (trade.dca_count || 0) > 0 ? 0.02 : 0.015;
  const baseStake = trade.initial_stake || trade.stake_amount || scalpBotConfig.stake_amount;
  const nextStep1 = (trade.dca_count || 0) + 1;
  const nextStep2 = (trade.dca_count || 0) + 2;

  // Проверяем, является ли автоматический уровень адекватным (не дальше 20% от цены входа, чтобы исключить старые уровни вроде 0.027629 при пампе 0.26491)
  const isReasonableAutoDca = (p: number) => {
    if (!(p > 0)) return false;
    if (trade.is_short && p <= openRate) return false;
    if (!trade.is_short && p >= openRate) return false;
    const distPct = (Math.abs(p - openRate) / openRate) * 100;
    return distPct >= 0.3 && distPct <= 20.0;
  };

  if (resetLevels || !Array.isArray(trade.planned_dca_levels) || trade.planned_dca_levels.length === 0) {
    const prevLevels = Array.isArray(trade.planned_dca_levels) ? trade.planned_dca_levels : [];
    const prevManualStep1 = prevLevels.find((l) => l.step === nextStep1 && l.manual_override);
    const prevManualStep2 = prevLevels.find((l) => l.step === nextStep2 && l.manual_override);

    const isValidManualSide = (p: number) =>
      p > 0 && (trade.is_short ? p > openRate : p < openRate);

    let dcaPrice1: number;
    let isManual1 = false;
    if (prevManualStep1 && isValidManualSide(prevManualStep1.price)) {
      dcaPrice1 = roundPrice(prevManualStep1.price);
      isManual1 = true;
    } else if (trade.dca_manual_override && !resetLevels && trade.next_dca_price && isValidManualSide(trade.next_dca_price)) {
      dcaPrice1 = roundPrice(trade.next_dca_price);
      isManual1 = true;
    } else if (trade.next_dca_price && isReasonableAutoDca(trade.next_dca_price)) {
      dcaPrice1 = roundPrice(trade.next_dca_price);
      isManual1 = false;
    } else {
      dcaPrice1 = roundPrice(trade.is_short ? openRate * (1 + dist1) : openRate * (1 - dist1));
    }

    let dcaPrice2: number;
    let isManual2 = false;
    if (
      prevManualStep2 &&
      prevManualStep2.price > 0 &&
      (trade.is_short ? prevManualStep2.price > dcaPrice1 : prevManualStep2.price < dcaPrice1)
    ) {
      dcaPrice2 = roundPrice(prevManualStep2.price);
      isManual2 = true;
    } else {
      dcaPrice2 = roundPrice(
        trade.is_short ? dcaPrice1 * (1 + dist1) : dcaPrice1 * (1 - dist1)
      );
    }

    trade.next_dca_price = dcaPrice1;
    trade.dca_manual_override = isManual1 || isManual2;
    trade.planned_dca_levels = [
      {
        step: nextStep1,
        label: `DCA ${nextStep1}`,
        price: dcaPrice1,
        stake_amount: baseStake,
        amount: Number(((baseStake * lev) / Math.max(1e-8, dcaPrice1)).toFixed(4)),
        distance_pct: Number((((dcaPrice1 - openRate) / openRate) * 100).toFixed(2)),
        manual_override: isManual1,
      },
      {
        step: nextStep2,
        label: `DCA ${nextStep2}`,
        price: dcaPrice2,
        stake_amount: baseStake,
        amount: Number(((baseStake * lev) / Math.max(1e-8, dcaPrice2)).toFixed(4)),
        distance_pct: Number((((dcaPrice2 - openRate) / openRate) * 100).toFixed(2)),
        manual_override: isManual2,
      },
    ];
  } else {
    // Сохраняем все уровни DCA, которые перетащил пользователь (manual_override === true),
    // и автоматически исправляем только старые не-ручные уровни, если они улетели дальше 20% от openRate (как 0.027629 на ARIA/USDT)
    for (let i = 0; i < trade.planned_dca_levels.length; i++) {
      const lvl = trade.planned_dca_levels[i];
      if (!lvl.manual_override && !isReasonableAutoDca(lvl.price)) {
        const refBase = i === 0 ? openRate : trade.planned_dca_levels[i - 1].price;
        lvl.price = roundPrice(trade.is_short ? refBase * (1 + dist1) : refBase * (1 - dist1));
      }
      lvl.amount = Number(((lvl.stake_amount * lev) / Math.max(1e-8, lvl.price)).toFixed(4));
      lvl.distance_pct = Number((((lvl.price - openRate) / openRate) * 100).toFixed(2));
    }
    if (trade.planned_dca_levels[0]) {
      trade.next_dca_price = trade.planned_dca_levels[0].price;
    }
  }
}

const botConfig = {
  version: '2026.9-ScalpBot',
  strategy_version: 'v2.5-MTF',
  api_version: 2.34,
  dry_run: Boolean(scalpBotConfig.dry_run),
  runmode: scalpBotConfig.dry_run ? 'dry_run' : 'live',
  state: 'running' as 'running' | 'stopped' | 'paused',
  bot_name: 'ScalpBot',
  strategy: String(scalpBotConfig.strategy || 'ScalpingStrategy'),
  timeframe: String(scalpBotConfig.timeframe || '1h'),
  timeframe_ms: 3600000,
  exchange: 'binance',
  stake_currency: String(scalpBotConfig.stake_currency || 'USDT'),
  stake_amount: Number(scalpBotConfig.stake_amount || 25),
  stake_percent: Number(scalpBotConfig.stake_percent || 0.005),
  min_stake_amount: Number(scalpBotConfig.min_stake_amount || 5),
  leverage: Number(scalpBotConfig.leverage || 25),
  margin_mode: String(scalpBotConfig.margin_mode || 'cross'),
  max_open_trades: Number(scalpBotConfig.max_open_trades || 30),
  dca_enabled: Boolean(scalpBotConfig.dca_enabled ?? true),
  max_dca_orders: Number(scalpBotConfig.max_dca_orders || 5),
  dca_multiplier: scalpBotConfig.dca_scale_mode === 'martingale' ? 1.5 : 1.0,
  max_position_multiplier: Number(scalpBotConfig.max_position_multiplier || 6.0),
  min_liquidation_distance_pct: Number(scalpBotConfig.min_liquidation_distance_pct || 15.0),
  max_margin_used_for_dca_pct: Number(scalpBotConfig.max_margin_used_for_dca_pct || 60.0),
  max_pair_margin_pct: Number(scalpBotConfig.max_pair_margin_pct || 20.0),
  dca_scale_mode: String(scalpBotConfig.dca_scale_mode || 'linear'),
  stoploss: Number(scalpBotConfig.stoploss ?? -1.0),
  trailing_stop: false,
  trailing_stop_positive: 0.02,
  trailing_stop_positive_offset: 0.035,
  minimal_roi: {
    '0': 0.08,
    '120': 0.05,
    '240': 0.035,
  },
  force_entry_enable: true,
  starting_balance: 0,
};

let blacklist: string[] = [
  'USDC/USDT:USDT',
  'TUSD/USDT:USDT',
  'FDUSD/USDT:USDT',
  'BUSD/USDT:USDT',
  'EUR/USDT:USDT',
];
let pairLocks: any[] = [];
const botLogs: any[] = [];
const cooldownPairs = new Map<string, number>();

function appendLog(logger: string, level: 'INFO' | 'DEBUG' | 'WARNING' | 'ERROR', message: string) {
  const now = new Date();
  const formatted = now.toISOString().replace('T', ' ').slice(0, 19);
  botLogs.push({
    timestamp: formatted,
    epoch: now.getTime(),
    logger,
    level,
    message,
  });
  if (botLogs.length > 250) botLogs.shift();
}

let tradesStore: FreqtradeTrade[] = [];
const botLevelsStore = new Map<string, BotChartLevel[]>();

interface ChartDrawingPoint {
  timestamp: number;
  price: number;
}

interface ChartDrawingObject {
  id: string;
  pair: string;
  tool:
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
  points: ChartDrawingPoint[];
  color: string;
  text?: string;
  locked?: boolean;
  created_at: string;
}

const chartDrawingsStore = new Map<string, ChartDrawingObject[]>();

type SupportedExchange = 'binance' | 'bybit' | 'okx' | 'bitget' | 'bingx';

interface ExchangeAccountRecord {
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
  connected_at?: number;
  api_key_raw?: string;
  api_secret_raw?: string;
  passphrase_raw?: string;
  is_testnet?: boolean;
  network_label?: string;
}

function hasConnectedExchangeAccount(): boolean {
  return exchangeAccountsStore.some((a) => a.enabled);
}

/**
 * Возвращает актуальный баланс аккаунта:
 * - Для реальных биржевых ключей (Bybit / Binance / OKX / Bitget / BingX): `acc.balance_usdt` синхронизируется напрямую с API биржи
 *   и УЖЕ включает в себя все закрытые сделки и списанные комиссии (1 в 1 как на счету Bybit).
 * - Для тестовых симуляционных ключей (`test_...`): складывает стартовый депозит + накопленный чистый профит.
 */
function getCompoundedAccountBalance(accountId = 'master'): {
  baseDeposit: number;
  closedNetProfit: number;
  compoundedBalance: number;
} {
  if (!hasConnectedExchangeAccount()) {
    return { baseDeposit: 0, closedNetProfit: 0, compoundedBalance: 0 };
  }
  if (accountId === 'master') {
    const ownerAcc =
      exchangeAccountsStore.find((a) => a.enabled && a.is_owner) ||
      exchangeAccountsStore.find((a) => a.enabled);
    const rawBalance = Number(ownerAcc?.balance_usdt || botConfig.starting_balance || 5000);
    const closedNetProfit = tradesStore
      .filter((t) => !t.is_open && (!t.account_id || t.account_id === 'master'))
      .reduce((sum, t) => sum + (t.net_profit ?? t.profit_abs ?? 0), 0);
    const isRealExchangeAcc = Boolean(
      ownerAcc?.api_key_raw && !isSimulatedTestApiKey(ownerAcc.api_key_raw)
    );
    if (isRealExchangeAcc) {
      return {
        baseDeposit: Number(Math.max(10, rawBalance - closedNetProfit).toFixed(2)),
        closedNetProfit: Number(closedNetProfit.toFixed(2)),
        compoundedBalance: Number(Math.max(0, rawBalance).toFixed(2)),
      };
    }
    return {
      baseDeposit: rawBalance,
      closedNetProfit: Number(closedNetProfit.toFixed(2)),
      compoundedBalance: Number(Math.max(10, rawBalance + closedNetProfit).toFixed(2)),
    };
  }
  const clientAcc = exchangeAccountsStore.find((a) => a.id === accountId);
  const rawBalance = Number(clientAcc?.balance_usdt || 1000);
  const closedNetProfit = tradesStore
    .filter((t) => !t.is_open && t.account_id === accountId)
    .reduce((sum, t) => sum + (t.net_profit ?? t.profit_abs ?? 0), 0);
  const isRealClientAcc = Boolean(
    clientAcc?.api_key_raw && !isSimulatedTestApiKey(clientAcc.api_key_raw)
  );
  if (isRealClientAcc) {
    return {
      baseDeposit: Number(Math.max(10, rawBalance - closedNetProfit).toFixed(2)),
      closedNetProfit: Number(closedNetProfit.toFixed(2)),
      compoundedBalance: Number(Math.max(0, rawBalance).toFixed(2)),
    };
  }
  return {
    baseDeposit: rawBalance,
    closedNetProfit: Number(closedNetProfit.toFixed(2)),
    compoundedBalance: Number(Math.max(10, rawBalance + closedNetProfit).toFixed(2)),
  };
}

function maskApiKey(rawKey: string): string {
  const clean = String(rawKey || '').trim();
  if (clean.length <= 8) return '••••••••' + clean.slice(-2);
  return `${clean.slice(0, 4)}••••••••${clean.slice(-4)}`;
}

// Чистая база API-аккаунтов, синхронизированная с trades.sqlite
let exchangeAccountsStore: ExchangeAccountRecord[] = [];

let nextTradeId = 1;
let initializedTrades = false;

/**
 * Computes or loads MTF & Timeframe-specific Support/Resistance levels for a pair.
 * Respects any manual drags or additions saved by the user in trades.sqlite, while dynamically
 * computing Support & Resistance for the active timeframe (1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d, 1w).
 */
async function getOrComputeMtfBotLevels(pair: string, timeframe = '1h'): Promise<BotChartLevel[]> {
  const cleanPair = pair.toUpperCase();
  const normTf = String(timeframe || '1h').trim().toLowerCase();
  const tfLabel = normTf.toUpperCase();
  const storeKey = `${cleanPair}_${normTf}`;

  if (botLevelsStore.has(storeKey)) {
    return botLevelsStore.get(storeKey)!;
  }

  // Load all persisted levels for this pair (including deleted flag so deleted auto-levels are never recreated)
  const allForPair = sqliteDb.getAllBotLevelsForPairIncludeDeleted(cleanPair);

  // All manual levels configured or dragged by the user on this pair apply across all timeframes and bot cycles
  const manualLevels = allForPair.filter((l) => l.manual_override && !l.deleted);
  const hasManualSupport = manualLevels.some((l) => l.role === 'support');
  const hasManualResistance = manualLevels.some((l) => l.role === 'resistance');

  try {
    const { candles: tfCandles } = await fetchRealCandles(cleanPair, normTf, 220);
    const ms = detectMarketStructure(tfCandles, Math.min(120, Math.max(25, tfCandles.length)));
    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const generated: BotChartLevel[] = [...manualLevels];

    const supId = `tf-sup-${cleanPair}-${normTf}`;
    const resId = `tf-res-${cleanPair}-${normTf}`;

    const savedSup = allForPair.find(
      (l) => l.id === supId || (l.id === `mtf-sup-${cleanPair}` && normTf === '4h')
    );
    const savedRes = allForPair.find(
      (l) => l.id === resId || (l.id === `mtf-res-${cleanPair}` && normTf === '4h')
    );

    if (!hasManualSupport && !savedSup?.deleted) {
      if (savedSup && !savedSup.deleted) {
        if (!generated.some((g) => g.id === savedSup.id)) generated.push(savedSup);
      } else if (ms.nearest_support > 0) {
        const sh = ms.support_history;
        const scoreTxt = sh ? ` ${sh.strength_score.toFixed(1)}★` : '';
        const lvl: BotChartLevel = {
          id: supId,
          pair: cleanPair,
          label: `${tfLabel} SUP${scoreTxt}`,
          role: 'support',
          price: roundPrice(ms.nearest_support),
          touches: sh?.touches || 2,
          bounces: sh?.bounces || 2,
          breaks: sh?.breaks || 0,
          strength_score: sh?.strength_score || 3.0,
          source: tfLabel,
          manual_override: false,
          updated_at: nowStr,
        };
        generated.push(lvl);
        if (!allForPair.some((l) => l.id === supId)) {
          sqliteDb.upsertBotLevel({ ...lvl, deleted: false });
        }
      }
    }

    if (!hasManualResistance && !savedRes?.deleted) {
      if (savedRes && !savedRes.deleted) {
        if (!generated.some((g) => g.id === savedRes.id)) generated.push(savedRes);
      } else if (ms.nearest_resistance > 0) {
        const rh = ms.resistance_history;
        const scoreTxt = rh ? ` ${rh.strength_score.toFixed(1)}★` : '';
        const lvl: BotChartLevel = {
          id: resId,
          pair: cleanPair,
          label: `${tfLabel} RES${scoreTxt}`,
          role: 'resistance',
          price: roundPrice(ms.nearest_resistance),
          touches: rh?.touches || 2,
          bounces: rh?.bounces || 2,
          breaks: rh?.breaks || 0,
          strength_score: rh?.strength_score || 3.0,
          source: tfLabel,
          manual_override: false,
          updated_at: nowStr,
        };
        generated.push(lvl);
        if (!allForPair.some((l) => l.id === resId)) {
          sqliteDb.upsertBotLevel({ ...lvl, deleted: false });
        }
      }
    }

    generated.sort((a, b) => b.price - a.price);
    botLevelsStore.set(storeKey, generated);
    botLevelsStore.set(cleanPair, generated);
    return generated;
  } catch {
    return manualLevels;
  }
}

async function initializeBotTrades() {
  if (initializedTrades) return;
  initializedTrades = true;

  // 1. Загружаем сохраненные биржевые аккаунты и все сделки (открытые, усредненные, закрытые) из trades.sqlite
  const rawTrades = sqliteDb.loadAllTrades();
  exchangeAccountsStore = sqliteDb.loadExchangeAccounts();

  // Deduplicate any duplicate test accounts by client_access_code or (name + exchange)
  const uniqueAccounts: ExchangeAccountRecord[] = [];
  const seenAccKeys = new Set<string>();
  for (const acc of exchangeAccountsStore) {
    const key = `${acc.client_access_code || ''}::${acc.name.toLowerCase()}::${acc.exchange}`;
    if (seenAccKeys.has(key)) {
      sqliteDb.deleteExchangeAccount(acc.id);
    } else {
      seenAccKeys.add(key);
      uniqueAccounts.push(acc);
    }
  }
  exchangeAccountsStore = uniqueAccounts;
  const validAccIds = new Set(exchangeAccountsStore.map((a) => a.id));

  // 2. Подтягиваем актуальные рыночные котировки до пересчета сделок (если сеть временно недоступна — используем сохраненный current_rate из БД)
  await fetchAllMarketPairs().catch(() => {});

  // 3. Восстанавливаем все сделки без потерь (НИКОГДА не удаляем реальные открытые или усредненные сделки при перезапуске/сбое)
  const hasActiveExchange = exchangeAccountsStore.some((a) => a.enabled);
  const seenOpenKeys = new Set<string>();
  const cleanTrades: FreqtradeTrade[] = [];
  // Sort ascending by trade_id so we keep the original trade #1 first
  const sortedAsc = [...rawTrades].sort((a, b) => a.trade_id - b.trade_id);
  for (const t of sortedAsc) {
    const accId = t.account_id || 'master';
    const isOrphanClient = accId !== 'master' && exchangeAccountsStore.length > 0 && !validAccIds.has(accId);
    const isFakeTestRate =
      t.pair === 'ETH/USDT:USDT' && t.open_rate === 2500 && exchangeAccountsStore.length === 0;
    if (isOrphanClient || isFakeTestRate) {
      sqliteDb.deleteTrade(t.trade_id);
      continue;
    }
    if (t.is_open) {
      const openKey = `${accId}::${t.pair}::${t.is_short ? 'short' : 'long'}`;
      if (seenOpenKeys.has(openKey)) {
        sqliteDb.deleteTrade(t.trade_id);
        continue;
      }
      seenOpenKeys.add(openKey);

      // Обновляем текущую цену из живого кэша котировок (или сохраняем последний известный current_rate из trades.sqlite)
      const liveTicker = tickerCache.get(t.pair);
      if (liveTicker && liveTicker.price > 0) {
        t.current_rate = liveTicker.price;
      }
    }
    recalculateTradeMetrics(t, false);
    cleanTrades.unshift(t);
  }

  // 4. Восстанавливаем связь synced_accounts для сделок владельца по привязанным сделкам клиентов (parent_trade_id)
  for (const t of cleanTrades) {
    if (!t.account_id || t.account_id === 'master') {
      const linkedClients = cleanTrades.filter(
        (ct) => ct.account_id && ct.account_id !== 'master' && ct.parent_trade_id === t.trade_id
      );
      if (linkedClients.length > 0) {
        t.synced_accounts = Array.from(
          new Set([...(t.synced_accounts || []), ...linkedClients.map((c) => c.account_name || 'Client')])
        );
      }
    }
    sqliteDb.upsertTrade(t);
  }

  tradesStore = cleanTrades;

  // Строгое правило: без подключенного биржевого аккаунта бот остановлен (но все существующие сделки в БД сохранены)
  botConfig.state = hasActiveExchange ? 'running' : 'stopped';

  const maxExistingId = tradesStore.reduce((m, t) => Math.max(m, t.trade_id || 0), 0);
  nextTradeId = maxExistingId + 1;

  const openMasterCount = tradesStore.filter(
    (t) => t.is_open && (!t.account_id || t.account_id === 'master')
  ).length;
  const averagedMasterCount = tradesStore.filter(
    (t) => t.is_open && (!t.account_id || t.account_id === 'master') && (t.dca_count || 0) > 0
  ).length;
  const totalDcaStepsRestored = tradesStore
    .filter((t) => t.is_open && (!t.account_id || t.account_id === 'master'))
    .reduce((sum, t) => sum + (t.dca_count || 0), 0);

  appendLog(
    'freqtrade.worker',
    hasActiveExchange ? 'INFO' : 'WARNING',
    hasActiveExchange
      ? `Starting ScalpBot (${botConfig.version}) | Strategy: ${botConfig.strategy} (${botConfig.timeframe}) | Leverage: ${botConfig.leverage}x ${botConfig.margin_mode} | Active Exchanges: ${exchangeAccountsStore.filter((a) => a.enabled).length}`
      : `ScalpBot ожидает подключения биржи (state: STOPPED). Подключите API-ключи во вкладке «API / Клиенты» для запуска анализа и торговли.`
  );
  appendLog(
    'freqtrade.database',
    'INFO',
    `🔄 Восстановлено состояние из trades.sqlite после старта/перезапуска: открытых сделок владельца=${openMasterCount} (из них усреднённых=${averagedMasterCount}, шагов DCA=${totalDcaStepsRestored}), всего сделок в памяти=${tradesStore.length}, аккаунтов=${exchangeAccountsStore.length}`
  );

  if (hasActiveExchange) {
    syncRealExchangeBalancesIfNeeded(true).catch(() => {});
  }
}

let lastExchangeBalanceSyncTs = 0;

function resolveExchangeAccountRecord(
  accOrId: ExchangeAccountRecord | string | undefined
): ExchangeAccountRecord | undefined {
  if (!accOrId) return undefined;
  if (typeof accOrId !== 'string') return accOrId;
  if (accOrId === 'master') {
    const active = exchangeAccountsStore.filter((a) => a.enabled);
    return active.find((a) => a.is_owner) || active[0];
  }
  return exchangeAccountsStore.find((a) => a.id === accOrId);
}

function getAccountCredentialsFromStore(
  accOrId: ExchangeAccountRecord | string | undefined
) {
  const acc = resolveExchangeAccountRecord(accOrId);
  if (!acc) return null;
  let key = acc.api_key_raw;
  let secret = acc.api_secret_raw;
  let pass = acc.passphrase_raw;
  if (!key || !secret) {
    const dbAccs = sqliteDb.loadExchangeAccounts();
    const found = dbAccs.find((a) => a.id === acc.id);
    if (found) {
      key = found.api_key_raw;
      secret = found.api_secret_raw;
      pass = found.passphrase_raw;
      acc.api_key_raw = key;
      acc.api_secret_raw = secret;
      acc.passphrase_raw = pass;
    }
  }
  if (!key || !secret) return null;
  return {
    exchange: acc.exchange,
    apiKey: String(key).trim(),
    apiSecret: String(secret).trim(),
    passphrase: pass ? String(pass).trim() : undefined,
    isTestnet: Boolean(acc.is_testnet),
  };
}

async function dispatchOrderToExchangeAccount(
  accOrId: ExchangeAccountRecord | string | undefined,
  params: ExchangeOrderParams
): Promise<PlacedOrderResult | null> {
  const acc = resolveExchangeAccountRecord(accOrId);
  const creds = getAccountCredentialsFromStore(acc);
  if (!acc || !creds) return null;

  const orderRes = await executeExchangeFuturesOrder(creds, params);
  if (!orderRes.is_simulated_test) {
    const netTag =
      orderRes.network_label ||
      (acc.is_testnet ? `${acc.exchange.toUpperCase()} TESTNET` : acc.exchange.toUpperCase());
    if (orderRes.success) {
      appendLog(
        `freqtrade.exchange.${acc.exchange}`,
        'INFO',
        `✅ [${netTag} LIVE ORDER] Исполнен ордер на бирже (${acc.name}): ${params.action} [${params.pair}] ${orderRes.side} ${orderRes.qty} @ ${orderRes.price}$ (комиссия: ${orderRes.commission_usdt ?? 0}$) | OrderID: ${orderRes.order_id}`
      );
      // Сразу синхронизируем реальный баланс счета с биржей после исполнения ордера
      syncRealExchangeBalancesIfNeeded(true).catch(() => {});
    } else {
      appendLog(
        `freqtrade.exchange.${acc.exchange}`,
        'ERROR',
        `❌ [${netTag} ORDER REJECTED] Биржа отклонила ордер (${acc.name}) при ${params.action} [${params.pair}]: ${orderRes.error || 'Неизвестная ошибка биржи'}`
      );
    }
  }
  return orderRes;
}

async function syncPositionsAndHistoryFromExchanges(acc: ExchangeAccountRecord): Promise<void> {
  const creds = getAccountCredentialsFromStore(acc);
  if (!creds || isSimulatedTestApiKey(creds.apiKey)) return;

  const targetAccountId = acc.is_owner ? 'master' : acc.id;
  const targetAccountName = acc.is_owner ? 'Master' : acc.name;

  try {
    const [openPosRes, closedPnlRes] = await Promise.all([
      fetchExchangeOpenPositions(creds),
      fetchExchangeClosedPnl(creds, 50),
    ]);

    // 1. Синхронизация всех открытых позиций, которые уже есть на биржевом аккаунте
    if (openPosRes.success) {
      for (const pos of openPosRes.positions) {
        const existingOpen = tradesStore.find(
          (t) =>
            t.is_open &&
            (targetAccountId === 'master'
              ? !t.account_id || t.account_id === 'master'
              : t.account_id === targetAccountId) &&
            t.pair === pos.pair &&
            t.is_short === pos.is_short
        );

        if (existingOpen) {
          let updated = false;
          if (pos.mark_price > 0 && Math.abs(existingOpen.current_rate - pos.mark_price) > 1e-8) {
            existingOpen.current_rate = roundPrice(pos.mark_price);
            updated = true;
          }
          if (
            Math.abs(existingOpen.amount - pos.size) > 1e-5 ||
            Math.abs(existingOpen.open_rate - pos.entry_price) / Math.max(1e-8, pos.entry_price) > 0.0005
          ) {
            existingOpen.open_rate = roundPrice(pos.entry_price);
            existingOpen.amount = Number(pos.size.toFixed(4));
            existingOpen.stake_amount = Number(pos.margin_usdt.toFixed(2));
            existingOpen.leverage = pos.leverage || existingOpen.leverage;
            updated = true;
          }
          if (updated) {
            recalculateTradeMetrics(existingOpen, false);
            sqliteDb.upsertTrade(existingOpen);
          }
        } else {
          // На бирже уже есть открытая позиция, которой еще нет на сайте — импортируем её, чтобы бот видел её и управлял ей (без дублирования входов!)
          const id = nextTradeId++;
          const openTs = pos.created_time > 0 ? pos.created_time : Date.now();
          const openDateStr = new Date(openTs).toISOString().replace('T', ' ').slice(0, 19);
          const [base, quote] = pos.pair.split(':')[0].split('/');
          const entryRate = roundPrice(pos.entry_price);
          const markRate = roundPrice(pos.mark_price > 0 ? pos.mark_price : entryRate);
          const lev = pos.leverage || acc.max_leverage || 25;
          const stakeUsdt = Number(pos.margin_usdt.toFixed(2));
          const posTp = Number(pos.take_profit || 0);
          const posSl = Number(pos.stop_loss || 0);
          const initialTp =
            posTp > 0
              ? roundPrice(posTp)
              : roundPrice(pos.is_short ? entryRate * (1 - 0.012) : entryRate * (1 + 0.012));
          const initialDcaPrice = roundPrice(pos.is_short ? entryRate * 1.028 : entryRate * 0.972);
          const feeRate = getExchangeTakerFeeRate(acc.exchange);

          const importedTrade: FreqtradeTrade = {
            trade_id: id,
            pair: pos.pair,
            base_currency: base || 'ETH',
            quote_currency: quote || 'USDT',
            is_open: true,
            is_short: pos.is_short,
            exchange: acc.exchange,
            account_id: targetAccountId,
            account_name: targetAccountName,
            synced_accounts: [acc.name],
            amount: Number(pos.size.toFixed(4)),
            initial_amount: Number(pos.size.toFixed(4)),
            stake_amount: stakeUsdt,
            initial_stake: stakeUsdt,
            strategy: botConfig.strategy,
            timeframe: botConfig.timeframe,
            fee_open: Number((entryRate * pos.size * feeRate).toFixed(4)),
            fee_close: Number((markRate * pos.size * feeRate).toFixed(4)),
            open_date: openDateStr,
            open_timestamp: openTs,
            open_rate: entryRate,
            initial_open_rate: entryRate,
            dca_count: 0,
            last_dca_date: null,
            close_date: null,
            close_timestamp: null,
            close_rate: null,
            current_rate: markRate,
            profit_ratio: 0,
            profit_pct: 0,
            profit_abs: 0,
            stop_loss_abs: posSl > 0 ? roundPrice(posSl) : 0,
            stop_loss_pct: 0,
            initial_stop_loss_abs: posSl > 0 ? roundPrice(posSl) : 0,
            initial_stop_loss_pct: 0,
            exit_reason: null,
            take_profit_abs: initialTp,
            take_profit_pct: Number((0.012 * lev * 100).toFixed(1)),
            leverage: lev,
            enter_tag: 'EXCHANGE_SYNC_LIVE',
            orders: [
              {
                id: `ord-${id}-0`,
                step: 0,
                label: `Синхр. с биржи ${acc.exchange.toUpperCase()} (${pos.is_short ? 'Шорт' : 'Лонг'})`,
                side: pos.is_short ? 'short' : 'long',
                price: entryRate,
                amount: Number(pos.size.toFixed(4)),
                stake_amount: stakeUsdt,
                timestamp: openTs,
                date: openDateStr,
              },
            ],
            planned_dca_levels: [
              {
                step: 1,
                label: 'DCA #1 (4H S/R Zone)',
                price: initialDcaPrice,
                stake_amount: stakeUsdt,
                amount: Number(((stakeUsdt * lev) / Math.max(1e-8, initialDcaPrice)).toFixed(4)),
                distance_pct: pos.is_short ? 2.8 : -2.8,
              },
            ],
            support_level: pos.is_short ? initialTp : initialDcaPrice,
            resistance_level: pos.is_short ? initialDcaPrice : initialTp,
            plan_notes: `Позиция синхронизирована напрямую с биржи ${acc.exchange.toUpperCase()} (${acc.name})`,
            trade_state: 'WAITING_PULLBACK',
            next_dca_price: initialDcaPrice,
            tp_manual_override: posTp > 0,
            sl_manual_override: posSl > 0,
            dca_manual_override: false,
          };

          recalculateTradeMetrics(importedTrade, false);
          tradesStore.unshift(importedTrade);
          sqliteDb.upsertTrade(importedTrade);
          appendLog(
            `freqtrade.exchange.${acc.exchange}`,
            'INFO',
            `🔄 [EXCHANGE POSITION SYNC] Подтянута действующая позиция с биржи ${acc.exchange.toUpperCase()} (${acc.name}): #${id} [${pos.pair}] ${pos.is_short ? 'SHORT' : 'LONG'} ${lev}x | Объем: ${pos.size} @ ${entryRate}$ (Маржа: $${stakeUsdt})`
          );
        }
      }

      // 2. Если сделка числится открытой на сайте (старше 20 сек), но на бирже она уже закрыта — закрываем её и подтягиваем реальную цену и PnL с биржи
      const localOpenForAcc = tradesStore.filter(
        (t) =>
          t.is_open &&
          t.exchange === acc.exchange &&
          (targetAccountId === 'master'
            ? !t.account_id || t.account_id === 'master'
            : t.account_id === targetAccountId) &&
          Date.now() - (t.open_timestamp || 0) > 20_000
      );

      for (const localTrade of localOpenForAcc) {
        const stillOpenOnExchange = openPosRes.positions.some(
          (p) => p.pair === localTrade.pair && p.is_short === localTrade.is_short
        );
        if (!stillOpenOnExchange) {
          const matchedClosed = closedPnlRes.closed.find(
            (c) =>
              c.pair === localTrade.pair &&
              c.is_short === localTrade.is_short &&
              c.updated_time >= (localTrade.open_timestamp || 0) - 120_000
          );
          const closePrice = roundPrice(
            matchedClosed && matchedClosed.exit_price > 0
              ? matchedClosed.exit_price
              : localTrade.current_rate
          );
          const closeTs =
            matchedClosed && matchedClosed.updated_time > 0
              ? matchedClosed.updated_time
              : Date.now();
          const closeDateStr = new Date(closeTs).toISOString().replace('T', ' ').slice(0, 19);

          localTrade.is_open = false;
          localTrade.close_rate = closePrice;
          localTrade.current_rate = closePrice;
          localTrade.close_timestamp = closeTs;
          localTrade.close_date = closeDateStr;
          localTrade.exit_reason = 'exchange_closed_sync';
          localTrade.trade_state = 'CLOSED';
          localTrade.planned_dca_levels = [];
          recalculateTradeMetrics(localTrade, false);

          if (matchedClosed && Number.isFinite(matchedClosed.closed_pnl)) {
            localTrade.net_profit = Number(matchedClosed.closed_pnl.toFixed(4));
            localTrade.profit_abs = Number(matchedClosed.closed_pnl.toFixed(3));
            localTrade.net_profit_percent = Number(
              ((localTrade.net_profit / Math.max(1e-8, localTrade.stake_amount)) * 100).toFixed(2)
            );
            localTrade.profit_pct = localTrade.net_profit_percent;
            localTrade.profit_ratio = Number((localTrade.net_profit_percent / 100).toFixed(4));
          }

          sqliteDb.upsertTrade(localTrade);
          appendLog(
            `freqtrade.exchange.${acc.exchange}`,
            'INFO',
            `🏁 [EXCHANGE CLOSE SYNC] Позиция #${localTrade.trade_id} [${localTrade.pair}] была закрыта на бирже ${acc.exchange.toUpperCase()} @ ${closePrice}$ | Реальный PnL: ${localTrade.profit_abs}$`
          );
        }
      }
    }

    // 3. Импорт истории закрытых сделок с биржи (чтобы Дашборд и Закрытые сделки отражали реальную историю счета)
    if (closedPnlRes.success && closedPnlRes.closed.length > 0) {
      for (const c of closedPnlRes.closed.slice(0, 25)) {
        const alreadyRecorded = tradesStore.some(
          (t) =>
            !t.is_open &&
            t.pair === c.pair &&
            ((c.order_id && t.plan_notes && t.plan_notes.includes(c.order_id)) ||
              Math.abs((t.close_timestamp || 0) - c.updated_time) < 90_000)
        );
        if (alreadyRecorded) continue;

        const id = nextTradeId++;
        const [base, quote] = c.pair.split(':')[0].split('/');
        const openTs = c.created_time > 0 ? c.created_time : c.updated_time - 600_000;
        const closeTs = c.updated_time > 0 ? c.updated_time : Date.now();
        const openDateStr = new Date(openTs).toISOString().replace('T', ' ').slice(0, 19);
        const closeDateStr = new Date(closeTs).toISOString().replace('T', ' ').slice(0, 19);
        const lev = c.leverage || acc.max_leverage || 25;
        const notional = c.entry_price * c.qty;
        const stakeUsdt = Math.max(0.5, Number((notional / Math.max(1, lev)).toFixed(2)));
        const feeRate = getExchangeTakerFeeRate(acc.exchange);
        const feeOpen = Number((c.entry_price * c.qty * feeRate).toFixed(4));
        const feeClose = Number((c.exit_price * c.qty * feeRate).toFixed(4));
        const feeTotal = Number((feeOpen + feeClose).toFixed(4));
        const netPnl = Number(c.closed_pnl.toFixed(4));
        const netPct = Number(((netPnl / Math.max(1e-8, stakeUsdt)) * 100).toFixed(2));

        const closedTrade: FreqtradeTrade = {
          trade_id: id,
          pair: c.pair,
          base_currency: base || 'ETH',
          quote_currency: quote || 'USDT',
          is_open: false,
          is_short: c.is_short,
          exchange: acc.exchange,
          account_id: targetAccountId,
          account_name: targetAccountName,
          synced_accounts: [acc.name],
          amount: Number(c.qty.toFixed(4)),
          initial_amount: Number(c.qty.toFixed(4)),
          stake_amount: stakeUsdt,
          initial_stake: stakeUsdt,
          strategy: botConfig.strategy,
          timeframe: botConfig.timeframe,
          fee_open: feeOpen,
          fee_close: feeClose,
          fee_total: feeTotal,
          open_date: openDateStr,
          open_timestamp: openTs,
          open_rate: roundPrice(c.entry_price),
          initial_open_rate: roundPrice(c.entry_price),
          dca_count: 0,
          last_dca_date: null,
          close_date: closeDateStr,
          close_timestamp: closeTs,
          close_rate: roundPrice(c.exit_price),
          current_rate: roundPrice(c.exit_price),
          gross_profit: Number((netPnl + feeTotal).toFixed(4)),
          net_profit: netPnl,
          net_profit_percent: netPct,
          profit_ratio: Number((netPct / 100).toFixed(4)),
          profit_pct: netPct,
          profit_abs: Number(netPnl.toFixed(3)),
          stop_loss_abs: 0,
          stop_loss_pct: 0,
          initial_stop_loss_abs: 0,
          initial_stop_loss_pct: 0,
          take_profit_abs: roundPrice(c.exit_price),
          take_profit_pct: 0,
          leverage: lev,
          enter_tag: 'EXCHANGE_HISTORY',
          exit_reason: 'exchange_closed_pnl',
          orders: [
            {
              id: `ord-${id}-0`,
              step: 0,
              label: `Вход на бирже (${c.is_short ? 'Шорт' : 'Лонг'})`,
              side: c.is_short ? 'short' : 'long',
              price: roundPrice(c.entry_price),
              amount: Number(c.qty.toFixed(4)),
              stake_amount: stakeUsdt,
              timestamp: openTs,
              date: openDateStr,
            },
          ],
          planned_dca_levels: [],
          plan_notes: `Историческая сделка с биржи ${acc.exchange.toUpperCase()} (OrderID: ${c.order_id})`,
          trade_state: 'CLOSED',
        };

        tradesStore.push(closedTrade);
        sqliteDb.upsertTrade(closedTrade);
      }
    }
  } catch {
    // ignore transient position sync errors
  }
}

async function syncRealExchangeBalancesIfNeeded(force = false): Promise<void> {
  if (!force && Date.now() - lastExchangeBalanceSyncTs < 20_000) return;
  lastExchangeBalanceSyncTs = Date.now();
  const enabledAccs = exchangeAccountsStore.filter((a) => a.enabled);
  for (const acc of enabledAccs) {
    const creds = getAccountCredentialsFromStore(acc);
    if (!creds || isSimulatedTestApiKey(creds.apiKey)) continue;
    try {
      const check = await testExchangeConnection(creds);
      if (check.success) {
        let changed = false;
        if (typeof check.is_testnet === 'boolean' && acc.is_testnet !== check.is_testnet) {
          acc.is_testnet = check.is_testnet;
          changed = true;
        }
        if (check.network_label && acc.network_label !== check.network_label) {
          acc.network_label = check.network_label;
          changed = true;
        }
        if (typeof check.balance_usdt === 'number' && check.balance_usdt > 0) {
          if (Math.abs(acc.balance_usdt - check.balance_usdt) >= 0.01) {
            acc.balance_usdt = Number(check.balance_usdt.toFixed(2));
            changed = true;
          }
        }
        acc.status = 'connected';
        acc.last_sync = new Date().toISOString().replace('T', ' ').slice(0, 19);
        if (changed || force) {
          sqliteDb.upsertExchangeAccount(acc);
          appendLog(
            'freqtrade.exchange.sync',
            'INFO',
            `🔄 Синхронизирован баланс биржи ${check.network_label || acc.exchange.toUpperCase()} (${acc.name}): ${acc.balance_usdt.toFixed(2)} USDT | Пинг: ${check.latency_ms} мс`
          );
        }
      } else {
        appendLog(
          'freqtrade.exchange.sync',
          'WARNING',
          `⚠️ Проверка связи с биржей ${acc.exchange.toUpperCase()} (${acc.name}): ${check.message}`
        );
      }
      // Синхронизируем реальные открытые позиции и закрытые сделки с биржи
      await syncPositionsAndHistoryFromExchanges(acc);
    } catch {
      // ignore transient network error
    }
  }
}

function closeClientCopiesForMasterTrade(
  masterTrade: FreqtradeTrade,
  closeRate: number,
  now: number,
  nowStr: string,
  exitReason: string
) {
  if (masterTrade.account_id && masterTrade.account_id !== 'master') return;
  const clientCopies = tradesStore.filter(
    (ct) =>
      ct.is_open &&
      ct.account_id &&
      ct.account_id !== 'master' &&
      (ct.parent_trade_id === masterTrade.trade_id ||
        (ct.pair === masterTrade.pair &&
          ct.is_short === masterTrade.is_short &&
          (masterTrade.campaign_id ? ct.campaign_id === masterTrade.campaign_id : true)))
  );

  for (const ct of clientCopies) {
    ct.current_rate = closeRate;
    recalculateTradeMetrics(ct, false);
    // ЗАПРЕТ ЗАКРЫТИЯ В МИНУС: если сделка клиента с учетом комиссии 0.06% еще не в чистом плюсе, не закрываем её в убыток
    if ((ct.net_profit ?? ct.profit_abs) <= 0) {
      sqliteDb.upsertTrade(ct);
      appendLog(
        'freqtrade.copytrading',
        'INFO',
        `🛡️ Zero-Loss Guard: позиция клиента #${ct.trade_id} (${ct.account_name}) оставлена открытой (Net PnL: ${ct.net_profit}$ <= 0 с учетом комиссии 0.06%). Ожидание выхода в чистый плюс.`
      );
      continue;
    }

    const clientAcc = exchangeAccountsStore.find((a) => a.id === ct.account_id);
    if (clientAcc) {
      dispatchOrderToExchangeAccount(clientAcc, {
        pair: ct.pair,
        action: 'CLOSE',
        isShort: ct.is_short,
        quantity: ct.amount,
        referencePrice: closeRate,
        leverage: ct.leverage || 25,
      }).catch(() => {});
    }

    ct.is_open = false;
    ct.close_rate = closeRate;
    ct.close_date = nowStr;
    ct.close_timestamp = now;
    ct.exit_reason = `copy_${exitReason}`;
    ct.trade_state = 'CLOSED';
    ct.planned_dca_levels = [];
    recalculateTradeMetrics(ct, false);
    sqliteDb.upsertTrade(ct);
    sqliteDb.recordOrder({
      trade_id: ct.trade_id,
      pair: ct.pair,
      order_type: 'market',
      side: ct.is_short ? 'buy' : 'sell',
      price: closeRate,
      amount: ct.amount,
      cost: Number((closeRate * ct.amount).toFixed(4)),
      fee: ct.fee_close || 0,
      realized_pnl: ct.net_profit || ct.profit_abs,
      action_type: 'COPY_EXIT',
      notes: `Copy exit on master closure: ${exitReason} @ ${closeRate}`,
    });

    if (clientAcc) {
      const netProfit = ct.net_profit || ct.profit_abs;
      const { compoundedBalance } = getCompoundedAccountBalance(clientAcc.id);
      appendLog(
        'freqtrade.copytrading',
        'INFO',
        `💰 Клиент «${clientAcc.name}» (${clientAcc.exchange.toUpperCase()}): позиция #${ct.trade_id} синхронно закрыта в чистый плюс (+${netProfit}$, комиссия учтена). Реинвест-баланс: $${compoundedBalance}`
      );
    }
  }
}

/**
 * Core ScalpBot processing loop (ported 1:1 from freqtrade/bot/freqtradebot.py::process):
 * 1. Updates active trades, checks Target TP, user-dragged SL, 4H Hedge leg exit, Strategy Exit with Pullback Guard, and Smart Level DCA.
 * 2. Scans active pairs (Volatility + 24h Gainers/Losers + Pairlist) for new entries when >= 1 API account is enabled.
 */
let isBotCycleRunning = false;
async function runScalpBotCycle(waitForActive = false) {
  if (waitForActive && isBotCycleRunning) {
    const startWait = Date.now();
    while (isBotCycleRunning && Date.now() - startWait < 8000) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (isBotCycleRunning || botConfig.state === 'stopped') return;
  if (!hasConnectedExchangeAccount()) {
    botConfig.state = 'stopped';
    return;
  }
  isBotCycleRunning = true;
  try {
    await initializeBotTrades();
    if (!hasConnectedExchangeAccount()) {
      botConfig.state = 'stopped';
      return;
    }

    await syncRealExchangeBalancesIfNeeded(false);

    const activeAccounts = exchangeAccountsStore.filter((a) => a.enabled);
    const ownerAcc = activeAccounts.find((a) => a.is_owner) || activeAccounts[0];

    // Always refresh live prices on any open client trades first
    for (const ct of tradesStore) {
      if (ct.is_open && ct.account_id && ct.account_id !== 'master') {
        const liveTicker = tickerCache.get(ct.pair);
        if (liveTicker && liveTicker.price > 0) {
          ct.current_rate = liveTicker.price;
          recalculateTradeMetrics(ct, false);
        }
      }
    }

    const openTrades = tradesStore.filter(
      (t) => t.is_open && (!t.account_id || t.account_id === 'master')
    );

    // 1. Evaluate all currently open master trades (TP, SL, 4H Hedge Leg, Pullback Exit Guard, Smart Level DCA)
    for (const trade of openTrades) {
      const { candles: candles1h } = await fetchRealCandles(trade.pair, trade.timeframe || botConfig.timeframe, 60);
      if (!candles1h || candles1h.length === 0) continue;
      const currentPrice = candles1h[candles1h.length - 1].close;
      trade.current_rate = currentPrice;
      recalculateTradeMetrics(trade, false);

      // Sync current_rate to any open client copies for this pair
      for (const ct of tradesStore) {
        if (ct.is_open && ct.account_id && ct.account_id !== 'master' && ct.pair === trade.pair) {
          ct.current_rate = currentPrice;
          recalculateTradeMetrics(ct, false);
        }
      }

      // 1A. Target TP check (respects user-dragged TP on chart, strictly enforces Zero-Loss Guard net_profit > 0)
      if (trade.take_profit_abs > 0) {
        const isTpHit = trade.is_short
          ? currentPrice <= trade.take_profit_abs
          : currentPrice >= trade.take_profit_abs;
        if (isTpHit && (trade.net_profit ?? trade.profit_abs) > 0) {
          const closeOrderRes = await dispatchOrderToExchangeAccount(ownerAcc, {
            pair: trade.pair,
            action: 'CLOSE',
            isShort: trade.is_short,
            quantity: trade.amount,
            referencePrice: currentPrice,
            leverage: trade.leverage || 25,
          });
          if (ownerAcc && !isSimulatedTestApiKey(ownerAcc.api_key_raw) && !closeOrderRes?.success) {
            continue;
          }

          const actualClosePrice =
            closeOrderRes?.success && closeOrderRes.price > 0
              ? roundPrice(closeOrderRes.price)
              : currentPrice;
          const now =
            closeOrderRes?.exchange_time && closeOrderRes.exchange_time > 0
              ? closeOrderRes.exchange_time
              : Date.now();
          const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
          sqliteDb.runInTransaction(() => {
            trade.is_open = false;
            trade.close_rate = actualClosePrice;
            trade.current_rate = actualClosePrice;
            trade.close_date = nowStr;
            trade.close_timestamp = now;
            if (closeOrderRes?.commission_usdt && closeOrderRes.commission_usdt > 0) {
              trade.fee_close = Number(closeOrderRes.commission_usdt.toFixed(4));
            }
            trade.exit_reason = 'roi_target_tp';
            trade.trade_state = 'CLOSED';
            trade.planned_dca_levels = [];
            recalculateTradeMetrics(trade, false);
            sqliteDb.upsertTrade(trade);
            sqliteDb.recordOrder({
              trade_id: trade.trade_id,
              pair: trade.pair,
              order_type: 'market',
              side: trade.is_short ? 'buy' : 'sell',
              price: actualClosePrice,
              amount: trade.amount,
              cost: Number((actualClosePrice * trade.amount).toFixed(4)),
              fee: trade.fee_close || 0,
              realized_pnl: trade.net_profit || trade.profit_abs,
              action_type: 'TAKE_PROFIT',
              notes: `Target TP hit at ${actualClosePrice}, Net PnL: +${trade.profit_abs} USDT (Fee total: ${trade.fee_total} USDT)`,
            });

            // If this is leg 1 of a 4H Hedge Campaign, transfer banked profit to sibling leg
            if (trade.campaign_id) {
              const sibling = tradesStore.find(
                (s) =>
                  s.is_open &&
                  (!s.account_id || s.account_id === 'master') &&
                  s.campaign_id === trade.campaign_id &&
                  s.trade_id !== trade.trade_id
              );
              if (sibling) {
                sibling.campaign_banked_profit = trade.net_profit || trade.profit_abs;
                sqliteDb.upsertTrade(sibling);
                appendLog(
                  'freqtrade.bot.hedge',
                  'INFO',
                  `🏦 Hedge Campaign ${trade.campaign_id}: закрыта нога ${trade.pair} (${trade.is_short ? 'SHORT' : 'LONG'}) в чистый плюс +${trade.profit_abs}$ (после комиссии ${trade.fee_total}$). Вторая нога выводится в плюс через Smart DCA.`
                );
              }
            }

            closeClientCopiesForMasterTrade(trade, actualClosePrice, now, nowStr, 'roi_target_tp');
          });

          cooldownPairs.set(trade.pair, Date.now());
          appendLog(
            'freqtrade.bot.exit',
            'INFO',
            `🎯 Target TP Hit [${trade.pair}] #${trade.trade_id}: закрыто по реальной цене биржи ${actualClosePrice}$ | Чистый PnL: +${trade.profit_abs}$ (комиссия: ${trade.fee_total}$)`
          );
          continue;
        } else if (
          isTpHit &&
          (trade.net_profit ?? trade.profit_abs) <= 0 &&
          trade.min_profitable_tp &&
          !trade.tp_manual_override
        ) {
          // Защита от закрытия в минус для автоматического TP
          trade.take_profit_abs = trade.min_profitable_tp;
          sqliteDb.upsertTrade(trade);
        }
      }

      // 1C. 4H Hedge Campaign Second Leg Check — СТРОГО БЕЗ ЗАКРЫТИЯ В МИНУС!
      if (trade.campaign_banked_profit !== undefined && trade.campaign_banked_profit !== null) {
        if ((trade.net_profit ?? trade.profit_abs) > 0 && currentPrice && trade.min_profitable_tp) {
          const reachedMinProfit = trade.is_short
            ? currentPrice <= trade.min_profitable_tp
            : currentPrice >= trade.min_profitable_tp;
          if (reachedMinProfit) {
            const closeOrderRes = await dispatchOrderToExchangeAccount(ownerAcc, {
              pair: trade.pair,
              action: 'CLOSE',
              isShort: trade.is_short,
              quantity: trade.amount,
              referencePrice: currentPrice,
              leverage: trade.leverage || 25,
            });
            if (ownerAcc && !isSimulatedTestApiKey(ownerAcc.api_key_raw) && !closeOrderRes?.success) {
              continue;
            }

            const actualClosePrice =
              closeOrderRes?.success && closeOrderRes.price > 0
                ? roundPrice(closeOrderRes.price)
                : currentPrice;
            const now =
              closeOrderRes?.exchange_time && closeOrderRes.exchange_time > 0
                ? closeOrderRes.exchange_time
                : Date.now();
            const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
            sqliteDb.runInTransaction(() => {
              trade.is_open = false;
              trade.close_rate = actualClosePrice;
              trade.current_rate = actualClosePrice;
              trade.close_date = nowStr;
              trade.close_timestamp = now;
              if (closeOrderRes?.commission_usdt && closeOrderRes.commission_usdt > 0) {
                trade.fee_close = Number(closeOrderRes.commission_usdt.toFixed(4));
              }
              trade.exit_reason = 'hedge_breakeven_profit';
              trade.trade_state = 'CLOSED';
              trade.planned_dca_levels = [];
              recalculateTradeMetrics(trade, false);
              sqliteDb.upsertTrade(trade);
              sqliteDb.recordOrder({
                trade_id: trade.trade_id,
                pair: trade.pair,
                order_type: 'market',
                side: trade.is_short ? 'buy' : 'sell',
                price: actualClosePrice,
                amount: trade.amount,
                cost: Number((actualClosePrice * trade.amount).toFixed(4)),
                fee: trade.fee_close || 0,
                realized_pnl: trade.net_profit || trade.profit_abs,
                action_type: 'HEDGE_PROFIT_EXIT',
                notes: `2-я нога хеджа выведена в чистый плюс +${trade.profit_abs} USDT (комиссия: ${trade.fee_total} USDT)`,
              });
              closeClientCopiesForMasterTrade(trade, actualClosePrice, now, nowStr, 'hedge_breakeven_profit');
            });
            appendLog(
              'freqtrade.bot.hedge',
              'INFO',
              `⚖️ 2-я нога хеджа #${trade.trade_id} [${trade.pair}] выведена в чистый плюс по ${actualClosePrice}$ (+${trade.profit_abs}$ после комиссий ${trade.fee_total}$). Обе ноги кампании закрыты в плюс!`
            );
            continue;
          }
        }
      }

      // 1D. Smart Level DCA check (_check_trade_dca)
      const nextDcaTarget = trade.planned_dca_levels?.[0]?.price || trade.next_dca_price || 0;
      if (botConfig.dca_enabled && nextDcaTarget > 0) {
        const reachedDcaLevel = !trade.is_short
          ? currentPrice <= nextDcaTarget
          : currentPrice >= nextDcaTarget;

        if (reachedDcaLevel) {
          const { compoundedBalance: totalDeposit } = getCompoundedAccountBalance('master');
          const usedMargin = tradesStore
            .filter((t) => t.is_open && (!t.account_id || t.account_id === 'master'))
            .reduce((acc, t) => acc + t.stake_amount, 0);

          const riskCheck = canExecuteDca(
            {
              pair: trade.pair,
              dcaCount: trade.dca_count || 0,
              initialAmount: trade.initial_amount || trade.amount,
              currentAmount: trade.amount,
              currentPrice,
              openRate: trade.open_rate,
              isShort: trade.is_short,
              leverage: trade.leverage || botConfig.leverage,
              totalBalanceUsdt: totalDeposit,
              usedMarginUsdt: usedMargin,
            },
            scalpBotConfig
          );

          if (riskCheck.allowed) {
            const candleRej = checkCandleRejection(candles1h, nextDcaTarget, trade.is_short, 0.8);
            const rsiCheck = checkRsiCondition(candles1h, trade.is_short, 14);
            const { wt1, wt2 } = calculateWaveTrend(candles1h);
            const idx = candles1h.length - 1;
            const waveReversal = !trade.is_short
              ? wt1[idx] > wt2[idx] && wt2[idx] <= -20
              : wt1[idx] < wt2[idx] && wt2[idx] >= 20;

            const noKnifeOrPump = !trade.is_short
              ? !isKnifeDrop(candles1h)
              : !isPumpExhaustion(candles1h);

            // If user manually dragged the DCA level onto current price, or reversal is confirmed at the level:
            const isManualDcaTrigger = Boolean(trade.planned_dca_levels?.[0]?.manual_override);
            if (noKnifeOrPump && (isManualDcaTrigger || candleRej.confirmed || rsiCheck.confirmed || waveReversal)) {
              // Find next strongest 4H/1D DCA level first
              const [{ candles: c4h }, { candles: c1d }] = await Promise.all([
                fetchRealCandles(trade.pair, '4h', 250),
                fetchRealCandles(trade.pair, '1d', 150),
              ]);

              // 2. Dynamic DCA calculation: pulls average entry price as close to current reversal price as possible (within ~0.8%)
              const otherCoinsCount = tradesStore.filter(
                (t) => t.is_open && (!t.account_id || t.account_id === 'master') && t.pair !== trade.pair
              ).length;
              const dynamicDca = calculateDynamicDcaAmount({
                currentAmount: trade.amount,
                openRate: trade.open_rate,
                currentPrice,
                isShort: trade.is_short,
                leverage: trade.leverage || botConfig.leverage,
                totalBalanceUsdt: totalDeposit,
                usedMarginUsdt: usedMargin,
                otherActiveCoinsCount: otherCoinsCount,
                maxPairMarginPct: scalpBotConfig.max_pair_margin_pct || 20.0,
              });

              let addAmount = dynamicDca.addAmount;
              const addStake = dynamicDca.addStake;
              const prevMasterStake = trade.stake_amount || 25;
              const dcaMultiplierRatio = addStake / Math.max(1, prevMasterStake);

              // Исполняем реальный рыночный ордер усреднения (DCA) на бирже владельца
              const dcaOrderRes = await dispatchOrderToExchangeAccount(ownerAcc, {
                pair: trade.pair,
                action: 'DCA',
                isShort: trade.is_short,
                quantity: addAmount,
                referencePrice: currentPrice,
                leverage: trade.leverage || botConfig.leverage || 25,
              });
              if (ownerAcc && !isSimulatedTestApiKey(ownerAcc.api_key_raw) && !dcaOrderRes?.success) {
                continue;
              }
              if (dcaOrderRes?.success && !dcaOrderRes.is_simulated_test && dcaOrderRes.qty > 0) {
                addAmount = dcaOrderRes.qty;
              }
              const actualDcaPrice =
                dcaOrderRes?.success && dcaOrderRes.price > 0
                  ? roundPrice(dcaOrderRes.price)
                  : currentPrice;

              const prevOpenRate = trade.open_rate;
              const newTotalAmount = Number((trade.amount + addAmount).toFixed(4));
              const newTotalStake = Number((trade.stake_amount + addStake).toFixed(2));
              const newAvgOpenRate = roundPrice(
                (prevOpenRate * trade.amount + actualDcaPrice * addAmount) /
                  Math.max(1e-8, newTotalAmount)
              );

              const nextStep = (trade.dca_count || 0) + 1;
              const now =
                dcaOrderRes?.exchange_time && dcaOrderRes.exchange_time > 0
                  ? dcaOrderRes.exchange_time
                  : Date.now();
              const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
              const nextStrongDca = findStrongestDcaLevel(
                c4h,
                c1d,
                newAvgOpenRate,
                trade.is_short,
                2.0
              );

              sqliteDb.runInTransaction(() => {
                // 1. If this trade is part of a 2-way hedge campaign, check and close the profitable sibling leg on confirmed reversal
                if (trade.campaign_id) {
                  const sibling = tradesStore.find(
                    (s) =>
                      s.is_open &&
                      (!s.account_id || s.account_id === 'master') &&
                      s.campaign_id === trade.campaign_id &&
                      s.trade_id !== trade.trade_id
                  );
                  if (sibling && (sibling.net_profit ?? sibling.profit_abs) > 0) {
                    dispatchOrderToExchangeAccount(ownerAcc, {
                      pair: sibling.pair,
                      action: 'CLOSE',
                      isShort: sibling.is_short,
                      quantity: sibling.amount,
                      referencePrice: currentPrice,
                      leverage: sibling.leverage || 25,
                    }).catch(() => {});

                    sibling.is_open = false;
                    sibling.close_rate = currentPrice;
                    sibling.close_date = nowStr;
                    sibling.close_timestamp = now;
                    sibling.exit_reason = 'hedge_level_reversal_profit';
                    sibling.trade_state = 'CLOSED';
                    sibling.planned_dca_levels = [];
                    recalculateTradeMetrics(sibling, false);
                    sqliteDb.upsertTrade(sibling);
                    sqliteDb.recordOrder({
                      trade_id: sibling.trade_id,
                      pair: sibling.pair,
                      order_type: 'market',
                      side: sibling.is_short ? 'buy' : 'sell',
                      price: currentPrice,
                      amount: sibling.amount,
                      cost: Number((currentPrice * sibling.amount).toFixed(4)),
                      fee: sibling.fee_close || 0,
                      realized_pnl: sibling.net_profit || sibling.profit_abs,
                      action_type: 'TAKE_PROFIT',
                      notes: `Hedge Reversal: зафиксирован чистый профит +${sibling.profit_abs} USDT на глобальном развороте ${currentPrice}`,
                    });
                    closeClientCopiesForMasterTrade(sibling, currentPrice, now, nowStr, 'hedge_level_reversal_profit');
                    trade.campaign_banked_profit =
                      (trade.campaign_banked_profit || 0) + (sibling.net_profit || sibling.profit_abs);
                    appendLog(
                      'freqtrade.bot.hedge',
                      'INFO',
                      `🏦 Hedge Reversal [${trade.pair}]: зафиксирован чистый профит по ${sibling.is_short ? 'SHORT' : 'LONG'} (+${sibling.profit_abs}$ после комиссии). Вторая нога максимально усредняется для подтягивания цены к рынку!`
                    );
                  }
                }

                trade.open_rate = newAvgOpenRate;
                trade.amount = newTotalAmount;
                trade.stake_amount = newTotalStake;
                trade.dca_count = nextStep;
                trade.last_dca_date = nowStr;
                trade.trade_state = 'DCA_ACTIVE';
                trade.enter_tag = `${trade.is_short ? 'Short' : 'Long'} (DCA ×${nextStep})`;

                // Fast Scalp TP after DCA (+0.8% from new average entry = +20% gross / ~+17% net ROI on 25x) unless manually fixed by user
                const tpTargetMove = 0.008;
                if (!trade.tp_manual_override) {
                  trade.take_profit_abs = roundPrice(
                    trade.is_short ? newAvgOpenRate * (1 - tpTargetMove) : newAvgOpenRate * (1 + tpTargetMove)
                  );
                }
                trade.next_dca_price = roundPrice(nextStrongDca.price);

                trade.orders.push({
                  id: dcaOrderRes?.order_id || `ord-${trade.trade_id}-${nextStep}`,
                  step: nextStep,
                  label: `Smart DCA #${nextStep} (${nextStrongDca.source})`,
                  side: trade.is_short ? 'short' : 'long',
                  price: actualDcaPrice,
                  amount: addAmount,
                  stake_amount: addStake,
                  timestamp: now,
                  date: nowStr,
                });

                recalculateTradeMetrics(trade, true);
                sqliteDb.upsertTrade(trade);
                sqliteDb.recordOrder({
                  trade_id: trade.trade_id,
                  pair: trade.pair,
                  order_type: 'market',
                  side: trade.is_short ? 'sell' : 'buy',
                  price: actualDcaPrice,
                  amount: addAmount,
                  cost: addStake,
                  fee:
                    dcaOrderRes?.commission_usdt && dcaOrderRes.commission_usdt > 0
                      ? Number(dcaOrderRes.commission_usdt.toFixed(4))
                      : Number((actualDcaPrice * addAmount * TAKER_FEE_RATE).toFixed(4)),
                  realized_pnl: 0,
                  action_type: `DCA_STEP_${nextStep}`,
                  notes: `Smart DCA #${nextStep} at ${actualDcaPrice}, New Avg: ${newAvgOpenRate}, TP: ${trade.take_profit_abs}`,
                });

                // Synchronously execute proportional DCA on all open client copy-trades linked to this master trade
                const clientCopies = tradesStore.filter(
                  (ct) =>
                    ct.is_open &&
                    ct.account_id &&
                    ct.account_id !== 'master' &&
                    (ct.parent_trade_id === trade.trade_id ||
                      (ct.pair === trade.pair && ct.is_short === trade.is_short))
                );
                for (const ct of clientCopies) {
                  const clientAcc = exchangeAccountsStore.find((a) => a.id === ct.account_id);
                  const clientAddStake = Number((ct.stake_amount * dcaMultiplierRatio).toFixed(2));
                  const clientAddNotional = clientAddStake * (ct.leverage || 25);
                  const clientAddAmount = Number((clientAddNotional / Math.max(1e-8, actualDcaPrice)).toFixed(4));
                  if (clientAcc) {
                    dispatchOrderToExchangeAccount(clientAcc, {
                      pair: ct.pair,
                      action: 'DCA',
                      isShort: ct.is_short,
                      quantity: clientAddAmount,
                      referencePrice: actualDcaPrice,
                      leverage: ct.leverage || 25,
                    }).catch(() => {});
                  }
                  const clientPrevRate = ct.open_rate;
                  const clientNewTotalAmount = Number((ct.amount + clientAddAmount).toFixed(4));
                  const clientNewAvgRate = roundPrice(
                    (clientPrevRate * ct.amount + actualDcaPrice * clientAddAmount) /
                      Math.max(1e-8, clientNewTotalAmount)
                  );
                  ct.open_rate = clientNewAvgRate;
                  ct.amount = clientNewTotalAmount;
                  ct.stake_amount = Number((ct.stake_amount + clientAddStake).toFixed(2));
                  ct.dca_count = nextStep;
                  ct.last_dca_date = nowStr;
                  ct.trade_state = 'DCA_ACTIVE';
                  ct.enter_tag = trade.enter_tag;
                  if (!ct.tp_manual_override) {
                    ct.take_profit_abs = roundPrice(
                      ct.is_short ? clientNewAvgRate * (1 - tpTargetMove) : clientNewAvgRate * (1 + tpTargetMove)
                    );
                  }
                  ct.next_dca_price = trade.next_dca_price;
                  ct.orders.push({
                    id: `ord-${ct.trade_id}-${nextStep}`,
                    step: nextStep,
                    label: `Smart DCA #${nextStep} (${nextStrongDca.source})`,
                    side: ct.is_short ? 'short' : 'long',
                    price: actualDcaPrice,
                    amount: clientAddAmount,
                    stake_amount: clientAddStake,
                    timestamp: now,
                    date: nowStr,
                  });
                  recalculateTradeMetrics(ct, true);
                  sqliteDb.upsertTrade(ct);
                  sqliteDb.recordOrder({
                    trade_id: ct.trade_id,
                    pair: ct.pair,
                    order_type: 'market',
                    side: ct.is_short ? 'sell' : 'buy',
                    price: actualDcaPrice,
                    amount: clientAddAmount,
                    cost: clientAddStake,
                    fee: Number((actualDcaPrice * clientAddAmount * TAKER_FEE_RATE).toFixed(4)),
                    realized_pnl: 0,
                    action_type: `CLIENT_DCA_STEP_${nextStep}`,
                    notes: `Client Smart DCA #${nextStep} at ${actualDcaPrice}, New Avg: ${clientNewAvgRate}`,
                  });
                }
              });

              appendLog(
                'freqtrade.bot.dca',
                'INFO',
                `✅ Smart DCA #${nextStep} [${trade.pair}]: +${addAmount} монет @ ${actualDcaPrice}$ ($${addStake} маржи) | Новая средняя: ${newAvgOpenRate}$ (подтянута к цене на ${dynamicDca.pullDistancePct}%) | Безубыток (с комиссией 0.06%): ${trade.breakeven_price}$ | TP: ${trade.take_profit_abs}$ | След. DCA: ${trade.next_dca_price}$`
              );
            }
          }
        }
      }

      sqliteDb.upsertTrade(trade);
    }

    // 1E. Also check independent client trades for their own TP hit (strictly enforcing net_profit > 0)
    const independentClientTrades = tradesStore.filter(
      (ct) => ct.is_open && ct.account_id && ct.account_id !== 'master' && ct.take_profit_abs > 0
    );
    for (const ct of independentClientTrades) {
      const livePrice = ct.current_rate;
      if (livePrice <= 0) continue;
      recalculateTradeMetrics(ct, false);
      const isTpHit = ct.is_short
        ? livePrice <= ct.take_profit_abs
        : livePrice >= ct.take_profit_abs;
      if (isTpHit && (ct.net_profit ?? ct.profit_abs) > 0) {
        const clientAcc = exchangeAccountsStore.find((a) => a.id === ct.account_id);
        let clientCloseRes: PlacedOrderResult | null = null;
        if (clientAcc) {
          clientCloseRes = await dispatchOrderToExchangeAccount(clientAcc, {
            pair: ct.pair,
            action: 'CLOSE',
            isShort: ct.is_short,
            quantity: ct.amount,
            referencePrice: livePrice,
            leverage: ct.leverage || 25,
          });
          if (!isSimulatedTestApiKey(clientAcc.api_key_raw) && !clientCloseRes?.success) {
            continue;
          }
        }
        const actualClientClosePrice =
          clientCloseRes?.success && clientCloseRes.price > 0
            ? roundPrice(clientCloseRes.price)
            : livePrice;
        const now =
          clientCloseRes?.exchange_time && clientCloseRes.exchange_time > 0
            ? clientCloseRes.exchange_time
            : Date.now();
        const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
        sqliteDb.runInTransaction(() => {
          ct.is_open = false;
          ct.close_rate = actualClientClosePrice;
          ct.current_rate = actualClientClosePrice;
          ct.close_date = nowStr;
          ct.close_timestamp = now;
          if (clientCloseRes?.commission_usdt && clientCloseRes.commission_usdt > 0) {
            ct.fee_close = Number(clientCloseRes.commission_usdt.toFixed(4));
          }
          ct.exit_reason = 'client_roi_target_tp';
          ct.trade_state = 'CLOSED';
          ct.planned_dca_levels = [];
          recalculateTradeMetrics(ct, false);
          sqliteDb.upsertTrade(ct);
          sqliteDb.recordOrder({
            trade_id: ct.trade_id,
            pair: ct.pair,
            order_type: 'market',
            side: ct.is_short ? 'buy' : 'sell',
            price: actualClientClosePrice,
            amount: ct.amount,
            cost: Number((actualClientClosePrice * ct.amount).toFixed(4)),
            fee: ct.fee_close || 0,
            realized_pnl: ct.net_profit || ct.profit_abs,
            action_type: 'CLIENT_TAKE_PROFIT',
            notes: `Client Target TP hit at ${actualClientClosePrice}, Net PnL: +${ct.profit_abs}`,
          });
          if (clientAcc) {
            const netProfit = ct.net_profit || ct.profit_abs;
            const { compoundedBalance } = getCompoundedAccountBalance(clientAcc.id);
            appendLog(
              'freqtrade.copytrading',
              'INFO',
              `🎯 Клиент «${clientAcc.name}»: закрыт TP по #${ct.trade_id} @ ${actualClientClosePrice}$ (+${netProfit}$ чистыми). Баланс: $${compoundedBalance}`
            );
          }
        });
      }
    }

    // 2. Scan for new entries ONLY if bot state === 'running' AND at least 1 API account is enabled
    if (botConfig.state !== 'running' || activeAccounts.length === 0) {
      return;
    }

    const { candles: btc1h } = await fetchRealCandles('BTC/USDT:USDT', '1h', 60);
    const btcGuard = checkBtcMarketHealth(btc1h);

    // Scan all active USDT-M Futures with volume >= $50M, prioritized by 24h price swing / volatility
    const candidatePairs = await fetchTopVolatileFuturesPairs(50_000_000);
    const activeClientAccounts = exchangeAccountsStore.filter(
      (a) => !a.is_owner && a.enabled && a.copy_trading
    );

    let scannedCount = 0;
    let openedInThisCycle = 0;
    for (const pair of candidatePairs) {
      if (blacklist.includes(pair)) continue;
      const lastCd = cooldownPairs.get(pair) || 0;
      if (Date.now() - lastCd < 3 * 60_000) continue; // 3-minute fast scalp re-entry cooldown after profitable TP

      const currentMasterOpen = tradesStore.filter(
        (t) => t.is_open && (!t.account_id || t.account_id === 'master')
      );
      const masterHasPair = currentMasterOpen.some((t) => t.pair === pair);

      // Check if any connected client is missing an analyzed position on this pair
      const clientsMissingPair = activeClientAccounts.filter(
        (acc) => !tradesStore.some((ct) => ct.is_open && ct.account_id === acc.id && ct.pair === pair)
      );

      // If master already has this pair AND all connected clients also have this pair, skip to next coin
      if (masterHasPair && clientsMissingPair.length === 0) continue;
      if (!masterHasPair && currentMasterOpen.length >= botConfig.max_open_trades && clientsMissingPair.length === 0) {
        break;
      }

      scannedCount++;
      if (scannedCount > 24) break; // Analyze top 24 most volatile pairs per cycle for high capital turnover

      const [{ candles: c1h }, { candles: c4h }, { candles: c1d }] = await Promise.all([
        fetchRealCandles(pair, botConfig.timeframe, 100),
        fetchRealCandles(pair, '4h', 250),
        fetchRealCandles(pair, '1d', 150),
      ]);
      if (c1h.length < 35) continue;

      const livePrice = c1h[c1h.length - 1].close;
      const pairLevels = await getOrComputeMtfBotLevels(pair, botConfig.timeframe);
      const manualSupLvl =
        pairLevels.find((l) => l.role === 'support' && l.manual_override) ||
        pairLevels.find((l) => l.role === 'support');
      const manualResLvl =
        pairLevels.find((l) => l.role === 'resistance' && l.manual_override) ||
        pairLevels.find((l) => l.role === 'resistance');

      const mtf = analyzeMultiTimeframe(pair, c1h, c4h, c1d, {
        support: manualSupLvl?.manual_override ? manualSupLvl.price : undefined,
        resistance: manualResLvl?.manual_override ? manualResLvl.price : undefined,
      });
      const struct4h = detectMarketStructure(c4h, c4h.length);

      const customSup = manualSupLvl?.price || mtf.key_4h_support;
      const customRes = manualResLvl?.price || mtf.key_4h_resistance;
      const sig = evaluateScalpingStrategy(c1h, customSup, customRes);

      // Record multi-coin market scan in signals table so user sees full market analysis across volatile coins
      sqliteDb.recordSignal({
        pair,
        signal_type: 'MTF_SCAN',
        direction: sig.enter_long ? 'long' : sig.enter_short ? 'short' : mtf.d1_trend.toLowerCase(),
        confidence: sig.enter_long || sig.enter_short ? 0.85 : 0.55,
        price: livePrice,
        reason: `MTF Scan [${pair}]: 1D=${mtf.d1_trend} (RSI 1D=${mtf.rsi_1d}, 4H=${mtf.rsi_4h}, 1H=${mtf.rsi_1h}) | 4H Sup=${roundPrice(customSup)} Res=${roundPrice(customRes)} | Signal=${sig.enter_tag || 'WAIT_LEVEL'}`,
      });

      // CASE A: Master does NOT have this pair open yet -> Automatic Dual-Strategy Engine:
      // Priority 1: If a valid 1H Scalping signal exists on this coin -> Scalp it (1 direction).
      // Priority 2: If NO Scalping signal exists, and the coin is in the middle of a wide 4H channel AND MTF RSI is not extreme -> Open 2-Way Hedge (LONG + SHORT).
      if (!masterHasPair && currentMasterOpen.length < botConfig.max_open_trades) {
        const { compoundedBalance: totalDeposit } = getCompoundedAccountBalance('master');
        const usedMargin = currentMasterOpen.reduce((acc, t) => acc + t.stake_amount, 0);
        const masterMarginOk = totalDeposit > 0 && (usedMargin / totalDeposit) * 100 < 40.0;

        if (masterMarginOk) {
          try {
            if (sig.enter_long && btcGuard.isSafe && mtf.allow_long) {
              await createScalpBotPosition(pair, 'long', livePrice, mtf, c4h, c1d, sig.enter_tag);
              openedInThisCycle++;
              if (openedInThisCycle >= 3) break;
              continue;
            } else if (sig.enter_short && mtf.allow_short) {
              await createScalpBotPosition(pair, 'short', livePrice, mtf, c4h, c1d, sig.enter_tag);
              openedInThisCycle++;
              if (openedInThisCycle >= 3) break;
              continue;
            } else if (
              currentMasterOpen.length + 1 < botConfig.max_open_trades &&
              btcGuard.isSafe &&
              mtf.rsi_1d <= 68 &&
              mtf.rsi_1d >= 32 &&
              mtf.rsi_4h <= 60 &&
              mtf.rsi_4h >= 40 &&
              isHedgeEntryCandidate(struct4h, 35, 65, 3.0)
            ) {
              await openHedgeCampaign(pair, livePrice, mtf, c4h, c1d);
              openedInThisCycle += 2;
              if (openedInThisCycle >= 3) break;
              continue;
            }
          } catch (entryErr: any) {
            appendLog(
              'freqtrade.bot.entry',
              'WARNING',
              `⚠️ Не удалось открыть сделку [${pair}] на бирже: ${entryErr?.message || 'Ошибка биржи'}`
            );
          }
        }
      }

      // CASE B: Master ALREADY has an old open trade on this pair, and a new Client connected later.
      // We NEVER blindly copy Master's old entry price; instead we open for the new Client ONLY if current live market analysis gives a valid entry signal!
      if (masterHasPair && clientsMissingPair.length > 0) {
        const masterTradeOnPair = currentMasterOpen.find((t) => t.pair === pair);
        const entrySide: 'long' | 'short' | null =
          sig.enter_long && btcGuard.isSafe && mtf.allow_long
            ? 'long'
            : sig.enter_short && mtf.allow_short
            ? 'short'
            : null;

        if (entrySide) {
          for (const clientAcc of clientsMissingPair) {
            const clientOpenTrades = tradesStore.filter(
              (ct) => ct.is_open && ct.account_id === clientAcc.id
            );
            const clientUsedMargin = clientOpenTrades.reduce((s, t) => s + t.stake_amount, 0);
            const { compoundedBalance: clientDeposit } = getCompoundedAccountBalance(clientAcc.id);
            if (
              clientOpenTrades.length < botConfig.max_open_trades &&
              (clientUsedMargin / Math.max(1, clientDeposit)) * 100 < 40.0
            ) {
              const { clientStakeUsdt } = calculateClientProportionalOrder({
                clientBalanceUsdt: clientDeposit,
                entryPrice: livePrice,
                leverage: clientAcc.max_leverage || botConfig.leverage || 25,
                stakePercent: 0.005,
                minStakeUsdt: 5,
              });
              try {
                await createScalpBotPosition(
                  pair,
                  entrySide,
                  livePrice,
                  mtf,
                  c4h,
                  c1d,
                  `${sig.enter_tag} (Analyzed Client Entry)`,
                  {
                    accountId: clientAcc.id,
                    accountName: clientAcc.name,
                    stake: clientStakeUsdt,
                    leverage: clientAcc.max_leverage || botConfig.leverage || 25,
                    isCopyChild: true,
                    parentTradeId: masterTradeOnPair?.trade_id,
                  }
                );
              } catch {
                // logged by dispatchOrderToExchangeAccount
              }
            }
          }
        }
      }
    }

    if (scannedCount > 0) {
      const openMasterAfter = tradesStore.filter(
        (t) => t.is_open && (!t.account_id || t.account_id === 'master')
      );
      const scalpCount = openMasterAfter.filter(
        (t) => !t.campaign_id && !String(t.enter_tag || '').toLowerCase().includes('hedge')
      ).length;
      const hedgeCount = openMasterAfter.length - scalpCount;
      const accSummary = activeAccounts
        .map(
          (a) =>
            `${a.name} [${a.network_label || (a.is_testnet ? `${a.exchange.toUpperCase()} TESTNET` : a.exchange.toUpperCase())}]: ${a.balance_usdt.toFixed(2)} USDT`
        )
        .join(', ');
      appendLog(
        'freqtrade.scanner',
        'INFO',
        `🔍 Цикл авто-анализа завершён: проверено ${scannedCount} пар | Открыто за цикл: ${openedInThisCycle} | Активно: ${openMasterAfter.length} (Скальпинг: ${scalpCount}, Хедж: ${hedgeCount}) | Биржи: ${accSummary}`
      );
    }
  } catch (err) {
    console.error('Error in runScalpBotCycle:', err);
  } finally {
    isBotCycleRunning = false;
  }
}

async function openHedgeCampaign(
  pair: string,
  entryPrice: number,
  mtf: ReturnType<typeof analyzeMultiTimeframe>,
  candles4h: RawCandle[],
  candles1d: RawCandle[]
): Promise<{ longTrade: FreqtradeTrade; shortTrade: FreqtradeTrade }> {
  const campaignId = `hedge-${pair.split(':')[0].replace('/', '')}-${Date.now()}`;
  appendLog(
    'freqtrade.bot.hedge',
    'INFO',
    `⚖️ Открываю 2-стороннюю хедж-кампанию ${campaignId} [${pair}] @ ${entryPrice}$: одновременный вход LONG и SHORT (0.5% депозит / 25x плечо)`
  );

  const longTrade = await createScalpBotPosition(
    pair,
    'long',
    entryPrice,
    mtf,
    candles4h,
    candles1d,
    '4H_Hedge_Long',
    { campaignId }
  );

  const shortTrade = await createScalpBotPosition(
    pair,
    'short',
    entryPrice,
    mtf,
    candles4h,
    candles1d,
    '4H_Hedge_Short',
    { campaignId }
  );

  return { longTrade, shortTrade };
}

async function createScalpBotPosition(
  pair: string,
  side: 'long' | 'short',
  entryPrice: number,
  mtf: ReturnType<typeof analyzeMultiTimeframe>,
  candles4h: RawCandle[],
  candles1d: RawCandle[],
  enterTag: string,
  customOpts?: {
    stake?: number;
    leverage?: number;
    customTp?: number;
    customSl?: number;
    campaignId?: string;
    accountId?: string;
    accountName?: string;
    isCopyChild?: boolean;
    parentTradeId?: number;
    skipClientSync?: boolean;
  }
): Promise<FreqtradeTrade> {
  const activeAccounts = exchangeAccountsStore.filter((a) => a.enabled);
  if (activeAccounts.length === 0) {
    throw new Error('Бот не может открывать сделки без подключенной биржи (API)');
  }

  const cleanPair = pair.toUpperCase();
  const isShort = side === 'short';
  let entryRate = roundPrice(entryPrice);
  const targetAccId = customOpts?.accountId || 'master';

  // Защита от дублирования: не открывать вторую сделку в ту же сторону на одной и той же монете для одного аккаунта
  const existingSameSide = tradesStore.find(
    (t) =>
      t.is_open &&
      (t.account_id || 'master') === targetAccId &&
      t.pair === cleanPair &&
      t.is_short === isShort
  );
  if (existingSameSide) {
    return existingSameSide;
  }

  const ownerAcc = activeAccounts.find((a) => a.is_owner) || activeAccounts[0];
  const targetExchangeAcc =
    targetAccId === 'master'
      ? ownerAcc
      : activeAccounts.find((a) => a.id === targetAccId) || ownerAcc;

  const { compoundedBalance: totalDeposit } = getCompoundedAccountBalance('master');
  // Dynamic compounded stake: strictly 0.5% of current compounded account equity ($25 on $5000, growing automatically with closed net profit)
  const dynamicStake = Math.max(
    botConfig.min_stake_amount || 5,
    Number((totalDeposit * 0.005).toFixed(2))
  );

  const stake =
    customOpts?.stake && customOpts.stake > 0 ? customOpts.stake : dynamicStake;
  const leverage =
    customOpts?.leverage && customOpts.leverage >= 1
      ? Math.round(customOpts.leverage)
      : (botConfig.leverage || 25);

  const notional = stake * leverage;
  let amount = Number((notional / Math.max(1e-8, entryRate)).toFixed(4));

  // Отправляем реальный рыночный ордер (OPEN) на подключенную биржу (Binance Futures / Bybit / BingX и др.)
  const primaryOrderRes = await dispatchOrderToExchangeAccount(targetExchangeAcc, {
    pair: cleanPair,
    action: 'OPEN',
    isShort,
    quantity: amount,
    referencePrice: entryRate,
    leverage,
  });

  if (
    targetExchangeAcc &&
    !isSimulatedTestApiKey(targetExchangeAcc.api_key_raw) &&
    !primaryOrderRes?.success
  ) {
    throw new Error(
      primaryOrderRes?.error ||
        `Биржа ${targetExchangeAcc.exchange.toUpperCase()} отклонила ордер на открытие сделки [${cleanPair}]`
    );
  }

  if (primaryOrderRes?.success && !primaryOrderRes.is_simulated_test) {
    if (primaryOrderRes.qty > 0) amount = primaryOrderRes.qty;
    if (primaryOrderRes.price > 0) entryRate = roundPrice(primaryOrderRes.price);
  }

  const [base, quote] = cleanPair.split(':')[0].split('/');
  const id = nextTradeId++;
  const now = Date.now();
  const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);

  const hasCustomTp = Boolean(customOpts?.customTp && customOpts.customTp > 0);
  const hasCustomSl = Boolean(customOpts?.customSl && customOpts.customSl > 0);

  // Загружаем актуальные уровни бота (включая уровни SUP/RES, которые пользователь передвинул или добавил на графике)
  const activePairLevels = await getOrComputeMtfBotLevels(cleanPair, botConfig.timeframe);
  const manualSupLvl = activePairLevels.find(
    (l) => l.role === 'support' && l.manual_override && l.price < entryRate
  );
  const manualResLvl = activePairLevels.find(
    (l) => l.role === 'resistance' && l.manual_override && l.price > entryRate
  );
  const effectiveSup = manualSupLvl ? manualSupLvl.price : roundPrice(mtf.key_4h_support);
  const effectiveRes = manualResLvl ? manualResLvl.price : roundPrice(mtf.key_4h_resistance);

  let rawTp = hasCustomTp
    ? Number(customOpts!.customTp)
    : isShort
    ? mtf.recommended_tp_short
    : mtf.recommended_tp_long;

  if (!isShort) {
    if (!hasCustomTp || rawTp <= entryRate * 1.002) {
      const minTpLong = manualResLvl ? entryRate * 1.0035 : entryRate * 1.008;
      const maxTpLong = manualResLvl ? entryRate * 1.080 : entryRate * 1.015;
      const structRes = effectiveRes * 0.998;
      if (structRes >= minTpLong && structRes <= maxTpLong) {
        rawTp = structRes;
      } else if (rawTp < minTpLong || rawTp > maxTpLong) {
        rawTp = entryRate * 1.012;
      }
    }
  } else {
    if (!hasCustomTp || rawTp >= entryRate * 0.998) {
      const minTpShort = manualSupLvl ? entryRate * 0.9965 : entryRate * 0.992;
      const maxTpShort = manualSupLvl ? entryRate * 0.920 : entryRate * 0.985;
      const structSup = effectiveSup * 1.002;
      if (structSup <= minTpShort && structSup >= maxTpShort) {
        rawTp = structSup;
      } else if (rawTp > minTpShort || rawTp < maxTpShort) {
        rawTp = entryRate * 0.988;
      }
    }
  }

  const targetTp = roundPrice(rawTp);
  const computedTpPct = Number(
    ((Math.abs(targetTp - entryRate) / Math.max(1e-8, entryRate)) * 100).toFixed(2)
  );

  const strongestDca = findStrongestDcaLevel(candles4h, candles1d, entryRate, isShort, 1.5);
  const nextDcaPrice = !isShort
    ? manualSupLvl
      ? roundPrice(manualSupLvl.price)
      : roundPrice(strongestDca.price)
    : manualResLvl
    ? roundPrice(manualResLvl.price)
    : roundPrice(strongestDca.price);
  const dcaSourceLabel =
    (!isShort && manualSupLvl) || (isShort && manualResLvl) ? 'MANUAL_LVL' : strongestDca.source;

  const planNotes = `${side.toUpperCase()} ${customOpts?.campaignId ? '4H HEDGE' : '1H SCALP'} | 1D: ${mtf.d1_trend} | ${isShort ? `Res: ${effectiveRes}` : `Sup: ${effectiveSup}`} | Target TP: ${targetTp} | Next DCA (${dcaSourceLabel}): ${nextDcaPrice}`;

  const newTrade: FreqtradeTrade = {
    trade_id: id,
    pair: cleanPair,
    base_currency: base || 'ETH',
    quote_currency: quote || 'USDT',
    is_open: true,
    is_short: isShort,
    exchange: targetExchangeAcc?.exchange || ownerAcc?.exchange || activeAccounts[0]?.exchange || 'binance',
    amount,
    initial_amount: amount,
    stake_amount: stake,
    initial_stake: stake,
    strategy: botConfig.strategy,
    timeframe: botConfig.timeframe,
    enter_tag: enterTag || (isShort ? 'Short' : 'Long'),
    open_date: nowStr,
    open_timestamp: now,
    open_rate: entryRate,
    initial_open_rate: entryRate,
    dca_count: 0,
    last_dca_date: null,
    current_rate: entryRate,
    close_date: null,
    close_timestamp: null,
    close_rate: null,
    profit_ratio: 0,
    profit_pct: 0,
    profit_abs: 0,
    take_profit_abs: targetTp,
    take_profit_pct: computedTpPct,
    tp_manual_override: hasCustomTp,
    stop_loss_abs: hasCustomSl ? roundPrice(Number(customOpts!.customSl)) : 0,
    stop_loss_pct: -3.0,
    sl_manual_override: hasCustomSl,
    initial_stop_loss_abs: hasCustomSl
      ? roundPrice(Number(customOpts!.customSl))
      : roundPrice(isShort ? mtf.recommended_sl_short : mtf.recommended_sl_long),
    initial_stop_loss_pct: -3.0,
    exit_reason: null,
    leverage,
    support_level: effectiveSup,
    resistance_level: effectiveRes,
    next_dca_price: nextDcaPrice,
    trade_state: 'WAITING_PULLBACK',
    pullback_min_profit_pct: 0.5,
    plan_notes: planNotes,
    campaign_id: customOpts?.campaignId,
    account_id: targetAccId,
    account_name: customOpts?.accountName || 'Master',
    parent_trade_id: customOpts?.parentTradeId,
    orders: [
      {
        id: `ord-${id}-0`,
        step: 0,
        label: `Нач. вход #1 (${isShort ? 'Шорт' : 'Лонг'})`,
        side: isShort ? 'short' : 'long',
        price: entryRate,
        amount,
        stake_amount: stake,
        timestamp: now,
        date: nowStr,
      },
    ],
    planned_dca_levels: [],
  };

  // Атомарная запись в SQLite: сделка владельца + анализированные входы всех активных клиентов сохраняются в одной транзакции
  const liveMarketCandlePrice =
    candles4h.length > 0 ? candles4h[candles4h.length - 1].close : entryRate;

  sqliteDb.runInTransaction(() => {
    recalculateTradeMetrics(newTrade, false);
    tradesStore.unshift(newTrade);
    sqliteDb.upsertTrade(newTrade);
    sqliteDb.recordOrder({
      trade_id: id,
      pair: cleanPair,
      order_type: 'market',
      side: isShort ? 'sell' : 'buy',
      price: entryRate,
      amount,
      cost: stake,
      fee: Number((entryRate * amount * TAKER_FEE_RATE).toFixed(4)),
      realized_pnl: 0,
      action_type: 'INITIAL_ENTRY',
      notes: planNotes,
    });
    sqliteDb.recordSignal({
      pair: cleanPair,
      signal_type: 'ENTRY',
      direction: side,
      confidence: 0.88,
      price: entryRate,
      reason: planNotes,
    });

    // Умный анализируемый вход для подключенных клиентских аккаунтов в момент актуального рыночного сигнала:
    // Проверяет: 1) актуальность рыночной цены (не историческая сделка), 2) лимит маржи клиента (< 40%), 3) расчет 0.5% от депозита клиента с плечом 25x
    if (!customOpts?.isCopyChild && !customOpts?.skipClientSync && targetAccId === 'master') {
      const priceDeviationPct =
        liveMarketCandlePrice > 0
          ? Math.abs(entryRate - liveMarketCandlePrice) / liveMarketCandlePrice
          : 0;
      // Если сделка открывается по устаревшей/исторической цене (отклонение > 5% от текущего рынка), не копируем её клиентам вслепую
      const isLiveMarketEntry = priceDeviationPct <= 0.05;

      if (isLiveMarketEntry) {
        const copyAccounts = exchangeAccountsStore.filter(
          (a) => !a.is_owner && a.enabled && a.copy_trading
        );
        const seenCodes = new Set<string>();
        const syncedNames: string[] = [];

        for (const acc of copyAccounts) {
          const codeKey = acc.client_access_code || acc.id;
          if (seenCodes.has(codeKey)) continue;
          seenCodes.add(codeKey);

          const alreadyCopied = tradesStore.some(
            (ct) =>
              ct.is_open &&
              ct.account_id === acc.id &&
              ct.pair === cleanPair &&
              ct.is_short === isShort
          );
          if (alreadyCopied) continue;

          // Проверка риска и свободной маржи клиента перед входом
          const clientOpenTrades = tradesStore.filter(
            (ct) => ct.is_open && ct.account_id === acc.id
          );
          if (clientOpenTrades.length >= botConfig.max_open_trades) continue;
          const { compoundedBalance: clientDeposit } = getCompoundedAccountBalance(acc.id);
          const clientUsedMargin = clientOpenTrades.reduce((s, t) => s + t.stake_amount, 0);
          if (clientDeposit > 0 && (clientUsedMargin / clientDeposit) * 100 >= 40.0) {
            appendLog(
              'freqtrade.copytrading',
              'WARNING',
              `⚠️ Пропущен вход [${cleanPair}] для клиента «${acc.name}»: задействовано более 40% маржи ($${clientUsedMargin} из $${clientDeposit})`
            );
            continue;
          }

          const clientLev = acc.max_leverage || leverage || 25;
          const { clientStakeUsdt, notionalUsdt, coinAmount } = calculateClientProportionalOrder({
            clientBalanceUsdt: clientDeposit,
            entryPrice: entryRate,
            leverage: clientLev,
            stakePercent: 0.005, // Строго 0.5% от текущего реинвест-депозита клиента
            minStakeUsdt: 5,
          });

          dispatchOrderToExchangeAccount(acc, {
            pair: cleanPair,
            action: 'OPEN',
            isShort,
            quantity: coinAmount,
            referencePrice: entryRate,
            leverage: clientLev,
          }).catch(() => {});

          const clientTradeId = nextTradeId++;
          const clientTrade: FreqtradeTrade = {
            ...newTrade,
            trade_id: clientTradeId,
            parent_trade_id: newTrade.trade_id,
            account_id: acc.id,
            account_name: acc.name,
            exchange: acc.exchange,
            leverage: clientLev,
            stake_amount: clientStakeUsdt,
            initial_stake: clientStakeUsdt,
            amount: coinAmount,
            initial_amount: coinAmount,
            synced_accounts: [acc.name],
            orders: [
              {
                id: `ord-${clientTradeId}-0`,
                step: 0,
                label: `Анализ + Вход (${acc.name}): #1 (${isShort ? 'Шорт' : 'Лонг'})`,
                side: isShort ? 'short' : 'long',
                price: entryRate,
                amount: coinAmount,
                stake_amount: clientStakeUsdt,
                timestamp: now,
                date: nowStr,
              },
            ],
            planned_dca_levels: newTrade.planned_dca_levels.map((l) => ({ ...l })),
          };

          recalculateTradeMetrics(clientTrade, false);
          tradesStore.unshift(clientTrade);
          sqliteDb.upsertTrade(clientTrade);
          sqliteDb.recordOrder({
            trade_id: clientTradeId,
            pair: cleanPair,
            order_type: 'market',
            side: isShort ? 'sell' : 'buy',
            price: entryRate,
            amount: coinAmount,
            cost: clientStakeUsdt,
            fee: Number((entryRate * coinAmount * TAKER_FEE_RATE).toFixed(4)),
            realized_pnl: 0,
            action_type: 'CLIENT_INITIAL_ENTRY',
            notes: `Analyzed entry for ${acc.name} (linked to #${newTrade.trade_id}): ${planNotes}`,
          });
          syncedNames.push(acc.name);

          appendLog(
            'freqtrade.copytrading',
            'INFO',
            `📋 Проанализирована и открыта позиция #${clientTradeId} для «${acc.name}» (${acc.exchange.toUpperCase()}): ${cleanPair} ${isShort ? 'SHORT' : 'LONG'} ${clientLev}x | Ставка 0.5%: $${clientStakeUsdt} (депозит $${clientDeposit}) | Объем: ${coinAmount} ($${notionalUsdt})`
          );
        }

        if (syncedNames.length > 0) {
          newTrade.synced_accounts = syncedNames;
          sqliteDb.upsertTrade(newTrade);
        }
      }
    }
  });

  appendLog(
    'freqtrade.bot',
    'INFO',
    `🟢 Открыта позиция #${id} [${cleanPair}] ${isShort ? 'SHORT' : 'LONG'} ${leverage}x @ ${entryRate}$ | Маржа: ${stake}$ | TP: ${newTrade.take_profit_abs}$ | Next DCA (${strongestDca.source}): ${nextDcaPrice}$ | Аккаунтов: ${activeAccounts.length}`
  );

  return newTrade;
}

async function startServer() {
  const app = express();
  app.use(express.json());

  initializeBotTrades().catch(console.error);
  setInterval(() => {
    runScalpBotCycle().catch(() => {});
  }, 10_000);

  app.get('/api/v1/ping', (_req, res) => {
    res.json({ status: 'pong' });
  });

  // ============================================================================
  // АВТОРИЗАЦИЯ ВЛАДЕЛЬЦА САЙТА (ЧЕРЕЗ СЕКРЕТЫ) И ДОСТУП ПО ССЫЛКЕ (?invite=...)
  // ============================================================================
  app.get('/api/v1/auth/status', (req, res) => {
    const cfg = sqliteDb.getSiteAuthConfig();
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

    // 1. Если передан ?invite=... в URL, проверяем пригласительную ссылку
    const inviteParam = String(req.query.invite || '').trim();
    if (inviteParam) {
      const consumed = sqliteDb.consumeInviteToken(inviteParam);
      if (consumed) {
        const sessionToken = sqliteDb.createAuthToken({
          role: consumed.role,
          login: consumed.label,
          inviteId: consumed.id,
        });
        appendLog(
          'freqtrade.auth',
          'INFO',
          `Вход по персональной ссылке доступа: ${consumed.label} (роль: ${consumed.role})`
        );
        res.json({
          require_login: true,
          password_changed: cfg.password_changed,
          has_env_secrets: cfg.has_env_secrets,
          authenticated: true,
          role: consumed.role,
          login: consumed.label,
          token: sessionToken,
        });
        return;
      }
    }

    // 2. Если передан ?client=... или ?code=... в URL, проверяем ссылку клиента
    const clientParam = String(req.query.client || req.query.code || '').trim().toUpperCase();
    if (clientParam) {
      const acc = sqliteDb.verifyClientAccessCode(clientParam);
      if (acc) {
        const sessionToken = sqliteDb.createAuthToken({
          role: 'client',
          login: acc.name,
          accountId: acc.id,
        });
        appendLog(
          'freqtrade.auth',
          'INFO',
          `Вход по персональной ссылке инвестора: ${acc.name} (${String(acc.exchange).toUpperCase()}, код: ${acc.client_access_code})`
        );
        res.json({
          require_login: true,
          password_changed: cfg.password_changed,
          has_env_secrets: cfg.has_env_secrets,
          authenticated: true,
          role: 'client',
          login: acc.name,
          account_id: acc.id,
          client_code: acc.client_access_code,
          token: sessionToken,
        });
        return;
      }
    }

    const verified = token ? sqliteDb.verifyAuthToken(token) : { valid: false };

    if (!cfg.require_login) {
      res.json({
        require_login: false,
        password_changed: cfg.password_changed,
        has_env_secrets: cfg.has_env_secrets,
        owner_login: cfg.owner_login,
        authenticated: true,
        role: 'owner',
        login: cfg.owner_login,
      });
      return;
    }

    if (verified.valid) {
      let clientCode: string | undefined;
      if (verified.role === 'client' && verified.accountId) {
        const acc = exchangeAccountsStore.find((a) => a.id === verified.accountId);
        if (acc) clientCode = acc.client_access_code;
      }
      res.json({
        require_login: true,
        password_changed: cfg.password_changed,
        has_env_secrets: cfg.has_env_secrets,
        owner_login: verified.role === 'owner' ? cfg.owner_login : undefined,
        authenticated: true,
        role: verified.role || 'owner',
        login: verified.login || cfg.owner_login,
        account_id: verified.accountId,
        client_code: clientCode,
      });
      return;
    }

    // Неавторизованный посетитель — не раскрываем логин владельца
    res.json({
      require_login: true,
      password_changed: cfg.password_changed,
      has_env_secrets: cfg.has_env_secrets,
      authenticated: false,
    });
  });

  app.post('/api/v1/auth/login', (req, res) => {
    const { mode = 'owner', login, password, access_code, invite_token } = req.body || {};

    if (mode === 'invite') {
      const consumed = sqliteDb.consumeInviteToken(String(invite_token || ''));
      if (!consumed) {
        res.status(401).json({ error: 'Ссылка доступа недействительна или отозвана владельцем' });
        return;
      }
      const token = sqliteDb.createAuthToken({
        role: consumed.role,
        login: consumed.label,
        inviteId: consumed.id,
      });
      appendLog(
        'freqtrade.auth',
        'INFO',
        `Вход по персональной ссылке доступа: ${consumed.label} (${consumed.role})`
      );
      res.json({
        authenticated: true,
        role: consumed.role,
        login: consumed.label,
        token,
      });
      return;
    }

    if (mode === 'client') {
      const acc = sqliteDb.verifyClientAccessCode(String(access_code || ''));
      if (!acc) {
        res.status(401).json({ error: 'Неверный код доступа' });
        return;
      }
      const token = sqliteDb.createAuthToken({
        role: 'client',
        login: String(acc.name || 'Клиент'),
        accountId: String(acc.id),
      });
      appendLog(
        'freqtrade.auth',
        'INFO',
        `Вход по коду доступа клиента: ${acc.name} (${String(acc.exchange).toUpperCase()})`
      );
      res.json({
        authenticated: true,
        role: 'client',
        login: String(acc.name),
        account_id: String(acc.id),
        token,
      });
      return;
    }

    const ok = sqliteDb.verifyOwnerCredentials(String(login || ''), String(password || ''));
    if (!ok) {
      res.status(401).json({ error: 'Неверный логин или пароль владельца' });
      return;
    }
    const cfg = sqliteDb.getSiteAuthConfig();
    const token = sqliteDb.createAuthToken({
      role: 'owner',
      login: cfg.owner_login,
    });
    appendLog('freqtrade.auth', 'INFO', `Выполнен вход владельца терминала (${cfg.owner_login})`);
    res.json({
      authenticated: true,
      role: 'owner',
      login: cfg.owner_login,
      owner_login: cfg.owner_login,
      password_changed: cfg.password_changed,
      has_env_secrets: cfg.has_env_secrets,
      require_login: cfg.require_login,
      token,
    });
  });

  app.get('/api/v1/auth/invites', (req, res) => {
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const verified = sqliteDb.verifyAuthToken(token);
    if (!verified.valid || verified.role !== 'owner') {
      res.status(403).json({ error: 'Доступно только владельцу сайта' });
      return;
    }
    res.json({ invites: sqliteDb.listInviteLinks() });
  });

  app.post('/api/v1/auth/invites', (req, res) => {
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const verified = sqliteDb.verifyAuthToken(token);
    if (!verified.valid || verified.role !== 'owner') {
      res.status(403).json({ error: 'Доступно только владельцу сайта' });
      return;
    }
    const { label = 'Гостевой доступ', role = 'client' } = req.body || {};
    const invite = sqliteDb.createInviteLink(
      String(label),
      role === 'owner' ? 'owner' : 'client'
    );
    appendLog(
      'freqtrade.auth',
      'INFO',
      `Создана ссылка доступа для "${invite.label}" (роль: ${invite.role})`
    );
    res.json({ invite, invites: sqliteDb.listInviteLinks() });
  });

  app.delete('/api/v1/auth/invites/:id', (req, res) => {
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const verified = sqliteDb.verifyAuthToken(token);
    if (!verified.valid || verified.role !== 'owner') {
      res.status(403).json({ error: 'Доступно только владельцу сайта' });
      return;
    }
    const id = String(req.params.id);
    sqliteDb.deleteInviteLink(id);
    appendLog('freqtrade.auth', 'WARNING', `Отозвана и удалена ссылка доступа #${id}`);
    res.json({ removed_id: id, invites: sqliteDb.listInviteLinks() });
  });

  app.patch('/api/v1/auth/settings', (req, res) => {
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const cfg = sqliteDb.getSiteAuthConfig();
    if (cfg.require_login) {
      const verified = sqliteDb.verifyAuthToken(token);
      if (!verified.valid || verified.role !== 'owner') {
        res.status(403).json({ error: 'Доступно только владельцу терминала' });
        return;
      }
    }

    const { new_login, new_password, require_login } = req.body || {};
    const updated = sqliteDb.updateOwnerCredentials({
      newLogin: new_login !== undefined ? String(new_login) : undefined,
      newPassword: new_password !== undefined ? String(new_password) : undefined,
      requireLogin: require_login !== undefined ? Boolean(require_login) : undefined,
    });
    const freshToken = sqliteDb.createAuthToken({
      role: 'owner',
      login: updated.owner_login,
    });
    appendLog(
      'freqtrade.auth',
      'INFO',
      `Обновлены настройки безопасности сайта: логин=${updated.owner_login}, вход по паролю=${updated.require_login ? 'ВКЛ' : 'ВЫКЛ'}`
    );
    res.json({
      ...updated,
      token: freshToken,
    });
  });

  app.get('/api/v1/show_config', (_req, res) => {
    const connected = hasConnectedExchangeAccount();
    if (!connected) {
      botConfig.state = 'stopped';
      botConfig.starting_balance = 0;
    } else {
      const ownerAcc =
        exchangeAccountsStore.find((a) => a.enabled && a.is_owner) ||
        exchangeAccountsStore.find((a) => a.enabled);
      botConfig.starting_balance = Number(ownerAcc?.balance_usdt || 0);
    }
    res.json({
      ...botConfig,
      exchange_connected: connected,
      active_accounts_count: exchangeAccountsStore.filter((a) => a.enabled).length,
      available_strategies: ['ScalpingStrategy', 'SampleStrategy', 'AdvancedStrategy'],
      available_timeframes: ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '1w'],
    });
  });

  app.get('/api/v1/mtf_analysis', async (req, res) => {
    const pair = String(req.query.pair || 'ETH/USDT:USDT').toUpperCase();
    const [{ candles: c1d }, { candles: c4h }, { candles: c1h }] = await Promise.all([
      fetchRealCandles(pair, '1d', 150),
      fetchRealCandles(pair, '4h', 250),
      fetchRealCandles(pair, '1h', 250),
    ]);
    const mtf = analyzeMultiTimeframe(pair, c1h, c4h, c1d);
    const { candles: btcCandles } = await fetchRealCandles('BTC/USDT:USDT', '1h', 60);
    const btcGuard = checkBtcMarketHealth(btcCandles);
    const strategyEval =
      c1h.length >= 30
        ? evaluateScalpingStrategy(c1h, mtf.key_4h_support, mtf.key_4h_resistance)
        : null;
    res.json({
      pair,
      mtf,
      btc_guard: btcGuard,
      strategy_signal: strategyEval,
    });
  });

  app.get('/api/v1/volatile_scan', async (req, res) => {
    const minVol = Number(req.query.min_volume) || 50_000_000;
    const limit = Math.min(25, Math.max(1, Number(req.query.limit) || 10));
    const pairs = await fetchTopVolatileFuturesPairs(minVol);
    const topSlice = pairs.slice(0, limit);
    const analyzed = await Promise.all(
      topSlice.map(async (pair) => {
        const ticker = tickerCache.get(pair);
        const [{ candles: c1d }, { candles: c4h }, { candles: c1h }] = await Promise.all([
          fetchRealCandles(pair, '1d', 150),
          fetchRealCandles(pair, '4h', 250),
          fetchRealCandles(pair, '1h', 100),
        ]);
        const mtf = analyzeMultiTimeframe(pair, c1h, c4h, c1d);
        const sig =
          c1h.length >= 30
            ? evaluateScalpingStrategy(c1h, mtf.key_4h_support, mtf.key_4h_resistance)
            : null;
        const swing24h =
          ticker && ticker.low24h > 0
            ? Number((((ticker.high24h - ticker.low24h) / ticker.low24h) * 100).toFixed(2))
            : 0;
        return {
          pair,
          price: ticker?.price || (c1h[c1h.length - 1]?.close ?? 0),
          volume24h_usdt: ticker?.volume24h || 0,
          change24h_pct: ticker?.change24h || 0,
          swing24h_pct: swing24h,
          d1_trend: mtf.d1_trend,
          key_4h_support: roundPrice(mtf.key_4h_support),
          key_4h_resistance: roundPrice(mtf.key_4h_resistance),
          recommended_tp_long: roundPrice(mtf.recommended_tp_long),
          recommended_tp_short: roundPrice(mtf.recommended_tp_short),
          enter_long: Boolean(sig?.enter_long),
          enter_short: Boolean(sig?.enter_short),
          enter_tag: sig?.enter_tag || '',
        };
      })
    );
    res.json({
      min_volume_usdt: minVol,
      total_qualified_pairs: pairs.length,
      analyzed_count: analyzed.length,
      pairs: analyzed,
    });
  });

  app.post('/api/v1/scan_cycle', async (_req, res) => {
    if (!hasConnectedExchangeAccount()) {
      botConfig.state = 'stopped';
      res.status(400).json({
        error: 'Бот не может запускать цикл анализа без подключенной биржи.',
        state: 'stopped',
      });
      return;
    }
    await runScalpBotCycle(true);
    res.json({
      status: 'completed',
      state: botConfig.state,
      open_trades_count: tradesStore.filter((t) => t.is_open).length,
    });
  });

  // Полная симуляция сбоя/перезапуска памяти сервера с холодным восстановлением из trades.sqlite
  app.post('/api/v1/simulate_crash_recovery', async (_req, res) => {
    tradesStore = [];
    exchangeAccountsStore = [];
    botLevelsStore.clear();
    chartDrawingsStore.clear();
    candleCache.clear();
    initializedTrades = false;
    await initializeBotTrades();
    res.json({
      status: 'recovered_from_sqlite',
      state: botConfig.state,
      restored_trades_count: tradesStore.length,
      open_master_trades: tradesStore.filter(
        (t) => t.is_open && (!t.account_id || t.account_id === 'master')
      ).length,
      averaged_master_trades: tradesStore.filter(
        (t) => t.is_open && (!t.account_id || t.account_id === 'master') && (t.dca_count || 0) > 0
      ).length,
      accounts_count: exchangeAccountsStore.length,
    });
  });

  app.get('/api/orders', (_req, res) => {
    res.json(sqliteDb.getRecentOrders(150));
  });

  app.get('/api/analytics/pnl', (_req, res) => {
    res.json(sqliteDb.getPnlAnalytics());
  });

  app.get('/api/signals', (req, res) => {
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
    res.json(sqliteDb.getRecentSignals(limit));
  });

  function resolveRequestAccountScope(req: express.Request): {
    accountId: string;
    isClient: boolean;
    baseDeposit: number;
    account?: ExchangeAccountRecord;
  } {
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const verified = token ? sqliteDb.verifyAuthToken(token) : { valid: false };

    const queryAccId = String(req.query.account_id || '').trim();
    const queryCode = String(req.query.code || req.query.client || '').trim().toUpperCase();

    if (queryCode) {
      const byCode = exchangeAccountsStore.find(
        (a) => a.client_access_code.toUpperCase() === queryCode
      );
      if (byCode) {
        return {
          accountId: byCode.id,
          isClient: !byCode.is_owner,
          baseDeposit: byCode.balance_usdt || 2000,
          account: byCode,
        };
      }
    }

    if (queryAccId && queryAccId !== 'master') {
      const byId = exchangeAccountsStore.find((a) => a.id === queryAccId);
      if (byId) {
        return {
          accountId: byId.id,
          isClient: !byId.is_owner,
          baseDeposit: byId.balance_usdt || 2000,
          account: byId,
        };
      }
    }

    if (verified.valid && verified.role === 'client' && verified.accountId) {
      const clientAcc = exchangeAccountsStore.find((a) => a.id === verified.accountId);
      return {
        accountId: verified.accountId,
        isClient: true,
        baseDeposit: clientAcc?.balance_usdt || 2000,
        account: clientAcc,
      };
    }

    if (!hasConnectedExchangeAccount()) {
      return {
        accountId: 'master',
        isClient: false,
        baseDeposit: 0,
        account: undefined,
      };
    }

    const ownerAcc =
      exchangeAccountsStore.find((a) => a.enabled && a.is_owner) ||
      exchangeAccountsStore.find((a) => a.enabled);
    return {
      accountId: 'master',
      isClient: false,
      baseDeposit: Number(ownerAcc?.balance_usdt || 0),
      account: ownerAcc,
    };
  }

  function filterTradesForScope(scopeAccountId: string): FreqtradeTrade[] {
    if (!hasConnectedExchangeAccount()) {
      return [];
    }
    if (scopeAccountId === 'master') {
      return tradesStore.filter((t) => !t.account_id || t.account_id === 'master');
    }
    return tradesStore.filter((t) => t.account_id === scopeAccountId);
  }

  app.get('/api/v1/status', async (req, res) => {
    await initializeBotTrades();
    const scope = resolveRequestAccountScope(req);
    const scopedTrades = filterTradesForScope(scope.accountId);
    for (const t of scopedTrades) {
      if (t.is_open) {
        const liveTicker = tickerCache.get(t.pair);
        if (liveTicker && liveTicker.price > 0) {
          t.current_rate = liveTicker.price;
        }
        recalculateTradeMetrics(t);
      }
    }
    res.json(scopedTrades.filter((t) => t.is_open));
  });

  app.get('/api/v1/trades/open', async (req, res) => {
    await initializeBotTrades();
    const scope = resolveRequestAccountScope(req);
    const scopedTrades = filterTradesForScope(scope.accountId);
    res.json(scopedTrades.filter((t) => t.is_open));
  });

  app.get('/api/v1/trades', async (req, res) => {
    await initializeBotTrades();
    const scope = resolveRequestAccountScope(req);
    const scopedTrades = filterTradesForScope(scope.accountId);
    const closed = scopedTrades.filter((t) => !t.is_open);
    res.json({
      trades: closed,
      trades_count: closed.length,
      total_trades: closed.length,
    });
  });

  app.get('/api/v1/profit', async (req, res) => {
    await initializeBotTrades();
    const scope = resolveRequestAccountScope(req);
    const scopedTrades = filterTradesForScope(scope.accountId);
    const open = scopedTrades.filter((t) => t.is_open);
    const closed = scopedTrades.filter((t) => !t.is_open);
    const closedProfitAbs = Number(
      closed.reduce((acc, t) => acc + t.profit_abs, 0).toFixed(3)
    );
    const openProfitAbs = Number(
      open.reduce((acc, t) => acc + t.profit_abs, 0).toFixed(3)
    );
    const allProfitAbs = Number((closedProfitAbs + openProfitAbs).toFixed(3));
    const wins = closed.filter((t) => t.profit_abs >= 0).length;
    const losses = closed.filter((t) => t.profit_abs < 0).length;
    const winrate = closed.length > 0 ? Number(((wins / closed.length) * 100).toFixed(1)) : 0;

    const compounded = getCompoundedAccountBalance(scope.accountId);
    const baseDeposit = compounded.baseDeposit > 0 ? compounded.baseDeposit : scope.baseDeposit;

    res.json({
      profit_closed_coin: closedProfitAbs,
      profit_closed_percent: baseDeposit > 0 ? Number(((closedProfitAbs / baseDeposit) * 100).toFixed(2)) : 0,
      profit_closed_fiat: closedProfitAbs,
      profit_all_coin: allProfitAbs,
      profit_all_percent: baseDeposit > 0 ? Number(((allProfitAbs / baseDeposit) * 100).toFixed(2)) : 0,
      profit_all_fiat: allProfitAbs,
      profit_open_coin: openProfitAbs,
      profit_open_percent: baseDeposit > 0 ? Number(((openProfitAbs / baseDeposit) * 100).toFixed(2)) : 0,
      trade_count: scopedTrades.length,
      closed_trade_count: closed.length,
      open_trade_count: open.length,
      winning_trades: wins,
      losing_trades: losses,
      winrate,
      expectancy: 0,
      max_drawdown: 0,
      max_drawdown_abs: 0,
      best_pair: closed[0]?.pair || open[0]?.pair || 'ETH/USDT:USDT',
      best_rate: 0,
      starting_balance: baseDeposit,
      current_balance: Number(compounded.compoundedBalance.toFixed(2)),
    });
  });

  app.get('/api/v1/daily', async (req, res) => {
    await initializeBotTrades();
    const scope = resolveRequestAccountScope(req);
    const scopedTrades = filterTradesForScope(scope.accountId);
    const dailyMap = new Map<string, { date: string; abs_profit: number; rel_profit: number; trades_count: number; wins: number; losses: number }>();
    for (const t of scopedTrades) {
      const dStr = (t.close_date || t.open_date || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
      const curr = dailyMap.get(dStr) || { date: dStr, abs_profit: 0, rel_profit: 0, trades_count: 0, wins: 0, losses: 0 };
      curr.abs_profit = Number((curr.abs_profit + (t.profit_abs || 0)).toFixed(3));
      curr.rel_profit = Number((curr.rel_profit + (t.profit_pct || 0)).toFixed(2));
      curr.trades_count += 1;
      if ((t.profit_abs || 0) >= 0) curr.wins += 1;
      else curr.losses += 1;
      dailyMap.set(dStr, curr);
    }
    const data = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    res.json({ data, fiat_display_currency: 'USD', stake_currency: 'USDT' });
  });

  app.get('/api/v1/balance', async (req, res) => {
    await initializeBotTrades();
    await syncRealExchangeBalancesIfNeeded(false);
    const scope = resolveRequestAccountScope(req);
    const scopedTrades = filterTradesForScope(scope.accountId);
    const usedStake = Number(
      scopedTrades
        .filter((t) => t.is_open)
        .reduce((acc, t) => acc + t.stake_amount, 0)
        .toFixed(2)
    );
    const compounded = getCompoundedAccountBalance(scope.accountId);
    const baseStartingBalance = compounded.baseDeposit > 0 ? compounded.baseDeposit : scope.baseDeposit;
    const totalBalance = Number(compounded.compoundedBalance.toFixed(2));
    const freeBalance = Number(Math.max(0, totalBalance - usedStake).toFixed(2));
    res.json({
      currencies: [
        {
          currency: 'USDT',
          free: freeBalance,
          used: usedStake,
          balance: totalBalance,
          est_stake: totalBalance,
          stake: 'USDT',
        },
      ],
      total: totalBalance,
      symbol: 'USDT',
      value: totalBalance,
      starting_capital: baseStartingBalance,
      starting_capital_ratio: 0,
    });
  });

  app.get('/api/v1/performance', async (req, res) => {
    await initializeBotTrades();
    const scope = resolveRequestAccountScope(req);
    const scopedTrades = filterTradesForScope(scope.accountId);
    const map = new Map<string, { pair: string; profit_pct: number; profit_abs: number; count: number }>();
    for (const t of scopedTrades) {
      const curr = map.get(t.pair) || { pair: t.pair, profit_pct: 0, profit_abs: 0, count: 0 };
      curr.profit_pct = Number((curr.profit_pct + t.profit_pct).toFixed(2));
      curr.profit_abs = Number((curr.profit_abs + t.profit_abs).toFixed(3));
      curr.count += 1;
      map.set(t.pair, curr);
    }
    res.json(Array.from(map.values()));
  });

  app.get('/api/v1/whitelist', async (_req, res) => {
    const allMarketPairs = await fetchAllMarketPairs();
    const activeWhitelist = allMarketPairs.filter((p) => !blacklist.includes(p));
    const pairMetrics = activeWhitelist.map((pair) => {
      const t = tickerCache.get(pair);
      return {
        pair,
        price: t?.price || 0,
        change24h: t?.change24h || 0,
        volume24h: t?.volume24h || 0,
        high24h: t?.high24h || 0,
        low24h: t?.low24h || 0,
      };
    });
    res.json({
      whitelist: activeWhitelist,
      length: activeWhitelist.length,
      method: ['VolumePairList'],
      pair_metrics: pairMetrics,
    });
  });

  app.get('/api/v1/blacklist', (_req, res) => {
    res.json({ blacklist, length: blacklist.length, method: ['StaticPairList'] });
  });

  app.post('/api/v1/blacklist', (req, res) => {
    const { blacklist: newPairs } = req.body || {};
    if (Array.isArray(newPairs)) {
      for (const p of newPairs) {
        const clean = String(p).trim().toUpperCase();
        if (clean && !blacklist.includes(clean)) blacklist.push(clean);
      }
    }
    res.json({ blacklist, length: blacklist.length });
  });

  app.delete('/api/v1/blacklist', (req, res) => {
    const p = String(req.query.pairs_to_delete || '').toUpperCase();
    if (p) blacklist = blacklist.filter((item) => item !== p);
    res.json({ blacklist, length: blacklist.length });
  });

  app.get('/api/v1/locks', (_req, res) => {
    res.json({ lock_count: pairLocks.length, locks: pairLocks });
  });

  app.post('/api/v1/locks', (req, res) => {
    const { pair, until, reason = 'Manual Lock', side = '*' } = req.body || {};
    const lock = {
      id: Date.now(),
      pair: String(pair || 'ETH/USDT:USDT').toUpperCase(),
      lock_time: new Date().toISOString(),
      lock_end_time: until || new Date(Date.now() + 3600_000).toISOString(),
      reason,
      side,
      active: true,
    };
    pairLocks.push(lock);
    res.json(lock);
  });

  app.delete('/api/v1/locks/:id', (req, res) => {
    const id = Number(req.params.id);
    pairLocks = pairLocks.filter((l) => l.id !== id);
    res.json({ lock_count: pairLocks.length, locks: pairLocks });
  });

  app.get('/api/v1/pair_candles', async (req, res) => {
    await initializeBotTrades();
    const pair = String(req.query.pair || 'ETH/USDT:USDT').toUpperCase();
    const timeframe = String(req.query.timeframe || botConfig.timeframe);
    const strategy = String(req.query.strategy || botConfig.strategy);
    const limit = Math.min(1000, Math.max(60, Number(req.query.limit) || 1000));
    const endTime = req.query.endTime ? Number(req.query.endTime) : undefined;

    const { candles, source } = await fetchRealCandles(pair, timeframe, limit, endTime);

    // Update current rate for open trades on this pair without mutating entry price across timeframes
    if (!endTime && candles.length > 0) {
      const cLatest = candles[candles.length - 1];
      for (const t of tradesStore) {
        if (t.is_open && t.pair === pair && cLatest) {
          t.current_rate = cLatest.close;
          recalculateTradeMetrics(t);
        }
      }
    }

    const dataframe = buildFreqtradeDataframe(pair, timeframe, strategy, candles, source);
    res.json(dataframe);
  });

  app.get('/api/v1/logs', (_req, res) => {
    res.json({ log_count: botLogs.length, logs: [...botLogs].reverse() });
  });

  app.post('/api/v1/start', (_req, res) => {
    if (!hasConnectedExchangeAccount()) {
      botConfig.state = 'stopped';
      appendLog(
        'freqtrade.rpc.rpc',
        'ERROR',
        'Отказ запуска: не подключен ни один биржевой аккаунт (API). Подключите биржу во вкладке «API / Клиенты».'
      );
      res.status(400).json({
        error:
          'Невозможно запустить бота без подключенной биржи. Добавьте API-ключ во вкладке «API / Клиенты».',
        status: 'stopped (no exchange connected)',
        state: 'stopped',
      });
      return;
    }
    botConfig.state = 'running';
    appendLog('freqtrade.rpc.rpc', 'INFO', 'Changing state to: RUNNING');
    res.json({ status: 'starting trader ...', state: botConfig.state });
  });

  app.post('/api/v1/stop', (_req, res) => {
    botConfig.state = 'stopped';
    appendLog('freqtrade.rpc.rpc', 'WARNING', 'Changing state to: STOPPED');
    res.json({ status: 'stopping trader ...', state: botConfig.state });
  });

  app.post('/api/v1/stopbuy', (_req, res) => {
    botConfig.state = 'paused';
    appendLog('freqtrade.rpc.rpc', 'INFO', 'Changing state to: PAUSED');
    res.json({ status: 'paused new entries', state: botConfig.state });
  });

  app.post('/api/v1/reload_config', (_req, res) => {
    candleCache.clear();
    appendLog('freqtrade.rpc.rpc', 'INFO', 'Reloading config ...');
    res.json({ status: 'Reloading config ...', state: botConfig.state });
  });

  app.patch('/api/v1/config', (req, res) => {
    const { strategy, timeframe } = req.body || {};
    if (strategy) botConfig.strategy = String(strategy);
    if (timeframe) botConfig.timeframe = String(timeframe);
    res.json(botConfig);
  });

  app.post('/api/v1/forceenter', async (req, res) => {
    await initializeBotTrades();
    if (!hasConnectedExchangeAccount()) {
      botConfig.state = 'stopped';
      res.status(400).json({
        error:
          'Бот не может открывать сделки без подключенной биржи. Сначала подключите биржевой аккаунт во вкладке «API / Клиенты».',
      });
      return;
    }
    const {
      pair = 'ETH/USDT:USDT',
      side = 'long',
      price: customPrice,
      stakeamount,
      leverage: customLeverage,
      take_profit_abs: customTp,
      stop_loss_abs: customSl,
      skip_client_sync: skipClientSync,
    } = req.body || {};
    const cleanPair = String(pair).toUpperCase();
    const [{ candles: c1d }, { candles: c4h }, { candles: c1h }] = await Promise.all([
      fetchRealCandles(cleanPair, '1d', 150),
      fetchRealCandles(cleanPair, '4h', 250),
      fetchRealCandles(cleanPair, '1h', 250),
    ]);
    const latestPrice = c1h.length > 0 ? c1h[c1h.length - 1].close : 100;
    const entryRate = roundPrice(
      customPrice && Number(customPrice) > 0 ? Number(customPrice) : latestPrice
    );
    const mtf = analyzeMultiTimeframe(cleanPair, c1h, c4h, c1d);
    const isShort = side === 'short';

    let newTrade: FreqtradeTrade;
    try {
      newTrade = await createScalpBotPosition(
        cleanPair,
        isShort ? 'short' : 'long',
        entryRate,
        mtf,
        c4h,
        c1d,
        isShort ? 'Short (MTF)' : 'Long (MTF)',
        {
          stake: stakeamount && Number(stakeamount) > 0 ? Number(stakeamount) : undefined,
          leverage: customLeverage && Number(customLeverage) >= 1 ? Number(customLeverage) : undefined,
          customTp: customTp && Number(customTp) > 0 ? Number(customTp) : undefined,
          customSl: customSl && Number(customSl) > 0 ? Number(customSl) : undefined,
          skipClientSync: Boolean(skipClientSync),
        }
      );
    } catch (err: any) {
      res.status(400).json({
        error: err?.message || 'Ошибка при открытии сделки на бирже.',
      });
      return;
    }

    // Sync MTF levels into bot_levels table for this pair
    await getOrComputeMtfBotLevels(cleanPair);

    res.json(newTrade);
  });

  // Bot Averaging (DCA) endpoint — uses MTF 4H/1D strongest level & shifts weighted average entry price atomically across master and linked clients
  app.post('/api/v1/dca', async (req, res) => {
    await initializeBotTrades();
    if (!hasConnectedExchangeAccount()) {
      res.status(400).json({
        error: 'Бот не может выполнять усреднение (DCA) без подключенной биржи.',
      });
      return;
    }
    const { tradeid, price: customDcaPrice, stakeamount } = req.body || {};
    const id = Number(tradeid);
    const trade = tradesStore.find((t) => t.trade_id === id && t.is_open);
    if (!trade) {
      res.status(404).json({ error: `Открытая сделка #${id} не найдена` });
      return;
    }

    const [{ candles: c1d }, { candles: c4h }, { candles: c1h }] = await Promise.all([
      fetchRealCandles(trade.pair, '1d', 150),
      fetchRealCandles(trade.pair, '4h', 250),
      fetchRealCandles(trade.pair, '1h', 100),
    ]);
    const livePrice =
      c1h.length > 0 ? c1h[c1h.length - 1].close : trade.current_rate;
    trade.current_rate = livePrice;

    const plannedLevel1 = trade.planned_dca_levels?.[0]?.price || trade.next_dca_price;
    let fillPrice = livePrice;
    if (customDcaPrice && Number(customDcaPrice) > 0) {
      fillPrice = Number(customDcaPrice);
    } else if (plannedLevel1 && plannedLevel1 > 0) {
      fillPrice = plannedLevel1;
    }
    fillPrice = roundPrice(fillPrice);

    const nextStep = (trade.dca_count || 0) + 1;
    const baseStake = trade.initial_stake || trade.stake_amount;
    const defaultDcaStake = Number(
      (baseStake * Math.pow(botConfig.dca_multiplier, nextStep)).toFixed(2)
    );
    const addStake =
      stakeamount && Number(stakeamount) > 0 ? Number(stakeamount) : defaultDcaStake;
    const leverage = trade.leverage || botConfig.leverage;
    const rawAddAmount = Number(((addStake * leverage) / Math.max(1e-8, fillPrice)).toFixed(4));

    // Отправка реального DCA-ордера на биржу
    const targetAccId = trade.account_id || 'master';
    const dcaOrderRes = await dispatchOrderToExchangeAccount(targetAccId, {
      pair: trade.pair,
      isShort: trade.is_short,
      action: 'DCA',
      quantity: rawAddAmount,
      leverage,
      referencePrice: fillPrice,
    });
    const targetCreds = getAccountCredentialsFromStore(targetAccId);
    if (
      targetCreds &&
      !isSimulatedTestApiKey(targetCreds.apiKey) &&
      (!dcaOrderRes || !dcaOrderRes.success)
    ) {
      res.status(400).json({
        error:
          dcaOrderRes?.error ||
          `Биржа отклонила ордер усреднения (DCA) по паре ${trade.pair}.`,
      });
      return;
    }

    const addAmount =
      dcaOrderRes?.success && dcaOrderRes.qty > 0 ? dcaOrderRes.qty : rawAddAmount;
    if (dcaOrderRes?.success && dcaOrderRes.price > 0 && !customDcaPrice && !plannedLevel1) {
      fillPrice = roundPrice(dcaOrderRes.price);
    }

    const prevOpenRate = trade.open_rate;
    const prevAmount = trade.amount;
    const prevStake = trade.stake_amount;
    const dcaMultiplierRatio = addStake / Math.max(1, prevStake);

    const newTotalAmount = Number((prevAmount + addAmount).toFixed(4));
    const newTotalStake = Number((prevStake + addStake).toFixed(3));
    const newAvgOpenRate = roundPrice(
      (prevOpenRate * prevAmount + fillPrice * addAmount) / Math.max(1e-8, newTotalAmount)
    );

    const now = Date.now();
    const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
    const nextStrongDca = findStrongestDcaLevel(c4h, c1d, fillPrice, trade.is_short, 2.0);

    // Pre-dispatch client DCA orders if master trade is averaged
    const clientDcaDispatches = new Map<number, PlacedOrderResult | null>();
    if (!trade.account_id || trade.account_id === 'master') {
      const clientCopies = tradesStore.filter(
        (ct) =>
          ct.is_open &&
          ct.account_id &&
          ct.account_id !== 'master' &&
          (ct.parent_trade_id === trade.trade_id ||
            (ct.pair === trade.pair && ct.is_short === trade.is_short))
      );
      for (const ct of clientCopies) {
        const clientAddStake = Number((ct.stake_amount * dcaMultiplierRatio).toFixed(2));
        const clientLev = ct.leverage || 25;
        const clientRawAddAmount = Number(
          ((clientAddStake * clientLev) / Math.max(1e-8, fillPrice)).toFixed(4)
        );
        const cRes = await dispatchOrderToExchangeAccount(ct.account_id!, {
          pair: ct.pair,
          isShort: ct.is_short,
          action: 'DCA',
          quantity: clientRawAddAmount,
          leverage: clientLev,
          referencePrice: fillPrice,
        });
        clientDcaDispatches.set(ct.trade_id, cRes);
      }
    }

    sqliteDb.runInTransaction(() => {
      trade.open_rate = newAvgOpenRate;
      trade.amount = newTotalAmount;
      trade.stake_amount = newTotalStake;
      trade.dca_count = nextStep;
      trade.last_dca_date = nowStr;
      trade.trade_state = 'AVERAGED';
      trade.pullback_min_profit_pct = 0.4;
      trade.enter_tag = `${trade.is_short ? 'Short' : 'Long'} (DCA ×${nextStep})`;
      trade.next_dca_price = roundPrice(nextStrongDca.price);

      trade.orders.push({
        id: dcaOrderRes?.order_id || `ord-${trade.trade_id}-${nextStep}`,
        step: nextStep,
        label: `Усреднение #${nextStep} (${nextStrongDca.source})`,
        side: trade.is_short ? 'short' : 'long',
        price: fillPrice,
        amount: addAmount,
        stake_amount: addStake,
        timestamp: now,
        date: nowStr,
      });

      recalculateTradeMetrics(trade, true);
      sqliteDb.upsertTrade(trade);
      sqliteDb.recordOrder({
        trade_id: trade.trade_id,
        pair: trade.pair,
        order_type: 'market',
        side: trade.is_short ? 'sell' : 'buy',
        price: fillPrice,
        amount: addAmount,
        cost: addStake,
        fee: Number((fillPrice * addAmount * TAKER_FEE_RATE).toFixed(4)),
        realized_pnl: 0,
        action_type: `DCA_${nextStep}`,
        notes: `DCA #${nextStep} @ ${fillPrice} | Avg: ${prevOpenRate} -> ${newAvgOpenRate} | Breakeven: ${trade.breakeven_price} | Next DCA: ${trade.next_dca_price}${dcaOrderRes?.order_id ? ` | ExOrderId: ${dcaOrderRes.order_id}` : ''}`,
      });

      // Synchronously average all linked client trades in the same SQLite transaction
      if (!trade.account_id || trade.account_id === 'master') {
        const clientCopies = tradesStore.filter(
          (ct) =>
            ct.is_open &&
            ct.account_id &&
            ct.account_id !== 'master' &&
            (ct.parent_trade_id === trade.trade_id ||
              (ct.pair === trade.pair && ct.is_short === trade.is_short))
        );
        for (const ct of clientCopies) {
          const cRes = clientDcaDispatches.get(ct.trade_id);
          const cCreds = getAccountCredentialsFromStore(ct.account_id!);
          if (cCreds && !isSimulatedTestApiKey(cCreds.apiKey) && (!cRes || !cRes.success)) {
            continue;
          }
          const clientAddStake = Number((ct.stake_amount * dcaMultiplierRatio).toFixed(2));
          const clientLev = ct.leverage || 25;
          const rawClientAddAmount = Number(
            ((clientAddStake * clientLev) / Math.max(1e-8, fillPrice)).toFixed(4)
          );
          const clientAddAmount =
            cRes?.success && cRes.qty > 0 ? cRes.qty : rawClientAddAmount;
          const clientPrevRate = ct.open_rate;
          const clientNewTotalAmount = Number((ct.amount + clientAddAmount).toFixed(4));
          const clientNewAvgRate = roundPrice(
            (clientPrevRate * ct.amount + fillPrice * clientAddAmount) /
              Math.max(1e-8, clientNewTotalAmount)
          );
          ct.open_rate = clientNewAvgRate;
          ct.amount = clientNewTotalAmount;
          ct.stake_amount = Number((ct.stake_amount + clientAddStake).toFixed(2));
          ct.dca_count = nextStep;
          ct.last_dca_date = nowStr;
          ct.trade_state = 'AVERAGED';
          ct.enter_tag = trade.enter_tag;
          ct.next_dca_price = trade.next_dca_price;
          ct.orders.push({
            id: cRes?.order_id || `ord-${ct.trade_id}-${nextStep}`,
            step: nextStep,
            label: `Усреднение #${nextStep} (${nextStrongDca.source})`,
            side: ct.is_short ? 'short' : 'long',
            price: fillPrice,
            amount: clientAddAmount,
            stake_amount: clientAddStake,
            timestamp: now,
            date: nowStr,
          });
          recalculateTradeMetrics(ct, true);
          sqliteDb.upsertTrade(ct);
          sqliteDb.recordOrder({
            trade_id: ct.trade_id,
            pair: ct.pair,
            order_type: 'market',
            side: ct.is_short ? 'sell' : 'buy',
            price: fillPrice,
            amount: clientAddAmount,
            cost: clientAddStake,
            fee: Number((fillPrice * clientAddAmount * TAKER_FEE_RATE).toFixed(4)),
            realized_pnl: 0,
            action_type: `CLIENT_DCA_${nextStep}`,
            notes: `Client DCA #${nextStep} @ ${fillPrice} | Avg: ${clientPrevRate} -> ${clientNewAvgRate}`,
          });
        }
      }
    });

    appendLog(
      'freqtrade.bot.dca',
      'INFO',
      `🔄 Усреднение #${nextStep} [${trade.pair}]: +${addStake}$ @ ${fillPrice}$. Средняя цена: ${prevOpenRate}$ ➔ ${newAvgOpenRate}$ | Безубыток (с комиссией 0.06%): ${trade.breakeven_price}$ | Новый TP: ${trade.take_profit_abs}$ | След. DCA: ${trade.next_dca_price}$`
    );

    res.json({
      result: `Trade #${id} averaged (DCA ×${nextStep})`,
      previous_open_rate: prevOpenRate,
      new_open_rate: newAvgOpenRate,
      trade,
    });
  });

  // Update trade levels (TP, SL, Support, Resistance, or Planned DCA levels) when dragged by the user on the chart
  app.patch('/api/v1/trade_levels', async (req, res) => {
    await initializeBotTrades();
    const { tradeid, level_type, step, price } = req.body || {};
    const id = Number(tradeid);
    const requestedPrice = roundPrice(Number(price));
    if (!Number.isFinite(requestedPrice) || requestedPrice <= 0) {
      res.status(400).json({ error: 'Invalid price' });
      return;
    }

    const trade = tradesStore.find((t) => t.trade_id === id && t.is_open);
    if (!trade) {
      res.status(404).json({ error: `Open trade #${id} not found` });
      return;
    }

    recalculateTradeMetrics(trade, false);
    let prevPrice = 0;
    let effectivePrice = requestedPrice;
    let clampedToBreakeven = false;
    let clampWarning: string | undefined;

    sqliteDb.runInTransaction(() => {
      if (level_type === 'tp') {
        prevPrice = trade.take_profit_abs;
        const minProfitableTp = trade.min_profitable_tp || trade.breakeven_price || trade.open_rate;
        const wouldCloseInLossOrFeeMinus = trade.is_short
          ? requestedPrice > minProfitableTp
          : requestedPrice < minProfitableTp;

        if (wouldCloseInLossOrFeeMinus) {
          effectivePrice = minProfitableTp;
          clampedToBreakeven = true;
          clampWarning = `Защита от закрытия в минус: TP скорректирован до минимального плюсового уровня ${minProfitableTp}$ (покрывает среднюю цену ${trade.open_rate}$ + комиссии Taker 0.06% на вход, DCA и выход = ${trade.fee_total}$).`;
        }

        trade.take_profit_abs = effectivePrice;
        trade.tp_manual_override = true;
        recalculateTradeMetrics(trade, false);
        appendLog(
          'freqtrade.bot.levels',
          clampedToBreakeven ? 'WARNING' : 'INFO',
          clampedToBreakeven
            ? `🛡️ [${trade.pair}] Попытка поставить TP (${requestedPrice}$) в зону убытка/комиссии! Авто-коррекция TP до безубытка+профит: ${trade.take_profit_abs}$ (чистый ROI: +${trade.take_profit_pct}%).`
            : `[${trade.pair}] TP изменен вручную на графике: ${prevPrice}$ ➔ ${trade.take_profit_abs}$ (чистый ROI: +${trade.take_profit_pct}%). Сохранено в trades.sqlite.`
        );
      } else if (level_type === 'sl') {
        prevPrice = trade.stop_loss_abs;
        trade.stop_loss_abs = effectivePrice;
        trade.sl_manual_override = true;
        recalculateTradeMetrics(trade, false);
        appendLog(
          'freqtrade.bot.levels',
          'INFO',
          `[${trade.pair}] SL изменен вручную на графике: ${prevPrice}$ ➔ ${effectivePrice}$ (${trade.stop_loss_pct}%). Сохранено в trades.sqlite.`
        );
      } else if (level_type === 'dca') {
        const targetStep = Number(step) || (trade.dca_count || 0) + 1;
        trade.dca_manual_override = true;
        const dcaItem = trade.planned_dca_levels?.find((l) => l.step === targetStep);
        if (dcaItem) {
          prevPrice = dcaItem.price;
          dcaItem.price = effectivePrice;
          dcaItem.manual_override = true;
          if (targetStep === (trade.dca_count || 0) + 1) {
            trade.next_dca_price = effectivePrice;
            if (!trade.is_short && effectivePrice < trade.open_rate) {
              trade.support_level = effectivePrice;
            } else if (trade.is_short && effectivePrice > trade.open_rate) {
              trade.resistance_level = effectivePrice;
            }
            const secondItem = trade.planned_dca_levels?.find((l) => l.step === targetStep + 1);
            if (
              secondItem &&
              (!secondItem.manual_override ||
                (!trade.is_short && secondItem.price >= effectivePrice) ||
                (trade.is_short && secondItem.price <= effectivePrice))
            ) {
              const dist = (trade.dca_count || 0) > 0 ? 0.02 : 0.015;
              secondItem.price = roundPrice(
                trade.is_short ? effectivePrice * (1 + dist) : effectivePrice * (1 - dist)
              );
            }
          }
          recalculateTradeMetrics(trade, false);
          appendLog(
            'freqtrade.bot.levels',
            'INFO',
            `[${trade.pair}] Уровень DCA #${targetStep} перенесен на графике: ${prevPrice}$ ➔ ${effectivePrice}$ (дистанция: ${dcaItem.distance_pct}%, объем: ${dcaItem.amount}). Бот синхронизирован.`
          );
        } else {
          prevPrice = trade.next_dca_price || 0;
          trade.next_dca_price = effectivePrice;
          if (trade.planned_dca_levels?.[0]) {
            trade.planned_dca_levels[0].price = effectivePrice;
            trade.planned_dca_levels[0].manual_override = true;
          }
          recalculateTradeMetrics(trade, false);
        }
      } else if (level_type === 'support') {
        prevPrice = trade.support_level || 0;
        trade.support_level = effectivePrice;
        if (!trade.is_short && effectivePrice < trade.open_rate) {
          trade.next_dca_price = effectivePrice;
          trade.dca_manual_override = true;
          if (trade.planned_dca_levels?.[0]) {
            trade.planned_dca_levels[0].price = effectivePrice;
            trade.planned_dca_levels[0].manual_override = true;
          }
        }
        recalculateTradeMetrics(trade, false);
      } else if (level_type === 'resistance') {
        prevPrice = trade.resistance_level || 0;
        trade.resistance_level = effectivePrice;
        if (trade.is_short && effectivePrice > trade.open_rate) {
          trade.next_dca_price = effectivePrice;
          trade.dca_manual_override = true;
          if (trade.planned_dca_levels?.[0]) {
            trade.planned_dca_levels[0].price = effectivePrice;
            trade.planned_dca_levels[0].manual_override = true;
          }
        }
        recalculateTradeMetrics(trade, false);
      }

      sqliteDb.upsertTrade(trade);

      // Synchronously update linked client trades if master level was dragged
      if (!trade.account_id || trade.account_id === 'master') {
        const linkedClientTrades = tradesStore.filter(
          (ct) =>
            ct.is_open &&
            ct.account_id &&
            ct.account_id !== 'master' &&
            ct.parent_trade_id === trade.trade_id
        );
        for (const ct of linkedClientTrades) {
          if (level_type === 'tp') {
            ct.take_profit_abs = effectivePrice;
            ct.tp_manual_override = true;
          } else if (level_type === 'sl') {
            ct.stop_loss_abs = effectivePrice;
            ct.sl_manual_override = true;
          } else if (level_type === 'dca') {
            const targetStep = Number(step) || (ct.dca_count || 0) + 1;
            ct.dca_manual_override = true;
            const dcaItem = ct.planned_dca_levels?.find((l) => l.step === targetStep);
            if (dcaItem) {
              dcaItem.price = effectivePrice;
              dcaItem.manual_override = true;
            }
            if (targetStep === (ct.dca_count || 0) + 1) {
              ct.next_dca_price = effectivePrice;
              const secondItem = ct.planned_dca_levels?.find((l) => l.step === targetStep + 1);
              const masterSecond = trade.planned_dca_levels?.find((l) => l.step === targetStep + 1);
              if (secondItem && masterSecond) {
                secondItem.price = masterSecond.price;
              }
            }
          } else if (level_type === 'support') {
            ct.support_level = effectivePrice;
            if (!ct.is_short && effectivePrice < ct.open_rate) {
              ct.next_dca_price = effectivePrice;
              ct.dca_manual_override = true;
              if (ct.planned_dca_levels?.[0]) {
                ct.planned_dca_levels[0].price = effectivePrice;
                ct.planned_dca_levels[0].manual_override = true;
              }
            }
          } else if (level_type === 'resistance') {
            ct.resistance_level = effectivePrice;
            if (ct.is_short && effectivePrice > ct.open_rate) {
              ct.next_dca_price = effectivePrice;
              ct.dca_manual_override = true;
              if (ct.planned_dca_levels?.[0]) {
                ct.planned_dca_levels[0].price = effectivePrice;
                ct.planned_dca_levels[0].manual_override = true;
              }
            }
          }
          recalculateTradeMetrics(ct, false);
          sqliteDb.upsertTrade(ct);
        }
      }
    });

    res.json({
      result: 'Level updated and synced with bot SQLite database',
      level_type,
      previous_price: prevPrice,
      new_price: effectivePrice,
      clamped_to_breakeven: clampedToBreakeven,
      warning: clampWarning,
      trade,
    });
  });

  // Get MTF & Timeframe Bot Levels (Support & Resistance with touches/bounces/strength_score) for a pair & timeframe
  app.get('/api/v1/pair_levels', async (req, res) => {
    await initializeBotTrades();
    const pair = String(req.query.pair || 'ETH/USDT:USDT').toUpperCase();
    const timeframe = String(req.query.timeframe || botConfig.timeframe || '1h').toLowerCase();
    const levels = await getOrComputeMtfBotLevels(pair, timeframe);
    res.json({ pair, timeframe, levels });
  });

  // Add a new Bot Level on a pair (persisted in trades.sqlite)
  app.post('/api/v1/pair_levels', async (req, res) => {
    await initializeBotTrades();
    const { pair = 'ETH/USDT:USDT', timeframe = botConfig.timeframe, price, role, label } = req.body || {};
    const cleanPair = String(pair).toUpperCase();
    const normTf = String(timeframe || '1h').toLowerCase();
    const cleanPrice = roundPrice(Number(price));
    if (!Number.isFinite(cleanPrice) || cleanPrice <= 0) {
      res.status(400).json({ error: 'Invalid level price' });
      return;
    }
    const existing = await getOrComputeMtfBotLevels(cleanPair, normTf);
    const nextIdx = existing.length + 1;
    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const livePrice = tickerCache.get(cleanPair)?.price || 0;
    const cleanRole: 'support' | 'resistance' =
      role === 'resistance'
        ? 'resistance'
        : role === 'support'
        ? 'support'
        : livePrice > 0 && cleanPrice >= livePrice
        ? 'resistance'
        : 'support';
    const newLevel: BotChartLevel = {
      id: `lvl-${cleanPair}-${Date.now()}`,
      pair: cleanPair,
      label: label || `MANUAL LVL ${nextIdx} (${cleanRole === 'resistance' ? 'RES' : 'SUP'})`,
      role: cleanRole,
      price: cleanPrice,
      touches: 1,
      bounces: 1,
      breaks: 0,
      strength_score: 10,
      source: 'MANUAL',
      manual_override: true,
      updated_at: nowStr,
    };
    for (const k of Array.from(botLevelsStore.keys())) {
      if (k === cleanPair || k.startsWith(`${cleanPair}_`)) {
        botLevelsStore.delete(k);
      }
    }
    sqliteDb.upsertBotLevel({
      ...newLevel,
      touches: 1,
      bounces: 1,
      breaks: 0,
      strength_score: 10,
      source: 'MANUAL',
      manual_override: true,
      deleted: false,
    });
    const refreshed = await getOrComputeMtfBotLevels(cleanPair, normTf);
    appendLog(
      'freqtrade.bot.levels',
      'INFO',
      `[${cleanPair}] Добавлен уровень бота ${newLevel.label} @ ${cleanPrice}$`
    );
    res.json({ pair: cleanPair, level: newLevel, levels: refreshed });
  });

  // Update a Bot Level price when dragged on the chart (persisted in trades.sqlite & synced to open trades)
  app.patch('/api/v1/pair_levels', async (req, res) => {
    await initializeBotTrades();
    const { pair = 'ETH/USDT:USDT', timeframe = botConfig.timeframe, id, price, role } = req.body || {};
    const cleanPair = String(pair).toUpperCase();
    const normTf = String(timeframe || '1h').toLowerCase();
    const newPrice = roundPrice(Number(price));
    if (!Number.isFinite(newPrice) || newPrice <= 0) {
      res.status(400).json({ error: 'Invalid level price' });
      return;
    }
    const existing = await getOrComputeMtfBotLevels(cleanPair, normTf);
    const allDbLevels = sqliteDb.getAllBotLevelsForPairIncludeDeleted(cleanPair);
    const target = existing.find((l) => l.id === id) || allDbLevels.find((l) => l.id === id);
    if (!target) {
      res.status(404).json({ error: 'Bot level not found' });
      return;
    }
    const prevPrice = target.price;
    target.price = newPrice;
    target.manual_override = true;
    target.updated_at = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // Keep the level's explicit role ('support' for SUP, 'resistance' for RES) unless explicitly overridden in req.body.role
    if (role === 'support' || role === 'resistance') {
      target.role = role;
    } else if (target.id.includes('-sup-') || target.label.toUpperCase().includes('SUP')) {
      target.role = 'support';
    } else if (target.id.includes('-res-') || target.label.toUpperCase().includes('RES')) {
      target.role = 'resistance';
    }

    sqliteDb.runInTransaction(() => {
      sqliteDb.upsertBotLevel({
        id: target.id,
        pair: cleanPair,
        label: target.label,
        role: target.role,
        price: target.price,
        touches: target.touches || 1,
        bounces: target.bounces || 1,
        breaks: target.breaks || 0,
        strength_score: target.strength_score || 10,
        source: target.source || normTf.toUpperCase(),
        manual_override: true,
        deleted: false,
        updated_at: target.updated_at,
      });

      // Remove any old non-manual auto-levels of the same role for this pair so they never reappear on reload or other timeframes
      sqliteDb.replaceAutoBotLevelsWithManual(cleanPair, target.role, target.id);

      // Синхронизируем передвинутый уровень бота (SUP / RES) со всеми открытыми сделками по этой паре (мастер и клиенты):
      // - Для LONG: поддержка (SUP) ниже входа обновляет целевой уровень DCA 1 (и отменяет старый уровень DCA!), а сопротивление (RES) обновляет структурный TP.
      // - Для SHORT: сопротивление (RES) выше входа обновляет целевой уровень DCA 1 (и отменяет старый уровень DCA!), а поддержка (SUP) обновляет структурный TP.
      for (const t of tradesStore) {
        if (t.is_open && t.pair === cleanPair) {
          recalculateTradeMetrics(t, false);
          const minProfTp = t.min_profitable_tp || t.breakeven_price || t.open_rate;
          const dist = (t.dca_count || 0) > 0 ? 0.02 : 0.015;
          if (target.role === 'support') {
            t.support_level = newPrice;
            if (!t.is_short) {
              // LONG: пользователь передвинул уровень поддержки — обновляем целевой уровень Smart DCA #1 на новый уровень!
              if (newPrice < t.open_rate) {
                t.next_dca_price = newPrice;
                t.dca_manual_override = true;
                if (t.planned_dca_levels?.[0]) {
                  t.planned_dca_levels[0].price = newPrice;
                  t.planned_dca_levels[0].manual_override = true;
                }
                if (
                  t.planned_dca_levels?.[1] &&
                  (!t.planned_dca_levels[1].manual_override ||
                    t.planned_dca_levels[1].price >= newPrice)
                ) {
                  t.planned_dca_levels[1].price = roundPrice(newPrice * (1 - dist));
                }
              }
            } else {
              // SHORT: уровень поддержки служит структурной целью Take Profit
              if (!t.tp_manual_override) {
                const candidateTp = roundPrice(newPrice * 1.002);
                t.take_profit_abs = Math.min(candidateTp, minProfTp);
              }
            }
          } else {
            t.resistance_level = newPrice;
            if (!t.is_short) {
              // LONG: уровень сопротивления служит структурной целью Take Profit
              if (!t.tp_manual_override) {
                const candidateTp = roundPrice(newPrice * 0.998);
                t.take_profit_abs = Math.max(candidateTp, minProfTp);
              }
            } else {
              // SHORT: пользователь передвинул уровень сопротивления — обновляем целевой уровень Smart DCA #1 на новый уровень!
              if (newPrice > t.open_rate) {
                t.next_dca_price = newPrice;
                t.dca_manual_override = true;
                if (t.planned_dca_levels?.[0]) {
                  t.planned_dca_levels[0].price = newPrice;
                  t.planned_dca_levels[0].manual_override = true;
                }
                if (
                  t.planned_dca_levels?.[1] &&
                  (!t.planned_dca_levels[1].manual_override ||
                    t.planned_dca_levels[1].price <= newPrice)
                ) {
                  t.planned_dca_levels[1].price = roundPrice(newPrice * (1 + dist));
                }
              }
            }
          }
          recalculateTradeMetrics(t, false);
          sqliteDb.upsertTrade(t);
        }
      }
    });

    for (const k of Array.from(botLevelsStore.keys())) {
      if (k === cleanPair || k.startsWith(`${cleanPair}_`)) {
        botLevelsStore.delete(k);
      }
    }
    const refreshedLevels = await getOrComputeMtfBotLevels(cleanPair, normTf);

    appendLog(
      'freqtrade.bot.levels',
      'INFO',
      `[${cleanPair}] Уровень ${target.label} (${target.role.toUpperCase()}) перенесен на графике: ${prevPrice}$ ➔ ${newPrice}$. Цели TP и DCA открытых сделок синхронизированы.`
    );
    res.json({ pair: cleanPair, previous_price: prevPrice, level: target, levels: refreshedLevels });
  });

  // Delete a single Bot Level (marks deleted in trades.sqlite so auto-MTF won't recreate it)
  app.delete('/api/v1/pair_levels/:id', async (req, res) => {
    await initializeBotTrades();
    const id = String(req.params.id);
    const pair = String(req.query.pair || 'ETH/USDT:USDT').toUpperCase();
    const timeframe = String(req.query.timeframe || botConfig.timeframe || '1h').toLowerCase();
    const existing = await getOrComputeMtfBotLevels(pair, timeframe);
    const removed = existing.find((l) => l.id === id);
    const next = existing.filter((l) => l.id !== id);
    for (const k of Array.from(botLevelsStore.keys())) {
      if (k === pair || k.startsWith(`${pair}_`)) {
        botLevelsStore.delete(k);
      }
    }
    botLevelsStore.set(`${pair}_${timeframe}`, next);
    sqliteDb.markBotLevelDeleted(id);
    appendLog(
      'freqtrade.bot.levels',
      'INFO',
      `[${pair}] Удален уровень бота ${removed ? `${removed.label} @ ${removed.price}$` : id}. Триггер уровня отменен.`
    );
    res.json({ pair, removed_id: id, levels: next });
  });

  // Clear all Bot Levels for a pair
  app.delete('/api/v1/pair_levels', async (req, res) => {
    await initializeBotTrades();
    const pair = String(req.query.pair || 'ETH/USDT:USDT').toUpperCase();
    for (const k of Array.from(botLevelsStore.keys())) {
      if (k === pair || k.startsWith(`${pair}_`)) {
        botLevelsStore.delete(k);
      }
    }
    sqliteDb.clearBotLevelsForPair(pair);
    appendLog('freqtrade.bot.levels', 'INFO', `[${pair}] Очищены все уровни бота на графике`);
    res.json({ pair, levels: [] });
  });

  // ============================================================================
  // TRADINGVIEW CHART DRAWINGS & PINNED MEASURE RULERS API (Persisted in trades.sqlite)
  // ============================================================================
  app.get('/api/v1/chart_drawings', (req, res) => {
    const pair = String(req.query.pair || 'ETH/USDT:USDT').toUpperCase();
    if (!chartDrawingsStore.has(pair)) {
      chartDrawingsStore.set(pair, sqliteDb.getChartDrawingsForPair(pair));
    }
    const drawings = chartDrawingsStore.get(pair) || [];
    res.json({ pair, drawings });
  });

  app.post('/api/v1/chart_drawings', (req, res) => {
    const { pair = 'ETH/USDT:USDT', tool, points, color = '#2962ff', text, locked = false } =
      req.body || {};
    const cleanPair = String(pair).toUpperCase();
    if (!tool || !Array.isArray(points) || points.length === 0) {
      res.status(400).json({ error: 'Invalid drawing payload' });
      return;
    }
    if (!chartDrawingsStore.has(cleanPair)) {
      chartDrawingsStore.set(cleanPair, sqliteDb.getChartDrawingsForPair(cleanPair));
    }
    const existing = chartDrawingsStore.get(cleanPair) || [];
    const newDrawing: ChartDrawingObject = {
      id: `drw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      pair: cleanPair,
      tool,
      points: points.map((pt: any) => ({
        timestamp: Number(pt.timestamp),
        price: roundPrice(Number(pt.price)),
      })),
      color: String(color),
      text: text ? String(text) : undefined,
      locked: Boolean(locked),
      created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    };
    existing.push(newDrawing);
    chartDrawingsStore.set(cleanPair, existing);
    sqliteDb.upsertChartDrawing(newDrawing);
    res.json({ pair: cleanPair, drawing: newDrawing, drawings: existing });
  });

  app.patch('/api/v1/chart_drawings/:id', (req, res) => {
    const id = String(req.params.id);
    const { pair = 'ETH/USDT:USDT', points, color, text, locked } = req.body || {};
    const cleanPair = String(pair).toUpperCase();
    if (!chartDrawingsStore.has(cleanPair)) {
      chartDrawingsStore.set(cleanPair, sqliteDb.getChartDrawingsForPair(cleanPair));
    }
    const existing = chartDrawingsStore.get(cleanPair) || [];
    const target = existing.find((d) => d.id === id);
    if (!target) {
      res.status(404).json({ error: 'Drawing not found' });
      return;
    }
    if (Array.isArray(points) && points.length > 0) {
      target.points = points.map((pt: any) => ({
        timestamp: Number(pt.timestamp),
        price: roundPrice(Number(pt.price)),
      }));
    }
    if (color !== undefined) target.color = String(color);
    if (text !== undefined) target.text = String(text);
    if (locked !== undefined) target.locked = Boolean(locked);
    sqliteDb.upsertChartDrawing(target);
    res.json({ pair: cleanPair, drawing: target, drawings: existing });
  });

  app.delete('/api/v1/chart_drawings/:id', (req, res) => {
    const id = String(req.params.id);
    const pair = String(req.query.pair || 'ETH/USDT:USDT').toUpperCase();
    if (!chartDrawingsStore.has(pair)) {
      chartDrawingsStore.set(pair, sqliteDb.getChartDrawingsForPair(pair));
    }
    const existing = chartDrawingsStore.get(pair) || [];
    const next = existing.filter((d) => d.id !== id);
    chartDrawingsStore.set(pair, next);
    sqliteDb.deleteChartDrawing(id);
    res.json({ pair, removed_id: id, drawings: next });
  });

  app.delete('/api/v1/chart_drawings', (req, res) => {
    const pair = String(req.query.pair || 'ETH/USDT:USDT').toUpperCase();
    chartDrawingsStore.set(pair, []);
    sqliteDb.clearChartDrawingsForPair(pair);
    res.json({ pair, drawings: [] });
  });

  // ============================================================================
  // MULTI-EXCHANGE API ACCOUNTS & CLIENT ACCESS MANAGEMENT
  // Supported Exchanges: Binance, Bybit, OKX, Bitget, BingX
  // ============================================================================
  app.get('/api/v1/accounts', async (_req, res) => {
    await initializeBotTrades();
    await syncRealExchangeBalancesIfNeeded(false);
    const masterOpen = tradesStore.filter(
      (t) => t.is_open && (!t.account_id || t.account_id === 'master')
    );
    const masterOpenPnl = masterOpen.reduce((acc, t) => acc + t.profit_abs, 0);

    const synced = exchangeAccountsStore.map((acc) => {
      if (!acc.enabled) {
        return {
          ...acc,
          open_trades_count: 0,
          unrealized_pnl: 0,
          status: 'paused' as const,
        };
      }
      if (acc.is_owner) {
        return {
          ...acc,
          open_trades_count: masterOpen.length,
          unrealized_pnl: Number(masterOpenPnl.toFixed(2)),
          status: 'connected' as const,
        };
      }
      const clientOpen = tradesStore.filter((t) => t.is_open && t.account_id === acc.id);
      const clientPnl = clientOpen.reduce((sum, t) => sum + t.profit_abs, 0);
      return {
        ...acc,
        open_trades_count: acc.copy_trading ? clientOpen.length : 0,
        unrealized_pnl: acc.copy_trading ? Number(clientPnl.toFixed(2)) : 0,
        status: 'connected' as const,
      };
    });
    res.json({ accounts: synced });
  });

  app.post('/api/v1/accounts', async (req, res) => {
    const {
      name,
      owner_label,
      exchange = 'bybit',
      market_type = 'futures',
      api_key,
      api_secret,
      passphrase,
      is_owner = false,
      copy_trading = true,
      copy_multiplier = 1.0,
      max_leverage = 25,
      balance_usdt,
      client_access_code,
      is_testnet = false,
    } = req.body || {};

    const validExchanges: SupportedExchange[] = ['binance', 'bybit', 'okx', 'bitget', 'bingx'];
    const cleanExchange: SupportedExchange = validExchanges.includes(exchange)
      ? exchange
      : 'bybit';

    if (!name || !api_key || !api_secret) {
      res.status(400).json({ error: 'Укажите название аккаунта, API Key и Secret Key' });
      return;
    }

    let resolvedBalanceUsdt = Number(balance_usdt);
    let resolvedIsTestnet = Boolean(is_testnet);
    let resolvedNetworkLabel: string | undefined;
    let liveCheckResult: any = null;

    // Для реальных API-ключей всегда проверяем подключение к бирже (с авто-определением Mainnet / Testnet / Demo и запросом реального баланса USDT)
    if (!isSimulatedTestApiKey(String(api_key))) {
      try {
        const liveCheck = await testExchangeConnection({
          exchange: cleanExchange,
          apiKey: String(api_key).trim(),
          apiSecret: String(api_secret).trim(),
          passphrase: passphrase ? String(passphrase).trim() : undefined,
          isTestnet: resolvedIsTestnet,
        });
        liveCheckResult = liveCheck;
        if (typeof liveCheck.is_testnet === 'boolean') {
          resolvedIsTestnet = liveCheck.is_testnet;
        }
        if (liveCheck.network_label) {
          resolvedNetworkLabel = liveCheck.network_label;
        }
        if (
          liveCheck.success &&
          typeof liveCheck.balance_usdt === 'number' &&
          liveCheck.balance_usdt > 0
        ) {
          resolvedBalanceUsdt = Number(liveCheck.balance_usdt.toFixed(2));
        }
        appendLog(
          'freqtrade.exchange.connect',
          liveCheck.success ? 'INFO' : 'WARNING',
          liveCheck.success
            ? `🔗 Успешное подключение к ${resolvedNetworkLabel || cleanExchange.toUpperCase()} (${String(name).trim()}): реальный баланс = ${resolvedBalanceUsdt > 0 ? resolvedBalanceUsdt.toFixed(2) : '0.00'} USDT | Пинг: ${liveCheck.latency_ms} мс`
            : `⚠️ Подключение API ${cleanExchange.toUpperCase()} (${String(name).trim()}): ${liveCheck.message}`
        );
      } catch {
        // ignore network timeout
      }
    }

    if (!Number.isFinite(resolvedBalanceUsdt) || resolvedBalanceUsdt <= 0) {
      resolvedBalanceUsdt = Number(balance_usdt) > 0 ? Number(balance_usdt) : 1000;
    }

    const cleanName = String(name).trim();
    const generatedCode =
      client_access_code && String(client_access_code).trim().length >= 4
        ? String(client_access_code).trim().toUpperCase()
        : `${cleanExchange.toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    // Защита от дублирования: если аккаунт с тем же кодом доступа или тем же именем и биржей уже существует — обновляем его
    const existingAcc = exchangeAccountsStore.find(
      (a) =>
        (client_access_code && a.client_access_code.toUpperCase() === generatedCode) ||
        (a.name.toLowerCase() === cleanName.toLowerCase() && a.exchange === cleanExchange)
    );

    // Если это первый подключенный аккаунт в системе и флаг is_owner не передан явно — назначаем его основным
    const effectiveIsOwner =
      req.body?.is_owner !== undefined
        ? Boolean(is_owner)
        : exchangeAccountsStore.length === 0;

    if (existingAcc) {
      existingAcc.name = cleanName;
      existingAcc.owner_label = owner_label ? String(owner_label).trim() : cleanName;
      existingAcc.exchange = cleanExchange;
      existingAcc.market_type = market_type === 'spot' ? 'spot' : 'futures';
      existingAcc.api_key_masked = maskApiKey(String(api_key));
      existingAcc.api_key_raw = String(api_key).trim();
      existingAcc.api_secret_raw = String(api_secret).trim();
      existingAcc.passphrase_raw = passphrase ? String(passphrase).trim() : '';
      existingAcc.has_passphrase = Boolean(passphrase && String(passphrase).trim().length > 0);
      existingAcc.is_owner = effectiveIsOwner;
      existingAcc.client_access_code = generatedCode;
      existingAcc.enabled = true;
      existingAcc.copy_trading = Boolean(copy_trading);
      existingAcc.copy_multiplier = Math.max(0.05, Math.min(20, Number(copy_multiplier) || 1.0));
      existingAcc.max_leverage = Math.max(1, Math.min(50, Math.round(Number(max_leverage) || 25)));
      if (resolvedBalanceUsdt > 0) {
        existingAcc.balance_usdt = resolvedBalanceUsdt;
      }
      existingAcc.is_testnet = resolvedIsTestnet;
      existingAcc.network_label = resolvedNetworkLabel;
      existingAcc.status = 'connected';
      existingAcc.last_sync = new Date().toISOString().replace('T', ' ').slice(0, 19);

      sqliteDb.upsertExchangeAccount(existingAcc);
      botConfig.state = 'running';

      if (!isSimulatedTestApiKey(String(api_key))) {
        runScalpBotCycle(false).catch(() => {});
      }

      res.json({
        account: existingAcc,
        accounts: exchangeAccountsStore,
        connection_check: liveCheckResult,
      });
      return;
    }

    const nowTs = Date.now();
    const newAcc: ExchangeAccountRecord = {
      id: `acc-${cleanExchange}-${nowTs}-${Math.random().toString(36).slice(2, 5)}`,
      name: cleanName,
      owner_label: owner_label ? String(owner_label).trim() : cleanName,
      exchange: cleanExchange,
      market_type: market_type === 'spot' ? 'spot' : 'futures',
      api_key_masked: maskApiKey(String(api_key)),
      api_key_raw: String(api_key).trim(),
      api_secret_raw: String(api_secret).trim(),
      passphrase_raw: passphrase ? String(passphrase).trim() : '',
      has_passphrase: Boolean(passphrase && String(passphrase).trim().length > 0),
      is_owner: effectiveIsOwner,
      client_access_code: generatedCode,
      enabled: true,
      copy_trading: Boolean(copy_trading),
      copy_multiplier: Math.max(0.05, Math.min(20, Number(copy_multiplier) || 1.0)),
      max_leverage: Math.max(1, Math.min(50, Math.round(Number(max_leverage) || 25))),
      balance_usdt: resolvedBalanceUsdt,
      unrealized_pnl: 0,
      open_trades_count: 0,
      status: 'connected',
      last_sync: new Date(nowTs).toISOString().replace('T', ' ').slice(0, 19),
      connected_at: nowTs,
      is_testnet: resolvedIsTestnet,
      network_label: resolvedNetworkLabel,
    };

    exchangeAccountsStore.push(newAcc);
    sqliteDb.upsertExchangeAccount(newAcc);
    botConfig.state = 'running';

    appendLog(
      'freqtrade.exchange.accounts',
      'INFO',
      `Подключен новый API-аккаунт: ${newAcc.name} (${resolvedNetworkLabel || `${cleanExchange.toUpperCase()} ${newAcc.market_type.toUpperCase()}`}) | Баланс: ${newAcc.balance_usdt.toFixed(2)} USDT | Ключ: ${newAcc.api_key_masked}`
    );

    if (!isSimulatedTestApiKey(String(api_key))) {
      await syncPositionsAndHistoryFromExchanges(newAcc);
      runScalpBotCycle(false).catch(() => {});
    }

    res.json({
      account: newAcc,
      accounts: exchangeAccountsStore,
      connection_check: liveCheckResult,
    });
  });

  app.patch('/api/v1/accounts/:id', (req, res) => {
    const id = String(req.params.id);
    const target = exchangeAccountsStore.find((a) => a.id === id);
    if (!target) {
      res.status(404).json({ error: 'Аккаунт не найден' });
      return;
    }
    const {
      name,
      enabled,
      copy_trading,
      copy_multiplier,
      max_leverage,
      balance_usdt,
      client_access_code,
    } = req.body || {};

    if (name !== undefined) target.name = String(name).trim();
    if (enabled !== undefined) {
      target.enabled = Boolean(enabled);
      target.status = target.enabled ? 'connected' : 'paused';
    }
    if (copy_trading !== undefined) target.copy_trading = Boolean(copy_trading);
    if (copy_multiplier !== undefined) {
      target.copy_multiplier = Math.max(0.05, Math.min(20, Number(copy_multiplier) || 1));
    }
    if (max_leverage !== undefined) {
      target.max_leverage = Math.max(1, Math.min(50, Math.round(Number(max_leverage) || 3)));
    }
    if (balance_usdt !== undefined && Number(balance_usdt) >= 0) {
      target.balance_usdt = Number(balance_usdt);
    }
    if (client_access_code !== undefined && String(client_access_code).trim()) {
      target.client_access_code = String(client_access_code).trim().toUpperCase();
    }
    target.last_sync = new Date().toISOString().replace('T', ' ').slice(0, 19);

    sqliteDb.upsertExchangeAccount(target);
    botConfig.state = hasConnectedExchangeAccount() ? 'running' : 'stopped';

    appendLog(
      'freqtrade.exchange.accounts',
      'INFO',
      `Обновлены параметры аккаунта ${target.name} (${target.exchange.toUpperCase()}): Активен=${target.enabled}, Копирование=${target.copy_trading} (×${target.copy_multiplier})`
    );
    res.json({ account: target, accounts: exchangeAccountsStore });
  });

  app.delete('/api/v1/accounts/:id', (req, res) => {
    const id = String(req.params.id);
    const target = exchangeAccountsStore.find((a) => a.id === id);
    exchangeAccountsStore = exchangeAccountsStore.filter((a) => a.id !== id);
    sqliteDb.deleteExchangeAccount(id);
    // Также удаляем открытые копии сделок удаленного клиентского аккаунта
    const clientTrades = tradesStore.filter((t) => t.account_id === id);
    for (const ct of clientTrades) {
      sqliteDb.deleteTrade(ct.trade_id);
    }
    tradesStore = tradesStore.filter((t) => t.account_id !== id);

    // Если больше нет ни одного активного аккаунта — останавливаем бота и очищаем незакрытые позиции
    if (!hasConnectedExchangeAccount()) {
      botConfig.state = 'stopped';
      for (const t of tradesStore) {
        if (t.is_open) sqliteDb.deleteTrade(t.trade_id);
      }
      tradesStore = tradesStore.filter((t) => !t.is_open);
    }

    if (target) {
      appendLog(
        'freqtrade.exchange.accounts',
        'WARNING',
        `Отключен и удален API-аккаунт: ${target.name} (${target.exchange.toUpperCase()})`
      );
    }
    res.json({ removed_id: id, accounts: exchangeAccountsStore });
  });

  app.delete('/api/v1/accounts', (req, res) => {
    const explicitUserClear = req.query.confirm === 'true';
    exchangeAccountsStore = [];
    sqliteDb.clearAllExchangeAccounts(explicitUserClear);
    botConfig.state = 'stopped';
    for (const t of tradesStore) {
      sqliteDb.deleteTrade(t.trade_id);
    }
    tradesStore = [];
    appendLog(
      'freqtrade.exchange.accounts',
      'WARNING',
      `База API-аккаунтов полностью очищена владельцем. Бот переведен в статус STOPPED.`
    );
    res.json({ accounts: [] });
  });

  app.post('/api/v1/accounts/test-connection', async (req, res) => {
    const { account_id, exchange, api_key, api_secret, passphrase, is_testnet } = req.body || {};
    let credsExchange = exchange;
    let credsKey = api_key;
    let credsSecret = api_secret;
    let credsPass = passphrase;
    let credsIsTestnet = is_testnet !== undefined ? Boolean(is_testnet) : undefined;
    let targetAcc: ExchangeAccountRecord | undefined;

    if (account_id) {
      const allAccs = sqliteDb.loadExchangeAccounts();
      const acc = allAccs.find((a) => a.id === account_id);
      targetAcc = exchangeAccountsStore.find((a) => a.id === account_id);
      if (acc) {
        credsExchange = acc.exchange;
        credsKey = acc.api_key_raw;
        credsSecret = acc.api_secret_raw;
        credsPass = acc.passphrase_raw;
        if (credsIsTestnet === undefined) {
          credsIsTestnet = Boolean(acc.is_testnet);
        }
      }
    }

    if (!credsKey || !credsSecret) {
      res.status(400).json({
        success: false,
        exchange: String(credsExchange || 'bybit'),
        latency_ms: 0,
        permissions: [],
        message: 'Для проверки соединения необходимы реальные API Key и Secret Key',
        live_verified: false,
      });
      return;
    }

    const testRes = await testExchangeConnection({
      exchange: credsExchange || 'bybit',
      apiKey: String(credsKey),
      apiSecret: String(credsSecret),
      passphrase: credsPass ? String(credsPass) : undefined,
      isTestnet: credsIsTestnet,
    });

    if (targetAcc && testRes.success) {
      if (typeof testRes.is_testnet === 'boolean') {
        targetAcc.is_testnet = testRes.is_testnet;
      }
      if (testRes.network_label) {
        targetAcc.network_label = testRes.network_label;
      }
      if (typeof testRes.balance_usdt === 'number' && testRes.balance_usdt > 0) {
        targetAcc.balance_usdt = Number(testRes.balance_usdt.toFixed(2));
      }
      targetAcc.status = 'connected';
      targetAcc.last_sync = new Date().toISOString().replace('T', ' ').slice(0, 19);
      sqliteDb.upsertExchangeAccount(targetAcc);
      runScalpBotCycle(false).catch(() => {});
    }

    appendLog(
      'freqtrade.exchange.test',
      testRes.success ? 'INFO' : 'WARNING',
      `Тестирование API ${String(credsExchange).toUpperCase()}${targetAcc ? ` (${targetAcc.name})` : ''}: ${testRes.message}`
    );

    res.json(testRes);
  });

  app.get('/api/v1/client/dashboard', async (req, res) => {
    await initializeBotTrades();
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const verified = token ? sqliteDb.verifyAuthToken(token) : { valid: false };

    const codeParam = String(req.query.code || req.query.client || '').trim().toUpperCase();
    let acc = codeParam ? sqliteDb.verifyClientAccessCode(codeParam) : null;
    if (!acc && verified.valid && verified.accountId) {
      acc = exchangeAccountsStore.find((a) => a.id === verified.accountId) || null;
    }
    if (!acc && exchangeAccountsStore.length > 0) {
      acc = exchangeAccountsStore.find((a) => !a.is_owner) || exchangeAccountsStore[0];
    }

    if (!acc) {
      res.status(404).json({ error: 'Аккаунт клиента не найден по указанному коду доступа' });
      return;
    }

    // Изолированные сделки клиента: строго принадлежащие этому аккаунту (без слепого копирования старых сделок владельца)
    const clientOpenTrades = tradesStore.filter(
      (t) => t.is_open && t.account_id === acc.id
    );
    const clientClosedTrades = tradesStore.filter(
      (t) => !t.is_open && t.account_id === acc.id
    );

    const clientUnrealizedPnl = Number(
      clientOpenTrades.reduce((sum, t) => sum + t.profit_abs, 0).toFixed(2)
    );
    const clientTotalProfit = Number(
      clientClosedTrades.reduce((sum, t) => sum + t.profit_abs, 0).toFixed(2)
    );
    const winningTrades = clientClosedTrades.filter((t) => t.profit_abs >= 0).length;
    const winrate =
      clientClosedTrades.length > 0
        ? Number(((winningTrades / clientClosedTrades.length) * 100).toFixed(1))
        : 100;

    const { compoundedBalance: clientCompoundedBalance } = getCompoundedAccountBalance(acc.id);

    res.json({
      account: {
        id: acc.id,
        name: acc.name,
        exchange: acc.exchange,
        balance_usdt: clientCompoundedBalance,
        open_trades_count: clientOpenTrades.length,
        unrealized_pnl: clientUnrealizedPnl,
        copy_trading: Boolean(acc.copy_trading),
        stake_pct: 0.5,
        leverage: acc.max_leverage || 25,
        last_sync: acc.last_sync,
      },
      open_trades: clientOpenTrades,
      closed_trades: clientClosedTrades,
      total_profit_usdt: clientTotalProfit,
      winrate,
      current_pair: clientOpenTrades[0]?.pair || tradesStore[0]?.pair || 'ETH/USDT:USDT',
    });
  });

  app.post('/api/v1/forceexit', async (req, res) => {
    const scope = resolveRequestAccountScope(req);
    const { tradeid } = req.body || {};
    if (tradeid === 'all') {
      const now = Date.now();
      const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
      const targetTrades = filterTradesForScope(scope.accountId);
      let closedCount = 0;
      let skippedNegativeCount = 0;
      const tradesToClose: FreqtradeTrade[] = [];
      for (const t of targetTrades) {
        if (t.is_open) {
          recalculateTradeMetrics(t, false);
          if ((t.net_profit ?? t.profit_abs) <= 0) {
            skippedNegativeCount++;
            sqliteDb.upsertTrade(t);
            continue;
          }
          const tAccId = t.account_id || 'master';
          const closeRes = await dispatchOrderToExchangeAccount(tAccId, {
            pair: t.pair,
            isShort: t.is_short,
            action: 'CLOSE',
            quantity: t.amount,
            leverage: t.leverage || 25,
            referencePrice: t.current_rate,
          });
          const tCreds = getAccountCredentialsFromStore(tAccId);
          if (tCreds && !isSimulatedTestApiKey(tCreds.apiKey) && (!closeRes || !closeRes.success)) {
            continue;
          }
          tradesToClose.push(t);
        }
      }

      sqliteDb.runInTransaction(() => {
        for (const t of tradesToClose) {
          t.is_open = false;
          t.close_date = nowStr;
          t.close_timestamp = now;
          t.close_rate = t.current_rate;
          t.exit_reason = 'force_exit';
          t.planned_dca_levels = [];
          recalculateTradeMetrics(t, false);
          sqliteDb.upsertTrade(t);
          sqliteDb.recordOrder({
            trade_id: t.trade_id,
            pair: t.pair,
            order_type: 'market',
            side: t.is_short ? 'buy' : 'sell',
            price: t.current_rate,
            amount: t.amount,
            cost: Number((t.current_rate * t.amount).toFixed(4)),
            fee: t.fee_close || 0,
            realized_pnl: t.net_profit || t.profit_abs,
            action_type: 'FORCE_EXIT',
            notes: 'Force exit all profitable trades',
          });
          if (!t.account_id || t.account_id === 'master') {
            closeClientCopiesForMasterTrade(t, t.current_rate, now, nowStr, 'force_exit');
          }
          closedCount++;
        }
      });
      if (closedCount === 0 && skippedNegativeCount > 0) {
        res.status(400).json({
          error: `Защита от закрытия в минус: все открытые сделки (${skippedNegativeCount} шт.) сейчас находятся в минусе с учетом комиссии 0.06%. Бот удерживает их до выхода в чистый плюс через усреднение (DCA).`,
          closed_count: 0,
          protected_count: skippedNegativeCount,
        });
        return;
      }
      res.json({
        result: `Закрыто плюсовых сделок: ${closedCount}. Защищено от закрытия в минус: ${skippedNegativeCount}.`,
        closed_count: closedCount,
        protected_count: skippedNegativeCount,
      });
      return;
    }

    const id = Number(tradeid);
    const trade = tradesStore.find((t) => t.trade_id === id && t.is_open);
    if (!trade) {
      res.status(404).json({ error: `Open trade #${id} not found` });
      return;
    }

    recalculateTradeMetrics(trade, false);
    const netProfitUsdt = trade.net_profit ?? trade.profit_abs;
    if (netProfitUsdt <= 0) {
      appendLog(
        'freqtrade.bot.guard',
        'WARNING',
        `🛡️ Заблокировано закрытие сделки #${id} [${trade.pair}] в минус (${netProfitUsdt}$ с учетом комиссии 0.06% = ${trade.fee_total}$). Точка безубытка: ${trade.breakeven_price}$.`
      );
      res.status(400).json({
        error: `Запрещено закрывать сделку #${id} (${trade.pair}) в минус! Текущий чистый PnL с учетом комиссии биржи 0.06% ($${trade.fee_total}): ${netProfitUsdt}$ (${trade.net_profit_percent}%). Точка безубытка: ${trade.breakeven_price}$, мин. плюсовой TP: ${trade.min_profitable_tp}$. Используйте усреднение (DCA) или дождитесь выхода в плюс.`,
        net_profit: netProfitUsdt,
        fee_total: trade.fee_total,
        breakeven_price: trade.breakeven_price,
        min_profitable_tp: trade.min_profitable_tp,
      });
      return;
    }

    // Отправка реального ордера закрытия на биржу
    const targetAccId = trade.account_id || 'master';
    const closeOrderRes = await dispatchOrderToExchangeAccount(targetAccId, {
      pair: trade.pair,
      isShort: trade.is_short,
      action: 'CLOSE',
      quantity: trade.amount,
      leverage: trade.leverage || 25,
      referencePrice: trade.current_rate,
    });
    const targetCreds = getAccountCredentialsFromStore(targetAccId);
    if (
      targetCreds &&
      !isSimulatedTestApiKey(targetCreds.apiKey) &&
      (!closeOrderRes || !closeOrderRes.success)
    ) {
      res.status(400).json({
        error:
          closeOrderRes?.error ||
          `Биржа отклонила закрытие сделки #${id} (${trade.pair}).`,
      });
      return;
    }

    const closeTs =
      closeOrderRes?.exchange_time && closeOrderRes.exchange_time > 0
        ? closeOrderRes.exchange_time
        : Date.now();
    const closeDateStr = new Date(closeTs).toISOString().replace('T', ' ').slice(0, 19);
    sqliteDb.runInTransaction(() => {
      trade.is_open = false;
      trade.close_date = closeDateStr;
      trade.close_timestamp = closeTs;
      trade.close_rate =
        closeOrderRes?.success && closeOrderRes.price > 0
          ? roundPrice(closeOrderRes.price)
          : trade.current_rate;
      if (closeOrderRes?.commission_usdt && closeOrderRes.commission_usdt > 0) {
        trade.fee_close = Number(closeOrderRes.commission_usdt.toFixed(4));
      }
      trade.exit_reason = 'force_exit';
      trade.planned_dca_levels = [];
      recalculateTradeMetrics(trade, false);
      sqliteDb.upsertTrade(trade);
      sqliteDb.recordOrder({
        trade_id: trade.trade_id,
        pair: trade.pair,
        order_type: 'market',
        side: trade.is_short ? 'buy' : 'sell',
        price: trade.close_rate,
        amount: trade.amount,
        cost: Number((trade.close_rate * trade.amount).toFixed(4)),
        fee: trade.fee_close || 0,
        realized_pnl: trade.net_profit || trade.profit_abs,
        action_type: 'FORCE_EXIT',
        notes: `Manual force exit in net profit (+${trade.profit_abs} USDT after ${trade.fee_total} USDT fees)${closeOrderRes?.order_id ? ` | ExOrderId: ${closeOrderRes.order_id}` : ''}`,
      });
      if (!trade.account_id || trade.account_id === 'master') {
        closeClientCopiesForMasterTrade(trade, trade.close_rate, closeTs, closeDateStr, 'force_exit');
      }
    });
    appendLog(
      'freqtrade.rpc.rpc',
      'INFO',
      `Закрыта сделка #${id} (${trade.pair}) @ ${trade.close_rate} $ | Чистый итог: +${trade.profit_abs} $ (комиссия 0.06%: ${trade.fee_total}$)`
    );
    res.json({ result: `Closed trade #${id}`, trade });
  });

  app.delete('/api/v1/trades/:id', (req, res) => {
    const id = Number(req.params.id);
    tradesStore = tradesStore.filter((t) => t.trade_id !== id);
    sqliteDb.deleteTrade(id);
    res.json({ result_msg: `Deleted trade #${id}` });
  });

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: {
          server: httpServer,
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`FreqtradeUI Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
