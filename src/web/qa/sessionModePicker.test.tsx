import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@va/i18n";
import { ChatInput, type ChatInputProps } from "../src/components/chat/ChatInput";

const props: ChatInputProps = {
  value: "", onChange: () => {}, onSubmit: () => {}, onSessionModeChange: () => {},
  sessionMode: { source: "config_option", configId: "mode", name: "Mode", currentValue: "default", options: [
    { value: "default", name: "Manual" }, { value: "plan", name: "Plan" },
  ] },
  sessionControls: { config: null, sessionStarted: true },
};
function render(patch: Partial<ChatInputProps> = {}) {
  return renderToStaticMarkup(<I18nProvider><ChatInput {...props} {...patch} /></I18nProvider>);
}
function trigger(html: string) {
  return html.match(/<button[^>]*aria-label="Session mode: Manual"[^>]*>/)?.[0] ?? "";
}

test("existing idle and busy sessions both allow choosing a mode", () => {
  for (const patch of [{}, { isStreaming: true }, { sessionControls: { config: null, sessionStarted: true, disabled: true } }]) {
    const button = trigger(render(patch));
    expect(button).toContain("Change mode for this session");
    expect(button).not.toContain('disabled=""');
  }
});

test("disconnected, replaying, pending and unstarted sessions explain disabled mode", () => {
  for (const patch of [
    { disabled: true },
    { sessionModeDisabledReason: "Loading history" },
    { sessionControls: { config: null, sessionStarted: true, pendingConfigId: "effort" } },
    { sessionControls: { config: null, sessionStarted: false } },
  ]) expect(trigger(render(patch))).toContain('disabled=""');
  expect(trigger(render({ sessionModeDisabledReason: "Loading history" }))).toContain('title="Loading history"');
});

test("queued mode stays separate from confirmed mode and can be cancelled", () => {
  const html = render({ isStreaming: true, queuedModeId: "plan", onCancelQueuedMode: () => {} });
  expect(trigger(html)).toContain("Session mode: Manual");
  expect(html).toContain("Mode will change to Plan after the current turn finishes.");
  expect(html).toContain('aria-label="Cancel mode change"');
  expect(html).toContain('role="status"');
});
