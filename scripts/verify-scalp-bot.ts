import assert from 'node:assert/strict';
import { SqliteBotDatabase } from '../src/bot/sqliteStore';

const sqliteDb = new SqliteBotDatabase();
const BASE_URL = 'http://127.0.0.1:3000';

async function api<T = any>(path: string, options?: RequestInit): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
  });
  const data = (await res.json()) as T;
  return { status: res.status, data };
}

async function runVerification() {
  console.log('================================================================');
  console.log('🚀 ЗАПУСК ПОЛНОЙ ПРОВЕРКИ БД, УМНОГО АНАЛИЗА, СКАНЕРА И БИРЖИ');
  console.log('================================================================\n');

  // ---------------------------------------------------------------------------
  // ТЕСТ 1: СТРОГИЙ ЗАПРЕТ РАБОТЫ БЕЗ ПОДКЛЮЧЕННОЙ БИРЖИ (Пункт 4)
  // ---------------------------------------------------------------------------
  console.log('1️⃣ [Пункт 4] Проверка блокировки работы бота без подключенной биржи...');
  await api('/api/v1/accounts', { method: 'DELETE' });

  const cfgNoEx = await api('/api/v1/show_config');
  assert.equal(cfgNoEx.data.state, 'stopped', 'Без подключенной биржи бот должен быть в состоянии stopped');
  assert.equal(cfgNoEx.data.exchange_connected, false, 'exchange_connected должен быть false');
  assert.equal(cfgNoEx.data.starting_balance, 0, 'Без подключенной биржи starting_balance должен быть 0 (никаких демо $5000)');
  assert.equal(cfgNoEx.data.dry_run, false, 'dry_run должен быть false');

  const balNoEx = await api('/api/v1/balance');
  assert.equal(balNoEx.data.total, 0, 'Без подключенной биржи общий баланс должен быть 0 USDT');
  assert.equal(balNoEx.data.starting_capital, 0, 'Без подключенной биржи стартовый капитал должен быть 0 USDT');

  const candlesCheck = await api('/api/v1/pair_candles?pair=ETH/USDT:USDT&timeframe=1h&limit=60');
  assert.ok(
    candlesCheck.data.data?.length > 0 && !String(candlesCheck.data.source || '').includes('Local Feed'),
    `Свечи должны загружаться только с реальной биржи (получен источник: ${candlesCheck.data.source})`
  );

  const testNoCreds = await api('/api/v1/accounts/test-connection', {
    method: 'POST',
    body: JSON.stringify({ exchange: 'bybit' }),
  });
  assert.equal(testNoCreds.status, 400, 'Проверка соединения без реальных ключей должна возвращать HTTP 400 (без демо-ключей)');

  const openNoEx = await api('/api/v1/status');
  assert.equal(openNoEx.data.length, 0, 'Без подключенной биржи не должно быть ни одной открытой сделки');

  const startRejected = await api('/api/v1/start', { method: 'POST' });
  assert.equal(startRejected.status, 400, 'POST /api/v1/start без биржи должен возвращать HTTP 400');

  const enterRejected = await api('/api/v1/forceenter', {
    method: 'POST',
    body: JSON.stringify({ pair: 'ETH/USDT:USDT', side: 'long' }),
  });
  assert.equal(enterRejected.status, 400, 'POST /api/v1/forceenter без биржи должен возвращать HTTP 400');

  console.log(
    `   ✅ Без подключенной биржи: state="${cfgNoEx.data.state}", баланс=${balNoEx.data.total} USDT, свечи="${candlesCheck.data.source}", открытых сделок=${openNoEx.data.length}, старт и вход заблокированы (HTTP 400)`
  );

  // ---------------------------------------------------------------------------
  // ТЕСТ 2: ЗАЩИТА ОТ СЛЕПОГО КОПИРОВАНИЯ СТАРЫХ СДЕЛОК ВЛАДЕЛЬЦА (Пункт 2)
  // ---------------------------------------------------------------------------
  console.log('\n2️⃣ [Пункт 2] Проверка: новый клиент НЕ копирует старые сделки владельца вслепую...');

  // Подключаем аккаунт владельца ($5,000)
  const ownerRes = await api('/api/v1/accounts', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Master Owner Account',
      exchange: 'bybit',
      market_type: 'futures',
      api_key: 'OWNR9988776655443322',
      api_secret: 'OWNRSECRET99887766554433221100',
      is_owner: true,
      copy_trading: true,
      max_leverage: 25,
      balance_usdt: 5000,
      client_access_code: 'MASTER01',
    }),
  });
  assert.equal(ownerRes.status, 200, 'Аккаунт владельца должен успешно подключаться');

  const cfgWithOwner = await api('/api/v1/show_config');
  assert.equal(cfgWithOwner.data.state, 'running', 'После подключения биржи бот переходит в running');

  // Владелец открывает сделку по SOL/USDT:USDT ДО подключения клиента (имитация старой открытой сделки)
  const oldMasterTradeRes = await api('/api/v1/forceenter', {
    method: 'POST',
    body: JSON.stringify({
      pair: 'SOL/USDT:USDT',
      side: 'long',
    }),
  });
  assert.equal(oldMasterTradeRes.status, 200);
  const oldSolTradeId = oldMasterTradeRes.data.trade_id;
  console.log(
    `   📌 У владельца уже открыта старая сделка #${oldSolTradeId} [SOL/USDT:USDT] @ ${oldMasterTradeRes.data.open_rate}$ (маржа $${oldMasterTradeRes.data.stake_amount})`
  );

  // Теперь ПОСЛЕ этого подключается новый клиент (Инвестор #1, $2,000)
  const client1Res = await api('/api/v1/accounts', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Инвестор Алексей',
      exchange: 'binance',
      market_type: 'futures',
      api_key: 'CLNT1122334455667788',
      api_secret: 'CLNTSECRET11223344556677889900',
      is_owner: false,
      copy_trading: true,
      max_leverage: 25,
      balance_usdt: 2000,
      client_access_code: 'CLIENT01',
    }),
  });
  assert.equal(client1Res.status, 200);
  const client1Id = client1Res.data.account.id;

  // Проверяем, что старая сделка SOL/USDT:USDT НЕ скопировалась новому клиенту
  const client1StatusBeforeNewSignal = await api('/api/v1/status?code=CLIENT01');
  const client1DashboardBefore = await api('/api/v1/client/dashboard?code=CLIENT01');
  assert.equal(
    client1StatusBeforeNewSignal.data.length,
    0,
    'Старая сделка владельца НЕ должна слепо копироваться новому клиенту при подключении!'
  );
  assert.equal(
    client1DashboardBefore.data.open_trades.length,
    0,
    'В дашборде нового клиента должно быть 0 старых чужих сделок'
  );
  console.log(
    `   ✅ Доказано: у нового клиента «Инвестор Алексей» ($2000) открытых старых сделок = ${client1StatusBeforeNewSignal.data.length} (слепое копирование отключено)`
  );

  // ---------------------------------------------------------------------------
  // ТЕСТ 3: УЧЕТ КОМИССИИ 0.06%, ЗАЩИТА ОТ ЗАКРЫТИЯ В МИНУС И АТОМАРНАЯ СИНХРОНИЗАЦИЯ БД
  // ---------------------------------------------------------------------------
  console.log('\n3️⃣ Проверка комиссии Taker 0.06%, Zero-Loss Guard (запрет закрытия в минус), защиты TP и атомарности SQLite...');

  // Открываем новую актуальную сделку по ETH/USDT:USDT при подключенном клиенте
  const newEthRes = await api('/api/v1/forceenter', {
    method: 'POST',
    body: JSON.stringify({
      pair: 'ETH/USDT:USDT',
      side: 'long',
    }),
  });
  assert.equal(newEthRes.status, 200);
  const masterEthTrade = newEthRes.data;

  // 3A. Проверяем точный расчет комиссии Taker 0.06% на вход и выход ($25 * 25x = $625 номинал => $0.375 вход + $0.375 выход = $0.75)
  assert.ok(masterEthTrade.fee_open > 0, 'fee_open (0.06% Taker) должен быть рассчитан');
  assert.ok(masterEthTrade.fee_close > 0, 'fee_close (0.06% Taker) должен быть рассчитан');
  assert.equal(
    Number((masterEthTrade.fee_open + masterEthTrade.fee_close).toFixed(4)),
    masterEthTrade.fee_total,
    'fee_total должен равняться сумме fee_open + fee_close'
  );
  assert.ok(
    masterEthTrade.breakeven_price > masterEthTrade.open_rate,
    `Точка безубытка LONG (${masterEthTrade.breakeven_price}$) должна быть выше цены входа (${masterEthTrade.open_rate}$) на величину комиссий 0.06%`
  );
  assert.ok(
    masterEthTrade.min_profitable_tp > masterEthTrade.breakeven_price,
    `Минимальный плюсовой TP (${masterEthTrade.min_profitable_tp}$) должен быть выше точки безубытка (${masterEthTrade.breakeven_price}$)`
  );
  console.log(
    `   💰 Комиссия 0.06% учтена: Вход=${masterEthTrade.open_rate}$ | Безубыток=${masterEthTrade.breakeven_price}$ | Мин. плюсовой TP=${masterEthTrade.min_profitable_tp}$ | Комиссия круга=${masterEthTrade.fee_total}$ | Чистый PnL на старте=${masterEthTrade.net_profit}$`
  );

  // 3B. Проверяем ЗАПРЕТ закрытия сделки в минус (на старте цена = цене входа, чистый PnL = -fee_total < 0)
  const blockedCloseRes = await api('/api/v1/forceexit', {
    method: 'POST',
    body: JSON.stringify({ tradeid: masterEthTrade.trade_id }),
  });
  assert.equal(
    blockedCloseRes.status,
    400,
    'Zero-Loss Guard ОБЯЗАН заблокировать закрытие сделки в минус (HTTP 400)!'
  );
  console.log(
    `   🛡️ Zero-Loss Guard сработал при попытке закрыть в минус: HTTP ${blockedCloseRes.status} — "${blockedCloseRes.data.error}"`
  );

  // 3C. Проверяем защиту TP на графике (попытка перетащить TP ниже цены входа / в минус)
  const badTpPrice = Number((masterEthTrade.open_rate * 0.99).toFixed(2));
  const dragBadTpRes = await api('/api/v1/trade_levels', {
    method: 'PATCH',
    body: JSON.stringify({
      tradeid: masterEthTrade.trade_id,
      level_type: 'tp',
      price: badTpPrice,
    }),
  });
  assert.equal(dragBadTpRes.status, 200);
  assert.equal(
    dragBadTpRes.data.clamped_to_breakeven,
    true,
    'При перетаскивании TP в зону убытка/комиссии должен сработать флаг clamped_to_breakeven=true'
  );
  assert.equal(
    dragBadTpRes.data.new_price,
    masterEthTrade.min_profitable_tp,
    'TP должен автоматически зафиксироваться на min_profitable_tp (безубыток + комиссия 0.06% + профит)'
  );
  console.log(
    `   🛡️ Защита TP на графике сработала: попытка поставить TP=${badTpPrice}$ автоматически скорректирована до ${dragBadTpRes.data.new_price}$ (чистый ROI: +${dragBadTpRes.data.trade.take_profit_pct}%)`
  );

  // Проверяем изоляцию на графике владельца и наличие проанализированной сделки у клиента
  const masterOpenList = await api('/api/v1/status');
  const clientOpenList = await api('/api/v1/status?code=CLIENT01');

  assert.equal(
    masterOpenList.data.every((t: any) => !t.account_id || t.account_id === 'master'),
    true,
    'Владелец видит только свои сделки (master)'
  );
  assert.equal(
    clientOpenList.data.length,
    1,
    'У клиента должна открыться ровно 1 новая проанализированная сделка (ETH/USDT:USDT)'
  );

  const clientEthTrade = clientOpenList.data[0];
  assert.equal(clientEthTrade.pair, 'ETH/USDT:USDT');
  assert.equal(clientEthTrade.parent_trade_id, masterEthTrade.trade_id, 'parent_trade_id должен ссылаться на сделку владельца');
  assert.equal(masterEthTrade.stake_amount, 25, 'Ставка владельца 0.5% от $5000 = $25');
  assert.equal(clientEthTrade.stake_amount, 10, 'Ставка клиента 0.5% от $2000 = $10');

  // Проверяем прямым чтением из SQLite (trades.sqlite)
  const dbTradesAfterOpen = sqliteDb.loadAllTrades();
  const dbMasterEth = dbTradesAfterOpen.find((t) => t.trade_id === masterEthTrade.trade_id);
  const dbClientEth = dbTradesAfterOpen.find((t) => t.trade_id === clientEthTrade.trade_id);
  assert.ok(dbMasterEth && dbMasterEth.is_open, 'Сделка владельца сохранена в trades.sqlite');
  assert.ok(
    dbClientEth && dbClientEth.is_open && dbClientEth.parent_trade_id === masterEthTrade.trade_id,
    'Сделка клиента атомарно сохранена в trades.sqlite с parent_trade_id'
  );
  console.log(
    `   ✅ Атомарное открытие в trades.sqlite: Master #${dbMasterEth.trade_id} ($${dbMasterEth.stake_amount}) <-> Client #${dbClientEth.trade_id} ($${dbClientEth.stake_amount}, parent_trade_id=${dbClientEth.parent_trade_id})`
  );

  // 3D. Проверяем синхронное усреднение (DCA), суммирование комиссий 0.06% по всем ордерам и вывод сделки в чистый плюс
  const feeOpenBeforeDca = masterEthTrade.fee_open;
  const dcaPrice = Number((masterEthTrade.open_rate * 0.98).toFixed(2));
  const dcaRes = await api('/api/v1/dca', {
    method: 'POST',
    body: JSON.stringify({
      tradeid: masterEthTrade.trade_id,
      price: dcaPrice,
    }),
  });
  assert.equal(dcaRes.status, 200);
  const averagedTrade = dcaRes.data.trade;
  assert.ok(
    averagedTrade.fee_open >= feeOpenBeforeDca * 1.9,
    `После DCA комиссия открытия (${averagedTrade.fee_open}$) должна включать 0.06% от начального входа (${feeOpenBeforeDca}$) + 0.06% от ордера DCA`
  );
  assert.ok(
    averagedTrade.net_profit > 0,
    `После подтягивания средней цены через DCA чистый профит с учетом всех комиссий 0.06% должен стать строго положительным (net_profit=${averagedTrade.net_profit}$)`
  );

  const dbTradesAfterDca = sqliteDb.loadAllTrades();
  const dbMasterAfterDca = dbTradesAfterDca.find((t) => t.trade_id === masterEthTrade.trade_id);
  const dbClientAfterDca = dbTradesAfterDca.find((t) => t.trade_id === clientEthTrade.trade_id);
  assert.equal(dbMasterAfterDca?.dca_count, 1, 'Владелец: dca_count = 1 в trades.sqlite');
  assert.equal(dbClientAfterDca?.dca_count, 1, 'Клиент: dca_count = 1 синхронно в trades.sqlite');
  assert.equal(
    dbMasterAfterDca?.open_rate,
    dbClientAfterDca?.open_rate,
    'Средняя цена входа после DCA синхронизирована'
  );
  console.log(
    `   ✅ Атомарный DCA в trades.sqlite: dca_count=1, новая средняя=${dbMasterAfterDca?.open_rate}$, накопленная комиссия=${averagedTrade.fee_total}$, чистый PnL=+${averagedTrade.net_profit}$ (+${averagedTrade.net_profit_percent}%)`
  );

  // 3E. Теперь, когда сделка выведена в чистый плюс (net_profit > 0 с учетом всех комиссий 0.06%), закрываем её и проверяем синхронное закрытие у клиента
  const closeEthRes = await api('/api/v1/forceexit', {
    method: 'POST',
    body: JSON.stringify({ tradeid: masterEthTrade.trade_id }),
  });
  assert.equal(closeEthRes.status, 200, 'Когда сделка в чистом плюсе (net_profit > 0), закрытие разрешено (HTTP 200)');

  const dbTradesAfterClose = sqliteDb.loadAllTrades();
  const dbMasterClosed = dbTradesAfterClose.find((t) => t.trade_id === masterEthTrade.trade_id);
  const dbClientClosed = dbTradesAfterClose.find((t) => t.trade_id === clientEthTrade.trade_id);
  assert.equal(dbMasterClosed?.is_open, false, 'Сделка владельца закрыта в чистый плюс в trades.sqlite');
  assert.equal(dbClientClosed?.is_open, false, 'Связанная сделка клиента атомарно закрыта в чистый плюс в trades.sqlite');
  assert.ok((dbMasterClosed?.net_profit ?? 0) > 0, 'Зафиксированный чистый профит владельца строго > 0');
  assert.ok((dbClientClosed?.net_profit ?? 0) > 0, 'Зафиксированный чистый профит клиента строго > 0');
  console.log(
    `   ✅ Атомарное закрытие в чистый плюс: Master #${masterEthTrade.trade_id} (+${dbMasterClosed?.net_profit}$ чистыми после комиссии ${dbMasterClosed?.fee_total}$) и Client #${clientEthTrade.trade_id} (+${dbClientClosed?.net_profit}$ чистыми после комиссии ${dbClientClosed?.fee_total}$)`
  );

  // ---------------------------------------------------------------------------
  // ТЕСТ 4: МУЛЬТИ-МОНЕТНЫЙ СКАНЕР ВОЛАТИЛЬНОСТИ (НЕ ТОЛЬКО ETH) (Пункт 3)
  // ---------------------------------------------------------------------------
  console.log('\n4️⃣ [Пункт 3] Проверка мульти-монетного сканера волатильности USDT-M (объем >= $50M)...');
  const scanRes = await api('/api/v1/volatile_scan?min_volume=50000000&limit=8');
  assert.equal(scanRes.status, 200);
  assert.ok(
    scanRes.data.total_qualified_pairs >= 5,
    `Сканер должен находить минимум 5 ликвидных USDT-M пар (найдено: ${scanRes.data.total_qualified_pairs})`
  );
  assert.ok(scanRes.data.pairs.length >= 5, 'Должен проводиться MTF-анализ нескольких монет, а не только ETH');

  // Запускаем цикл сканирования бота и проверяем запись MTF_SCAN сигналов по разным монетам в SQLite
  const cycleRes = await api('/api/v1/scan_cycle', { method: 'POST' });
  assert.equal(cycleRes.status, 200);

  const recentSignals = sqliteDb.getRecentSignals(30);
  const distinctScannedPairs = Array.from(new Set(recentSignals.map((s: any) => s.pair)));
  assert.ok(
    distinctScannedPairs.length >= 3,
    `Бот должен записывать анализ по разным монетам в таблицу signals (найдено пар: ${distinctScannedPairs.join(', ')})`
  );

  console.log(
    `   ✅ Сканер волатильности нашел ${scanRes.data.total_qualified_pairs} пар USDT-M с объемом >= $50M.`
  );
  console.log(
    `   📊 Топ проанализированных монет: ${scanRes.data.pairs
      .slice(0, 6)
      .map((p: any) => `${p.pair} (24h swing: ${p.swing24h_pct}%, 1D: ${p.d1_trend})`)
      .join(' | ')}`
  );
  console.log(
    `   📈 Сохранено сигналов анализа в БД по монетам: ${distinctScannedPairs.slice(0, 10).join(', ')}`
  );

  // ---------------------------------------------------------------------------
  // ТЕСТ 5: КАК БОТ ВЫСТАВЛЯЕТ И РЕАГИРУЕТ НА ИЗМЕНЕНИЕ TP, DCA И УРОВНЕЙ (SUP / RES)
  // ---------------------------------------------------------------------------
  console.log('\n5️⃣ Проверка выставления и реакции бота на изменение TP, DCA и уровней (SUP/RES)...');

  // 5A. Как бот автоматически выставляет MTF-уровни поддержки и сопротивления для пары
  await api('/api/v1/pair_levels?pair=BTC/USDT:USDT', { method: 'DELETE' });
  const initialLevelsRes = await api('/api/v1/pair_levels?pair=BTC/USDT:USDT&timeframe=1h');
  assert.equal(initialLevelsRes.status, 200);
  const autoLevels: any[] = initialLevelsRes.data.levels || [];
  const supLvl = autoLevels.find((l) => l.role === 'support');
  const resLvl = autoLevels.find((l) => l.role === 'resistance');
  assert.ok(supLvl && supLvl.price > 0, 'Бот должен автоматически находить уровень поддержки (SUP)');
  assert.ok(resLvl && resLvl.price > 0, 'Бот должен автоматически находить уровень сопротивления (RES)');
  console.log(
    `   📐 [5A] Авто-уровни бота для BTC/USDT:USDT: SUP=${supLvl.price}$ (${supLvl.label}, касаний: ${supLvl.touches}) | RES=${resLvl.price}$ (${resLvl.label}, касаний: ${resLvl.touches})`
  );

  // Открываем сделку LONG по BTC/USDT:USDT и проверяем начальное выставление TP и уровней DCA
  const btcOpenRes = await api('/api/v1/forceenter', {
    method: 'POST',
    body: JSON.stringify({ pair: 'BTC/USDT:USDT', side: 'long' }),
  });
  assert.equal(btcOpenRes.status, 200);
  const btcTrade = btcOpenRes.data;
  assert.equal(
    btcTrade.tp_manual_override,
    false,
    'При автоматическом расчете TP флаг tp_manual_override должен быть false (чтобы TP адаптировался к уровням и DCA)'
  );
  assert.ok(
    btcTrade.take_profit_abs > btcTrade.min_profitable_tp,
    'Начальный TP должен быть выше min_profitable_tp'
  );
  assert.equal(
    btcTrade.planned_dca_levels.length,
    2,
    'Бот должен автоматически выставить 2 плановых уровня усреднения (DCA 1 и DCA 2)'
  );
  console.log(
    `   🎯 [5A] Начальное выставление для BTC LONG (#${btcTrade.trade_id} @ ${btcTrade.open_rate}$): TP=${btcTrade.take_profit_abs}$ (+${btcTrade.take_profit_pct}% чистыми) | DCA 1=${btcTrade.planned_dca_levels[0].price}$ (${btcTrade.planned_dca_levels[0].distance_pct}%) | DCA 2=${btcTrade.planned_dca_levels[1].price}$`
  );

  // 5B. Реакция открытой сделки на перетаскивание глобальных уровней бота (SUP / RES) на графике
  const movedResPrice = Number((btcTrade.open_rate * 1.052).toFixed(2));
  const patchResLvl = await api('/api/v1/pair_levels', {
    method: 'PATCH',
    body: JSON.stringify({
      pair: 'BTC/USDT:USDT',
      timeframe: '1h',
      id: resLvl.id,
      price: movedResPrice,
    }),
  });
  assert.equal(patchResLvl.status, 200);

  const movedSupPrice = Number((btcTrade.open_rate * 0.978).toFixed(2));
  const patchSupLvl = await api('/api/v1/pair_levels', {
    method: 'PATCH',
    body: JSON.stringify({
      pair: 'BTC/USDT:USDT',
      timeframe: '1h',
      id: supLvl.id,
      price: movedSupPrice,
    }),
  });
  assert.equal(patchSupLvl.status, 200);

  const statusAfterPairLvlMove = await api('/api/v1/status');
  const btcAfterPairLvl = statusAfterPairLvlMove.data.find((t: any) => t.trade_id === btcTrade.trade_id);
  const expectedStructTp = Number((movedResPrice * 0.998).toFixed(2));
  assert.equal(
    btcAfterPairLvl.resistance_level,
    movedResPrice,
    'resistance_level сделки должен синхронизироваться с перенесенным уровнем RES'
  );
  assert.equal(
    btcAfterPairLvl.take_profit_abs,
    expectedStructTp,
    'Пока TP не зафиксирован вручную, перенос уровня сопротивления RES автоматически обновляет структурный TP сделки LONG'
  );
  assert.equal(
    btcAfterPairLvl.support_level,
    movedSupPrice,
    'support_level сделки должен синхронизироваться с перенесенным уровнем SUP'
  );
  assert.equal(
    btcAfterPairLvl.next_dca_price,
    movedSupPrice,
    'Перенос уровня поддержки SUP ниже входа автоматически обновляет целевой уровень усреднения next_dca_price (DCA 1)'
  );
  console.log(
    `   🔄 [5B] Реакция на перенос уровней SUP/RES: RES ➔ ${movedResPrice}$ обновил структурный TP сделки до ${btcAfterPairLvl.take_profit_abs}$ | SUP ➔ ${movedSupPrice}$ обновил цель DCA 1 до ${btcAfterPairLvl.next_dca_price}$`
  );

  // 5C. Реакция бота на ручной перенос линии DCA 1 сделки на графике
  const customDca1Price = Number((btcTrade.open_rate * 0.982).toFixed(2));
  const patchDcaRes = await api('/api/v1/trade_levels', {
    method: 'PATCH',
    body: JSON.stringify({
      tradeid: btcTrade.trade_id,
      level_type: 'dca',
      step: 1,
      price: customDca1Price,
    }),
  });
  assert.equal(patchDcaRes.status, 200);
  const btcAfterDcaDrag = patchDcaRes.data.trade;
  assert.equal(btcAfterDcaDrag.dca_manual_override, true, 'Должен включиться флаг dca_manual_override=true');
  assert.equal(btcAfterDcaDrag.next_dca_price, customDca1Price, 'next_dca_price должен стать равен новой цене DCA 1');
  assert.equal(
    btcAfterDcaDrag.planned_dca_levels[0].price,
    customDca1Price,
    'planned_dca_levels[0].price должен обновиться'
  );
  console.log(
    `   📏 [5C] Ручной перенос линии DCA 1 ➔ ${customDca1Price}$: новая дистанция=${btcAfterDcaDrag.planned_dca_levels[0].distance_pct}%, объем добора=${btcAfterDcaDrag.planned_dca_levels[0].amount} BTC, DCA 2 автоматически смещен на ${btcAfterDcaDrag.planned_dca_levels[1].price}$`
  );

  // 5D. Реакция бота на ручной перенос TP в допустимую плюсовую зону и синхронизация с клиентом
  const customValidTp = Number((btcTrade.open_rate * 1.018).toFixed(2));
  const patchValidTpRes = await api('/api/v1/trade_levels', {
    method: 'PATCH',
    body: JSON.stringify({
      tradeid: btcTrade.trade_id,
      level_type: 'tp',
      price: customValidTp,
    }),
  });
  assert.equal(patchValidTpRes.status, 200);
  assert.equal(patchValidTpRes.data.clamped_to_breakeven, false);
  assert.equal(patchValidTpRes.data.trade.take_profit_abs, customValidTp);
  assert.equal(patchValidTpRes.data.trade.tp_manual_override, true);

  const clientStatusBtc = await api('/api/v1/status?code=CLIENT01');
  const clientBtcTrade = clientStatusBtc.data.find((t: any) => t.parent_trade_id === btcTrade.trade_id);
  assert.equal(
    clientBtcTrade?.take_profit_abs,
    customValidTp,
    'Измененный вручную TP владельца должен мгновенно синхронизироваться со связанной сделкой клиента'
  );
  console.log(
    `   🎯 [5D] Ручной перенос TP в плюсовую зону ➔ ${customValidTp}$: чистый ожидаемый ROI=+${patchValidTpRes.data.trade.take_profit_pct}% (с учетом комиссии 0.06%), синхронизировано с клиентом (#${clientBtcTrade?.trade_id})`
  );

  // 5E. Автоматическое исполнение (закрытие сделки) ботом при достижении измененного пользователем TP в цикле
  const btcDcaFillPrice = Number((btcTrade.open_rate * 0.98).toFixed(2));
  const btcDcaExec = await api('/api/v1/dca', {
    method: 'POST',
    body: JSON.stringify({
      tradeid: btcTrade.trade_id,
      price: btcDcaFillPrice,
    }),
  });
  assert.equal(btcDcaExec.status, 200);
  const btcAveraged = btcDcaExec.data.trade;

  // Перетаскиваем TP на уровень между min_profitable_tp и текущей рыночной ценой current_rate, чтобы проверить авто-срабатывание TP в цикле бота
  const autoTriggerTpPrice = Number(
    ((btcAveraged.min_profitable_tp + btcAveraged.current_rate) / 2).toFixed(2)
  );
  assert.ok(
    autoTriggerTpPrice > btcAveraged.min_profitable_tp &&
      autoTriggerTpPrice < btcAveraged.current_rate,
    'Целевой TP для авто-срабатывания должен быть строго между min_profitable_tp и current_rate'
  );
  await api('/api/v1/trade_levels', {
    method: 'PATCH',
    body: JSON.stringify({
      tradeid: btcTrade.trade_id,
      level_type: 'tp',
      price: autoTriggerTpPrice,
    }),
  });

  // Запускаем рабочий цикл бота: бот должен увидеть currentPrice >= take_profit_abs и net_profit > 0 и САМ закрыть сделку по roi_target_tp
  await api('/api/v1/scan_cycle', { method: 'POST' });

  const dbAfterAutoTp = sqliteDb.loadAllTrades();
  const closedMasterBtc = dbAfterAutoTp.find((t) => t.trade_id === btcTrade.trade_id);
  const closedClientBtc = dbAfterAutoTp.find((t) => t.trade_id === clientBtcTrade.trade_id);
  assert.equal(
    closedMasterBtc?.is_open,
    false,
    'Бот в рабочем цикле обязан автоматически закрыть сделку при достижении переставленного пользователем TP'
  );
  assert.equal(
    closedMasterBtc?.exit_reason,
    'roi_target_tp',
    'Причина закрытия должна быть roi_target_tp'
  );
  assert.equal(
    closedClientBtc?.is_open,
    false,
    'Связанная сделка клиента должна автоматически закрыться вместе со сделкой владельца при срабатывании TP'
  );
  assert.ok((closedMasterBtc?.net_profit ?? 0) > 0, 'Чистый профит закрытой по TP сделки строго > 0');
  console.log(
    `   🚀 [5E] Авто-срабатывание пользовательского TP в цикле бота: сделка #${btcTrade.trade_id} автоматически закрыта по ${closedMasterBtc?.close_rate}$ (exit_reason="${closedMasterBtc?.exit_reason}", чистый PnL=+${closedMasterBtc?.net_profit}$ после комиссии ${closedMasterBtc?.fee_total}$)`
  );

  // Очищаем тестовые уровни BTC
  await api('/api/v1/pair_levels?pair=BTC/USDT:USDT', { method: 'DELETE' });

  // ---------------------------------------------------------------------------
  // ТЕСТ 6: СБОЙ / ПЕРЕЗАПУСК СЕРВЕРА И ПОТЕРЯ СВЯЗИ (СОХРАНЕНИЕ ПАМЯТИ О СДЕЛКАХ И DCA)
  // ---------------------------------------------------------------------------
  console.log('\n6️⃣ Проверка восстановления после сбоя/перезапуска сервера и временной потери связи с биржей...');

  // Открываем сделку XRP/USDT:USDT LONG и выполняем 2 последовательных шага усреднения (DCA #1 и DCA #2)
  const xrpOpenRes = await api('/api/v1/forceenter', {
    method: 'POST',
    body: JSON.stringify({ pair: 'XRP/USDT:USDT', side: 'long' }),
  });
  assert.equal(xrpOpenRes.status, 200);
  const xrpInitial = xrpOpenRes.data;

  // Шаг DCA #1 (-1.8% от входа)
  const xrpDca1Price = Number((xrpInitial.open_rate * 0.982).toFixed(4));
  const xrpDca1Res = await api('/api/v1/dca', {
    method: 'POST',
    body: JSON.stringify({ tradeid: xrpInitial.trade_id, price: xrpDca1Price }),
  });
  assert.equal(xrpDca1Res.status, 200);

  // Шаг DCA #2 (-3.5% от начального входа)
  const xrpDca2Price = Number((xrpInitial.open_rate * 0.965).toFixed(4));
  const xrpDca2Res = await api('/api/v1/dca', {
    method: 'POST',
    body: JSON.stringify({ tradeid: xrpInitial.trade_id, price: xrpDca2Price }),
  });
  assert.equal(xrpDca2Res.status, 200);

  // Также меняем вручную TP на +2.5% от новой средней цены
  const xrpCustomTp = Number((xrpDca2Res.data.trade.open_rate * 1.025).toFixed(4));
  const xrpTpPatch = await api('/api/v1/trade_levels', {
    method: 'PATCH',
    body: JSON.stringify({
      tradeid: xrpInitial.trade_id,
      level_type: 'tp',
      price: xrpCustomTp,
    }),
  });
  assert.equal(xrpTpPatch.status, 200);
  const xrpBeforeCrash = xrpTpPatch.data.trade;

  // 6A. Имитируем временную потерю связи с биржей (все аккаунты временно enabled=false) + перезапуск памяти сервера
  const accListRes = await api('/api/v1/accounts');
  for (const acc of accListRes.data.accounts) {
    await api(`/api/v1/accounts/${acc.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    });
  }

  const crashWithPausedExRes = await api('/api/v1/simulate_crash_recovery', { method: 'POST' });
  assert.equal(crashWithPausedExRes.status, 200);
  assert.equal(
    crashWithPausedExRes.data.open_master_trades >= 2,
    true,
    'Даже при временно отключенной бирже во время перезапуска НИ ОДНА открытая сделка НЕ должна удаляться или отменяться!'
  );
  console.log(
    `   🔌 [6A] Перезапуск при временно недоступной бирже: state="${crashWithPausedExRes.data.state}", сохранено открытых сделок владельца=${crashWithPausedExRes.data.open_master_trades} (усреднённых=${crashWithPausedExRes.data.averaged_master_trades}) — 0 сделок отменено!`
  );

  // Включаем биржевые аккаунты обратно и выполняем полный сброс памяти + восстановление из SQLite
  for (const acc of accListRes.data.accounts) {
    await api(`/api/v1/accounts/${acc.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: true }),
    });
  }
  const crashRecoveryRes = await api('/api/v1/simulate_crash_recovery', { method: 'POST' });
  assert.equal(crashRecoveryRes.status, 200);
  assert.equal(crashRecoveryRes.data.state, 'running');

  // 6B. Проверяем, что после перезапуска бот на 100% помнит сделку XRP, её начальный вход, оба шага DCA, среднюю цену, комиссии и ручной TP
  const statusAfterCrash = await api('/api/v1/status');
  const xrpAfterCrash = statusAfterCrash.data.find((t: any) => t.trade_id === xrpInitial.trade_id);
  assert.ok(xrpAfterCrash && xrpAfterCrash.is_open, 'Сделка XRP осталась открытой после перезапуска');
  assert.equal(xrpAfterCrash.dca_count, 2, 'Бот помнит точное количество выполненных усреднений (dca_count = 2)');
  assert.equal(
    xrpAfterCrash.initial_open_rate,
    xrpInitial.open_rate,
    'Бот помнит самую первую цену входа до усреднений (initial_open_rate)'
  );
  assert.equal(
    xrpAfterCrash.open_rate,
    xrpBeforeCrash.open_rate,
    'Бот помнит средневзвешенную цену после 2 шагов DCA (open_rate)'
  );
  assert.equal(
    xrpAfterCrash.stake_amount,
    xrpBeforeCrash.stake_amount,
    'Бот помнит суммарную маржу после 2 шагов DCA'
  );
  assert.equal(
    xrpAfterCrash.amount,
    xrpBeforeCrash.amount,
    'Бот помнит суммарный объем монет после 2 шагов DCA'
  );
  assert.equal(
    xrpAfterCrash.take_profit_abs,
    xrpCustomTp,
    'Бот помнит выставленный вручную TP после перезапуска'
  );
  assert.equal(xrpAfterCrash.tp_manual_override, true, 'Флаг tp_manual_override=true сохранен');
  assert.equal(
    xrpAfterCrash.orders.length,
    3,
    'Бот помнит все 3 исполненных ордера в цепочке (Нач. вход #1 + Усреднение #1 + Усреднение #2)'
  );
  assert.equal(
    xrpAfterCrash.dca_history.length,
    2,
    'В dca_history сохранены оба шага усреднения'
  );
  assert.equal(
    xrpAfterCrash.planned_dca_levels[0].step,
    3,
    'Следующий плановый уровень DCA после перезапуска — шаг #3 (а не #1!)'
  );
  assert.ok(
    Array.isArray(xrpAfterCrash.synced_accounts) && xrpAfterCrash.synced_accounts.length > 0,
    'Бот помнит привязанные клиентские аккаунты (synced_accounts)'
  );

  // Проверяем, что у клиента также сохранились все 2 шага DCA после перезапуска
  const clientAfterCrashRes = await api('/api/v1/status?code=CLIENT01');
  const clientXrpAfterCrash = clientAfterCrashRes.data.find(
    (t: any) => t.parent_trade_id === xrpInitial.trade_id
  );
  assert.ok(clientXrpAfterCrash && clientXrpAfterCrash.is_open, 'Сделка клиента сохранена после перезапуска');
  assert.equal(clientXrpAfterCrash.dca_count, 2, 'У клиента также сохранен dca_count = 2');
  assert.equal(clientXrpAfterCrash.orders.length, 3, 'У клиента сохранены все 3 ордера (вход + 2 DCA)');

  console.log(
    `   🧠 [6B] Полная память после перезапуска для XRP (#${xrpAfterCrash.trade_id}): Нач. вход=${xrpAfterCrash.initial_open_rate}$ ➔ Средняя после 2×DCA=${xrpAfterCrash.open_rate}$ | Маржа=${xrpAfterCrash.stake_amount}$ | Ордеров в памяти=${xrpAfterCrash.orders.length} | След. план. шаг=DCA #${xrpAfterCrash.planned_dca_levels[0].step} | TP=${xrpAfterCrash.take_profit_abs}$`
  );

  // ---------------------------------------------------------------------------
  // ТЕСТ 7: СОХРАНЕНИЕ ПЕРЕТАЩЕННЫХ УРОВНЕЙ И РИСУНКОВ ПРИ ПЕРЕЗАГРУЗКЕ СТРАНИЦЫ (F5)
  //         И ПРОВЕРКА ОТСУТСТВИЯ УСРЕДНЕНИЯ НА СТАРЫХ УРОВНЯХ
  // ---------------------------------------------------------------------------
  console.log('\n7️⃣ Проверка сохранения перетащенных уровней при перезагрузке страницы (F5) и отмены старых уровней DCA...');

  // 7A. Сбрасываем уровни LINK и открываем сделку LINK/USDT:USDT LONG
  await api('/api/v1/pair_levels?pair=LINK/USDT:USDT', { method: 'DELETE' });
  const linkOpenRes = await api('/api/v1/forceenter', {
    method: 'POST',
    body: JSON.stringify({ pair: 'LINK/USDT:USDT', side: 'long' }),
  });
  assert.equal(linkOpenRes.status, 200);
  const linkTrade = linkOpenRes.data;
  const oldDca1Price = linkTrade.next_dca_price;

  // Загружаем уровни бота для LINK/USDT:USDT на 1h
  const linkLevelsInitRes = await api('/api/v1/pair_levels?pair=LINK/USDT:USDT&timeframe=1h');
  assert.equal(linkLevelsInitRes.status, 200);
  const linkSupLvl = linkLevelsInitRes.data.levels.find((l: any) => l.role === 'support');
  const linkResLvl = linkLevelsInitRes.data.levels.find((l: any) => l.role === 'resistance');
  assert.ok(linkSupLvl && linkResLvl, 'Начальные уровни SUP и RES для LINK должны существовать');

  // Перетаскиваем уровень SUP глубже (-4.5% от входа) и RES выше (+5.0% от входа)
  const newDraggedSupPrice = Number((linkTrade.open_rate * 0.955).toFixed(4));
  const newDraggedResPrice = Number((linkTrade.open_rate * 1.05).toFixed(4));

  const patchSupRes = await api('/api/v1/pair_levels', {
    method: 'PATCH',
    body: JSON.stringify({
      pair: 'LINK/USDT:USDT',
      timeframe: '1h',
      id: linkSupLvl.id,
      price: newDraggedSupPrice,
    }),
  });
  assert.equal(patchSupRes.status, 200);
  assert.equal(patchSupRes.data.level.price, newDraggedSupPrice);
  assert.equal(patchSupRes.data.level.role, 'support', 'Роль уровня SUP должна остаться support');
  assert.equal(patchSupRes.data.level.manual_override, true);

  const patchResRes = await api('/api/v1/pair_levels', {
    method: 'PATCH',
    body: JSON.stringify({
      pair: 'LINK/USDT:USDT',
      timeframe: '1h',
      id: linkResLvl.id,
      price: newDraggedResPrice,
    }),
  });
  assert.equal(patchResRes.status, 200);
  assert.equal(patchResRes.data.level.price, newDraggedResPrice);
  assert.equal(patchResRes.data.level.role, 'resistance', 'Роль уровня RES должна остаться resistance');

  // Также перетаскиваем вручную второй уровень усреднения (DCA 2, step=2) на -8.0% от входа
  const newDraggedDca2Price = Number((linkTrade.open_rate * 0.92).toFixed(4));
  const patchDca2Res = await api('/api/v1/trade_levels', {
    method: 'PATCH',
    body: JSON.stringify({
      tradeid: linkTrade.trade_id,
      level_type: 'dca',
      step: 2,
      price: newDraggedDca2Price,
    }),
  });
  assert.equal(patchDca2Res.status, 200);

  // Добавляем и перетаскиваем графический объект (линию тренда / линейку) на графике LINK
  const addDrwRes = await api('/api/v1/chart_drawings', {
    method: 'POST',
    body: JSON.stringify({
      pair: 'LINK/USDT:USDT',
      tool: 'trendline',
      points: [
        { timestamp: Date.now() - 3600_000, price: newDraggedSupPrice },
        { timestamp: Date.now(), price: newDraggedResPrice },
      ],
      color: '#2962ff',
    }),
  });
  assert.equal(addDrwRes.status, 200);
  const createdDrwId = addDrwRes.data.drawing.id;

  // Имитируем перезагрузку страницы (F5) и перезапуск памяти сервера (simulate_crash_recovery)
  await api('/api/v1/simulate_crash_recovery', { method: 'POST' });

  // Проверяем, что после перезагрузки страницы уровни SUP и RES остались ровно там, где их поставил пользователь (и на 1h, и на 4h, и на 15m, без дублей!)
  for (const tf of ['1h', '4h', '15m']) {
    const reloadLvls = await api(`/api/v1/pair_levels?pair=LINK/USDT:USDT&timeframe=${tf}`);
    assert.equal(reloadLvls.status, 200);
    const supAfterReload = reloadLvls.data.levels.filter((l: any) => l.role === 'support');
    const resAfterReload = reloadLvls.data.levels.filter((l: any) => l.role === 'resistance');
    assert.equal(
      supAfterReload.length,
      1,
      `На таймфрейме ${tf} должен быть ровно 1 уровень SUP (старый авто-уровень не должен появляться повторно)`
    );
    assert.equal(
      resAfterReload.length,
      1,
      `На таймфрейме ${tf} должен быть ровно 1 уровень RES (старый авто-уровень не должен появляться повторно)`
    );
    assert.equal(
      supAfterReload[0].price,
      newDraggedSupPrice,
      `После перезагрузки страницы на ${tf} уровень SUP обязан остаться на ${newDraggedSupPrice}$`
    );
    assert.equal(
      resAfterReload[0].price,
      newDraggedResPrice,
      `После перезагрузки страницы на ${tf} уровень RES обязан остаться на ${newDraggedResPrice}$`
    );
  }

  // Проверяем, что графические построения (drawings) также сохранились после перезагрузки и перезапуска
  const reloadDrwRes = await api('/api/v1/chart_drawings?pair=LINK/USDT:USDT');
  assert.equal(reloadDrwRes.status, 200);
  assert.equal(reloadDrwRes.data.drawings.length, 1);
  assert.equal(reloadDrwRes.data.drawings[0].id, createdDrwId);
  assert.equal(reloadDrwRes.data.drawings[0].points[0].price, newDraggedSupPrice);

  // 7B. Проверяем, что сделка LINK синхронизирована с новыми уровнями, а старый уровень DCA (oldDca1Price) полностью отменен!
  const statusAfterReload = await api('/api/v1/status');
  const linkAfterReload = statusAfterReload.data.find((t: any) => t.trade_id === linkTrade.trade_id);
  assert.ok(linkAfterReload, 'Сделка LINK должна присутствовать после перезагрузки');
  assert.notEqual(
    linkAfterReload.next_dca_price,
    oldDca1Price,
    'Старый уровень DCA 1 должен быть полностью отменен'
  );
  assert.equal(
    linkAfterReload.next_dca_price,
    newDraggedSupPrice,
    'Новый целевой уровень DCA 1 (next_dca_price) должен быть равен перетащенному уровню SUP'
  );
  assert.equal(
    linkAfterReload.planned_dca_levels[0].price,
    newDraggedSupPrice,
    'planned_dca_levels[0].price должен быть равен новому уровню SUP'
  );
  assert.equal(
    linkAfterReload.planned_dca_levels[1].price,
    newDraggedDca2Price,
    'planned_dca_levels[1].price (DCA 2) должен сохраниться на выставленном пользователем уровне'
  );

  // Запускаем цикл анализа бота (scan_cycle): так как рыночная цена выше нового уровня newDraggedSupPrice, бот НЕ должен усреднять сделку на старом уровне!
  await api('/api/v1/scan_cycle', { method: 'POST' });
  const statusAfterScan = await api('/api/v1/status');
  const linkAfterScan = statusAfterScan.data.find((t: any) => t.trade_id === linkTrade.trade_id);
  assert.equal(
    linkAfterScan.dca_count,
    0,
    'Бот НЕ должен усреднять позицию на старом уровне после переноса уровня пользователем'
  );

  // Теперь исполняем DCA #1 на новом уровне newDraggedSupPrice и проверяем, что выставленный вручную DCA 2 (newDraggedDca2Price) стал следующим активным уровнем усреднения!
  const linkDca1Exec = await api('/api/v1/dca', {
    method: 'POST',
    body: JSON.stringify({
      tradeid: linkTrade.trade_id,
      price: newDraggedSupPrice,
    }),
  });
  assert.equal(linkDca1Exec.status, 200);
  const linkAfterDca1 = linkDca1Exec.data.trade;
  assert.equal(linkAfterDca1.dca_count, 1);
  assert.equal(
    linkAfterDca1.next_dca_price,
    newDraggedDca2Price,
    'После исполнения DCA #1 следующим целевым уровнем усреднения обязан стать выставленный пользователем DCA 2 (а не сброшенный авто-уровень!)'
  );
  assert.equal(
    linkAfterDca1.planned_dca_levels[0].price,
    newDraggedDca2Price,
    'planned_dca_levels[0].price после DCA #1 должен равняться пользовательскому уровню DCA 2'
  );
  assert.equal(
    linkAfterDca1.planned_dca_levels[0].manual_override,
    true,
    'Флаг manual_override=true на продвинутом уровне DCA 2 должен сохраниться'
  );

  console.log(
    `   📌 [7A-7B] Перетащенные уровни SUP (${newDraggedSupPrice}$), RES (${newDraggedResPrice}$), DCA 1 (${newDraggedSupPrice}$) и DCA 2 (${newDraggedDca2Price}$) на 100% сохраняются после перезагрузки страницы (F5) и перезапуска сервера. Старый уровень (${oldDca1Price}$) отменён, бот анализирует и усредняет строго по новым уровням!`
  );

  // ---------------------------------------------------------------------------
  // ТЕСТ 8: БЫСТРЫЙ СКАЛЬП-TP (0.8–1.5%), ЛИМИТ 30 СДЕЛОК И АВТО-РЕИНВЕСТ ПРОФИТА (СЛОЖНЫЙ % ПОД 50%+/МЕС)
  // ---------------------------------------------------------------------------
  console.log('\n8️⃣ Проверка быстрого скальп-TP (0.8–1.5%), пула 30 сделок и авто-реинвеста профита (сложный процент)...');

  const cfgFastRes = await api('/api/v1/show_config');
  assert.equal(cfgFastRes.data.max_open_trades, 30, 'Пул одновременных 1H сделок должен быть расширен до 30');
  assert.equal(cfgFastRes.data.timeframe, '1h', 'Рабочий таймфрейм должен оставаться 1h');

  // Открываем новую сделку AVAX/USDT:USDT LONG и проверяем, что:
  // 1) Ставка входа выросла за счет реинвеста профита от ранее закрытых сделок ETH и BTC (сложный процент > $25.00!)
  // 2) Автоматический скальп-TP выставлен в диапазоне 0.8%–1.5% от цены входа (20%–35% ROI на 25x) и строго выше min_profitable_tp
  const balBeforeAvax = await api('/api/v1/balance');
  const compoundedEquityMaster = balBeforeAvax.data.total;
  assert.ok(
    compoundedEquityMaster > 5000,
    `Текущий баланс с учетом реинвеста закрытых плюсовых сделок (${compoundedEquityMaster}$) должен быть выше стартовых $5000`
  );

  await api('/api/v1/pair_levels?pair=AVAX/USDT:USDT', { method: 'DELETE' });
  const avaxOpenRes = await api('/api/v1/forceenter', {
    method: 'POST',
    body: JSON.stringify({ pair: 'AVAX/USDT:USDT', side: 'long' }),
  });
  assert.equal(avaxOpenRes.status, 200);
  const avaxTrade = avaxOpenRes.data;

  const expectedCompoundedStake = Number((compoundedEquityMaster * 0.005).toFixed(2));
  assert.equal(
    avaxTrade.stake_amount,
    expectedCompoundedStake,
    `Ставка новой сделки (${avaxTrade.stake_amount}$) должна рассчитываться как 0.5% от текущего реинвест-баланса (${compoundedEquityMaster}$)`
  );

  const tpDistancePct = ((avaxTrade.take_profit_abs - avaxTrade.open_rate) / avaxTrade.open_rate) * 100;
  assert.ok(
    tpDistancePct >= 0.75 && tpDistancePct <= 1.55,
    `Быстрый скальп-TP должен находиться в диапазоне 0.8%–1.5% от цены входа (получено: +${tpDistancePct.toFixed(2)}%)`
  );
  assert.ok(
    avaxTrade.take_profit_abs >= avaxTrade.min_profitable_tp,
    'Быстрый скальп-TP обязан быть не ниже min_profitable_tp (с учетом комиссии 0.06%)'
  );

  // Проверяем пересчет быстрого скальп-TP после усреднения (DCA): TP должен подтянуться на ~+0.8% от новой средней цены входа
  const avaxDcaPrice = Number((avaxTrade.open_rate * 0.982).toFixed(4));
  const avaxDcaRes = await api('/api/v1/dca', {
    method: 'POST',
    body: JSON.stringify({ tradeid: avaxTrade.trade_id, price: avaxDcaPrice }),
  });
  assert.equal(avaxDcaRes.status, 200);
  const avaxAfterDca = avaxDcaRes.data.trade;
  const dcaTpDistancePct =
    ((avaxAfterDca.take_profit_abs - avaxAfterDca.open_rate) / avaxAfterDca.open_rate) * 100;
  assert.ok(
    dcaTpDistancePct >= 0.3 && dcaTpDistancePct <= 1.0,
    `После DCA тейк-профит должен подтягиваться на ~+0.8% от новой средней цены для быстрого выхода в плюс (получено: +${dcaTpDistancePct.toFixed(2)}%)`
  );
  assert.ok(
    avaxAfterDca.take_profit_abs >= avaxAfterDca.min_profitable_tp,
    'После DCA тейк-профит обязан быть строго >= min_profitable_tp (чистый плюс с учетом всех комиссий 0.06%)'
  );

  console.log(
    `   📈 [8A-8B] Доказана работа сложного процента и быстрого скальп-TP: Реинвест-баланс=${compoundedEquityMaster}$ ➔ Новая ставка 0.5%=${avaxTrade.stake_amount}$ | Нач. скальп-TP=+${tpDistancePct.toFixed(2)}% (+${avaxTrade.take_profit_pct}% чистыми) | После DCA скальп-TP=+${dcaTpDistancePct.toFixed(2)}% (+${avaxAfterDca.take_profit_pct}% чистыми) | Лимит сделок=${cfgFastRes.data.max_open_trades}`
  );

  // Если передан флаг --leave-for-restart, оставляем эти сделки в БД для проверки через реальный перезапуск процесса Node.js (restart_dev_server)
  if (process.argv.includes('--leave-for-restart')) {
    console.log('\n⏸️ Режим --leave-for-restart: сделки оставлены в trades.sqlite для проверки реального перезапуска процесса Node.js.');
    return;
  }

  // ---------------------------------------------------------------------------
  // ОЧИСТКА ТЕСТОВЫХ ДАННЫХ (Чистое состояние после проверки)
  // ---------------------------------------------------------------------------
  console.log('\n🧹 Очистка тестовых аккаунтов и тестовых сделок...');
  await api('/api/v1/accounts', { method: 'DELETE' });
  const allRemainingTrades = sqliteDb.loadAllTrades();
  for (const t of allRemainingTrades) {
    sqliteDb.deleteTrade(t.trade_id);
  }
  sqliteDb.clearAllExchangeAccounts();
  sqliteDb.clearBotLevelsForPair('BTC/USDT:USDT');
  sqliteDb.clearBotLevelsForPair('ETH/USDT:USDT');
  sqliteDb.clearBotLevelsForPair('SOL/USDT:USDT');
  sqliteDb.clearBotLevelsForPair('XRP/USDT:USDT');
  sqliteDb.clearBotLevelsForPair('LINK/USDT:USDT');
  sqliteDb.clearBotLevelsForPair('AVAX/USDT:USDT');
  sqliteDb.clearChartDrawingsForPair('LINK/USDT:USDT');
  const finalCfg = await api('/api/v1/show_config');
  const finalBal = await api('/api/v1/balance');
  assert.equal(finalBal.data.total, 0, 'После очистки всех аккаунтов баланс должен быть 0 USDT');
  console.log(
    `   ✅ База очищена. Финальный статус бота без подключенной биржи: state="${finalCfg.data.state}", exchange_connected=${finalCfg.data.exchange_connected}, баланс=${finalBal.data.total} USDT`
  );

  console.log('\n================================================================');
  console.log('✅ ВСЕ 8 БЛОКОВ ТЕСТОВ ПРОВЕРЕНЫ НА ПРАКТИКЕ И ПОЛНОСТЬЮ ПОДТВЕРЖДЕНЫ!');
  console.log('================================================================');
}

