import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Loader2, Smartphone } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useI18n } from "@va/i18n";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import type { TunnelRuntime } from "../hooks/useTunnelsState";
import { useQuickTunnel } from "../hooks/useQuickTunnel";
import {
  normalizePairingPublicUrl,
  pairingSecondsRemaining,
  requestPhonePairing,
  readPairingExternalUrl,
  rememberPairingExternalUrl,
  type PhonePairingTicket,
} from "./phonePairingModel";

import { BrowserPairingDevices } from "./BrowserPairingDevices";

const EXTERNAL_SOURCE = "external";
const QUICK_SOURCE = "quick-cloudflare";

export function PhonePairing({ tunnels }: { tunnels: TunnelRuntime[] }) {
  const { t } = useI18n();
  const id = useId();
  const [source, setSource] = useState<string | null>(null);
  const quick = useQuickTunnel();
  const [cloudflaredPath, setCloudflaredPath] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const [externalUrl, setExternalUrl] = useState(() => readPairingExternalUrl(() => window.sessionStorage));
  useEffect(() => {
    rememberPairingExternalUrl(externalUrl, () => window.sessionStorage);
  }, [externalUrl]);
  const activeTunnels = tunnels.filter(
    (tunnel) => tunnel.status.state === "running" && normalizePairingPublicUrl(tunnel.url ?? ""),
  );
  const quickUrl = quick.status.state === "running" ? normalizePairingPublicUrl(quick.status.url ?? "") : null;
  const selectedSource = source ?? (quickUrl ? QUICK_SOURCE : activeTunnels[0]?.provider ?? EXTERNAL_SOURCE);
  const selectedTunnel = activeTunnels.find((tunnel) => tunnel.provider === selectedSource);
  const input = selectedSource === QUICK_SOURCE ? quickUrl ?? "" : selectedSource === EXTERNAL_SOURCE ? externalUrl : selectedTunnel?.url ?? "";
  const publicUrl = normalizePairingPublicUrl(input);
  const invalid = input.trim().length > 0 && !publicUrl;

  return (
    <section className="mx-auto mb-5 max-w-[960px] rounded-md border border-primary/30 bg-card p-4" aria-labelledby={`${id}-title`}>
      <div className="mb-3 flex items-start gap-2.5">
        <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        <div>
          <h2 id={`${id}-title`} className="text-base font-semibold">{t("Connect phone")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("Scan the link QR or open the URL in Chrome, then approve its six-digit code here. No token copying needed.")}
          </p>
        </div>
      </div>
      <div className="grid gap-3">
        <div className="space-y-2 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">{t("Temporary phone tunnel")}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{t("Create a public HTTPS link with Cloudflare. No account or terminal commands needed; phone approval stays required.")}</p>
            </div>
            {quick.status.state === "running" || quick.status.state === "starting" ? (
              <Button size="sm" variant="outline" disabled={quick.busy} onClick={() => setConfirmStop(true)}>{t("Stop tunnel")}</Button>
            ) : (
              <Button size="sm" disabled={!quick.available || quick.busy} onClick={() => {
                setSource(QUICK_SOURCE);
                void quick.start(cloudflaredPath);
              }}>{quick.busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{t("Start phone tunnel")}</Button>
            )}
          </div>
          <p role="status" className="text-xs text-muted-foreground">
            {quick.status.state === "starting" ? t("Creating a secure phone link…") : quick.status.state === "running" ? t("Tunnel running — the link and QR below are ready.") : quick.available ? t("Tunnel stopped") : t("Quick Tunnel controls need the updated desktop app.")}
          </p>
          {quick.status.error && <p role="alert" className="break-words text-xs text-destructive">{quick.status.error}</p>}
          {quickUrl && selectedSource !== QUICK_SOURCE && <Button variant="outline" size="sm" onClick={() => setSource(QUICK_SOURCE)}>{t("Use this tunnel")}</Button>}
          {confirmStop && (
            <div role="group" aria-label={t("Stop phone tunnel")} className="space-y-2 rounded-md bg-muted p-3">
              <p className="text-xs">{t("Stopping disconnects phones using this tunnel. Starting again creates a new link and requires pairing again.")}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" disabled={quick.busy} onClick={() => { setConfirmStop(false); void quick.stop(); }}>{t("Stop and disconnect")}</Button>
                <Button size="sm" variant="outline" onClick={() => setConfirmStop(false)}>{t("Cancel")}</Button>
              </div>
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">{t("Advanced: Cloudflare client path")}</summary>
            <label className="mt-2 grid gap-1 text-xs" htmlFor={`${id}-cloudflared`}>
              {t("Cloudflared executable (optional)")}
              <Input id={`${id}-cloudflared`} value={cloudflaredPath} onChange={event => setCloudflaredPath(event.target.value)} placeholder={t("Auto-detect installed cloudflared")} autoComplete="off" spellCheck={false} disabled={quick.busy || quick.status.state === "starting" || quick.status.state === "running"} />
            </label>
            <p className="mt-1 text-xs text-muted-foreground">{t("Uses an installed Node.js and Cloudflare client. No software is downloaded automatically.")}</p>
          </details>
        </div>
        <label className="grid gap-1 text-xs font-medium" htmlFor={`${id}-source`}>
          {t("Tunnel URL source")}
          <select
            id={`${id}-source`}
            value={selectedSource}
            onChange={(event) => setSource(event.target.value)}
            className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {(quickUrl || selectedSource === QUICK_SOURCE) && <option value={QUICK_SOURCE}>{t("Temporary phone tunnel")}{!quickUrl ? ` — ${t("Unavailable")}` : ""}</option>}
            {activeTunnels.map((tunnel) => (
              <option key={tunnel.provider} value={tunnel.provider}>
                {t("{{provider}} tunnel", { provider: tunnel.provider })} — {tunnel.url}
              </option>
            ))}
            {selectedSource !== EXTERNAL_SOURCE && selectedSource !== QUICK_SOURCE && !selectedTunnel && (
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
        <PhoneUrl key={publicUrl} publicUrl={publicUrl} />
        <BrowserPairingDevices />
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-xs font-medium">{t("Advanced: one-use owner sign-in QR")}</summary>
          <p className="my-3 flex items-start gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t("Anyone who scans an unexpired QR code gains app owner access. Only show it to a phone you trust.")}
          </p>
          <PairingCode key={JSON.stringify([selectedSource, input])} publicUrl={publicUrl} />
        </details>
      </div>
    </section>
  );
}

function PhoneUrl({ publicUrl }: { publicUrl: string | null }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const url = publicUrl ? `${publicUrl}/va/` : "";

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setError(false);
    } catch {
      setError(true);
    }
  }

  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-3">
      <p className="text-xs font-medium">{t("1. Open this URL on your phone")}</p>
      {url ? (
        <div className="flex flex-wrap items-center gap-4">
          <div className="grid w-full max-w-[320px] shrink-0 justify-items-center gap-2">
            <QRCodeSVG
              value={url}
              size={320}
              level="M"
              marginSize={4}
              bgColor="#ffffff"
              fgColor="#000000"
              title={t("Open phone link QR code")}
              role="img"
              aria-label={t("Open phone link QR code")}
              className="h-auto max-w-full rounded-md"
            />
            <p className="text-center text-xs text-muted-foreground">{t("Scan to open the link — desktop approval is still required.")}</p>
          </div>
          <div className="min-w-0 flex-1 basis-48 space-y-2">
            <code className="block break-all text-xs select-all">{url}</code>
            <Button size="sm" variant="outline" onClick={() => void copy()}>{copied ? t("Copied") : t("Copy URL")}</Button>
            <p className="text-xs text-muted-foreground">{t("Using WeChat to scan? Open the link in Chrome before tapping Connect to desktop.")}</p>
          </div>
        </div>
      ) : <p className="text-xs text-muted-foreground">{t("Choose a running tunnel or enter its public HTTPS URL above.")}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{t("Could not copy. Select and copy the URL above.")}</p>}
      <p className="text-xs font-medium">{t("2. Tap Connect to desktop on your phone")}</p>
      <p className="text-xs font-medium">{t("3. Match the code and approve below")}</p>
      <p className="text-xs text-muted-foreground">{t("This ordinary URL contains no sign-in secret. Keep it handy; it changes when a temporary tunnel restarts.")}</p>
    </div>
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
