import React, { useState, useEffect } from 'react';
import { RefreshCw, Server, Terminal, CheckCircle2, AlertCircle } from 'lucide-react';

interface DataPipelineViewProps {
  selectedPair: string;
  timeframe: string;
  strategy: string;
}

const API_ENDPOINTS = [
  {
    id: 'pair_candles',
    label: 'GET /api/v1/pair_candles',
    desc: 'Главный эндпоинт для графиков: возвращает сериализованный Pandas DataFrame со свечами OHLCV, рассчитанными индикаторами (EMA, BB, RSI, MACD) и колонками сигналов enter_long / exit_long.',
  },
  {
    id: 'status',
    label: 'GET /api/v1/status',
    desc: 'Возвращает список текущих открытых сделок бота с актуальной ценой current_rate, текущим P&L, уровнем stoploss_abs и списком биржевых ордеров.',
  },
  {
    id: 'profit',
    label: 'GET /api/v1/profit',
    desc: 'Агрегированная статистика доходности портфеля: закрытый и общий P&L, Winrate, мат. ожидание (Expectancy), лучшая пара и максимальная просадка.',
  },
  {
    id: 'whitelist',
    label: 'GET /api/v1/whitelist',
    desc: 'Активный список пар (Pairlist) после прохождения цепочки фильтров VolumePairList -> AgeFilter -> PriceFilter -> SpreadFilter.',
  },
  {
    id: 'balance',
    label: 'GET /api/v1/balance',
    desc: 'Балансы кошелька на бирже: свободные средства (free), заблокированные в открытых позициях (used) и оценка портфеля в USDT.',
  },
  {
    id: 'show_config',
    label: 'GET /api/v1/show_config',
    desc: 'Текущая конфигурация Freqtrade: активная стратегия, таймфрейм, таблица Minimal ROI, Stoploss, Trailing Stop и состояние воркера.',
  },
];

