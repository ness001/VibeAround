import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useI18n } from "@va/i18n";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { pairingSecondsRemaining } from "./phonePairingModel";
import { createBrowserPairingManager, type BrowserPairingSnapshot } from "./browserPairingModel";

export function BrowserPairingDevices() {
  const { t } = useI18n();
  const [state, setState] = useState<BrowserPairingSnapshot>({ requests: [], devices: [], loading: true, busyId: null, error: null });
  const [now, setNow] = useState(Date.now);
  const [confirmation, setConfirmation] = useState<{ id: string; label: string } | null>(null);
  const managerRef = useRef<ReturnType<typeof createBrowserPairingManager> | null>(null);
  const confirmationRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!confirmation) return;
    confirmationRef.current?.scrollIntoView({ block: "nearest" });
    confirmationRef.current?.focus({ preventScroll: true });
  }, [confirmation]);

  useEffect(() => {
    const manager = createBrowserPairingManager({ fetch: apiFetch, onState: setState });
    managerRef.current = manager;
    void manager.refresh();
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => {
      window.clearInterval(timer);
      manager.dispose();
      managerRef.current = null;
    };
  }, []);

  const current = Math.max(now, Date.now());
  const requests = state.requests.filter((request) => request.expiresAt > current);
  const confirmingDevice = confirmation
    ? state.devices.find((device) => device.id === confirmation.id)
    : null;

  return (
    <div className="space-y-4 border-t border-border pt-4">
      <section className="space-y-2" aria-label={t("Pending phone requests")}>
        <h3 className="text-sm font-semibold">{t("Pending phone requests")}</h3>
        <p className="text-xs text-muted-foreground">{t("Approve only if the six-digit code matches the one shown on your phone. Reject requests you do not recognize.")}</p>
        {state.loading && <p role="status" className="text-xs text-muted-foreground">{t("Loading…")}</p>}
        {!state.loading && !state.error && requests.length === 0 && <p className="text-xs text-muted-foreground">{t("No pending requests. Open the URL on your phone and tap Connect to desktop.")}</p>}
        {requests.map((request) => (
          <div key={request.id} data-pairing-request={request.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
            <div className="min-w-0 space-y-1">
              <p className="break-words text-sm font-medium">{request.label || t("Browser")}</p>
              <p className="font-mono text-2xl font-semibold tracking-widest">{request.code}</p>
              <p className="text-xs text-muted-foreground">{request.remember ? t("Remembered · up to 30 days") : t("Session only · up to 24 hours")}</p>
              <p className="text-xs tabular-nums text-muted-foreground">{t("Expires in {{seconds}}s", { seconds: pairingSecondsRemaining(request.expiresAt, current) })}</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={state.busyId !== null} onClick={() => { setConfirmation(null); void managerRef.current?.act("approve", request.id, request.code); }}>{t("Codes match — approve")}</Button>
              <Button size="sm" variant="outline" disabled={state.busyId !== null} onClick={() => { setConfirmation(null); void managerRef.current?.act("reject", request.id); }}>{t("Reject")}</Button>
              {state.busyId === request.id && <Loader2 className="h-4 w-4 animate-spin self-center" aria-label={t("Saving…")} />}
            </div>
          </div>
        ))}
      </section>
      <section className="space-y-2" aria-label={t("Connected phones and browsers")}>
        <h3 className="text-sm font-semibold">{t("Connected phones and browsers")}</h3>
        {!state.loading && !state.error && state.devices.length === 0 && <p className="text-xs text-muted-foreground">{t("No connected devices.")}</p>}
        {state.devices.map((device) => (
          <div key={device.id} data-paired-device={device.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
            <div className="min-w-0 space-y-1">
              <p className="break-words text-sm font-medium">{device.label || t("Browser")}</p>
              <p className="text-xs text-muted-foreground">{device.remember ? t("Remembered · up to 30 days") : t("Session only · up to 24 hours")}</p>
              <p className="text-xs text-muted-foreground">{t("Access expires {{date}}", { date: new Date(device.expiresAt).toLocaleString() })}</p>
            </div>
            <Button variant="outline" size="sm" disabled={state.busyId !== null} onClick={() => setConfirmation({ id: device.id, label: device.label })}>
              {state.busyId === device.id && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {t("Revoke")}
            </Button>
          </div>
        ))}
      </section>
      {confirmingDevice && (
        <div ref={confirmationRef} tabIndex={-1} role="group" aria-label={t("Revoke device access")} className="space-y-3 rounded-md border border-destructive/40 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <p className="text-sm font-medium">{t('Revoke access for "{{label}}"?', { label: confirmingDevice.label || t("Browser") })}</p>
          <p className="text-xs text-muted-foreground">{t("This browser will need approval again. Its saved connection will stop working.")}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="destructive" disabled={state.busyId !== null} onClick={() => {
              void managerRef.current?.act("revoke", confirmingDevice.id);
              setConfirmation(null);
            }}>{t("Revoke access")}</Button>
            <Button size="sm" variant="outline" onClick={() => setConfirmation(null)}>{t("Cancel")}</Button>
          </div>
        </div>
      )}
      {state.error && (
        <div role="alert" className="space-y-2">
          <p className="text-xs text-destructive">{state.error === "load" ? t("Could not load phone connections. Check the desktop connection.") : t("Could not complete that action. Check the latest device list before trying again.")}</p>
          <Button variant="outline" size="sm" disabled={state.busyId !== null} onClick={() => void managerRef.current?.refresh()}>{t("Refresh")}</Button>
        </div>
      )}
    </div>
  );
}
