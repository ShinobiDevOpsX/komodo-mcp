// komodo_client is written for the browser. Give it what it expects in Node.
// Must be imported before komodo_client (ES modules evaluate in import order).
import WebSocket from "ws";

const g = globalThis as any;

// mogh_auth_client reads localStorage at import time. Keep it in memory only,
// so nothing is written to disk.
if (!g.localStorage) {
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
}

// Node 20 has no global WebSocket; terminal calls need one.
g.WebSocket ??= WebSocket;
