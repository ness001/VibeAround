import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@va/i18n";
import { ChatInput } from "../src/components/chat/ChatInput";
import { ChatSessionControls } from "../src/components/chat/ChatSessionControls";
import type { SessionConfigState } from "../src/components/chat/chatTypes";

const config: SessionConfigState = {
  configOptions: [{
    configId: "model",
    category: "model",
    name: "Model",
    currentValue: "custom-model",
    options: [
      { value: "custom-model", name: "Custom gateway model", group: "Gateway" },
      { value: "other-model", name: "Other", group: "Gateway" },
    ],
  }],
  contextWindow: 500000,
  contextWindowEditable: true,
  contextWindowChoices: [100000, 200000, 500000, 1000000],
};

function render(component: React.ReactNode) {
  return renderToStaticMarkup(<I18nProvider>{component}</I18nProvider>);
}

test("settings start collapsed and do not occupy the composer with selects or help", () => {
  const markup = render(<ChatSessionControls config={config} onChange={() => {}} />);
  expect(markup).toContain('aria-label="Model, effort and context settings"');
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).toContain("Custom gateway model");
  expect(markup).not.toContain("<select");
  expect(markup).not.toContain("Auto-compaction budget; does not expand model context");
});

test("unknown usage is not displayed as zero percent or an inferred capacity", () => {
  const markup = render(<ChatSessionControls config={null} onChange={() => {}} />);
  expect(markup).toContain("Context usage not reported yet");
  expect(markup).not.toContain('aria-valuenow=');
  expect(markup).not.toContain(">0%</span>");
  expect(markup).not.toContain("200K");
});

test("circle reports model capacity independently of compaction budget", () => {
  const markup = render(<ChatSessionControls config={config} usage={{ used: 42000, size: 200000 }} />);
  expect(markup).toContain('role="meter"');
  expect(markup).toContain('aria-valuenow="21"');
  expect(markup).toContain("42,000 / 200,000 tokens");
  expect(markup).toContain(">21%</span>");
  expect(markup).toContain('stroke-dasharray="21 100"');
});

test("unknown capacity retains the exact token count without a fabricated percentage", () => {
  const markup = render(<ChatSessionControls config={config} usage={{ used: 100, size: null }} />);
  expect(markup).toContain("100 tokens (capacity unknown)");
  expect(markup).not.toContain('aria-valuenow=');
  expect(markup).not.toContain('stroke-dasharray=');
});

test("meter clamps its geometry and keeps reported token counts", () => {
  const markup = render(<ChatSessionControls config={config} usage={{ used: 220000, size: 200000 }} />);
  expect(markup).toContain('aria-valuenow="100"');
  expect(markup).toContain('stroke-dasharray="100 100"');
  expect(markup).toContain("220,000 / 200,000 tokens");
  expect(markup).toContain(">110%</span>");
});

test("tiny usage and invalid capacity do not appear as zero or NaN", () => {
  const tiny = render(<ChatSessionControls config={config} usage={{ used: 100, size: 1000000 }} />);
  expect(tiny).toContain("&lt;1%");
  const invalid = render(<ChatSessionControls config={config} usage={{ used: 100, size: 0 }} />);
  expect(invalid).not.toContain('aria-valuenow=');
  expect(invalid).not.toContain("NaN");
});

test("summary uses confirmed model and resolved default effort", () => {
  const defaults: SessionConfigState = {
    ...config,
    effortDefault: "high",
    configOptions: [...config.configOptions, {
      configId: "effort", name: "Effort", currentValue: "default",
      options: [{ value: "default", name: "Default" }, { value: "high", name: "High" }],
    }],
  };
  const markup = render(<ChatSessionControls config={defaults} />);
  expect(markup).toContain("Custom gateway model · High");
  expect(markup).not.toContain("Other ·");
});

test("applying preserves summary and disables send", () => {
  const markup = render(<ChatInput value="Hello" onChange={() => {}} onSubmit={() => {}}
    sessionControls={{ config, pendingConfigId: "model", onChange: () => {} }} />);
  expect(markup).toContain("Applying…");
  expect(markup).toContain("Custom gateway model");
  expect(markup.match(/<button[^>]*aria-label="Send"[^>]*>/)?.[0]).toContain(' disabled=""');
});
