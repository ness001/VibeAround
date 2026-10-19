import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@va/i18n";
import { DesktopPairingGate } from "../src/DesktopPairingGate";

const render = () => renderToStaticMarkup(<I18nProvider><DesktopPairingGate /></I18nProvider>);

test("phone gate offers explicit desktop approval with remember off by default", () => {
  const html = render();
  expect(html).toContain("Connect to desktop");
  expect(html).toContain("Remember this phone");
  expect(html).toContain("six-digit code");
  expect(html).toContain("30 days on this link and browser");
  expect(html).toContain("New tunnel URL or cleared browser data requires approval again.");
  expect(html).toContain('aria-label="Remember this phone"');
  const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? "";
  expect(checkbox).not.toBe("");
  expect(checkbox).not.toContain("checked");
  expect(html).not.toContain("Generating pairing code");
});

test("owner-token and IM login remain secondary instead of requiring token entry", () => {
  const html = render();
  expect(html).toContain("Other ways to connect");
  expect(html).not.toContain('type="text"');
  expect(html).not.toContain("Auth Token");
  expect(html).not.toContain("/pair");
});