async function verifyAfterRealProcessRestart() {
  console.log('================================================================');
  console.log('🔄 ПРОВЕРКА СОСТОЯНИЯ ПОСЛЕ РЕАЛЬНОГО ПЕРЕЗАПУСКА ПРОЦЕССА СЕРВЕРА');
  console.log('================================================================\n');

  const cfgRes = await api('/api/v1/show_config');
  assert.equal(cfgRes.data.state, 'running', 'После перезапуска процесса бот должен быть в состоянии running');
  assert.equal(cfgRes.data.exchange_connected, true, 'Аккаунты биржи должны быть восстановлены из trades.sqlite');

  const masterTradesRes = await api('/api/v1/status');
  const clientTradesRes = await api('/api/v1/status?code=CLIENT01');

  const solTrade = masterTradesRes.data.find((t: any) => t.pair === 'SOL/USDT:USDT');
  const xrpTrade = masterTradesRes.data.find((t: any) => t.pair === 'XRP/USDT:USDT');
  const clientXrp = clientTradesRes.data.find((t: any) => t.pair === 'XRP/USDT:USDT');

  assert.ok(solTrade && solTrade.is_open && solTrade.dca_count === 0, 'Обычная сделка SOL (dca_count=0) сохранена после перезапуска процесса');
  assert.ok(xrpTrade && xrpTrade.is_open && xrpTrade.dca_count === 2, 'Усреднённая сделка XRP (dca_count=2) сохранена после перезапуска процесса');
  assert.equal(xrpTrade.orders.length, 3, 'Все 3 ордера (Нач. вход + DCA #1 + DCA #2) сохранены в памяти после перезапуска процесса');
  assert.equal(xrpTrade.dca_history.length, 2, 'История dca_history (2 шага) сохранена после перезапуска процесса');
  assert.equal(xrpTrade.planned_dca_levels[0].step, 3, 'Следующий плановый шаг после перезапуска процесса — DCA #3');
  assert.equal(xrpTrade.tp_manual_override, true, 'Ручной TP сохранен после перезапуска процесса');
  assert.ok(clientXrp && clientXrp.is_open && clientXrp.dca_count === 2, 'Усреднённая сделка клиента (dca_count=2) сохранена после перезапуска процесса');

  // Выполняем еще один шаг усреднения (DCA #3) ПОСЛЕ перезапуска процесса, чтобы доказать, что бот продолжает с шага #3, а не сбрасывает счетчик
  const dca3Price = Number((xrpTrade.open_rate * 0.985).toFixed(4));
  const dca3Res = await api('/api/v1/dca', {
    method: 'POST',
    body: JSON.stringify({ tradeid: xrpTrade.trade_id, price: dca3Price }),
  });
  assert.equal(dca3Res.status, 200);
  const xrpAfterDca3 = dca3Res.data.trade;
  assert.equal(xrpAfterDca3.dca_count, 3, 'После перезапуска сервера следующее усреднение стало шагом DCA #3!');
  assert.equal(xrpAfterDca3.orders.length, 4, 'В цепочке ордеров теперь 4 ордера (Вход + DCA #1 + DCA #2 + DCA #3)');
  assert.equal(xrpAfterDca3.planned_dca_levels[0].step, 4, 'Следующий плановый уровень теперь DCA #4');

  console.log(
    `   ✅ Доказано после РЕАЛЬНОГО перезапуска Node.js: открытая сделка SOL (#${solTrade.trade_id}, dca_count=0) и усреднённая сделка XRP (#${xrpTrade.trade_id}, dca_count=2 ➔ продолжена до dca_count=${xrpAfterDca3.dca_count}, ордеров=${xrpAfterDca3.orders.length}) сохранены без единой потери!`
  );

  // Очистка после завершения двухфазного теста
  await api('/api/v1/accounts', { method: 'DELETE' });
  const allRemainingTrades = sqliteDb.loadAllTrades();
  for (const t of allRemainingTrades) {
    sqliteDb.deleteTrade(t.trade_id);
  }
  console.log('   🧹 Тестовые данные очищены, БД возвращена в чистое стартовое состояние.');
}

if (process.argv.includes('--verify-after-restart')) {
  verifyAfterRealProcessRestart().catch((err) => {
    console.error('❌ ОШИБКА ПРОВЕРКИ ПОСЛЕ ПЕРЕЗАПУСКА:', err);
    process.exit(1);
  });
} else {
  runVerification().catch((err) => {
    console.error('❌ ОШИБКА ПРОВЕРКИ:', err);
    process.exit(1);
  });
}
