import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  DollarSign,
  LayoutGrid,
  LineChart,
  List,
  Sun,
  RotateCw,
  ChevronDown,
  Check,
  Key,
  ShieldCheck,
} from 'lucide-react';
import {
  PairCandlesResponse,
  FreqtradeTrade,
  ProfitSummary,
  DailyRecord,
  BalanceResponse,
  WhitelistResponse,
  PairPerformance,
  PairLock,
  BotLogEntry,
  BotConfig,
  PlotConfig,
  BotChartLevel,
  ChartDrawingObject,
  ExchangeAccount,
  parseDataframeToCandles,
} from './types/frequi';
import { TradeView, RightPanelSection } from './components/TradeView';
import { DashboardView } from './components/DashboardView';
import { CandleChart, TradeLevelUpdatePayload, QuickOrderFromChartPayload } from './components/CandleChart';
import { PairlistLogsView } from './components/PairlistLogsView';
import { ExchangeAccountsView } from './components/ExchangeAccountsView';
import { OfflineIndicator } from './components/PWAInstallButton';
import { SiteLoginScreen, SiteSettingsModal, AuthSessionState } from './components/SiteAuthGate';

type ActiveRoute = 'trade' | 'dashboard' | 'chart' | 'accounts' | 'logs';

// Official Freqtrade Robot Emblem SVG matching the top-left logo in all screenshots
const FreqtradeLogoSVG: React.FC = () => (
  <svg viewBox="0 0 36 36" className="w-7 h-7 shrink-0">
    <circle cx="18" cy="18" r="16.5" fill="#13171d" stroke="#cfd6df" strokeWidth="1.5" />
    {/* Antenna */}
    <line x1="18" y1="3.5" x2="18" y2="7.5" stroke="#00b4d8" strokeWidth="1.8" />
    <circle cx="18" cy="3" r="1.6" fill="#00b4d8" />
    {/* Robot Head */}
    <rect x="10.5" y="7.5" width="15" height="9.5" rx="2.5" fill="#e2e8f0" stroke="#00b4d8" strokeWidth="1.2" />
    <circle cx="14.5" cy="12" r="1.6" fill="#0f172a" />
    <circle cx="21.5" cy="12" r="1.6" fill="#0f172a" />
    {/* Ears */}
    <rect x="8" y="10" width="2" height="4.5" rx="1" fill="#00b4d8" />
    <rect x="26" y="10" width="2" height="4.5" rx="1" fill="#00b4d8" />
    {/* Robot Body with Bitcoin B */}
    <rect x="9.5" y="18.5" width="17" height="12" rx="3" fill="#00a8b5" stroke="#e2e8f0" strokeWidth="1.2" />
    <text x="18" y="27.2" textAnchor="middle" fill="#ffffff" fontSize="9.5" fontWeight="bold" fontFamily="monospace">
      ₿
    </text>
  </svg>
);

