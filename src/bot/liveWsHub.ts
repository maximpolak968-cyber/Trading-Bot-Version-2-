import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

export interface LiveHubScopeInfo {
  accountId: string;
  isClient: boolean;
}

export interface LiveHubSnapshot {
  botConfig: any;
  openTrades: any[];
  closedTrades: any[];
  balance: any;
  profit?: any;
  daily?: any[];
  logs?: any[];
  accounts?: any[];
  timestamp: number;
}

export interface LiveHubProviders {
  resolveScopeFromAuth: (params: {
    token?: string;
    clientCode?: string;
    accountId?: string;
  }) => LiveHubScopeInfo;
  buildSnapshotForScope: (accountId: string, isClient: boolean) => Promise<LiveHubSnapshot>;
  onClientPairSubscribe?: (pair: string, timeframe: string) => void;
}

interface ConnectedUiClient {
  ws: WebSocket;
  accountId: string;
  isClient: boolean;
  subscribedPair: string;
  subscribedTimeframe: string;
  isAlive: boolean;
}

export interface LiveTickerFrame {
  pair: string;
  exchange: 'bybit' | 'binance';
  price: number;
  markPrice: number;
  bestBid?: number;
  bestAsk?: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  updatedAt: number;
}

export interface LiveCandleFrame {
  pair: string;
  interval: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  confirmed: boolean;
}

const uiClients = new Set<ConnectedUiClient>();
let hubProviders: LiveHubProviders | null = null;
let wssInstance: WebSocketServer | null = null;

// Throttled ticker batcher (every 100ms max)
const pendingTickerUpdates = new Map<string, LiveTickerFrame>();
let tickerFlushTimer: ReturnType<typeof setTimeout> | null = null;

// Coalesced state:sync scheduler per scope (every 40ms max)
const pendingScopeSyncs = new Set<string>();
let stateSyncFlushTimer: ReturnType<typeof setTimeout> | null = null;

export function getConnectedUiClientsCount(): number {
  let count = 0;
  for (const c of uiClients) {
    if (c.ws.readyState === WebSocket.OPEN) count++;
  }
  return count;
}

function safeSend(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // ignore closed/broken socket write
  }
}

