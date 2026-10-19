import { expect, test } from "bun:test";
import { createBrowserPairing, restoreBrowserSession, type BrowserPairingState, type PairingClock } from "../src/lib/browserPairing";

const TOKEN = "ab".repeat(32);
const startResponse = () => Response.json({ sid: "request-1", code: "012345", expires_in: 60 });
const flush = async () => { for (let i = 0; i < 15; i += 1) await Promise.resolve(); };

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: PairingClock = {
    now: () => now,
    setTimeout(run, delay) {
      const id = ++nextId;
      timers.set(id, { at: now + delay, run });
      return id;
    },
    clearTimeout(id) { timers.delete(id as number); },
  };
  return {
    clock,
    timers,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now && timers.delete(id)) timer.run();
      }
    },
  };
}

function setup(fetcher: typeof fetch = (async (path) => String(path).endsWith("/start")
  ? startResponse()
  : Response.json({ status: "pending" })) as typeof fetch) {
  const time = fakeClock();
  const states: BrowserPairingState[] = [];
  const tokens: string[] = [];
  const calls: { path: RequestInfo | URL; init?: RequestInit }[] = [];
  const model = createBrowserPairing({
    fetch: ((path, init) => { calls.push({ path, init }); return fetcher(path, init); }) as typeof fetch,
    onState: (state) => states.push(state),
    onVerified: (token) => tokens.push(token),
    clock: time.clock,
  });
  return { ...time, model, states, tokens, calls };
}

test("does not start on mount; explicit start sends remember choice without credentials in URL", async () => {
  for (const remember of [false, true]) {
    const s = setup();
    expect(s.calls).toHaveLength(0);
    await s.model.start(remember);
    expect(s.calls[0].path).toBe("/va/api/pair/browser/start");
    expect(s.calls[0].init).toMatchObject({
      method: "POST", body: JSON.stringify({ remember }), credentials: "same-origin",
      mode: "cors", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
    });
    expect(s.states.at(-1)).toEqual({ status: "pending", code: "012345", expiresAt: 60_000 });
    s.model.dispose();
    expect(s.timers.size).toBe(0);
  }
});

test("polls pending then accepts a verified per-device token exactly once", async () => {
  let statuses = 0;
  const s = setup((async (path) => String(path).endsWith("/start") ? startResponse()
    : Response.json(++statuses === 1 ? { status: "pending" } : { status: "verified", token: TOKEN })) as typeof fetch);
  await s.model.start(true);
  s.advance(1500);
  await flush();
  expect(s.calls[1].path).toBe("/va/api/pair/browser/status?sid=request-1");
  s.advance(1500);
  await flush();
  expect(s.states.at(-1)).toEqual({ status: "verified" });
  expect(s.tokens).toEqual([TOKEN]);
  expect(s.timers.size).toBe(0);
  s.advance(60_000);
  expect(s.tokens).toEqual([TOKEN]);
});

test("expiry and rejection stop polling and permit an explicit retry", async () => {
  for (const status of ["expired", "rejected"] as const) {
    const s = setup((async (path) => String(path).endsWith("/start") ? startResponse() : Response.json({ status })) as typeof fetch);
    await s.model.start(false);
    s.advance(1500);
    await flush();
    expect(s.states.at(-1)).toEqual({ status });
    expect(s.timers.size).toBe(0);
    expect(s.tokens).toEqual([]);
    await s.model.start(true);
    expect(s.states.at(-1)?.status).toBe("pending");
    s.model.dispose();
  }
});

test("late status after expiry never authenticates, even if fetch ignores abort", async () => {
  let resolve!: (response: Response) => void;
  const s = setup(((path) => String(path).endsWith("/start") ? Promise.resolve(startResponse()) : new Promise((done) => { resolve = done; })) as typeof fetch);
  await s.model.start(false);
  s.advance(1500);
  s.advance(58_500);
  expect(s.states.at(-1)).toEqual({ status: "expired" });
  expect(s.calls[1].init?.signal?.aborted).toBe(true);
  resolve(Response.json({ status: "verified", token: TOKEN }));
  await flush();
  expect(s.tokens).toEqual([]);
  expect(s.states.at(-1)).toEqual({ status: "expired" });
});

test("cancel, dispose, and restart ignore a late start response", async () => {
  for (const action of ["cancel", "dispose", "restart"] as const) {
    let resolve!: (response: Response) => void;
    let starts = 0;
    const s = setup((() => ++starts === 1 ? new Promise((done) => { resolve = done; }) : Promise.resolve(startResponse())) as typeof fetch);
    const first = s.model.start(false);
    if (action === "restart") await s.model.start(true);
    else s.model[action]();
    const last = s.states.at(-1);
    resolve(startResponse());
    await first;
    expect(s.states.at(-1)).toBe(last);
    expect(s.tokens).toEqual([]);
    s.model.dispose();
    expect(s.timers.size).toBe(0);
  }
});