export default function App() {
  const [authToken, setAuthToken] = useState<string>(() => {
    try {
      return localStorage.getItem('scalpbot_auth_token') || '';
    } catch {
      return '';
    }
  });
  const [authState, setAuthState] = useState<AuthSessionState>({
    loading: true,
    require_login: true,
    password_changed: false,
    owner_login: 'admin',
    authenticated: false,
    role: 'owner',
    login: 'admin',
  });
  const [showSiteSettingsModal, setShowSiteSettingsModal] = useState<boolean>(false);

  const [activeRoute, setActiveRoute] = useState<ActiveRoute>('trade');
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [dynamicUpdate, setDynamicUpdate] = useState<boolean>(true);

  const [selectedPair, setSelectedPair] = useState<string>(() => {
    try {
      return localStorage.getItem('scalpbot_selected_pair') || 'ETH/USDT:USDT';
    } catch {
      return 'ETH/USDT:USDT';
    }
  });
  const [timeframe, setTimeframe] = useState<string>(() => {
    try {
      return localStorage.getItem('scalpbot_timeframe') || '1h';
    } catch {
      return '1h';
    }
  });
  const [strategy, setStrategy] = useState<string>('ScalpingStrategy');

  useEffect(() => {
    try {
      if (selectedPair) localStorage.setItem('scalpbot_selected_pair', selectedPair);
    } catch {
      // ignore storage error
    }
  }, [selectedPair]);

  useEffect(() => {
    try {
      if (timeframe) localStorage.setItem('scalpbot_timeframe', timeframe);
    } catch {
      // ignore storage error
    }
  }, [timeframe]);

  const [botConfig, setBotConfig] = useState<BotConfig | null>(null);
  const [dataframe, setDataframe] = useState<PairCandlesResponse | null>(null);
  const [openTrades, setOpenTrades] = useState<FreqtradeTrade[]>([]);
  const [closedTrades, setClosedTrades] = useState<FreqtradeTrade[]>([]);
  const [, setProfit] = useState<ProfitSummary | null>(null);
  const [daily, setDaily] = useState<DailyRecord[]>([]);
  const [balance, setBalance] = useState<BalanceResponse | null>(null);
  const [whitelist, setWhitelist] = useState<WhitelistResponse | null>(null);
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [performance, setPerformance] = useState<PairPerformance[]>([]);
  const [locks, setLocks] = useState<PairLock[]>([]);
  const [logs, setLogs] = useState<BotLogEntry[]>([]);
  const [botLevels, setBotLevels] = useState<BotChartLevel[]>([]);
  const [drawings, setDrawings] = useState<ChartDrawingObject[]>([]);

  // Подключённые API-аккаунты владельца и людей (Binance, Bybit, OKX, Bitget, BingX)
  const [accounts, setAccounts] = useState<ExchangeAccount[]>([]);

  const [loadingChart, setLoadingChart] = useState<boolean>(false);

  // Force Entry Modal State
  const [showForceEnterModal, setShowForceEnterModal] = useState<boolean>(false);
  const [forcePair, setForcePair] = useState<string>('ETH/USDT:USDT');
  const [forceSide, setForceSide] = useState<'long' | 'short'>('long');
  const [forceStake, setForceStake] = useState<number>(25);
  const [forceLeverage, setForceLeverage] = useState<number>(25);
  const [submittingForce, setSubmittingForce] = useState<boolean>(false);

  // Right panel active section & notification banner for automatic trade movement
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelSection>('open');
  const [statusNotification, setStatusNotification] = useState<string | null>(null);

  // Plot Config with TradingView indicators & quick order buttons
  const [plotConfig, setPlotConfig] = useState<PlotConfig>({
    showCandles: true,
    showVolume: true,
    showEntry: true,
    showExit: true,
    showTrades: true,
    showChartAreas: true,
    heikinAshi: false,
    showEma20: false,
    showEma50: false,
    showSma200: false,
    showBollinger: false,
    showVwap: false,
    showVolumeProfile: false,
    showRsi: false,
    showMacd: false,
    showQuickOrderButtons: true,
  });

  const candleAbortRef = useRef<AbortController | null>(null);

  const fetchCandles = useCallback(
    async (pairArg = selectedPair, tfArg = timeframe, stratArg = strategy) => {
      if (candleAbortRef.current) {
        candleAbortRef.current.abort();
      }
      const controller = new AbortController();
      candleAbortRef.current = controller;
      setLoadingChart(true);
      try {
        const res = await fetch(
          `/api/v1/pair_candles?pair=${encodeURIComponent(pairArg)}&timeframe=${encodeURIComponent(tfArg)}&strategy=${encodeURIComponent(stratArg)}&limit=1000`,
          { signal: controller.signal }
        );
        if (res.ok && !controller.signal.aborted) {
          const data: PairCandlesResponse = await res.json();
          if (!controller.signal.aborted) {
            setDataframe(data);
          }
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          console.error('Failed to fetch pair_candles:', err);
        }
      } finally {
        if (candleAbortRef.current === controller) {
          setLoadingChart(false);
        }
      }
    },
    [selectedPair, timeframe, strategy]
  );

  const lastLevelMutationTsRef = useRef<number>(0);

  const fetchPairBotLevels = useCallback(
    async (pairArg = selectedPair, tfArg = timeframe) => {
      const reqStartTs = Date.now();
      if (reqStartTs - lastLevelMutationTsRef.current < 2500) {
        return;
      }
      try {
        const res = await fetch(
          `/api/v1/pair_levels?pair=${encodeURIComponent(pairArg)}&timeframe=${encodeURIComponent(tfArg)}`
        );
        if (res.ok) {
          const data = await res.json();
          if (reqStartTs >= lastLevelMutationTsRef.current && Date.now() - lastLevelMutationTsRef.current >= 1500) {
            setBotLevels(data.levels || []);
          }
        }
      } catch (err) {
        console.error('Failed to fetch pair_levels:', err);
      }
    },
    [selectedPair, timeframe]
  );

  const fetchPairDrawings = useCallback(
    async (pairArg = selectedPair) => {
      try {
        const res = await fetch(`/api/v1/chart_drawings?pair=${encodeURIComponent(pairArg)}`);
        if (res.ok) {
          const data = await res.json();
          setDrawings(data.drawings || []);
        }
      } catch (err) {
        console.error('Failed to fetch chart_drawings:', err);
      }
    },
    [selectedPair]
  );

  const restoringVaultRef = useRef<boolean>(false);

  const fetchAccounts = useCallback(async () => {
    if (authState.role !== 'owner') {
      setAccounts([]);
      return;
    }
    try {
      const res = await fetch('/api/v1/accounts', {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        const serverAccounts: ExchangeAccount[] = data.accounts || [];
        if (serverAccounts.length === 0 && !restoringVaultRef.current) {
          try {
            const rawVault = localStorage.getItem('scalpbot_saved_accounts_vault_v1');
            const vaultItems = rawVault ? JSON.parse(rawVault) : [];
            if (Array.isArray(vaultItems) && vaultItems.length > 0) {
              restoringVaultRef.current = true;
              let latestAccounts: ExchangeAccount[] = [];
              for (const item of vaultItems) {
                if (item && item.api_key && item.api_secret) {
                  const restoreRes = await fetch('/api/v1/accounts', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
                    },
                    body: JSON.stringify(item),
                  });
                  if (restoreRes.ok) {
                    const restoreData = await restoreRes.json();
                    if (Array.isArray(restoreData.accounts)) {
                      latestAccounts = restoreData.accounts;
                    }
                  }
                }
              }
              restoringVaultRef.current = false;
              if (latestAccounts.length > 0) {
                setAccounts(latestAccounts);
                return;
              }
            }
          } catch {
            restoringVaultRef.current = false;
          }
        }
        setAccounts(serverAccounts);
      }
    } catch (err) {
      console.error('Failed to fetch accounts:', err);
    }
  }, [authState.role, authToken]);

  const fetchBotState = useCallback(async () => {
    const reqStartTs = Date.now();
    try {
      const authHeaders: Record<string, string> = authToken
        ? { Authorization: `Bearer ${authToken}` }
        : {};
      const [
        cfgRes,
        statusRes,
        tradesRes,
        profitRes,
        dailyRes,
        balRes,
        wlRes,
        blRes,
        perfRes,
        locksRes,
        logsRes,
      ] = await Promise.all([
        fetch('/api/v1/show_config', { headers: authHeaders }),
        fetch('/api/v1/status', { headers: authHeaders }),
        fetch('/api/v1/trades', { headers: authHeaders }),
        fetch('/api/v1/profit', { headers: authHeaders }),
        fetch('/api/v1/daily', { headers: authHeaders }),
        fetch('/api/v1/balance', { headers: authHeaders }),
        fetch('/api/v1/whitelist', { headers: authHeaders }),
        fetch('/api/v1/blacklist', { headers: authHeaders }),
        fetch('/api/v1/performance', { headers: authHeaders }),
        fetch('/api/v1/locks', { headers: authHeaders }),
        fetch('/api/v1/logs', { headers: authHeaders }),
      ]);

      if (cfgRes.ok) setBotConfig(await cfgRes.json());
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        if (
          reqStartTs >= lastLevelMutationTsRef.current &&
          Date.now() - lastLevelMutationTsRef.current >= 1500
        ) {
          setOpenTrades(statusData);
        }
      }
      if (tradesRes.ok) {
        const td = await tradesRes.json();
        setClosedTrades(td.trades || []);
      }
      if (profitRes.ok) setProfit(await profitRes.json());
      if (dailyRes.ok) {
        const dd = await dailyRes.json();
        setDaily(dd.data || []);
      }
      if (balRes.ok) setBalance(await balRes.json());
      if (wlRes.ok) setWhitelist(await wlRes.json());
      if (blRes.ok) {
        const bd = await blRes.json();
        setBlacklist(bd.blacklist || []);
      }
      if (perfRes.ok) setPerformance(await perfRes.json());
      if (locksRes.ok) {
        const ld = await locksRes.json();
        setLocks(ld.locks || []);
      }
      if (logsRes.ok) {
        const lg = await logsRes.json();
        setLogs(lg.logs || []);
      }
    } catch (err) {
      console.error('Error syncing Freqtrade state:', err);
    }
  }, [authToken]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const inviteToken = params.get('invite') || '';
        const clientCode = params.get('client') || params.get('code') || '';
        let statusUrl = '/api/v1/auth/status';
        if (inviteToken) {
          statusUrl += `?invite=${encodeURIComponent(inviteToken)}`;
        } else if (clientCode) {
          statusUrl += `?client=${encodeURIComponent(clientCode)}`;
        }

        const res = await fetch(statusUrl, {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
        });
        if (res.ok && !cancelled) {
          const data = await res.json();
          if (data.token) {
            try {
              localStorage.setItem('scalpbot_auth_token', String(data.token));
            } catch {
              // ignore storage error
            }
            setAuthToken(String(data.token));
            // Clean ?invite=... or ?client=... from address bar after successful authentication
            if ((inviteToken || clientCode) && window.history?.replaceState) {
              params.delete('invite');
              params.delete('client');
              params.delete('code');
              const nextSearch = params.toString();
              const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}`;
              window.history.replaceState({}, '', nextUrl);
            }
          }
          setAuthState({
            loading: false,
            require_login: Boolean(data.require_login),
            password_changed: Boolean(data.password_changed),
            has_env_secrets: Boolean(data.has_env_secrets),
            owner_login: String(data.owner_login || 'admin'),
            authenticated: Boolean(data.authenticated),
            role: data.role === 'client' ? 'client' : 'owner',
            login: String(data.login || data.owner_login || 'admin'),
            account_id: data.account_id,
            client_code: data.client_code || clientCode,
          });
        } else if (!cancelled) {
          setAuthState((prev) => ({ ...prev, loading: false }));
        }
      } catch {
        if (!cancelled) {
          setAuthState((prev) => ({ ...prev, loading: false }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authToken]);

  const fetchCandlesRef = useRef(fetchCandles);
  useEffect(() => {
    fetchCandlesRef.current = fetchCandles;
  }, [fetchCandles]);

  useEffect(() => {
    if (authState.loading || (authState.require_login && !authState.authenticated)) return;
    fetchBotState();
    fetchAccounts();
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchBotState();
      fetchCandlesRef.current();
      fetchAccounts();
    }, 10000);
    return () => clearInterval(interval);
  }, [authState.loading, authState.require_login, authState.authenticated, autoRefresh, fetchBotState, fetchAccounts]);

  useEffect(() => {
    if (authState.loading || (authState.require_login && !authState.authenticated)) return;
    fetchCandles(selectedPair, timeframe, strategy);
    fetchPairBotLevels(selectedPair, timeframe);
    fetchPairDrawings(selectedPair);
    fetch('/api/v1/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeframe, strategy }),
    }).catch(() => {});
  }, [authState.loading, authState.require_login, authState.authenticated, selectedPair, timeframe, strategy, fetchCandles, fetchPairBotLevels, fetchPairDrawings]);

  const parsedCandles = useMemo(
    () => parseDataframeToCandles(dataframe),
    [dataframe]
  );

  const availablePairs = useMemo(
    () =>
      whitelist?.whitelist || [
        'ETH/USDT:USDT',
        'DOT/USDT:USDT',
        'AVAX/USDT:USDT',
        'LINK/USDT:USDT',
        'XRP/USDT:USDT',
        'BTC/USDT:USDT',
        'SOL/USDT:USDT',
        'DOGE/USDT:USDT',
        'ADA/USDT:USDT',
      ],
    [whitelist]
  );

  const handleBotCommand = async (endpoint: 'start' | 'stop' | 'stopbuy' | 'reload_config') => {
    const res = await fetch(`/api/v1/${endpoint}`, { method: 'POST' });
    if (!res.ok) {
      try {
        const errData = await res.json();
        if (errData?.error) {
          setStatusNotification(`⚠️ ${errData.error}`);
        }
      } catch {
        // ignore parse error
      }
    }
    await fetchBotState();
    if (endpoint === 'reload_config') {
      await fetchCandles();
    }
  };

  const handleForceExit = async (tradeId: number | 'all') => {
    const res = await fetch('/api/v1/forceexit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tradeid: tradeId }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setRightPanelTab('closed');
      if (data.trade) {
        const sign = data.trade.profit_abs >= 0 ? '+' : '';
        setStatusNotification(
          `${data.trade.pair.split('/')[0]}: Close (${sign}${data.trade.profit_abs}$) ➔ Закрытые`
        );
      } else {
        setStatusNotification(data.result || 'All profitable trades ➔ Закрытые');
      }
    } else if (data.error) {
      setStatusNotification(`🛡️ ${data.error}`);
    }
    await fetchBotState();
  };

  const handleAverageTrade = async (tradeId: number) => {
    const res = await fetch('/api/v1/dca', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tradeid: tradeId }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.trade) {
        setSelectedPair(data.trade.pair);
        setRightPanelTab('averaged');
        setStatusNotification(
          `${data.trade.pair.split('/')[0]}: DCA ×${data.trade.dca_count} (${data.previous_open_rate}$ ➔ ${data.new_open_rate}$) ➔ Усреднённые`
        );
      }
    }
    await fetchBotState();
    await fetchCandles();
  };

  const handleUpdateTradeLevel = async (payload: TradeLevelUpdatePayload) => {
    lastLevelMutationTsRef.current = Date.now();
    // Optimistic update so the dragged level stays at the exact dropped price without snapping back
    setOpenTrades((prev) =>
      prev.map((t) => {
        if (t.trade_id !== payload.tradeId) return t;
        if (payload.levelType === 'tp') {
          return { ...t, take_profit_abs: payload.price, tp_manual_override: true };
        }
        if (payload.levelType === 'sl') {
          return { ...t, stop_loss_abs: payload.price, sl_manual_override: true };
        }
        if (payload.levelType === 'dca') {
          const targetStep = Number(payload.step) || (t.dca_count || 0) + 1;
          const nextPlanned = (t.planned_dca_levels || []).map((lvl) =>
            lvl.step === targetStep
              ? { ...lvl, price: payload.price, manual_override: true }
              : lvl
          );
          return {
            ...t,
            dca_manual_override: true,
            next_dca_price: targetStep === (t.dca_count || 0) + 1 ? payload.price : t.next_dca_price,
            planned_dca_levels: nextPlanned,
          };
        }
        return t;
      })
    );

    const res = await fetch('/api/v1/trade_levels', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tradeid: payload.tradeId,
        level_type: payload.levelType,
        step: payload.step,
        price: payload.price,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const updatedTrade: FreqtradeTrade | undefined = data.trade;
      if (updatedTrade) {
        lastLevelMutationTsRef.current = Date.now();
        setOpenTrades((prev) =>
          prev.map((t) => (t.trade_id === updatedTrade.trade_id ? updatedTrade : t))
        );
        const lvlName =
          payload.levelType === 'tp'
            ? 'TP'
            : payload.levelType === 'sl'
            ? 'SL'
            : `DCA ${payload.step || 1}`;
        if (data.clamped_to_breakeven && data.warning) {
          setStatusNotification(`🛡️ ${data.warning}`);
        } else {
          setStatusNotification(
            `Бот обновил ${lvlName} по ${updatedTrade.pair.split('/')[0]}: ${data.previous_price}$ ➔ ${data.new_price}$ (бот отталкивается от вашего уровня)`
          );
        }
      }
    }
  };

  const handleUpdateBotLevel = async (id: string, price: number) => {
    lastLevelMutationTsRef.current = Date.now();
    // Optimistic update so the dragged SUP/RES level stays immediately at the dropped price
    setBotLevels((prev) =>
      prev.map((lvl) => (lvl.id === id ? { ...lvl, price, manual_override: true } : lvl))
    );

    const res = await fetch('/api/v1/pair_levels', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pair: selectedPair, timeframe, id, price }),
    });
    if (res.ok) {
      const data = await res.json();
      lastLevelMutationTsRef.current = Date.now();
      if (data.levels) setBotLevels(data.levels);
      if (data.level) {
        setStatusNotification(
          `Бот обновил уровень ${data.level.label} (${selectedPair.split('/')[0]}): ${data.previous_price}$ ➔ ${data.level.price}$`
        );
      }
    }
  };

  const handleAddBotLevel = async (price: number) => {
    const res = await fetch('/api/v1/pair_levels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pair: selectedPair, timeframe, price }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.levels) setBotLevels(data.levels);
      if (data.level) {
        setStatusNotification(
          `Добавлен уровень бота ${data.level.label} @ ${data.level.price}$ (${selectedPair.split('/')[0]})`
        );
      }
    }
    await fetchBotState();
  };

  const handleDeleteBotLevel = async (id: string) => {
    const res = await fetch(
      `/api/v1/pair_levels/${encodeURIComponent(id)}?pair=${encodeURIComponent(selectedPair)}&timeframe=${encodeURIComponent(timeframe)}`,
      { method: 'DELETE' }
    );
    if (res.ok) {
      const data = await res.json();
      setBotLevels(data.levels || []);
      setStatusNotification(
        `Удалён уровень бота (${selectedPair.split('/')[0]}) — бот больше не использует его`
      );
    }
    await fetchBotState();
  };

  const handleClearAllBotLevels = async () => {
    const res = await fetch(`/api/v1/pair_levels?pair=${encodeURIComponent(selectedPair)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      setBotLevels([]);
      setStatusNotification(`Все уровни бота (LVL) по ${selectedPair.split('/')[0]} удалены`);
    }
    await fetchBotState();
  };

  const handleAddDrawing = async (drawing: Omit<ChartDrawingObject, 'id' | 'created_at'>) => {
    const res = await fetch('/api/v1/chart_drawings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(drawing),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.drawings) setDrawings(data.drawings);
      if (drawing.tool === 'ruler') {
        setStatusNotification('Линейка зафиксирована на графике (удаление по кнопке × на замере)');
      }
    }
  };

  const handleUpdateDrawing = async (id: string, patch: Partial<ChartDrawingObject>) => {
    setDrawings((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    const res = await fetch(`/api/v1/chart_drawings/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...patch, pair: selectedPair }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.drawings) setDrawings(data.drawings);
    }
  };

  const handleDeleteDrawing = async (id: string) => {
    const res = await fetch(
      `/api/v1/chart_drawings/${encodeURIComponent(id)}?pair=${encodeURIComponent(selectedPair)}`,
      { method: 'DELETE' }
    );
    if (res.ok) {
      const data = await res.json();
      setDrawings(data.drawings || []);
    }
  };

  const handleClearAllDrawings = async () => {
    const res = await fetch(`/api/v1/chart_drawings?pair=${encodeURIComponent(selectedPair)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      setDrawings([]);
      setStatusNotification(`Все рисунки и линейки по ${selectedPair.split('/')[0]} очищены`);
    }
  };

  const handleQuickOrderFromChart = async (payload: QuickOrderFromChartPayload) => {
    const res = await fetch('/api/v1/forceenter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pair: payload.pair,
        side: payload.side,
        price: payload.price,
        stakeamount: forceStake,
        leverage: forceLeverage,
        take_profit_abs: payload.take_profit_abs,
        stop_loss_abs: payload.stop_loss_abs,
      }),
    });
    if (res.ok) {
      const trade = await res.json();
      setSelectedPair(trade.pair);
      setRightPanelTab('open');
      setStatusNotification(
        `${trade.pair.split('/')[0]}: ${trade.is_short ? 'SHORT' : 'LONG'} ${
          trade.leverage
        }x открыт с графика (TP ${trade.take_profit_abs}$ · без SL, 2 стороны + DCA)`
      );
      await fetchBotState();
      await fetchCandles(trade.pair, timeframe, strategy);
    } else {
      try {
        const errData = await res.json();
        if (errData?.error) {
          setStatusNotification(`⚠️ ${errData.error}`);
        }
      } catch {
        // ignore
      }
    }
  };

  // Обработчики раздела API / Клиенты (только для владельца)
  const handleAddAccount = async (
    payload: Partial<ExchangeAccount> & { api_key?: string; api_secret?: string; passphrase?: string }
  ) => {
    const res = await fetch('/api/v1/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.accounts) setAccounts(data.accounts);
      try {
        if (payload.api_key && payload.api_secret) {
          const rawPayload = payload as Record<string, any>;
          const rawVault = localStorage.getItem('scalpbot_saved_accounts_vault_v1');
          const vaultItems = rawVault ? JSON.parse(rawVault) : [];
          const list = Array.isArray(vaultItems) ? vaultItems : [];
          const createdId = data.account?.id;
          const nextList = list.filter(
            (item: any) =>
              item.api_key !== payload.api_key && (!createdId || item.id !== createdId)
          );
          nextList.push({
            id: createdId,
            name: payload.name,
            exchange: payload.exchange,
            market_type: payload.market_type,
            network_mode: rawPayload.network_mode,
            is_testnet: payload.is_testnet,
            api_key: payload.api_key,
            api_secret: payload.api_secret,
            passphrase: payload.passphrase,
            subaccount: rawPayload.subaccount,
            is_owner: payload.is_owner,
            enabled: payload.enabled ?? true,
            max_leverage: payload.max_leverage,
            copy_trading: payload.copy_trading,
            balance_usdt: data.account?.balance_usdt ?? payload.balance_usdt,
            client_access_code: payload.client_access_code,
          });
          localStorage.setItem('scalpbot_saved_accounts_vault_v1', JSON.stringify(nextList));
        }
      } catch {
        // ignore storage error
      }
      await fetchBotState();
      return data;
    }
    return undefined;
  };

  const handleToggleAccount = async (id: string, enabled: boolean) => {
    const res = await fetch(`/api/v1/accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.accounts) setAccounts(data.accounts);
      try {
        const rawVault = localStorage.getItem('scalpbot_saved_accounts_vault_v1');
        const vaultItems = rawVault ? JSON.parse(rawVault) : [];
        if (Array.isArray(vaultItems)) {
          const nextList = vaultItems.map((item: any) =>
            item.id === id ? { ...item, enabled } : item
          );
          localStorage.setItem('scalpbot_saved_accounts_vault_v1', JSON.stringify(nextList));
        }
      } catch {
        // ignore
      }
      await fetchBotState();
    }
  };

  const handleDeleteAccount = async (id: string) => {
    try {
      const targetAcc = accounts.find((a) => a.id === id);
      const rawVault = localStorage.getItem('scalpbot_saved_accounts_vault_v1');
      const vaultItems = rawVault ? JSON.parse(rawVault) : [];
      if (Array.isArray(vaultItems)) {
        const nextList = vaultItems.filter(
          (item: any) => item.id !== id && (!targetAcc || item.name !== targetAcc.name)
        );
        localStorage.setItem('scalpbot_saved_accounts_vault_v1', JSON.stringify(nextList));
      }
    } catch {
      // ignore
    }
    const res = await fetch(`/api/v1/accounts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      const data = await res.json();
      if (data.accounts) setAccounts(data.accounts);
      await fetchBotState();
    }
  };

  const handleClearAllAccounts = async () => {
    try {
      localStorage.removeItem('scalpbot_saved_accounts_vault_v1');
    } catch {
      // ignore
    }
    const res = await fetch('/api/v1/accounts?confirm=true', {
      method: 'DELETE',
    });
    if (res.ok) {
      setAccounts([]);
      await fetchBotState();
    }
  };

  const handleDeleteTrade = async (tradeId: number) => {
    await fetch(`/api/v1/trades/${tradeId}`, { method: 'DELETE' });
    await fetchBotState();
  };

  const handleOpenForceEnterModal = (defaultPair?: string) => {
    setForcePair(defaultPair || selectedPair);
    setShowForceEnterModal(true);
  };

  const handleForceEnterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittingForce(true);
    try {
      const res = await fetch('/api/v1/forceenter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pair: forcePair,
          side: forceSide,
          stakeamount: Number(forceStake),
          leverage: Number(forceLeverage),
        }),
      });
      if (res.ok) {
        const trade = await res.json();
        setShowForceEnterModal(false);
        setSelectedPair(trade.pair);
        setRightPanelTab('open');
        setStatusNotification(
          `${trade.pair.split('/')[0]}: ${trade.is_short ? 'SHORT' : 'LONG'} ${trade.leverage}x ➔ Открытые`
        );
        await fetchBotState();
        await fetchCandles(trade.pair, timeframe, strategy);
      } else {
        try {
          const errData = await res.json();
          if (errData?.error) {
            setStatusNotification(`⚠️ ${errData.error}`);
            setShowForceEnterModal(false);
          }
        } catch {
          // ignore
        }
      }
    } finally {
      setSubmittingForce(false);
    }
  };

  if (authState.loading) {
    return <div className="min-h-screen w-full bg-[#0b0d10]" />;
  }

  if (authState.require_login && !authState.authenticated) {
    return (
      <>
        <SiteLoginScreen
          authState={authState}
          onLoginSuccess={(token, nextState) => {
            try {
              localStorage.setItem('scalpbot_auth_token', token);
            } catch {
              // ignore storage error
            }
            setAuthToken(token);
            setAuthState((prev) => ({
              ...prev,
              ...nextState,
              authenticated: true,
            }));
          }}
        />
        <OfflineIndicator />
      </>
    );
  }

  return (
    <div className="h-screen max-h-screen overflow-hidden flex flex-col bg-[#141619] text-[#e2e8f0] font-sans">
      <OfflineIndicator />
      {/* =====================================================================
          ШАПКА FREQTRADEUI НА РУССКОМ ЯЗЫКЕ
      ===================================================================== */}
      <header className="h-[44px] px-3 bg-[#1c1f24] border-b border-[#0d99a6] flex items-center justify-between select-none shrink-0">
        {/* Слева: Логотип + FreqtradeUI + Навигация */}
        <div className="flex items-center gap-6">
          <button
            type="button"
            onClick={() => setActiveRoute('trade')}
            className="flex items-center gap-2 focus:outline-none"
          >
            <FreqtradeLogoSVG />
            <span className="text-[16px] font-bold tracking-tight text-white">
              Freqtrade<span className="text-[#00a8b5]">UI</span>
            </span>
          </button>

          <nav className="flex items-center gap-5 text-[13px]">
            <button
              type="button"
              onClick={() => setActiveRoute('trade')}
              className={`inline-flex items-center gap-1.5 transition-colors ${
                activeRoute === 'trade'
                  ? 'text-[#00b4d8] font-medium'
                  : 'text-[#9ca3af] hover:text-[#e2e8f0]'
              }`}
            >
              <DollarSign className="w-3.5 h-3.5" />
              <span>Торговля</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveRoute('dashboard')}
              className={`inline-flex items-center gap-1.5 transition-colors ${
                activeRoute === 'dashboard'
                  ? 'text-[#00b4d8] font-medium'
                  : 'text-[#9ca3af] hover:text-[#e2e8f0]'
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span>Дашборд</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveRoute('chart')}
              className={`inline-flex items-center gap-1.5 transition-colors ${
                activeRoute === 'chart'
                  ? 'text-[#00b4d8] font-medium'
                  : 'text-[#9ca3af] hover:text-[#e2e8f0]'
              }`}
            >
              <LineChart className="w-3.5 h-3.5" />
              <span>График</span>
            </button>

            {authState.role === 'owner' && (
              <button
                type="button"
                onClick={() => setActiveRoute('accounts')}
                className={`inline-flex items-center gap-1.5 transition-colors ${
                  activeRoute === 'accounts'
                    ? 'text-[#00b4d8] font-medium'
                    : 'text-[#9ca3af] hover:text-[#e2e8f0]'
                }`}
              >
                <Key className="w-3.5 h-3.5" />
                <span>API / Клиенты</span>
                {accounts.length > 0 && (
                  <span className="px-1.5 py-0.2 rounded-full bg-[#00b4d8]/20 border border-[#00b4d8]/50 text-[#38bdf8] text-[10px] font-mono">
                    {accounts.filter((a) => a.enabled).length}
                  </span>
                )}
              </button>
            )}

            <button
              type="button"
              onClick={() => setActiveRoute('logs')}
              className={`inline-flex items-center gap-1.5 transition-colors ${
                activeRoute === 'logs'
                  ? 'text-[#00b4d8] font-medium'
                  : 'text-[#9ca3af] hover:text-[#e2e8f0]'
              }`}
            >
              <List className="w-3.5 h-3.5" />
              <span>Журнал</span>
            </button>

            {authState.role === 'owner' && (
              <button
                type="button"
                onClick={() => setShowSiteSettingsModal(true)}
                title="Управление ссылками доступа и секретами владельца"
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#252a32] hover:bg-[#2f3640] border border-[#343a44] text-[11px] text-[#38bdf8] ml-1"
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span className="hidden md:inline">Доступ / Ссылки</span>
              </button>
            )}
          </nav>
        </div>

        {/* Справа: Статус бота и профиль владельца / клиента */}
        <div className="flex items-center gap-2.5">
          <div className="text-[11px] leading-[1.15] text-right text-[#cfd6df] hidden sm:block">
            <div>scalp-</div>
            <div>bot</div>
          </div>

          {/* Переключатель автообновления */}
          <button
            type="button"
            onClick={() => setAutoRefresh((v) => !v)}
            className={`w-9 h-5 rounded-full p-0.5 transition-colors flex items-center ${
              autoRefresh ? 'bg-[#00b4d8] justify-end' : 'bg-[#374151] justify-start'
            }`}
            title="Автоматическое обновление данных"
          >
            <span className="w-4 h-4 rounded-full bg-[#1e293b] block" />
          </button>

          {/* Зелёный индикатор онлайна */}
          <span className="w-3 h-3 rounded-full bg-[#10b981] inline-block" title="Бот в сети" />

          {/* Чекбокс динамического обновления */}
          <button
            type="button"
            onClick={() => setDynamicUpdate((v) => !v)}
            className={`w-4 h-4 rounded-[3px] flex items-center justify-center ml-1 ${
              dynamicUpdate ? 'bg-[#0ea5e9] text-[#090d11]' : 'border border-[#4b5563]'
            }`}
            title="Динамическое обновление свечей"
          >
            {dynamicUpdate && <Check className="w-3 h-3 stroke-[3]" />}
          </button>

          {/* Кнопка обновления всех данных */}
          <button
            type="button"
            onClick={() => {
              fetchBotState();
              fetchCandles();
            }}
            className="w-7 h-7 rounded-[4px] bg-[#21252b] hover:bg-[#2c313a] border border-[#383e48] flex items-center justify-center text-[#cfd6df]"
            title="Обновить все данные"
          >
            <RotateCw className={`w-3.5 h-3.5 ${loadingChart ? 'animate-spin' : ''}`} />
          </button>

          {/* Профиль владельца / клиента */}
          {authState.role === 'owner' ? (
            <button
              type="button"
              onClick={() => setShowSiteSettingsModal(true)}
              className="inline-flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-full bg-[#252a32] hover:bg-[#2f3640] border border-[#343a44] text-[11px] text-[#e2e8f0]"
              title="Настройки доступа, пароль владельца и ссылка на сайт"
            >
              <span className="w-5 h-5 rounded-full bg-[#00a8b5] text-[#090d11] flex items-center justify-center font-bold text-[10px]">
                OWN
              </span>
              <ChevronDown className="w-3 h-3 text-[#9ca3af]" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                try {
                  localStorage.removeItem('scalpbot_auth_token');
                } catch {
                  // ignore storage error
                }
                setAuthToken('');
                setAuthState({
                  loading: false,
                  require_login: true,
                  password_changed: false,
                  owner_login: 'admin',
                  authenticated: false,
                  role: 'owner',
                  login: 'admin',
                });
                if (window.history?.replaceState) {
                  window.history.replaceState({}, '', window.location.pathname);
                }
              }}
              className="inline-flex items-center gap-1.5 pl-2 pr-2.5 py-1 rounded-full bg-[#252a32] hover:bg-[#2f3640] border border-[#343a44] text-[11px] text-[#e2e8f0]"
              title={`Аккаунт клиента: ${authState.login} — нажмите для выхода`}
            >
              <span className="w-5 h-5 rounded-full bg-[#0ea5e9] text-[#090d11] flex items-center justify-center font-bold text-[10px]">
                CLI
              </span>
              <span className="hidden md:inline max-w-[110px] truncate">{authState.login}</span>
              <span className="text-[#9ca3af] text-[10px]">Выход</span>
            </button>
          )}
        </div>
      </header>

      {/* =====================================================================
          ОСНОВНОЙ РОУТЕР ВКЛАДОК
      ===================================================================== */}
      <main
        className={`flex-1 min-h-0 flex flex-col ${
          activeRoute === 'trade' || activeRoute === 'chart'
            ? 'overflow-hidden'
            : 'overflow-y-auto'
        }`}
      >
        {/* ВКЛАДКА 1: Торговля */}
        {activeRoute === 'trade' && (
          <TradeView
            selectedPair={selectedPair}
            onSelectPair={setSelectedPair}
            timeframe={timeframe}
            onSelectTimeframe={setTimeframe}
            strategy={strategy}
            exchangeSource={dataframe?.exchange_source}
            candles={parsedCandles}
            openTrades={openTrades}
            closedTrades={closedTrades}
            botLevels={botLevels}
            drawings={drawings}
            balance={balance}
            whitelist={whitelist}
            blacklist={blacklist}
            performance={performance}
            daily={daily}
            locks={locks}
            botConfig={botConfig}
            plotConfig={plotConfig}
            onChangePlotConfig={setPlotConfig}
            onBotCommand={handleBotCommand}
            onForceExit={handleForceExit}
            onAverageTrade={handleAverageTrade}
            onUpdateTradeLevel={handleUpdateTradeLevel}
            onUpdateBotLevel={handleUpdateBotLevel}
            onAddBotLevel={handleAddBotLevel}
            onDeleteBotLevel={handleDeleteBotLevel}
            onClearAllBotLevels={handleClearAllBotLevels}
            onAddDrawing={handleAddDrawing}
            onUpdateDrawing={handleUpdateDrawing}
            onDeleteDrawing={handleDeleteDrawing}
            onClearAllDrawings={handleClearAllDrawings}
            onQuickOrderFromChart={handleQuickOrderFromChart}
            onDeleteTrade={handleDeleteTrade}
            onOpenForceEnterModal={handleOpenForceEnterModal}
            onRefresh={() => {
              fetchCandles();
              fetchBotState();
              fetchPairBotLevels();
              fetchPairDrawings();
            }}
            loadingChart={loadingChart}
            rightPanelTab={rightPanelTab}
            onChangeRightPanelTab={setRightPanelTab}
            statusNotification={statusNotification}
          />
        )}

        {/* ВКЛАДКА 2: Дашборд */}
        {activeRoute === 'dashboard' && (
          <DashboardView
            openTrades={openTrades}
            closedTrades={closedTrades}
            accounts={accounts}
            balance={balance}
            botConfig={botConfig}
            onJumpToPair={(pair) => {
              setSelectedPair(pair);
              setActiveRoute('trade');
            }}
            onForceExit={(id) => handleForceExit(id)}
          />
        )}

        {/* ВКЛАДКА 3: Полноэкранный График */}
        {activeRoute === 'chart' && (
          <div className="flex-1 min-h-0 h-full max-h-full overflow-hidden bg-[#131722] flex flex-col">
            <CandleChart
              pair={selectedPair}
              availablePairs={availablePairs}
              pairMetrics={whitelist?.pair_metrics}
              onSelectPair={setSelectedPair}
              timeframe={timeframe}
              onSelectTimeframe={setTimeframe}
              strategy={strategy}
              exchangeSource={dataframe?.exchange_source}
              candles={parsedCandles}
              trades={[...openTrades, ...closedTrades]}
              botLevels={botLevels}
              drawings={drawings}
              plotConfig={plotConfig}
              onChangePlotConfig={setPlotConfig}
              onRefresh={() => {
                fetchCandles();
                fetchPairBotLevels();
                fetchPairDrawings();
              }}
              onUpdateTradeLevel={handleUpdateTradeLevel}
              onUpdateBotLevel={handleUpdateBotLevel}
              onAddBotLevel={handleAddBotLevel}
              onDeleteBotLevel={handleDeleteBotLevel}
              onClearAllBotLevels={handleClearAllBotLevels}
              onAddDrawing={handleAddDrawing}
              onUpdateDrawing={handleUpdateDrawing}
              onDeleteDrawing={handleDeleteDrawing}
              onClearAllDrawings={handleClearAllDrawings}
              onQuickOrderFromChart={handleQuickOrderFromChart}
              loading={loadingChart}
            />
          </div>
        )}

        {/* ВКЛАДКА 4: API / Клиенты (только для владельца: кого добавляем + секретные ключи) */}
        {activeRoute === 'accounts' && (
          <ExchangeAccountsView
            accounts={accounts}
            onAddAccount={handleAddAccount}
            onToggleAccount={handleToggleAccount}
            onDeleteAccount={handleDeleteAccount}
            onClearAllAccounts={handleClearAllAccounts}
            onRefreshAccounts={async () => {
              await fetchAccounts();
              await fetchBotState();
            }}
          />
        )}

        {/* ВКЛАДКА 5: Журнал работы бота и подключений к биржам */}
        {activeRoute === 'logs' && (
          <div className="p-4 space-y-4 bg-[#141619]">
            <PairlistLogsView
              logs={logs}
              accounts={accounts}
              botConfig={botConfig}
              openTradesCount={openTrades.length}
              onRefreshLogs={() => {
                fetchBotState();
                fetchAccounts();
              }}
            />
          </div>
        )}
      </main>

      {/* Модальное окно ручного открытия сделки */}
      {showForceEnterModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-[#1c2026] border border-[#323842] rounded-[4px] max-w-md w-full p-4 shadow-xl text-xs">
            <div className="flex items-center justify-between pb-2.5 border-b border-[#2e343c]">
              <h3 className="text-sm font-semibold text-white">
                Открыть новую сделку (добавится в «Открытые сделки» и на график)
              </h3>
              <button
                type="button"
                onClick={() => setShowForceEnterModal(false)}
                className="text-[#9ca3af] hover:text-white"
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleForceEnterSubmit} className="mt-3 space-y-3">
              <div>
                <label className="block text-[#9ca3af] mb-1">Торговая пара</label>
                <select
                  value={forcePair}
                  onChange={(e) => setForcePair(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-[#141619] border border-[#323842] rounded text-white"
                >
                  {availablePairs.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[#9ca3af] mb-1">Сторона сделки</label>
                  <div className="grid grid-cols-2 gap-1">
                    <button
                      type="button"
                      onClick={() => setForceSide('long')}
                      className={`py-1.5 rounded font-medium ${
                        forceSide === 'long'
                          ? 'bg-[#1fa866] text-white'
                          : 'bg-[#141619] border border-[#323842] text-[#9ca3af]'
                      }`}
                    >
                      Лонг
                    </button>
                    <button
                      type="button"
                      onClick={() => setForceSide('short')}
                      className={`py-1.5 rounded font-medium ${
                        forceSide === 'short'
                          ? 'bg-[#dc3545] text-white'
                          : 'bg-[#141619] border border-[#323842] text-[#9ca3af]'
                      }`}
                    >
                      Шорт
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-[#9ca3af] mb-1">Сумма ($ USDT)</label>
                  <input
                    type="number"
                    value={forceStake}
                    onChange={(e) => setForceStake(Number(e.target.value))}
                    className="w-full px-2.5 py-1.5 bg-[#141619] border border-[#323842] rounded text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[#9ca3af] mb-1">Плечо</label>
                  <select
                    value={forceLeverage}
                    onChange={(e) => setForceLeverage(Number(e.target.value))}
                    className="w-full px-2.5 py-1.5 bg-[#141619] border border-[#323842] rounded text-white font-mono"
                  >
                    {[1, 2, 3, 5, 10, 20, 25].map((lev) => (
                      <option key={lev} value={lev}>
                        {lev}x
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowForceEnterModal(false)}
                  className="px-3 py-1.5 rounded bg-[#2a2f37] text-[#cfd6df]"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={submittingForce}
                  className="px-3 py-1.5 rounded bg-[#00a8b5] text-[#090d11] font-semibold"
                >
                  {submittingForce ? 'Открытие...' : 'Открыть сделку'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Модальное окно настроек сайта, пароля владельца и деплоя 24/7 */}
      <SiteSettingsModal
        isOpen={showSiteSettingsModal}
        onClose={() => setShowSiteSettingsModal(false)}
        authState={authState}
        token={authToken}
        onUpdated={(next, nextToken) => {
          setAuthState((prev) => ({ ...prev, ...next }));
          if (nextToken) {
            try {
              localStorage.setItem('scalpbot_auth_token', nextToken);
            } catch {
              // ignore
            }
            setAuthToken(nextToken);
          }
        }}
        onLogout={() => {
          try {
            localStorage.removeItem('scalpbot_auth_token');
          } catch {
            // ignore
          }
          setAuthToken('');
          setShowSiteSettingsModal(false);
          setAuthState((prev) => ({
            ...prev,
            authenticated: false,
            require_login: true,
          }));
        }}
      />
    </div>
  );
}

