export type PhonePairingTicket = {
  url: string;
  expiresAt: number;
};

type PairingFetch = (path: string, init: RequestInit) => Promise<Response>;

export function normalizePairingPublicUrl(value: string): string | null {
  const input = value.trim();
  if (!/^https:\/\/[^/?#@\\\s]+(?:\/(?:va\/?)?)?$/i.test(input)) return null;
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      !["/", "/va", "/va/"].includes(url.pathname)
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

const EXTERNAL_URL_KEY = "vibearound.phone-pairing.external-url";
type PairingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readPairingExternalUrl(storage: () => PairingStorage): string {
  try {
    return normalizePairingPublicUrl(storage().getItem(EXTERNAL_URL_KEY) ?? "") ?? "";
  } catch {
    return "";
  }
}

export function rememberPairingExternalUrl(value: string, storage: () => PairingStorage): void {
  try {
    // Persist only a validated public origin, never a ticket or owner-token URL.
    const origin = normalizePairingPublicUrl(value);
    if (origin) storage().setItem(EXTERNAL_URL_KEY, origin);
    else storage().removeItem(EXTERNAL_URL_KEY);
  } catch {
    // Storage can be disabled; in-memory input remains usable.
  }
}

export function phonePairingUrl(publicUrl: string, ticket: string): string | null {
  const origin = normalizePairingPublicUrl(publicUrl);
  if (!origin || !/^[0-9a-f]{64}$/i.test(ticket)) return null;
  return `${origin}/va/#pair=${ticket}`;
}

export function pairingSecondsRemaining(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

export async function requestPhonePairing(
  publicUrl: string,
  fetcher: PairingFetch,
  signal: AbortSignal,
): Promise<PhonePairingTicket> {
  const origin = normalizePairingPublicUrl(publicUrl);
  if (!origin) throw new Error("Invalid pairing URL");
  signal.throwIfAborted();
  // Start locally before requesting so network latency never extends the ticket lifetime.
  const startedAt = Date.now();
  const response = await fetcher("/api/pair/ticket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ public_url: origin }),
    cache: "no-store",
    redirect: "error",
    signal,
  });
  signal.throwIfAborted();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data: unknown = await response.json();
  signal.throwIfAborted();
  if (!data || typeof data !== "object" || !("ticket" in data) || !("expires_in" in data)) {
    throw new Error("Invalid pairing response");
  }
  const url = typeof data.ticket === "string" ? phonePairingUrl(origin, data.ticket) : null;
  if (
    !url ||
    typeof data.expires_in !== "number" ||
    !Number.isInteger(data.expires_in) ||
    data.expires_in <= 0 ||
    data.expires_in > 60
  ) {
    throw new Error("Invalid pairing response");
  }
  return { url, expiresAt: startedAt + data.expires_in * 1000 };
}