test("cancel and dispose suppress late verified responses and side effects", async () => {
  for (const action of ["cancel", "dispose"] as const) {
    let resolve!: (response: Response) => void;
    const s = setup(((path) => String(path).endsWith("/start") ? Promise.resolve(startResponse()) : new Promise((done) => { resolve = done; })) as typeof fetch);
    await s.model.start(false);
    s.advance(1500);
    s.model[action]();
    const last = s.states.at(-1);
    resolve(Response.json({ status: "verified", token: TOKEN }));
    await flush();
    expect(s.states.at(-1)).toBe(last);
    expect(s.tokens).toEqual([]);
    expect(s.timers.size).toBe(0);
  }
});

test("start and status network failures fail clearly without automatic retry", async () => {
  for (const phase of ["start", "status"]) {
    const s = setup((async (path) => {
      if (phase === "start" || !String(path).endsWith("/start")) throw new Error("private server details");
      return startResponse();
    }) as typeof fetch);
    await s.model.start(false);
    s.advance(1500);
    await flush();
    expect(s.states.at(-1)).toEqual({ status: "failed" });
    expect(s.timers.size).toBe(0);
    expect(s.tokens).toEqual([]);
  }
});

test("hung requests are bounded even when fetch ignores abort", async () => {
  const s = setup((() => new Promise(() => {})) as typeof fetch);
  void s.model.start(false);
  s.advance(15_000);
  expect(s.states.at(-1)).toEqual({ status: "failed" });
  expect(s.calls[0].init?.signal?.aborted).toBe(true);
  expect(s.timers.size).toBe(0);
});

test("network time never extends the code lifetime", async () => {
  let resolve!: (response: Response) => void;
  const s = setup((() => new Promise((done) => { resolve = done; })) as typeof fetch);
  const starting = s.model.start(false);
  s.advance(3000);
  resolve(startResponse());
  await starting;
  expect(s.states.at(-1)).toEqual({ status: "pending", code: "012345", expiresAt: 60_000 });
  s.model.dispose();
});

test("malformed starts and verified responses fail closed", async () => {
  for (const body of [null, {}, { sid: "bad&sid=x", code: "123456", expires_in: 60 }, { sid: "ok", code: 123456, expires_in: 60 }, { sid: "ok", code: "12345", expires_in: 60 }, { sid: "ok", code: "123456", expires_in: 601 }]) {
    const s = setup((async () => Response.json(body)) as typeof fetch);
    await s.model.start(false);
    expect(s.states.at(-1)).toEqual({ status: "failed" });
    expect(s.tokens).toEqual([]);
    expect(s.timers.size).toBe(0);
  }
  for (const body of [{ status: "verified" }, { status: "verified", token: "not-a-device-token" }, { status: "unknown" }]) {
    const s = setup((async (path) => String(path).endsWith("/start") ? startResponse() : Response.json(body)) as typeof fetch);
    await s.model.start(false);
    s.advance(1500);
    await flush();
    expect(s.states.at(-1)).toEqual({ status: "failed" });
    expect(s.tokens).toEqual([]);
  }
});

test("cookie bootstrap restores the session using same-origin raw fetch", async () => {
  let token: string | null = null;
  const result = await restoreBrowserSession({
    hasQrInvitation: false,
    getAuthToken: () => token,
    setAuthToken: (value) => { token = value; },
    fetch: (async (path, init) => {
      expect(path).toBe("/va/api/pair/browser/session");
      expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store", redirect: "error" });
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      return Response.json({ status: "verified", token: TOKEN });
    }) as typeof fetch,
  });
  expect(result).toBe("restored");
  expect(token).toBe(TOKEN);
});

test("QR invitations and existing bearer credentials bypass cookie bootstrap", async () => {
  for (const [hasQrInvitation, token] of [[true, null], [false, TOKEN]] as const) {
    let calls = 0;
    expect(await restoreBrowserSession({
      hasQrInvitation, getAuthToken: () => token,
      setAuthToken: () => { throw new Error("must not replace auth"); },
      fetch: (async () => { calls += 1; return Response.json({}); }) as typeof fetch,
    })).toBe("skipped");
    expect(calls).toBe(0);
  }
});

test("a revoked or missing cookie reaches the gate without reload or storing credentials", async () => {
  for (const status of [401, 500]) {
    let writes = 0;
    expect(await restoreBrowserSession({
      hasQrInvitation: false, getAuthToken: () => null,
      setAuthToken: () => { writes += 1; },
      fetch: (async () => new Response(null, { status })) as typeof fetch,
    })).toBe(status === 401 ? "anonymous" : "unavailable");
    expect(writes).toBe(0);
  }
});

test("bootstrap malformed token, network failure, or newer bearer never overwrite auth", async () => {
  for (const outcome of ["malformed", "failure", "newer"] as const) {
    let token: string | null = null;
    let writes = 0;
    const result = await restoreBrowserSession({
      hasQrInvitation: false, getAuthToken: () => token,
      setAuthToken: () => { writes += 1; },
      fetch: (async () => {
        if (outcome === "failure") throw new Error("offline");
        if (outcome === "newer") token = "newer-token";
        return Response.json({ status: "verified", token: outcome === "malformed" ? "bad" : TOKEN });
      }) as typeof fetch,
    });
    expect(result).toBe(outcome === "newer" ? "skipped" : "unavailable");
    expect(writes).toBe(0);
  }
});
