import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Loader2, Smartphone } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useI18n } from "@va/i18n";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import type { TunnelRuntime } from "../hooks/useTunnelsState";
import {
  normalizePairingPublicUrl,
  pairingSecondsRemaining,
  requestPhonePairing,
  readPairingExternalUrl,
  rememberPairingExternalUrl,
  type PhonePairingTicket,
} from "./phonePairingModel";

const EXTERNAL_SOURCE = "external";

export function PhonePairing({ tunnels }: { tunnels: TunnelRuntime[] }) {
  const { t } = useI18n();
  const id = useId();
  const [source, setSource] = useState<string | null>(null);
  const [externalUrl, setExternalUrl] = useState(() => readPairingExternalUrl(() => window.sessionStorage));
  useEffect(() => {
    rememberPairingExternalUrl(externalUrl, () => window.sessionStorage);
  }, [externalUrl]);
  const activeTunnels = tunnels.filter(
    (tunnel) => tunnel.status.state === "running" && normalizePairingPublicUrl(tunnel.url ?? ""),
  );
  const selectedSource = source ?? activeTunnels[0]?.provider ?? EXTERNAL_SOURCE;
  const selectedTunnel = activeTunnels.find((tunnel) => tunnel.provider === selectedSource);
  const input = selectedSource === EXTERNAL_SOURCE ? externalUrl : selectedTunnel?.url ?? "";
  const publicUrl = normalizePairingPublicUrl(input);
  const invalid = input.trim().length > 0 && !publicUrl;

  return (
    <section className="mx-auto mb-5 max-w-[960px] rounded-md border border-primary/30 bg-card p-4" aria-labelledby={`${id}-title`}>
      <div className="mb-3 flex items-start gap-2.5">
        <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        <div>
          <h2 id={`${id}-title`} className="text-base font-semibold">{t("Connect phone")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("Scan with your iPhone camera to open the app and sign in. No token copying.")}
          </p>
        </div>
      </div>
      <div className="grid gap-3">
        <label className="grid gap-1 text-xs font-medium" htmlFor={`${id}-source`}>
          {t("Tunnel URL source")}
          <select
            id={`${id}-source`}
            value={selectedSource}
            onChange={(event) => setSource(event.target.value)}
            className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {activeTunnels.map((tunnel) => (
              <option key={tunnel.provider} value={tunnel.provider}>
                {t("{{provider}} tunnel", { provider: tunnel.provider })} — {tunnel.url}
              </option>
            ))}
            {selectedSource !== EXTERNAL_SOURCE && !selectedTunnel && (
              <option value={selectedSource} disabled>{t("Unavailable")}</option>
            )}
            <option value={EXTERNAL_SOURCE}>{t("External tunnel URL")}</option>
          </select>
        </label>
        {selectedSource === EXTERNAL_SOURCE && (
          <div>
            <label className="mb-1 block text-xs font-medium" htmlFor={`${id}-url`}>
              {t("Current external tunnel URL")}
            </label>
            <Input
              id={`${id}-url`}
              type="url"
              value={externalUrl}
              onChange={(event) => {
                setSource(EXTERNAL_SOURCE);
                setExternalUrl(event.target.value);
              }}
              placeholder="https://…trycloudflare.com"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={invalid}
              aria-describedby={`${id}-help${invalid ? ` ${id}-invalid` : ""}`}
            />
            <p id={`${id}-help`} className="mt-1.5 text-xs text-muted-foreground">
              {t("Paste the current Quick Tunnel HTTPS URL from this computer. Update it whenever the helper restarts.")}
            </p>
            {invalid && (
              <p id={`${id}-invalid`} className="mt-1.5 text-xs text-destructive">
                {t("Use an HTTPS origin or /va/ URL, without credentials, a query, or a fragment.")}
              </p>
            )}
          </div>
        )}
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {t("Anyone who scans an unexpired QR code gains app owner access. Only show it to a phone you trust.")}
        </p>
        <PairingCode key={JSON.stringify([selectedSource, input])} publicUrl={publicUrl} />
      </div>
    </section>
  );
}

type PairingState =
  | { status: "idle" | "loading" | "error" | "expired" }
  | { status: "ready"; ticket: PhonePairingTicket };

function PairingCode({ publicUrl }: { publicUrl: string | null }) {
  const { t } = useI18n();
  const [state, setState] = useState<PairingState>({ status: "idle" });
  const [now, setNow] = useState(Date.now);
  const requestRef = useRef<AbortController | null>(null);
  const ticket = state.status === "ready" ? state.ticket : null;
  const seconds = ticket ? pairingSecondsRemaining(ticket.expiresAt, Math.max(now, Date.now())) : 0;

  useEffect(() => () => requestRef.current?.abort(), []);

  useEffect(() => {
    if (!ticket) return;
    const update = () => {
      const current = Date.now();
      setNow(current);
      if (current >= ticket.expiresAt) setState({ status: "expired" });
    };
    update();
    const interval = window.setInterval(update, 250);
    const timeout = window.setTimeout(update, Math.max(0, ticket.expiresAt - Date.now()));
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", update);
    };
  }, [ticket]);

  async function generate() {
    if (!publicUrl || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setState({ status: "loading" });
    const timeout = window.setTimeout(() => {
      if (requestRef.current !== controller) return;
      controller.abort();
      requestRef.current = null;
      setState({ status: "error" });
    }, 15_000);
    const clearTimeout = () => window.clearTimeout(timeout);
    controller.signal.addEventListener("abort", clearTimeout, { once: true });
    try {
      const next = await requestPhonePairing(publicUrl, apiFetch, controller.signal);
      if (controller.signal.aborted) return;
      const current = Date.now();
      setNow(current);
      setState(current < next.expiresAt ? { status: "ready", ticket: next } : { status: "expired" });
    } catch {
      if (!controller.signal.aborted) setState({ status: "error" });
    } finally {
      clearTimeout();
      controller.signal.removeEventListener("abort", clearTimeout);
      if (requestRef.current === controller) requestRef.current = null;
    }
  }

  return (
    <div className="grid justify-items-start gap-3">
      <Button type="button" size="sm" disabled={!publicUrl || state.status === "loading"} onClick={() => void generate()}>
        {state.status === "loading" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {state.status === "loading" ? t("Generating…") : state.status === "expired" || state.status === "ready" ? t("Regenerate QR") : t("Generate QR")}
      </Button>
      {state.status === "error" && (
        <p role="alert" className="text-xs text-destructive">
          {t("Could not generate a pairing QR. Check the desktop connection and try again.")}
        </p>
      )}
      {state.status === "expired" && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("QR code expired. Generate a new one to connect.")}
        </p>
      )}
      {ticket && seconds > 0 && (
        <div className="grid max-w-full justify-items-center gap-2">
          <QRCodeSVG
            value={ticket.url}
            size={256}
            level="M"
            marginSize={4}
            bgColor="#ffffff"
            fgColor="#000000"
            title={t("Phone pairing QR code")}
            role="img"
            aria-label={t("Phone pairing QR code")}
            className="h-auto max-w-full rounded-md"
          />
          <p role="timer" className="text-xs tabular-nums text-muted-foreground">
            {t("Expires in {{seconds}}s", { seconds })}
          </p>
        </div>
      )}
    </div>
  );
}
