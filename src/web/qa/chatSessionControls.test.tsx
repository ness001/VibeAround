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

function select(markup: string, label: string) {
  return markup.match(new RegExp(`<select[^>]*aria-label="${label}"[^>]*>[\\s\\S]*?<\\/select>`))?.[0] ?? "";
}

test("new session controls are disabled until capabilities arrive", () => {
  const markup = render(<ChatSessionControls config={null} onChange={() => {}} />);
  expect(select(markup, "Model")).toContain(' disabled=""');
  expect(select(markup, "Effort")).toContain("Loading session options…");
  expect(select(markup, "Auto-compaction budget")).toContain(' disabled=""');
  expect(markup).not.toContain("200K");
  expect(markup).not.toContain("Context usage:");
});

test("model effort and context are selectable before the first prompt", () => {
  const prepared = { ...config, configOptions: [...config.configOptions, {
    configId: "effort", category: "thought_level", name: "Effort", currentValue: "high",
    options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }],
  }] };
  const markup = render(<ChatSessionControls config={prepared} sessionStarted={false} onChange={() => {}} />);
  for (const name of ["Model", "Effort", "Auto-compaction budget"]) {
    expect(select(markup, name)).not.toContain(' disabled=""');
  }
  expect(markup).not.toContain("Available after session starts");
});

test("selects render exact advertised groups and confirmed selections", () => {
  const markup = render(<ChatSessionControls config={config} onChange={() => {}} sessionStarted />);
  expect(markup).toContain('<optgroup label="Gateway">');
  expect(select(markup, "Model")).toContain('value="custom-model" selected=""');
  expect(select(markup, "Model")).not.toContain(' disabled=""');
  expect(select(markup, "Effort")).toContain("Not supported by this agent");
  expect(select(markup, "Effort")).toContain(' disabled=""');
  expect(select(markup, "Auto-compaction budget")).toContain('value="500000" selected=""');
  expect(markup).toContain("does not expand model context");
  expect(markup).toContain("flex-wrap");
});

test("default labels show resolved local values without changing selection semantics", () => {
  const defaults: SessionConfigState = {
    ...config,
    contextWindow: null,
    contextWindowDefault: 180000,
    effortDefault: "high",
    configOptions: [...config.configOptions, {
      configId: "effort", name: "Effort", currentValue: "default",
      options: [{ value: "default", name: "Default" }, { value: "high", name: "High" }],
    }],
  };
  const markup = render(<ChatSessionControls config={defaults} onChange={() => {}} />);
  expect(select(markup, "Effort")).toContain('value="default" selected="">Default (High)</option>');
  expect(select(markup, "Auto-compaction budget")).toContain('value="auto" selected="">Agent default (180K)</option>');
  const explicit = render(<ChatSessionControls config={{ ...defaults, contextWindow: 500000 }} />);
  expect(select(explicit, "Auto-compaction budget")).toContain('value="auto">Agent default (180K)</option>');
  expect(select(explicit, "Auto-compaction budget")).toContain('value="500000" selected=""');
});

test("resolved automatic context is distinguished from unreported settings", () => {
  const markup = render(<ChatSessionControls config={{ ...config, contextWindow: null, contextWindowAutomatic: true }} />);
  expect(select(markup, "Auto-compaction budget")).toContain('value="auto" selected="">Agent default (automatic)</option>');
  expect(select(markup, "Auto-compaction budget")).not.toContain("not reported");
});

test("unreported defaults are explicit and are not inferred from usage or current overrides", () => {
  const unknown: SessionConfigState = {
    ...config,
    configOptions: [...config.configOptions, {
      configId: "effort", name: "Effort", currentValue: "high",
      options: [{ value: "default", name: "Default" }, { value: "high", name: "High" }],
    }],
  };
  const markup = render(<ChatSessionControls config={unknown} usage={{ used: 10, size: 1000000 }} />);
  expect(select(markup, "Effort")).toContain("Default (not reported)");
  expect(select(markup, "Effort")).not.toContain("Default (High)");
  expect(select(markup, "Auto-compaction budget")).toContain("Agent default (not reported)");
  expect(select(markup, "Auto-compaction budget")).not.toContain("Agent default (1M)");
});

test("applying disables controls and send without changing confirmed values", () => {
  const markup = render(<ChatInput
    value="Hello"
    onChange={() => {}}
    onSubmit={() => {}}
    sessionControls={{ config, pendingConfigId: "model", onChange: () => {} }}
  />);
  expect(markup).toContain("Applying…");
  expect(select(markup, "Model")).toContain(' disabled=""');
  expect(select(markup, "Model")).toContain('value="custom-model" selected=""');
  expect(markup.match(/<button[^>]*aria-label="Send"[^>]*>/)?.[0]).toContain(' disabled=""');
});

test("usage capacity remains independent from the compaction budget", () => {
  const markup = render(<ChatSessionControls
    config={config}
    usage={{ used: 42000, size: 200000 }}
    onChange={() => {}}
  />);
  expect(markup).toContain("42,000 / 200,000 tokens");
  expect(select(markup, "Auto-compaction budget")).toContain("500K");
  const unknown = render(<ChatSessionControls config={config} usage={{ used: 100, size: null }} />);
  expect(unknown).toContain("100 tokens (capacity unknown)");
});

test("read-only context and running-turn selectors cannot be changed", () => {
  const readonly = render(<ChatSessionControls config={{ ...config, contextWindowEditable: false }} onChange={() => {}} />);
  expect(select(readonly, "Auto-compaction budget")).toContain(' disabled=""');
  expect(readonly).toContain("Start a new chat to change it.");
  expect(readonly).toContain("Agent default");
  const streaming = render(<ChatInput value="" onChange={() => {}} onSubmit={() => {}} isStreaming
    sessionControls={{ config, onChange: () => {} }} />);
  expect(select(streaming, "Model")).toContain(' disabled=""');
});
