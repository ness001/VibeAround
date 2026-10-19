import { expect, spyOn, test } from "bun:test";

import { initPairingAuth, watchPairingNavigation } from "../src/lib/qrPairing";

const ORIGIN = "https://phone.example";
const TICKET = "a1".repeat(32);
const TOKEN = "b2".repeat(32);

function setup(
  path: string,
  request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> =
    async () => Response.json({ status: "verified", token: TOKEN }),
) {
  let address = new URL(path, ORIGIN);
  let storedToken: string | null = "stale-token-from-another-installation";
  const events: string[] = [];
  const requests: { input: RequestInfo | URL; init?: RequestInit; token: string | null; hash: string }[] = [];
  const redirects: string[] = [];
  const browser = {
    location: { href: address.href, origin: address.origin },
    history: {
      replaceState(_state: unknown, _unused: string, url?: string | URL | null) {
        events.push("strip");
        address = new URL(String(url), address);
      },
    },
  };
  const attempt = initPairingAuth(browser, {
    clearAuthToken() {
      events.push("clear");
      storedToken = null;
    },
    initAuthFromUrl() {
      events.push("legacy-auth");
    },
    setAuthToken(token) {
      events.push("store");
      storedToken = token;
    },
    fetch: ((input, init) => {
      events.push("fetch");
      requests.push({ input, init, token: storedToken, hash: address.hash });
      return request(input, init);
    }) as typeof fetch,
    redirect(destination) {
      events.push("redirect");
      redirects.push(destination);
    },
  });
  return {
    attempt, events, requests, redirects,
    address: () => address,
    storedToken: () => storedToken,
  };
}

test("reloads once for a QR fragment delivered to an existing or restored tab", () => {
  for (const event of ["hashchange", "pageshow"] as const) {
    const listeners = new Map<string, () => void>();
    let reloads = 0;
    const browser = {
      location: { hash: "", reload: () => { reloads += 1; } },
      addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); },
      removeEventListener: (type: string) => { listeners.delete(type); },
    };
    const stop = watchPairingNavigation(browser);
    for (const hash of ["", "#content", "#repair=unrelated"]) {
      browser.location.hash = hash;
      listeners.get(event)!();
    }
    expect(reloads).toBe(0);
    browser.location.hash = `#pair=${TICKET}`;
    listeners.get(event)!();
    listeners.get("hashchange")!();
    listeners.get("pageshow")!();
    expect(reloads).toBe(1);
    expect(browser.location.hash).toBe(`#pair=${TICKET}`);
    stop();
    expect(listeners.size).toBe(0);
  }
});

test("re-enters bootstrap for malformed QR fragments so validation can clean them", () => {
  for (const hash of ["#pair", "#pair=bad", `#pair=${TICKET}&pair=${TICKET}`]) {
    let onChange = () => {};
    let reloads = 0;
    watchPairingNavigation({
      location: { hash, reload: () => { reloads += 1; } },
      addEventListener: (type, listener) => { if (type === "hashchange") onChange = listener; },
      removeEventListener: () => {},
    });
    onChange();
    expect(reloads).toBe(1);
  }
});

test("strips the fragment and foreign query token before clearing stale auth or fetching", async () => {
  const state = setup(`/va/?token=foreign-token&view=mobile#pair=${TICKET}`);
  expect(state.address().href).toBe(`${ORIGIN}/va/?view=mobile`);
  expect(state.events).toEqual(["strip", "clear"]);
  expect(state.storedToken()).toBeNull();
  expect(state.requests).toHaveLength(0);

  await state.attempt!.redeem();
  expect(state.events).toEqual(["strip", "clear", "fetch", "store", "redirect"]);
  expect(state.requests[0].token).toBeNull();
  expect(state.requests[0].hash).toBe("");
  expect(state.storedToken()).toBe(TOKEN);
});

test("preserves unrelated fragments and existing auth initialization when there is no invitation", () => {
  for (const hash of ["", "#content", "#view=mobile", "#repair=unrelated"]) {
    const state = setup(`/va/?token=legacy-token${hash}`);
    expect(state.attempt).toBeNull();
    expect(state.address().hash).toBe(hash);
    expect(state.address().search).toBe("?token=legacy-token");
    expect(state.events).toEqual(["legacy-auth"]);
  }
});

test("cleans every malformed pair fragment and never sends it to the server", async () => {
  for (const hash of [
    "#pair", "#pair=", "#pair=bad", `#pair=${"a".repeat(63)}`,
    `#pair=${"a".repeat(65)}`, `#pair=${"g".repeat(64)}`, `#pair=${TICKET.toUpperCase()}`,
    `#pair=${TICKET}&pair=${TICKET}`, "#view=mobile&pair=%ZZ", "#%70air=bad",
  ]) {
    const state = setup(`/va/?token=foreign-token&token=another${hash}`);
    expect(state.address().href).toBe(`${ORIGIN}/va/`);
    expect(state.storedToken()).toBeNull();
    expect(await state.attempt!.redeem()).toEqual({ status: "invalid" });
    expect(state.requests).toHaveLength(0);
    expect(state.redirects).toHaveLength(0);
    expect(state.events).toEqual(["strip", "clear"]);
  }
});