export function attachLiveWebSocketHub(
  httpServer: http.Server,
  providers: LiveHubProviders
): void {
  if (wssInstance) return;
  hubProviders = providers;

  const wss = new WebSocketServer({ noServer: true });
  wssInstance = wss;

  // Handle ONLY /ws/live upgrades so Vite HMR WebSocket stays completely untouched
  httpServer.on('upgrade', (req, socket, head) => {
    try {
      const rawUrl = req.url || '/';
      const parsed = new URL(rawUrl, 'http://localhost');
      if (parsed.pathname !== '/ws/live') {
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch {
      // ignore malformed upgrade URL
    }
  });

  // Keepalive ping/pong every 20s to detect dead browser tabs cleanly
  const heartbeatTimer = setInterval(() => {
    for (const client of uiClients) {
      if (!client.isAlive) {
        uiClients.delete(client);
        try {
          client.ws.terminate();
        } catch {
          // ignore
        }
        continue;
      }
      client.isAlive = false;
      try {
        client.ws.ping();
      } catch {
        // ignore
      }
    }
  }, 20_000);

  wss.on('close', () => {
    clearInterval(heartbeatTimer);
  });

  wss.on('connection', async (ws, req) => {
    let token = '';
    let clientCode = '';
    let reqAccountId = '';
    let pair = 'ETH/USDT:USDT';
    let timeframe = '1h';

    try {
      const parsed = new URL(req.url || '/ws/live', 'http://localhost');
      token = parsed.searchParams.get('token') || '';
      clientCode = parsed.searchParams.get('client') || parsed.searchParams.get('code') || '';
      reqAccountId = parsed.searchParams.get('account_id') || '';
      pair = parsed.searchParams.get('pair') || 'ETH/USDT:USDT';
      timeframe = parsed.searchParams.get('timeframe') || '1h';
    } catch {
      // keep defaults
    }

    const scope = providers.resolveScopeFromAuth({
      token,
      clientCode,
      accountId: reqAccountId,
    });

    const client: ConnectedUiClient = {
      ws,
      accountId: scope.accountId,
      isClient: scope.isClient,
      subscribedPair: pair,
      subscribedTimeframe: timeframe,
      isAlive: true,
    };
    uiClients.add(client);
    providers.onClientPairSubscribe?.(pair, timeframe);

    ws.on('pong', () => {
      client.isAlive = true;
    });

    ws.on('message', async (rawData) => {
      try {
        const msg = JSON.parse(String(rawData));
        if (!msg || typeof msg !== 'object') return;
        if (msg.op === 'ping') {
          safeSend(ws, { type: 'pong', ts: Date.now() });
          return;
        }
        if (msg.op === 'subscribe') {
          if (typeof msg.pair === 'string' && msg.pair.trim()) {
            client.subscribedPair = msg.pair.trim();
          }
          if (typeof msg.timeframe === 'string' && msg.timeframe.trim()) {
            client.subscribedTimeframe = msg.timeframe.trim();
          }
          if (typeof msg.token === 'string' || typeof msg.client === 'string') {
            const nextScope = providers.resolveScopeFromAuth({
              token: typeof msg.token === 'string' ? msg.token : token,
              clientCode: typeof msg.client === 'string' ? msg.client : clientCode,
              accountId: typeof msg.account_id === 'string' ? msg.account_id : reqAccountId,
            });
            client.accountId = nextScope.accountId;
            client.isClient = nextScope.isClient;
          }
          providers.onClientPairSubscribe?.(client.subscribedPair, client.subscribedTimeframe);
          return;
        }
        if (msg.op === 'resync') {
          const snap = await providers.buildSnapshotForScope(client.accountId, client.isClient);
          safeSend(ws, { type: 'snapshot', data: snap });
        }
      } catch {
        // ignore invalid client frame
      }
    });

    ws.on('close', () => {
      uiClients.delete(client);
    });

    ws.on('error', () => {
      uiClients.delete(client);
    });

    // Send initial authoritative snapshot immediately on connect
    try {
      const snap = await providers.buildSnapshotForScope(client.accountId, client.isClient);
      safeSend(ws, { type: 'snapshot', data: snap });
    } catch {
      // ignore initial build error
    }
  });
}

export function queueLiveTickerBroadcast(frame: LiveTickerFrame): void {
  if (getConnectedUiClientsCount() === 0) return;
  pendingTickerUpdates.set(`${frame.exchange}:${frame.pair}`, frame);
  if (tickerFlushTimer) return;
  tickerFlushTimer = setTimeout(() => {
    tickerFlushTimer = null;
    if (pendingTickerUpdates.size === 0 || getConnectedUiClientsCount() === 0) {
      pendingTickerUpdates.clear();
      return;
    }
    const items = Array.from(pendingTickerUpdates.values());
    pendingTickerUpdates.clear();
    const payload = {
      type: 'ticker:batch',
      ts: Date.now(),
      tickers: items,
    };
    for (const c of uiClients) {
      safeSend(c.ws, payload);
    }
  }, 100);
}

export function broadcastLiveCandleTick(frame: LiveCandleFrame): void {
  if (getConnectedUiClientsCount() === 0) return;
  const payload = {
    type: 'candle:tick',
    ts: Date.now(),
    candle: frame,
  };
  for (const c of uiClients) {
    if (
      c.subscribedPair === frame.pair &&
      c.subscribedTimeframe === frame.interval
    ) {
      safeSend(c.ws, payload);
    }
  }
}

export function broadcastTradeLifecycleEvent(
  eventName: 'trade:opened' | 'trade:updated' | 'trade:closed',
  trade: any
): void {
  if (getConnectedUiClientsCount() === 0 || !trade) return;
  const targetAccId = trade.account_id || 'master';
  const payload = {
    type: eventName,
    ts: Date.now(),
    trade,
  };
  for (const c of uiClients) {
    if (c.accountId === targetAccId) {
      safeSend(c.ws, payload);
    }
  }
  scheduleScopeStateSync(targetAccId);
}

export function scheduleScopeStateSync(accountId?: string): void {
  if (getConnectedUiClientsCount() === 0 || !hubProviders) return;
  if (accountId) {
    pendingScopeSyncs.add(accountId);
  } else {
    for (const c of uiClients) {
      pendingScopeSyncs.add(c.accountId);
    }
  }
  if (stateSyncFlushTimer) return;
  stateSyncFlushTimer = setTimeout(async () => {
    stateSyncFlushTimer = null;
    if (!hubProviders || pendingScopeSyncs.size === 0) {
      pendingScopeSyncs.clear();
      return;
    }
    const scopes = Array.from(pendingScopeSyncs);
    pendingScopeSyncs.clear();

    for (const accId of scopes) {
      const matchingClients = Array.from(uiClients).filter(
        (c) => c.ws.readyState === WebSocket.OPEN && c.accountId === accId
      );
      if (matchingClients.length === 0) continue;
      const isClient = matchingClients[0].isClient;
      try {
        const snap = await hubProviders.buildSnapshotForScope(accId, isClient);
        const msg = { type: 'state:sync', ts: Date.now(), data: snap };
        for (const c of matchingClients) {
          safeSend(c.ws, msg);
        }
      } catch {
        // ignore snapshot error
      }
    }
  }, 50);
}
