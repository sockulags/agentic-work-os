import type {
  ClientRequest,
  ServerMessage,
  ServerPush,
  ServerResponseBody,
} from '@awos/protocol';

/**
 * Typed WebSocket client for the core.
 *
 * Requests are promise-based and correlated by requestId; pushes go to subscribers.
 * Reconnects with backoff, because a core restart during `npm run dev` is routine and
 * should not mean reloading the window.
 */

type PushListener = (push: ServerPush) => void;
type StatusListener = (status: ConnectionStatus) => void;

export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'unauthorized';

interface Pending {
  resolve: (body: ServerResponseBody) => void;
  reject: (err: Error) => void;
}

export interface ClientOptions {
  host: string;
  port: number;
  token: string;
}

/**
 * Where the connection details come from, in priority order:
 *
 *  1. `window.__AWOS__` — injected by the Tauri shell, which spawned the core and knows
 *     its randomly assigned port and token.
 *  2. Query parameters — handy for pointing a browser tab at a core you started yourself.
 *  3. Vite env / defaults — the `npm run dev` path, where the core pins the token to
 *     `dev-token` so no copying is needed.
 *
 * Same code in both environments; only the source of the values differs.
 */
export function resolveClientOptions(): ClientOptions {
  const injected = window.__AWOS__;
  if (injected) return injected;

  const params = new URLSearchParams(window.location.search);
  const env = import.meta.env;
  return {
    host: params.get('host') ?? env.VITE_AWOS_HOST ?? '127.0.0.1',
    port: Number(params.get('port') ?? env.VITE_AWOS_PORT ?? 4319),
    token: params.get('token') ?? env.VITE_AWOS_TOKEN ?? 'dev-token',
  };
}

export class HarnessClient {
  #socket: WebSocket | null = null;
  #options: ClientOptions;
  #nextId = 1;
  #status: ConnectionStatus = 'closed';
  #retryDelay = 500;
  #disposed = false;
  #reconnectTimer: number | null = null;

  readonly #pending = new Map<string, Pending>();
  readonly #pushListeners = new Set<PushListener>();
  readonly #statusListeners = new Set<StatusListener>();

  constructor(options: ClientOptions) {
    this.#options = options;
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  onPush(listener: PushListener): () => void {
    this.#pushListeners.add(listener);
    return () => this.#pushListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.#statusListeners.add(listener);
    listener(this.#status);
    return () => this.#statusListeners.delete(listener);
  }

  connect(): void {
    if (this.#disposed) return;
    if (this.#socket && this.#socket.readyState <= WebSocket.OPEN) return;

    this.#setStatus('connecting');
    const { host, port } = this.#options;
    const socket = new WebSocket(`ws://${host}:${port}`);
    this.#socket = socket;

    socket.addEventListener('open', () => {
      // The handshake is a normal request, so an auth failure surfaces as a rejection
      // rather than a silent half-open socket.
      void this.request({ type: 'hello', token: this.#options.token })
        .then(() => {
          this.#retryDelay = 500;
          this.#setStatus('open');
        })
        .catch(() => this.#setStatus('unauthorized'));
    });

    socket.addEventListener('message', (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }

      if ('requestId' in msg) {
        const pending = this.#pending.get(msg.requestId);
        if (!pending) return;
        this.#pending.delete(msg.requestId);
        if (msg.type === 'error') pending.reject(new Error(msg.message));
        else pending.resolve(msg);
        return;
      }

      for (const listener of this.#pushListeners) listener(msg);
    });

    socket.addEventListener('close', (event) => {
      this.#socket = null;
      this.#failAll(new Error('Connection to the harness closed.'));
      // 4001 is our own "bad token" code; retrying can only fail the same way.
      if (event.code === 4001) {
        this.#setStatus('unauthorized');
        return;
      }
      this.#setStatus('closed');
      this.#scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // 'close' always follows, so reconnect logic lives there only.
    });
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#reconnectTimer !== null) window.clearTimeout(this.#reconnectTimer);
    this.#socket?.close();
    this.#socket = null;
    this.#failAll(new Error('Client disposed.'));
  }

  request(req: ClientRequest): Promise<ServerResponseBody> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected to the harness.'));
    }

    const requestId = `r${this.#nextId++}`;
    return new Promise<ServerResponseBody>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      socket.send(JSON.stringify({ ...req, requestId }));
    });
  }

  #scheduleReconnect(): void {
    if (this.#disposed) return;
    if (this.#reconnectTimer !== null) window.clearTimeout(this.#reconnectTimer);
    const delay = this.#retryDelay;
    this.#retryDelay = Math.min(delay * 2, 10_000);
    this.#reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  #failAll(err: Error): void {
    for (const [, pending] of this.#pending) pending.reject(err);
    this.#pending.clear();
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
  }
}
