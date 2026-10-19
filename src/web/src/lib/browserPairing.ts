export type BrowserPairingState =
  | { status: "idle" | "starting" | "expired" | "rejected" | "failed" | "verified" }
  | { status: "pending"; code: string; expiresAt: number };

export type PairingClock = {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (timer: unknown) => void;
};

const clock: PairingClock = {
  now: Date.now,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
const REQUEST_TIMEOUT = 15_000;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
const requestOptions: RequestInit = {
  credentials: "same-origin",
  mode: "cors",
  cache: "no-store",
  redirect: "error",
  referrerPolicy: "no-referrer",
};

function verifiedToken(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("status" in data) || data.status !== "verified") return null;
  return "token" in data && typeof data.token === "string" && TOKEN_PATTERN.test(data.token)
    ? data.token
    : null;
}

/** Use the original fetch, not the bearer/401 reload wrapper. A missing cookie is normal. */
export async function restoreBrowserSession(dependencies: {
  hasQrInvitation: boolean;
  getAuthToken: () => string | null;
  setAuthToken: (token: string) => void;
  fetch: typeof fetch;
}): Promise<"skipped" | "restored" | "anonymous" | "unavailable"> {
  if (dependencies.hasQrInvitation || dependencies.getAuthToken()) return "skipped";
  try {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT);
    const response = await dependencies.fetch("/va/api/pair/browser/session", {
      ...requestOptions,
      headers: { "bypass-tunnel-reminder": "1" },
      signal,
    });
    signal.throwIfAborted();
    if (response.status === 401) return "anonymous";
    if (!response.ok) return "unavailable";
    const token = verifiedToken(await response.json());
    signal.throwIfAborted();
    if (!token) return "unavailable";
    // Never overwrite a credential supplied while the cookie request was in flight.
    if (dependencies.getAuthToken()) return "skipped";
    dependencies.setAuthToken(token);
    return "restored";
  } catch {
    return "unavailable";
  }
}

/** Explicitly started, single-flight pairing with bounded requests and no stale callbacks. */
export function createBrowserPairing(dependencies: {
  fetch: typeof fetch;
  onState: (state: BrowserPairingState) => void;
  onVerified: (token: string) => void;
  clock?: PairingClock;
}) {
  const time = dependencies.clock ?? clock;
  let generation = 0;
  let disposed = false;
  let request: AbortController | null = null;
  const timers = new Set<unknown>();

  function schedule(callback: () => void, delay: number) {
    const timer = time.setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
    return timer;
  }

  function stop() {
    generation += 1;
    request?.abort();
    request = null;
    for (const timer of timers) time.clearTimeout(timer);
    timers.clear();
  }

  function finish(status: "expired" | "rejected" | "failed" | "verified") {
    stop();
    if (!disposed) dependencies.onState({ status });
  }

  async function fetchJson(path: string, init: RequestInit, attempt: number): Promise<unknown> {
    const controller = new AbortController();
    request = controller;
    const timeout = schedule(() => {
      if (attempt === generation && !disposed) finish("failed");
    }, REQUEST_TIMEOUT);
    try {
      const response = await dependencies.fetch(path, { ...requestOptions, ...init, signal: controller.signal });
      controller.signal.throwIfAborted();
      if (!response.ok) throw new Error("Pairing request failed");
      const data: unknown = await response.json();
      controller.signal.throwIfAborted();
      return data;
    } finally {
      time.clearTimeout(timeout);
      timers.delete(timeout);
      if (request === controller) request = null;
    }
  }

  async function poll(sid: string, expiresAt: number, attempt: number): Promise<void> {
    if (disposed || attempt !== generation) return;
    if (time.now() >= expiresAt) return finish("expired");
    try {
      const data = await fetchJson(`/va/api/pair/browser/status?sid=${encodeURIComponent(sid)}`, {}, attempt);
      if (disposed || attempt !== generation) return;
      if (time.now() >= expiresAt) return finish("expired");
      if (!data || typeof data !== "object" || !("status" in data)) throw new Error("Invalid status");
      if (data.status === "verified") {
        const token = verifiedToken(data);
        if (!token) throw new Error("Invalid token");
        finish("verified");
        dependencies.onVerified(token);
      } else if (data.status === "expired" || data.status === "rejected") {
        finish(data.status);
      } else if (data.status === "pending") {
        schedule(() => void poll(sid, expiresAt, attempt), 1500);
      } else {
        throw new Error("Invalid status");
      }
    } catch {
      if (!disposed && attempt === generation) finish("failed");
    }
  }

  async function start(remember: boolean) {
    if (disposed) return;
    stop();
    const attempt = generation;
    const startedAt = time.now();
    dependencies.onState({ status: "starting" });
    try {
      const data = await fetchJson("/va/api/pair/browser/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remember }),
      }, attempt);
      if (disposed || attempt !== generation) return;
      if (
        !data || typeof data !== "object" ||
        !("sid" in data) || typeof data.sid !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(data.sid) ||
        !("code" in data) || typeof data.code !== "string" || !/^\d{6}$/.test(data.code) ||
        !("expires_in" in data) || typeof data.expires_in !== "number" ||
        !Number.isInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 600
      ) throw new Error("Invalid pairing response");
      const expiresAt = startedAt + data.expires_in * 1000;
      if (time.now() >= expiresAt) return finish("expired");
      dependencies.onState({ status: "pending", code: data.code, expiresAt });
      schedule(() => finish("expired"), expiresAt - time.now());
      schedule(() => void poll(data.sid as string, expiresAt, attempt), 1500);
    } catch {
      if (!disposed && attempt === generation) finish("failed");
    }
  }

  return {
    start,
    cancel() {
      stop();
      if (!disposed) dependencies.onState({ status: "idle" });
    },
    dispose() {
      disposed = true;
      stop();
    },
  };
}
