import { expect, test } from "bun:test";
import { changeBrowserPairing, createBrowserPairingManager, loadBrowserPairing, type BrowserPairingSnapshot } from "../src/remote-dashboard/browserPairingModel";

const pending = { id: "request-1", code: "012345", label: "Chrome on Android", remember: true, expires_in: 60 };
const device = { id: "device-1", label: "Safari on iPhone", remember: false, created_at: 100, expires_at: 86_500 };
const signal = () => new AbortController().signal;
const flush = async () => { for (let i = 0; i < 25; i += 1) await Promise.resolve(); };

function response(path: string) {
  return Response.json(path.endsWith("/requests") ? { requests: [pending] } : { devices: [device] });
}

test("loads pending codes and both session and remembered devices via local authenticated paths", async () => {
  const calls: string[] = [];
  let now = 1000;
  const data = await loadBrowserPairing(async (path, init) => {
    calls.push(path);
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("error");
    now = 3000;
    return response(path);
  }, signal(), () => now);
  expect(calls).toEqual(["/api/pair/browser/requests", "/api/pair/devices"]);
  expect(data.requests).toEqual([{ id: pending.id, code: pending.code, label: pending.label, remember: true, expiresAt: 61_000 }]);
  expect(data.devices).toEqual([{ id: device.id, label: device.label, remember: false, createdAt: 100_000, expiresAt: 86_500_000 }]);
});

test("approval includes exact matched code; reject and revoke never send token material", async () => {
  for (const action of ["approve", "reject", "revoke"] as const) {
    await changeBrowserPairing(action, "request-1", "012345", async (path, init) => {
      expect(path).toBe(action === "revoke" ? "/api/pair/devices/request-1" : `/api/pair/browser/${action}`);
      expect(init.method).toBe(action === "revoke" ? "DELETE" : "POST");
      expect(init.body).toBe(action === "approve" ? '{"id":"request-1","code":"012345"}' : action === "reject" ? '{"id":"request-1"}' : undefined);
      return new Response(null, { status: 204 });
    }, signal());
  }
});

test("invalid identities, codes and server failures fail without revealing response bodies", async () => {
  const fetcher = async () => { throw new Error("must not fetch"); };
  await expect(changeBrowserPairing("approve", "ok", undefined, fetcher, signal())).rejects.toThrow("Invalid pairing action");
  await expect(changeBrowserPairing("revoke", "../owner", undefined, fetcher, signal())).rejects.toThrow("Invalid pairing action");
  await expect(changeBrowserPairing("reject", "ok", undefined, async () => new Response("private details", { status: 409 }), signal())).rejects.toThrow("Pairing action failed");
  for (const item of [{ ...pending, code: 123456 }, { ...pending, expires_in: -1 }, { ...pending, id: "bad/path" }]) {
    await expect(loadBrowserPairing(async (path) => path.endsWith("/requests") ? Response.json({ requests: [item] }) : response(path), signal())).rejects.toThrow();
  }
});

test("aborted list and action ignore late responses even when fetch ignores abort", async () => {
  const controller = new AbortController();
  let resolve!: (response: Response) => void;
  const action = changeBrowserPairing("reject", "request-1", undefined, () => new Promise((done) => { resolve = done; }), controller.signal);
  controller.abort();
  resolve(new Response(null, { status: 204 }));
  await expect(action).rejects.toThrow();
  const listController = new AbortController();
  await expect(loadBrowserPairing(async (path) => {
    listController.abort();
    return response(path);
  }, listController.signal)).rejects.toThrow();
});

function setup(fetcher: (path: string, init: RequestInit) => Promise<Response> = async (path, init) => init.method ? new Response(null, { status: 204 }) : response(path)) {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const states: BrowserPairingSnapshot[] = [];
  const calls: { path: string; init: RequestInit }[] = [];
  const manager = createBrowserPairingManager({
    fetch: (path, init) => { calls.push({ path, init }); return fetcher(path, init); },
    onState: (state) => states.push(state),
    clock: {
      now: () => now,
      setTimeout(callback, delay) { const key = ++id; timers.set(key, { at: now + delay, callback }); return key; },
      clearTimeout(key) { timers.delete(key as number); },
    },
  });
  return { manager, calls, states, timers, advance(ms: number) {
    now += ms;
    for (const [key, timer] of [...timers]) if (timer.at <= now && timers.delete(key)) timer.callback();
  } };
}

test("manager polls only after mounting and stops on dispose", async () => {
  const s = setup();
  expect(s.calls).toHaveLength(0);
  await s.manager.refresh();
  expect(s.calls).toHaveLength(2);
  expect(s.states.at(-1)?.requests).toHaveLength(1);
  s.advance(2500);
  await flush();
  expect(s.calls).toHaveLength(4);
  s.manager.dispose();
  expect(s.timers.size).toBe(0);
  s.advance(60_000);
  expect(s.calls).toHaveLength(4);
});

test("approval cannot run with an unmatched or expired code", async () => {
  const s = setup();
  await s.manager.refresh();
  await s.manager.act("approve", pending.id, "654321");
  await s.manager.act("approve", "other-id", pending.code);
  expect(s.calls.filter((call) => call.init.method)).toHaveLength(0);
  s.advance(60_001);
  await s.manager.act("approve", pending.id, pending.code);
  expect(s.calls.filter((call) => call.init.method)).toHaveLength(0);
  s.manager.dispose();
});

test("actions are single-flight, refresh lists on success, and do not autoapprove pending requests", async () => {
  let resolve!: (response: Response) => void;
  const s = setup((path, init) => init.method ? new Promise((done) => { resolve = done; }) : Promise.resolve(response(path)));
  await s.manager.refresh();
  expect(s.calls.filter((call) => call.init.method)).toHaveLength(0);
  const approve = s.manager.act("approve", pending.id, pending.code);
  expect(s.states.at(-1)?.busyId).toBe(pending.id);
  await s.manager.act("reject", pending.id);
  expect(s.calls.filter((call) => call.init.method)).toHaveLength(1);
  resolve(new Response(null, { status: 204 }));
  await approve;
  await flush();
  expect(s.states.at(-1)?.busyId).toBeNull();
  expect(s.calls).toHaveLength(5);
  s.manager.dispose();
});

test("load failures hide stale approvals, action failures stay visible after refresh", async () => {
  let failLoad = false;
  const s = setup(async (path, init) => init.method || failLoad ? new Response(null, { status: 500 }) : response(path));
  await s.manager.refresh();
  await s.manager.act("reject", pending.id);
  await flush();
  expect(s.states.at(-1)?.error).toBe("action");
  expect(s.states.at(-1)?.busyId).toBeNull();
  failLoad = true;
  await s.manager.refresh();
  expect(s.states.at(-1)?.error).toBe("load");
  expect(s.states.at(-1)?.requests).toEqual([]);
  s.manager.dispose();
});

test("hung loads time out and stale data cannot arrive after dispose", async () => {
  const resolvers: ((response: Response) => void)[] = [];
  const s = setup(() => new Promise((done) => resolvers.push(done)));
  const loading = s.manager.refresh();
  s.advance(15_000);
  expect(s.states.at(-1)?.error).toBe("load");
  expect(s.calls[0].init.signal?.aborted).toBe(true);
  s.manager.dispose();
  const last = s.states.at(-1);
  resolvers[0](response("/requests"));
  resolvers[1](response("/devices"));
  await loading;
  expect(s.states.at(-1)).toBe(last);
  expect(s.timers.size).toBe(0);
});
