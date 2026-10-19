import { useEffect, useRef, useState } from "react";
import { Loader2, Smartphone } from "lucide-react";
import { useI18n } from "@va/i18n";

import { Button } from "@/components/ui/button";
import { LanguageMenu } from "@/components/LanguageMenu";
import { setAuthToken } from "@/lib/auth";
import { createBrowserPairing, type BrowserPairingState } from "@/lib/browserPairing";
import { PairingGate } from "./PairingGate";

export function DesktopPairingGate() {
  const { t } = useI18n();
  const [state, setState] = useState<BrowserPairingState>({ status: "idle" });
  const [remember, setRemember] = useState(false);
  const [otherWays, setOtherWays] = useState(false);
  const [now, setNow] = useState(Date.now);
  const attempt = useRef<ReturnType<typeof createBrowserPairing> | null>(null);

  useEffect(() => {
    const pairing = createBrowserPairing({
      fetch: (input, init) => window.fetch(input, init),
      onState: setState,
      onVerified: (token) => {
        setAuthToken(token);
        // Browser credentials cannot access owner-only preview destinations.
        window.location.replace("/va/");
      },
    });
    attempt.current = pairing;
    return () => {
      pairing.dispose();
      attempt.current = null;
    };
  }, []);

  const expiresAt = state.status === "pending" ? state.expiresAt : null;
  useEffect(() => {
    if (expiresAt === null) return;
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 500);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [expiresAt]);

  if (otherWays) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="px-4 pt-3">
          <Button variant="ghost" size="sm" onClick={() => setOtherWays(false)}>{t("Back to desktop approval")}</Button>
        </div>
        <div className="min-h-0 flex-1"><PairingGate /></div>
      </div>
    );
  }

  const busy = state.status === "starting" || state.status === "pending" || state.status === "verified";
  const seconds = expiresAt === null ? 0 : Math.max(0, Math.ceil((expiresAt - Math.max(now, Date.now())) / 1000));

  return (
    <div className="flex h-full overflow-auto bg-background px-4 py-6 text-foreground">
      <main className="m-auto w-full max-w-md space-y-5">
        <div className="flex justify-end"><LanguageMenu /></div>
        <div className="flex items-center gap-3">
          <Smartphone className="h-7 w-7 shrink-0 text-primary" aria-hidden="true" />
          <div>
            <h1 className="text-lg font-semibold">{t("Connect to desktop")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("Connect this browser without scanning a QR code or copying a token.")}</p>
          </div>
        </div>
        <section className="space-y-4 rounded-lg border border-border bg-card p-5">
          {state.status === "pending" ? (
            <>
              <p className="text-center text-sm text-muted-foreground">{t("Your pairing code")}</p>
              <p className="text-center font-mono text-4xl font-bold tracking-[0.2em]" aria-label={t("Your pairing code")}>{state.code}</p>
              <p role="timer" className="text-center text-xs tabular-nums text-muted-foreground">{t("Expires in {{seconds}}s", { seconds })}</p>
              <ol className="list-decimal space-y-2 pl-5 text-sm">
                <li>{t("On your computer, open VibeAround Desktop > Remote > Connect phone.")}</li>
                <li>{t("Find this exact six-digit code, then approve that request on the desktop.")}</li>
                <li>{t("This page will update automatically.")}</li>
              </ol>
              <p className="text-xs text-muted-foreground">{remember ? t("Remembered for up to 30 days on this link and browser. Revoke access from Desktop > Remote at any time.") : t("This connection lasts for this browser session, up to 24 hours.")}</p>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{t("Keep your desktop open. A six-digit code will appear here for you to approve there.")}</p>
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" aria-label={t("Remember this phone")} checked={remember} disabled={busy} onChange={(event) => setRemember(event.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" />
                <span>
                  <span className="font-medium">{t("Remember this phone")}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{t("Up to 30 days on this link and browser. Use only on a phone you trust; revoke access from Desktop > Remote.")}</span>
                </span>
              </label>
            </>
          )}
          <p className="text-xs text-muted-foreground">{t("New tunnel URL or cleared browser data requires approval again.")}</p>
          <div role="status" aria-live="polite" className="text-sm">
            {state.status === "starting" && <p className="text-muted-foreground">{t("Generating pairing code…")}</p>}
            {state.status === "verified" && <p>{t("Paired! Continuing…")}</p>}
            {state.status === "expired" && <p className="text-destructive">{t("This code expired. Connect again for a new code.")}</p>}
            {state.status === "rejected" && <p className="text-destructive">{t("The desktop rejected this request. Connect again if this was your phone.")}</p>}
            {state.status === "failed" && <p className="text-destructive">{t("Could not connect. Check the desktop and tunnel connection, then try again.")}</p>}
          </div>
          {!busy && (
            <Button className="w-full" onClick={() => void attempt.current?.start(remember)}>{t("Connect to desktop")}</Button>
          )}
          {(state.status === "starting" || state.status === "pending") && (
            <Button variant="outline" className="w-full" onClick={() => attempt.current?.cancel()}>
              {state.status === "starting" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {t("Cancel")}
            </Button>
          )}
        </section>
        {state.status !== "verified" && (
          <Button variant="ghost" className="w-full" onClick={() => { attempt.current?.cancel(); setOtherWays(true); }}>{t("Other ways to connect")}</Button>
        )}
      </main>
    </div>
  );
}
