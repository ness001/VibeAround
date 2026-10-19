import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, useI18n } from "@va/i18n";
import App from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { PairingGate } from "./PairingGate";
import { DesktopPairingGate } from "./DesktopPairingGate";
import { restoreBrowserSession } from "./lib/browserPairing";
import { initTheme } from "./lib/theme";
import { clearAuthToken, getAuthToken, initAuthFromUrl, setAuthToken } from "./lib/auth";
import { initPairingAuth, watchPairingNavigation } from "./lib/qrPairing";
import { ownerPreviewSlug } from "./preview/previewRoute";
import "./index.css";

// Capture and strip QR credentials before theme, auth, fetch, or rendering.
// A QR invitation must not auto-login using an old cached or query token.
const qrPairing = initPairingAuth(window, {
  clearAuthToken,
  initAuthFromUrl,
  setAuthToken,
  fetch: (input, init) => window.fetch(input, init),
  redirect: (destination) => window.location.replace(destination),
});
const stopPairingNavigation = watchPairingNavigation(window);
if (import.meta.hot) import.meta.hot.dispose(stopPairingNavigation);

const PreviewPage = lazy(() => import("./preview/PreviewPage"));

initTheme();

// The fetch wrapper sets `vibearound.auth.reloading` before force-reloading
// the page on a 401, to prevent a reload loop when the daemon is actually
// unreachable. Clear it on every successful boot so a later stale-token
// detection can fire its own reload again.
sessionStorage.removeItem("vibearound.auth.reloading");

// Same-origin fetch wrapper:
//   - attaches `Authorization: Bearer <token>` to every API call
//   - sets the loca.lt bypass header so public tunnels don't show a
//     click-through interstitial
const BYPASS_HEADER = "bypass-tunnel-reminder";
const BYPASS_USER_AGENT = "VibeAround/1.0";
const originalFetch = window.fetch;
window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const isSameOrigin =
    typeof url === "string" &&
    (url.startsWith("/") || url.startsWith(window.location.origin));
  const opts = { ...init };
  if (isSameOrigin) {
    const headers = new Headers(opts.headers);
    headers.set(BYPASS_HEADER, "1");
    // Browser pairing uses the native UA for an advisory device label.
    const isBrowserPairing = new URL(url, window.location.origin).pathname.startsWith("/va/api/pair/browser/");
    if (!isBrowserPairing && !headers.has("User-Agent")) headers.set("User-Agent", BYPASS_USER_AGENT);
    // Token is only attached on same-origin calls — never leak it cross-origin.
    const token = getAuthToken();
    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    opts.headers = headers;
  }
  const res = await originalFetch.call(this, input, opts);
  // A 401 invalidates the session credential.
  if (res.status === 401 && isSameOrigin) {
    const isApiCall =
      typeof url === "string" &&
      (url.includes("/api/") || url.includes("/mcp") || url.includes("/ws"));
    const hadBearerToken = getAuthToken() !== null;
    if (isApiCall && hadBearerToken) {
      clearAuthToken();
      // Reload once to re-evaluate the auth gate.
      if (!sessionStorage.getItem("vibearound.auth.reloading")) {
        sessionStorage.setItem("vibearound.auth.reloading", "1");
        window.location.reload();
      }
    }
  }
  return res;
};

// Restore the per-device HttpOnly cookie before deciding whether to show the gate.
// QR invitations and existing bearer credentials take precedence over remembered sessions.
const previewSlug = ownerPreviewSlug(window.location.pathname);
const root = createRoot(document.getElementById("root")!);

function RestoringSession() {
  const { t } = useI18n();
  return <div role="status" className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">{t("Checking this browser’s saved connection…")}</div>;
}

async function renderApp() {
  root.render(<I18nProvider><RestoringSession /></I18nProvider>);
  await restoreBrowserSession({
    hasQrInvitation: qrPairing !== null,
    getAuthToken,
    setAuthToken,
    fetch: (input, init) => originalFetch.call(window, input, init),
  });
  const hasToken = getAuthToken() !== null;
  root.render(
    <StrictMode>
      <I18nProvider>
        <AppErrorBoundary>
          {qrPairing ? (
            <PairingGate qrPairing={qrPairing} />
          ) : previewSlug ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Loading Preview…
                </div>
              }
            >
              <PreviewPage initialSlug={previewSlug} />
            </Suspense>
          ) : hasToken ? (
            <App />
          ) : (
            <DesktopPairingGate />
          )}
        </AppErrorBoundary>
      </I18nProvider>
    </StrictMode>
  );
}

void renderApp();
