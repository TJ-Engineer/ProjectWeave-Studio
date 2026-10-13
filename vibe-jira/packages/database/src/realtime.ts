import { boardChangeEventSchema, type BoardChangeEvent } from "@vibe/contracts";
import { Client } from "pg";

export type BoardRealtimeMessage =
  { type: "sync" } | { type: "change"; event: BoardChangeEvent };

type Subscriber = {
  projectId: string;
  receive: (message: BoardRealtimeMessage) => void;
};

type BoardEventHub = {
  client: Client | null;
  connectPromise: Promise<void> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  subscribers: Map<symbol, Subscriber>;
};

declare global {
  var __vibeBoardEventHub: BoardEventHub | undefined;
}

function hub(): BoardEventHub {
  globalThis.__vibeBoardEventHub ??= {
    client: null,
    connectPromise: null,
    reconnectTimer: null,
    subscribers: new Map(),
  };
  return globalThis.__vibeBoardEventHub;
}

function scheduleReconnect(state: BoardEventHub): void {
  if (state.subscribers.size === 0 || state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connect(state).catch(() => scheduleReconnect(state));
  }, 1_000);
}

async function disconnect(state: BoardEventHub, client: Client): Promise<void> {
  if (state.client !== client) return;
  state.client = null;
  try {
    await client.end();
  } catch {
    // The connection may already be closed after an error.
  }
  scheduleReconnect(state);
}

async function connect(state: BoardEventHub): Promise<void> {
  if (state.client) return;
  if (state.connectPromise) return state.connectPromise;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  state.connectPromise = (async () => {
    const client = new Client({ connectionString, keepAlive: true });
    client.on("notification", (notification) => {
      if (notification.channel !== "vibe_board_changes") return;
      let payload: unknown = null;
      try {
        payload = notification.payload
          ? (JSON.parse(notification.payload) as unknown)
          : null;
      } catch {
        return;
      }
      const parsed = boardChangeEventSchema.safeParse(payload);
      if (!parsed.success) return;
      for (const subscriber of state.subscribers.values()) {
        if (subscriber.projectId === parsed.data.projectId) {
          subscriber.receive({ type: "change", event: parsed.data });
        }
      }
    });
    client.on("error", () => {
      void disconnect(state, client);
    });
    client.on("end", () => {
      if (state.client === client) {
        state.client = null;
        scheduleReconnect(state);
      }
    });
    await client.connect();
    await client.query("LISTEN vibe_board_changes");
    state.client = client;
    for (const subscriber of state.subscribers.values()) {
      subscriber.receive({ type: "sync" });
    }
  })();

  try {
    await state.connectPromise;
  } finally {
    state.connectPromise = null;
  }
}

export async function subscribeToBoardChanges(
  projectId: string,
  receive: (message: BoardRealtimeMessage) => void,
): Promise<() => void> {
  const state = hub();
  const token = Symbol(projectId);
  state.subscribers.set(token, { projectId, receive });
  try {
    await connect(state);
  } catch (error) {
    state.subscribers.delete(token);
    throw error;
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    state.subscribers.delete(token);
    if (state.subscribers.size > 0) return;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    const client = state.client;
    state.client = null;
    if (client) void client.end();
  };
}
