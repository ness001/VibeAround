import { pairingDestination } from "./auth";

export type QrPairingResult = {
  status: "verified" | "expired" | "invalid" | "failed";
};

export interface QrPairingAttempt {
  redeem: () => Promise<QrPairingResult>;
}

type PairingBrowser = {
  location: Pick<Location, "href" | "origin">;
  history: Pick<History, "replaceState">;
};

type PairingDependencies = {
  clearAuthToken: () => void;
  initAuthFromUrl: () => void;
  setAuthToken: (token: string) => void;
  fetch: typeof fetch;
  redirect: (destination: string) => void;
};

type PairingNavigationBrowser = {
  location: Pick<Location, "hash" | "reload">;
  addEventListener: (type: "hashchange" | "pageshow", listener: () => void) => void;
  removeEventListener: (type: "hashchange" | "pageshow", listener: () => void) => void;
};

/** Re-enter bootstrap when a QR opens in an already-loaded browser tab. */
export function watchPairingNavigation(browser: PairingNavigationBrowser): () => void {
  let reloading = false;
  const onNavigation = () => {
    if (reloading || !new URLSearchParams(browser.location.hash.slice(1)).has("pair")) return;
    reloading = true;
    browser.location.reload();
  };
  browser.addEventListener("hashchange", onNavigation);
  browser.addEventListener("pageshow", onNavigation);
  return () => {
    browser.removeEventListener("hashchange", onNavigation);
    browser.removeEventListener("pageshow", onNavigation);
  };
}

/** Strip the one-use credential before auth initialization or rendering. */
export function initPairingAuth(
  browser: PairingBrowser,
  dependencies: PairingDependencies,
): QrPairingAttempt | null {
  const url = new URL(browser.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (!fragment.has("pair")) {
    dependencies.initAuthFromUrl();
    return null;
  }

  const tickets = fragment.getAll("pair");
  url.hash = "";
  url.searchParams.delete("token");
  browser.history.replaceState(null, "", `${url.pathname}${url.search}`);
  // A QR invitation takes precedence over both a cached and a query token.
  dependencies.clearAuthToken();

  const destination = new URL(
    pairingDestination(url.searchParams.get("next"), browser.location.origin),
    browser.location.origin,
  );
  // Do not let a return URL replace the new token or restart one-use redemption.
  destination.searchParams.delete("token");
  if (new URLSearchParams(destination.hash.slice(1)).has("pair")) {
    destination.hash = "";
  }
  const next = `${destination.pathname}${destination.search}${destination.hash}`;
  const ticket = tickets.length === 1 && /^[0-9a-f]{64}$/.test(tickets[0])
    ? tickets[0]
    : null;

  async function redeem(): Promise<QrPairingResult> {
    if (!ticket) return { status: "invalid" };
    try {
      const response = await dependencies.fetch("/va/api/pair/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket }),
        credentials: "same-origin",
        // WebKit sends Origin: null for same-origin mode with no-referrer.
        // Keep the fixed relative endpoint and reject redirects, but retain a real Origin.
        mode: "cors",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 410) return { status: "expired" };
      if (response.status === 400) return { status: "invalid" };
      if (!response.ok) return { status: "failed" };
      const data: unknown = await response.json();
      if (
        !data || typeof data !== "object" ||
        !("status" in data) || data.status !== "verified" ||
        !("token" in data) || typeof data.token !== "string" ||
        !/^[0-9a-fA-F]{64}$/.test(data.token)
      ) {
        return { status: "invalid" };
      }
      dependencies.setAuthToken(data.token);
      dependencies.redirect(next);
      return { status: "verified" };
    } catch {
      // A failed POST may still have consumed the ticket. Never retry it.
      return { status: "failed" };
    }
  }

  // This boot-scoped promise survives React StrictMode effect remounts.
  let redemption: Promise<QrPairingResult> | null = null;
  return { redeem: () => redemption ??= redeem() };
}
