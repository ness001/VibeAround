export type BrowserPairingRequest = {
  id: string;
  code: string;
  label: string;
  remember: boolean;
  expiresAt: number;
};

export type PairedDevice = {
  id: string;
  label: string;
  remember: boolean;
  createdAt: number;
  expiresAt: number;
};

export type BrowserPairingSnapshot = {
  requests: BrowserPairingRequest[];
  devices: PairedDevice[];
  loading: boolean;
  busyId: string | null;
  error: "load" | "action" | null;
};

type PairingFetch = (path: string, init: RequestInit) => Promise<Response>;
type Clock = {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (timer: unknown) => void;
};
const clock: Clock = {
  now: Date.now,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function record(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") throw new Error("Invalid pairing response");
  return data as Record<string, unknown>;
}

function identity(data: Record<string, unknown>) {
  if (
    typeof data.id !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(data.id) ||
    typeof data.label !== "string" || data.label.length > 512 || typeof data.remember !== "boolean"
  ) throw new Error("Invalid pairing identity");
  return { id: data.id, label: data.label, remember: data.remember };
}

export async function loadBrowserPairing(fetcher: PairingFetch, signal: AbortSignal, now = Date.now): Promise<Pick<BrowserPairingSnapshot, "requests" | "devices">> {
  signal.throwIfAborted();
  const startedAt = now();
  const options: RequestInit = { cache: "no-store", redirect: "error", signal };
  const responses = await Promise.all([
    fetcher("/api/pair/browser/requests", options),
    fetcher("/api/pair/devices", options),
  ]);
  signal.throwIfAborted();
  if (responses.some((response) => !response.ok)) throw new Error("Pairing load failed");
  const [pending, paired] = await Promise.all(responses.map(async (response) => record(await response.json())));
  signal.throwIfAborted();
  if (!Array.isArray(pending.requests) || !Array.isArray(paired.devices)) throw new Error("Invalid pairing lists");
  const requests = pending.requests.map((value) => {
    const item = record(value);
    const info = identity(item);
    if (
      typeof item.code !== "string" || !/^\d{6}$/.test(item.code) ||
      typeof item.expires_in !== "number" || !Number.isInteger(item.expires_in) || item.expires_in < 0 || item.expires_in > 600
    ) throw new Error("Invalid pairing request");
    return { ...info, code: item.code, expiresAt: startedAt + item.expires_in * 1000 };
  });
  const devices = paired.devices.map((value) => {
    const item = record(value);
    const info = identity(item);
    if (
      typeof item.created_at !== "number" || !Number.isSafeInteger(item.created_at) || item.created_at < 0 ||
      typeof item.expires_at !== "number" || !Number.isSafeInteger(item.expires_at) || item.expires_at < item.created_at
    ) throw new Error("Invalid device expiry");
    return { ...info, createdAt: item.created_at * 1000, expiresAt: item.expires_at * 1000 };
  });
  return { requests, devices };
}

export async function changeBrowserPairing(
  action: "approve" | "reject" | "revoke",
  id: string,
  code: string | undefined,
  fetcher: PairingFetch,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!/^[a-z0-9_-]{1,128}$/i.test(id) || (action === "approve" && !/^\d{6}$/.test(code ?? ""))) throw new Error("Invalid pairing action");
  const response = await fetcher(
    action === "revoke" ? `/api/pair/devices/${encodeURIComponent(id)}` : `/api/pair/browser/${action}`,
    {
      method: action === "revoke" ? "DELETE" : "POST",
      headers: { "Content-Type": "application/json" },
      ...(action !== "revoke" && { body: JSON.stringify(action === "approve" ? { id, code } : { id }) }),
      cache: "no-store",
      redirect: "error",
      signal,
    },
  );
  signal.throwIfAborted();
  if (!response.ok) throw new Error("Pairing action failed");
}

/** Only runs while the Remote view is mounted. Never overlaps refreshes or replays mutations. */
export function createBrowserPairingManager(dependencies: {
  fetch: PairingFetch;
  onState: (state: BrowserPairingSnapshot) => void;
  clock?: Clock;
}) {
  const time = dependencies.clock ?? clock;
  let disposed = false;
  let generation = 0;
  let controller: AbortController | null = null;
  let timer: unknown;
  let timeout: unknown;
  let state: BrowserPairingSnapshot = { requests: [], devices: [], loading: true, busyId: null, error: null };

  function emit(next: Partial<BrowserPairingSnapshot>) {
    state = { ...state, ...next };
    if (!disposed) dependencies.onState(state);
  }

  function stop() {
    generation += 1;
    controller?.abort();
    controller = null;
    time.clearTimeout(timer);
    time.clearTimeout(timeout);
  }

  function scheduleRefresh() {
    if (!disposed) timer = time.setTimeout(() => void refresh(), 2500);
  }

  function begin(kind: "load" | "action") {
    stop();
    const current = generation;
    const abort = new AbortController();
    controller = abort;
    timeout = time.setTimeout(() => {
      if (disposed || current !== generation) return;
      stop();
      emit({ loading: false, busyId: null, error: kind, ...(kind === "load" && { requests: [] }) });
      scheduleRefresh();
    }, 15_000);
    return { current, signal: abort.signal };
  }

  async function refresh() {
    if (disposed || state.busyId) return;
    const { current, signal } = begin("load");
    try {
      const data = await loadBrowserPairing(dependencies.fetch, signal, time.now);
      if (disposed || current !== generation) return;
      emit({ ...data, loading: false, error: state.error === "action" ? "action" : null });
    } catch {
      if (disposed || current !== generation) return;
      emit({ loading: false, requests: [], error: "load" });
    } finally {
      if (!disposed && current === generation) {
        time.clearTimeout(timeout);
        controller = null;
        scheduleRefresh();
      }
    }
  }

  async function act(action: "approve" | "reject" | "revoke", id: string, code?: string) {
    if (disposed || state.busyId) return;
    if (action === "approve" && !state.requests.some((item) => item.id === id && item.code === code && item.expiresAt > time.now())) return;
    const { current, signal } = begin("action");
    emit({ busyId: id, error: null });
    try {
      await changeBrowserPairing(action, id, code, dependencies.fetch, signal);
      if (disposed || current !== generation) return;
      emit({
        busyId: null,
        requests: action === "revoke" ? state.requests : state.requests.filter((item) => item.id !== id),
        devices: action === "revoke" ? state.devices.filter((item) => item.id !== id) : state.devices,
      });
    } catch {
      if (disposed || current !== generation) return;
      emit({ busyId: null, error: "action" });
    } finally {
      if (!disposed && current === generation) {
        time.clearTimeout(timeout);
        controller = null;
        void refresh();
      }
    }
  }

  return {
    refresh,
    act,
    dispose() {
      disposed = true;
      stop();
    },
  };
}
