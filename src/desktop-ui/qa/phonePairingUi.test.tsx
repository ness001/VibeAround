import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@va/i18n";
import { QRCodeSVG } from "qrcode.react";
import { PhonePairing } from "../src/remote-dashboard/PhonePairing";
import type { TunnelRuntime } from "../src/hooks/useTunnelsState";

const origin = "https://phone.example";
const tunnel = { provider: "cloudflare", url: origin, status: { state: "running" } } as TunnelRuntime;
const render = () => renderToStaticMarkup(<I18nProvider><PhonePairing tunnels={[tunnel]} /></I18nProvider>);

test("desktop exposes a plain URL QR and approval instructions before the advanced sign-in QR", () => {
  const html = render();
  expect(html).toContain(`${origin}/va/`);
  expect(html).toContain("Copy URL");
  expect(html).toContain("Tap Connect to desktop on your phone");
  expect(html).toContain("Pending phone requests");
  expect(html).toContain("Connected phones and browsers");
  expect(html).not.toContain("#pair=");
  expect(html).not.toContain("?token=");
  const details = html.match(/<details[^>]*>/)?.[0] ?? "";
  expect(details).not.toBe("");
  expect(details).not.toContain("open");
  expect(html.indexOf("Copy URL")).toBeLessThan(html.indexOf("Advanced: one-use owner sign-in QR"));
  expect(html).toContain('aria-label="Open phone link QR code"');
  expect(html).toContain("Using WeChat to scan? Open the link in Chrome before tapping Connect to desktop.");
  const qr = html.match(/<svg[^>]*aria-label="Open phone link QR code"[\s\S]*?<\/svg>/)?.[0];
  expect(qr).toBeDefined();
  const expected = renderToStaticMarkup(<QRCodeSVG value={`${origin}/va/`} size={320} level="M" marginSize={4} bgColor="#ffffff" fgColor="#000000" />);
  expect(qr!.match(/<path[^>]*>/g)).toEqual(expected.match(/<path[^>]*>/g));
});

test("desktop does not render a link QR without a valid tunnel URL", () => {
  const html = renderToStaticMarkup(<I18nProvider><PhonePairing tunnels={[]} /></I18nProvider>);
  expect(html).not.toContain('aria-label="Open phone link QR code"');
});