export const DataPipelineView: React.FC<DataPipelineViewProps> = ({
  selectedPair,
  timeframe,
  strategy,
}) => {
  const [selectedEndpoint, setSelectedEndpoint] = useState<string>('pair_candles');
  const [jsonPreview, setJsonPreview] = useState<string>('Загрузка живого ответа API...');
  const [loadingJson, setLoadingJson] = useState<boolean>(false);

  // External Freqtrade connection tester state
  const [extUrl, setExtUrl] = useState('http://127.0.0.1:8080');
  const [extUsername, setExtUsername] = useState('freqtrader');
  const [extPassword, setExtPassword] = useState('');
  const [extStatus, setExtStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testingExt, setTestingExt] = useState(false);

  const fetchLiveEndpointPreview = async (epId: string) => {
    setLoadingJson(true);
    try {
      const url =
        epId === 'pair_candles'
          ? `/api/v1/pair_candles?pair=${encodeURIComponent(selectedPair)}&timeframe=${timeframe}&strategy=${strategy}&limit=8`
          : `/api/v1/${epId}`;
      const token = localStorage.getItem('scalpbot_auth_token') || '';
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const data = await res.json();
      setJsonPreview(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setJsonPreview(`Ошибка запроса: ${err?.message || String(err)}`);
    } finally {
      setLoadingJson(false);
    }
  };

  useEffect(() => {
    fetchLiveEndpointPreview(selectedEndpoint);
  }, [selectedEndpoint, selectedPair, timeframe, strategy]);

  const handleTestExternal = async (e: React.FormEvent) => {
    e.preventDefault();
    setTestingExt(true);
    setExtStatus(null);
    try {
      const res = await fetch('/api/v1/external_proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: extUrl,
          endpoint: '/api/v1/ping',
          username: extUsername,
          password: extPassword,
        }),
      });
      const data = await res.json();
      if (res.ok && data?.status === 'pong') {
        setExtStatus({
          ok: true,
          msg: `Успешный ответ от ${extUrl}/api/v1/ping: {"status": "pong"}`,
        });
      } else {
        setExtStatus({
          ok: false,
          msg: data?.details || data?.error || `Сервер вернул статус ${res.status}`,
        });
      }
    } catch (err: any) {
      setExtStatus({
        ok: false,
        msg: err?.message || 'Ошибка соединения',
      });
    } finally {
      setTestingExt(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Section 1: Detailed Architectural Breakdown of Where FreqUI Gets Chart Data */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6">
        <h2 className="text-lg font-display font-bold text-slate-900 dark:text-slate-100 mb-2">
          Откуда FreqUI берёт данные для реальных графиков и как устроен конвейер данных
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-6">
          Сам по себе фронтенд <strong>FreqUI</strong> (`freqtrade/frequi`) <strong>не ходит напрямую на биржу</strong> из браузера.
          Он подключается по HTTP REST и WebSocket к встроенному в бота серверу <strong>Freqtrade API Server (`api_server`, FastAPI)</strong>.
          Именно поэтому на графике в FreqUI видны не просто «голые» свечи с биржи, а точный <strong>DataFrame вашей стратегии</strong> со всеми индикаторами и точками входа/выхода:
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
          <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <div className="font-mono font-semibold text-sky-600 dark:text-sky-400 mb-1.5">
              01. Биржа (CCXT / Binance / Bybit / Kraken)
            </div>
            <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
              Ядро Freqtrade через библиотеку <code>ccxt</code> (метод <code>fetch_ohlcv</code> и WebSocket-стримы) запрашивает реальные исторические и живые свечи <code>[timestamp, open, high, low, close, volume]</code> у выбранной биржи. В этом приложении сервер напрямую забирает реальные рыночные свечи с публичного зеркала <code>data-api.binance.vision</code> (и Kraken в качестве резерва).
            </p>
          </div>

          <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <div className="font-mono font-semibold text-emerald-600 dark:text-emerald-400 mb-1.5">
              02. Стратегия и Pandas DataFrame
            </div>
            <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
              Полученные свечи передаются в Python-класс активной стратегии: вызываются <code>populate_indicators()</code>, <code>populate_entry_trend()</code> и <code>populate_exit_trend()</code>. В таблицу добавляются колонки индикаторов (<code>ema_20</code>, <code>bb_lowerband</code>, <code>rsi</code>, <code>macd</code>) и сигналы (<code>enter_long</code>, <code>enter_tag</code>, <code>exit_long</code>).
            </p>
          </div>

          <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <div className="font-mono font-semibold text-amber-600 dark:text-amber-400 mb-1.5">
              03. Эндпоинт /api/v1/pair_candles
            </div>
            <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
              Когда вы открываете график в FreqUI, фронтенд запрашивает <code>GET /api/v1/pair_candles?pair=BTC/USDT&amp;timeframe=5m</code> (или <code>/api/v1/pair_history</code> в режиме бэктеста). Сервер возвращает компактный JSON с массивом названий колонок <code>columns: [...]</code> и матрицей значений <code>data: [[...], [...]]</code>.
            </p>
          </div>

          <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <div className="font-mono font-semibold text-purple-600 dark:text-purple-400 mb-1.5">
              04. Отрисовка в FreqUI (CandleChart)
            </div>
            <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
              Компонент <code>CandleChartContainer</code> в FreqUI совмещает 3 потока данных на одном полотне:
              1) свечи и индикаторы из <code>/api/v1/pair_candles</code>,
              2) маркеры сигналов стратегии <code>▲ enter_long / ▼ exit_long</code>,
              3) реальные ордера и линию <code>stoploss</code> из <code>/api/v1/status</code> и <code>/api/v1/trades</code>.
            </p>
          </div>
        </div>
      </div>

      {/* Section 2: Live Interactive REST API Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Terminal className="w-4 h-4 text-sky-500" />
              <span>Живой инспектор эндпоинтов Freqtrade API</span>
            </h3>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Выберите любой REST-маршрут ниже, чтобы увидеть реальный JSON-ответ нашего встроенного сервера Freqtrade (пара: {selectedPair}, ТФ: {timeframe}):
          </p>

          <div className="space-y-2">
            {API_ENDPOINTS.map((ep) => {
              const active = selectedEndpoint === ep.id;
              return (
                <button
                  key={ep.id}
                  type="button"
                  onClick={() => setSelectedEndpoint(ep.id)}
                  className={`w-full text-left p-3 rounded-lg border transition-colors ${
                    active
                      ? 'bg-sky-50/90 dark:bg-sky-950/40 border-sky-500'
                      : 'bg-slate-50/60 dark:bg-slate-950/60 border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800/50'
                  }`}
                >
                  <div className="font-mono text-xs font-semibold text-slate-900 dark:text-slate-100">
                    {ep.label}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                    {ep.desc}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Live JSON Output Panel */}
        <div className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-950/40">
            <div className="font-mono text-xs font-semibold text-slate-800 dark:text-slate-200">
              Ответ сервера: /api/v1/{selectedEndpoint}
            </div>
            <button
              type="button"
              onClick={() => fetchLiveEndpointPreview(selectedEndpoint)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-200/80 dark:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-700"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingJson ? 'animate-spin' : ''}`} />
              <span>Повторить запрос</span>
            </button>
          </div>
          <pre className="flex-1 p-4 bg-slate-950 text-emerald-300 font-mono text-xs overflow-auto max-h-[460px] leading-relaxed">
            {jsonPreview}
          </pre>
        </div>
      </div>

      {/* Section 3: How to Enable api_server in Your Own Freqtrade config.json + External Bot Tester */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-2">
            Как включить REST API и FreqUI в вашем собственном config.json
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
            Чтобы ваш локальный или серверный бот Freqtrade отдавал свечи и сделки в FreqUI, в секции <code>api_server</code> файла <code>config.json</code> должны быть прописаны следующие настройки:
          </p>
          <pre className="p-4 rounded bg-slate-950 text-sky-300 font-mono text-xs overflow-x-auto leading-relaxed">
{`{
  "max_open_trades": 20,
  "stake_currency": "USDT",
  "stake_amount": 25,
  "dry_run": false,
  "exchange": {
    "name": "binance",
    "pair_whitelist": ["BTC/USDT", "ETH/USDT", "SOL/USDT"]
  },
  "api_server": {
    "enabled": true,
    "listen_ip_address": "0.0.0.0",
    "listen_port": 8080,
    "verbosity": "info",
    "enable_openapi": true,
    "jwt_secret_key": "your-random-jwt-secret",
    "CORS_origins": ["*"],
    "username": "freqtrader",
    "password": "SuperSecurePassword"
  }
}`}
          </pre>
        </div>

        <div className="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Server className="w-4 h-4 text-sky-500" />
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Проверка подключения к внешнему Freqtrade API
              </h3>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
              По умолчанию сейчас работает встроенный сервер с реальными котировками Binance. Если у вас поднят свой экземпляр Freqtrade с публичным IP/туннелем, вы можете протестировать связь через серверный прокси:
            </p>

            <form onSubmit={handleTestExternal} className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-500 dark:text-slate-400 mb-1">
                  URL сервера Freqtrade API
                </label>
                <input
                  type="text"
                  value={extUrl}
                  onChange={(e) => setExtUrl(e.target.value)}
                  placeholder="https://my-freqtrade-bot.example.com:8080"
                  className="w-full px-3 py-1.5 font-mono rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-slate-500 dark:text-slate-400 mb-1">
                    Имя пользователя
                  </label>
                  <input
                    type="text"
                    value={extUsername}
                    onChange={(e) => setExtUsername(e.target.value)}
                    className="w-full px-3 py-1.5 font-mono rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-500 dark:text-slate-400 mb-1">
                    Пароль API
                  </label>
                  <input
                    type="password"
                    value={extPassword}
                    onChange={(e) => setExtPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full px-3 py-1.5 font-mono rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={testingExt}
                className="w-full py-2 rounded-md bg-sky-600 hover:bg-sky-500 text-white font-medium transition-colors disabled:opacity-50"
              >
                {testingExt ? 'Проверка /api/v1/ping...' : 'Проверить соединение (/api/v1/ping)'}
              </button>
            </form>

            {extStatus && (
              <div
                className={`mt-3 p-3 rounded border text-xs flex items-start gap-2 ${
                  extStatus.ok
                    ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300'
                    : 'bg-rose-50 dark:bg-rose-950/40 border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300'
                }`}
              >
                {extStatus.ok ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                )}
                <span className="font-mono">{extStatus.msg}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
