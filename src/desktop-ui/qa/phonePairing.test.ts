import { afterEach, expect, setSystemTime, test } from "bun:test";

import {
  normalizePairingPublicUrl,
  pairingSecondsRemaining,
  phonePairingUrl,
  requestPhonePairing,
  readPairingExternalUrl,
  rememberPairingExternalUrl,
} from "../src/remote-dashboard/phonePairingModel";

const origin = "https://current-tunnel.trycloudflare.com";
const ticket = "a1".repeat(32);
const response = () => Response.json({ ticket, expires_in: 60 });

afterEach(() => setSystemTime());

test("pairing public URLs accept HTTPS origins and app paths only", () => {
  for (const value of [origin, `${origin}/`, `${origin}/va`, `${origin}/va/`, ` ${origin}/va/ `]) {
    expect(normalizePairingPublicUrl(value)).toBe(origin);
  }
  expect(normalizePairingPublicUrl("https://PUBLIC.example:443/va/")).toBe("https://public.example");
  expect(normalizePairingPublicUrl("https://public.example:8443")).toBe("https://public.example:8443");
});

test("pairing public URLs reject token-bearing, credentialed and unexpected URLs", () => {
  for (const value of [
    "", "not a URL", "//public.example", "http://public.example", "javascript:alert(1)",
    "https://", "https:///public.example", "https://user:secret@public.example", "https://@public.example",
    `${origin}?token=owner-secret`, `${origin}/va/?token=owner-secret`, `${origin}/va/#pair=${ticket}`,
    `${origin}/?`, `${origin}/#`, `${origin}/different`, `${origin}/va//`, `${origin}/va/../`,
    `${origin}/%76a/`, `${origin}/VA/`, `${origin}\\other`, "https://public.\nexample",
  ]) {
    expect(normalizePairingPublicUrl(value)).toBeNull();
  }
});

test("external URL survives remount while credential-bearing values never persist", () => {
  let saved: string | null = null;
  const storage = () => ({
    getItem: () => saved,
    setItem: (_key: string, value: string) => { saved = value; },
    removeItem: () => { saved = null; },
  });
  rememberPairingExternalUrl(`${origin}/va/`, storage);
  expect(saved).toBe(origin);
  expect(readPairingExternalUrl(storage)).toBe(origin);
  for (const value of ["", `${origin}/#pair=${ticket}`, `${origin}/?token=secret`]) {
    rememberPairingExternalUrl(value, storage);
    expect(saved).toBeNull();
    expect(readPairingExternalUrl(storage)).toBe("");
    saved = value;
    expect(readPairingExternalUrl(storage)).toBe("");
  }
});

test("unavailable session storage does not break phone URL input", () => {
  const unavailable = () => { throw new Error("Storage blocked"); };
  expect(readPairingExternalUrl(unavailable)).toBe("");
  expect(() => rememberPairingExternalUrl(origin, unavailable)).not.toThrow();
});

test("pairing QR uses a fragment ticket and never a query token", () => {
  const url = phonePairingUrl(`${origin}/va/`, ticket);
  expect(url).toBe(`${origin}/va/#pair=${ticket}`);
  expect(new URL(url!).search).toBe("");
  for (const invalid of ["", "owner-secret", "a".repeat(63), "g".repeat(64), `${ticket}&token=secret`]) {
    expect(phonePairingUrl(origin, invalid)).toBeNull();
  }
  expect(phonePairingUrl(`${origin}/?token=secret`, ticket)).toBeNull();
});

test("countdown rounds up and stops at expiration", () => {
  expect(pairingSecondsRemaining(60_000, 0)).toBe(60);
  expect(pairingSecondsRemaining(60_000, 1)).toBe(60);
  expect(pairingSecondsRemaining(60_000, 1_000)).toBe(59);
  expect(pairingSecondsRemaining(60_000, 59_999)).toBe(1);
  expect(pairingSecondsRemaining(60_000, 60_000)).toBe(0);
  expect(pairingSecondsRemaining(60_000, 100_000)).toBe(0);
});

test("ticket request uses the local authenticated fetch contract and counts network time", async () => {
  setSystemTime(1_000);
  const signal = new AbortController().signal;
  const result = await requestPhonePairing(`${origin}/va/`, async (path, init) => {
    expect(path).toBe("/api/pair/ticket");
    expect(init).toEqual({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ public_url: origin }),
      cache: "no-store",
      redirect: "error",
      signal,
    });
    setSystemTime(3_000);
    return response();
  }, signal);
  expect(result).toEqual({ url: `${origin}/va/#pair=${ticket}`, expiresAt: 61_000 });
  expect(pairingSecondsRemaining(result.expiresAt, Date.now())).toBe(58);
});

test("a response arriving after expiry cannot extend the countdown", async () => {
  setSystemTime(1_000);
  const result = await requestPhonePairing(origin, async () => {
    setSystemTime(62_000);
    return response();
  }, new AbortController().signal);
  expect(pairingSecondsRemaining(result.expiresAt, Date.now())).toBe(0);
});

test("cancelled requests ignore stale responses even if fetch ignores abort", async () => {
  const controller = new AbortController();
  let resolve!: (value: Response) => void;
  const pending = requestPhonePairing(origin, () => new Promise((done) => { resolve = done; }), controller.signal);
  controller.abort();
  resolve(response());
  await expect(pending).rejects.toThrow();
});

test("cancellation during JSON parsing also ignores stale tickets", async () => {
  const controller = new AbortController();
  const stale = response();
  stale.json = async () => {
    controller.abort();
    return { ticket, expires_in: 60 };
  };
  await expect(requestPhonePairing(origin, async () => stale, controller.signal)).rejects.toThrow();
});

test("a cancelled request never fetches and invalid URLs never fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const fetcher = async () => { called = true; return response(); };
  await expect(requestPhonePairing(origin, fetcher, controller.signal)).rejects.toThrow();
  await expect(requestPhonePairing("http://public.example", fetcher, new AbortController().signal)).rejects.toThrow();
  expect(called).toBe(false);
});

test("invalid ticket responses fail closed without exposing server content", async () => {
  for (const data of [
    null, {}, { ticket: "owner-secret", expires_in: 60 }, { ticket, expires_in: 0 },
    { ticket, expires_in: 61 }, { ticket, expires_in: -1 }, { ticket, expires_in: 1.5 },
    { ticket, expires_in: "60" }, { ticket: 123, expires_in: 60 },
  ]) {
    await expect(requestPhonePairing(origin, async () => Response.json(data), new AbortController().signal))
      .rejects.toThrow("Invalid pairing response");
  }
  await expect(requestPhonePairing(origin, async () => new Response("secret", { status: 500 }), new AbortController().signal))
    .rejects.toThrow("HTTP 500");
});