test("uses one cached POST across StrictMode-equivalent effect remounts", async () => {
  let respond!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { respond = resolve; });
  const state = setup(`/va/#pair=${TICKET}`, () => response);
  const first = state.attempt!.redeem();
  const remount = state.attempt!.redeem();
  expect(remount).toBe(first);
  expect(state.requests).toHaveLength(1);

  respond(Response.json({ status: "verified", token: TOKEN }));
  expect(await first).toEqual({ status: "verified" });
  expect(state.attempt!.redeem()).toBe(first);
  expect(await remount).toEqual({ status: "verified" });
  expect(state.requests).toHaveLength(1);
  expect(state.redirects).toEqual(["/va/"]);
  expect(state.events.filter((event) => event === "store")).toHaveLength(1);
});

test("keeps the ticket POST same-origin while preserving WebKit Origin with cors mode", async () => {
  const state = setup(`/va/#pair=${TICKET}`);
  await state.attempt!.redeem();
  const { input, init } = state.requests[0];
  expect(input).toBe("/va/api/pair/redeem");
  expect(init).toEqual({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket: TICKET }),
    credentials: "same-origin",
    mode: "cors",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    redirect: "error",
    signal: expect.any(AbortSignal),
  });
});

test("a bounded request timeout fails once without retrying redemption", async () => {
  const controller = new AbortController();
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  try {
    const state = setup(`/va/#pair=${TICKET}`, (_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const first = state.attempt!.redeem();
    expect(timeout).toHaveBeenCalledWith(15_000);
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
    expect(await first).toEqual({ status: "failed" });
    expect(state.attempt!.redeem()).toBe(first);
    expect(await state.attempt!.redeem()).toEqual({ status: "failed" });
    expect(state.requests).toHaveLength(1);
    expect(state.storedToken()).toBeNull();
    expect(state.redirects).toHaveLength(0);
  } finally {
    timeout.mockRestore();
  }
});

test("stores a verified token before redirecting to a same-origin destination", async () => {
  const next = "/va/preview/u/readme?view=compact#content";
  const state = setup(`/va/?next=${encodeURIComponent(next)}#pair=${TICKET}`);
  expect(await state.attempt!.redeem()).toEqual({ status: "verified" });
  expect(state.storedToken()).toBe(TOKEN);
  expect(state.redirects).toEqual([next]);
  expect(state.events.slice(-2)).toEqual(["store", "redirect"]);
});

test("rejects external or non-app redirect destinations", async () => {
  for (const next of [
    "https://other.example/va/", "//other.example/va/", "/outside", "javascript:alert(1)",
  ]) {
    const state = setup(`/va/?next=${encodeURIComponent(next)}#pair=${TICKET}`);
    await state.attempt!.redeem();
    expect(state.redirects).toEqual(["/va/"]);
  }
});

test("strips return-url credentials so a redirect cannot replace auth or replay a ticket", async () => {
  const next = `/va/?token=foreign-token&view=mobile#pair=${TICKET}`;
  const state = setup(`/va/?next=${encodeURIComponent(next)}#pair=${TICKET}`);
  await state.attempt!.redeem();
  expect(state.redirects).toEqual(["/va/?view=mobile"]);
});

test("expired, replayed, and invalid server responses never retry or store auth", async () => {
  for (const [httpStatus, status] of [[410, "expired"], [400, "invalid"], [500, "failed"], [401, "failed"]] as const) {
    let reads = 0;
    const state = setup(`/va/#pair=${TICKET}`, async () => {
      const response = new Response("sensitive error details", { status: httpStatus });
      response.json = async () => { reads += 1; throw new Error("must not read error body"); };
      return response;
    });
    const first = state.attempt!.redeem();
    expect(await first).toEqual({ status });
    expect(state.attempt!.redeem()).toBe(first);
    expect(await state.attempt!.redeem()).toEqual({ status });
    expect(state.requests).toHaveLength(1);
    expect(state.storedToken()).toBeNull();
    expect(state.redirects).toHaveLength(0);
    expect(reads).toBe(0);
  }
});

test("connection failure stays cached because the server might already have consumed the ticket", async () => {
  const state = setup(`/va/#pair=${TICKET}`, async () => { throw new Error("connection lost"); });
  const first = state.attempt!.redeem();
  expect(await first).toEqual({ status: "failed" });
  expect(state.attempt!.redeem()).toBe(first);
  expect(await state.attempt!.redeem()).toEqual({ status: "failed" });
  expect(state.requests).toHaveLength(1);
  expect(state.storedToken()).toBeNull();
  expect(state.redirects).toHaveLength(0);
});

test("requires a verified response containing an exact 64-hex auth token", async () => {
  for (const body of [
    null, {}, { status: "pending", token: TOKEN }, { status: "verified" },
    { status: "verified", token: "a".repeat(63) },
    { status: "verified", token: "a".repeat(65) },
    { status: "verified", token: "z".repeat(64) },
    { status: "verified", token: 42 },
  ]) {
    const state = setup(`/va/#pair=${TICKET}`, async () => Response.json(body));
    expect(await state.attempt!.redeem()).toEqual({ status: "invalid" });
    await state.attempt!.redeem();
    expect(state.requests).toHaveLength(1);
    expect(state.storedToken()).toBeNull();
    expect(state.redirects).toHaveLength(0);
  }
});

test("malformed response JSON fails without retrying", async () => {
  const state = setup(`/va/#pair=${TICKET}`, async () => new Response("not JSON"));
  expect(await state.attempt!.redeem()).toEqual({ status: "failed" });
  await state.attempt!.redeem();
  expect(state.requests).toHaveLength(1);
  expect(state.redirects).toHaveLength(0);
});
