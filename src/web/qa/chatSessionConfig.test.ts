import { expect, test } from "bun:test";
import { ChatEventSchema } from "@va/client";
import {
  canSetSessionConfigOption,
  CONTEXT_WINDOW_CONFIG_ID,
  EMPTY_SESSION_CONTROLS,
  findSessionConfigOption,
  parseContextUsage,
  parseSessionConfig,
  parseSessionConfigOptions,
  sessionControlsReducer,
} from "../src/components/chat/chatSessionConfig";
import { parseModeFromConfigOptions } from "../src/components/chat/chatSessionMode";

const configOptions = [
  {
    id: "provider-model",
    category: "model",
    type: "select",
    name: "Model",
    currentValue: "gateway-custom[1m]",
    options: [
      { name: "Gateway", options: [
        { value: "gateway-custom[1m]", name: "Custom model", description: "Provided by the agent" },
        { value: "gateway-other", name: "Other model" },
      ] },
    ],
  },
  {
    id: "effort",
    type: "select",
    category: "thought_level",
    name: "Reasoning effort",
    currentValue: "high",
    options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }],
  },
];
const snapshot = {
  kind: "session_config",
  config_options: configOptions,
  context_window: null,
  context_window_editable: true,
  context_window_choices: [100000, 200000, 500000, 1000000],
};

function config() {
  const parsed = parseSessionConfig(snapshot);
  if (!parsed) throw new Error("Fixture is invalid");
  return parsed;
}

test("session config envelope accepts advertised ACP arrays", () => {
  expect(ChatEventSchema.parse(snapshot).kind).toBe("session_config");
  expect(ChatEventSchema.safeParse({ ...snapshot, context_window: -1 }).success).toBe(false);
  expect(ChatEventSchema.safeParse({ ...snapshot, context_window_editable: "true" }).success).toBe(false);
  const defaults = { ...snapshot, effort_default: "high", context_window_default: 180000 };
  expect(ChatEventSchema.parse(defaults)).toMatchObject({ effort_default: "high", context_window_default: 180000 });
  expect(ChatEventSchema.safeParse({ ...defaults, context_window_default: -1 }).success).toBe(false);
});

test("local defaults are optional, validated and retained across ACP updates", () => {
  expect(config().effortDefault).toBeNull();
  expect(config().contextWindowDefault).toBeNull();
  const parsed = parseSessionConfig({ ...snapshot, effort_default: "high", context_window_default: 180000 });
  expect(parsed?.effortDefault).toBe("high");
  expect(parsed?.contextWindowDefault).toBe(180000);
  const updated = sessionControlsReducer({ config: parsed, pendingConfigId: null }, {
    type: "options", options: parseSessionConfigOptions([configOptions[0], { ...configOptions[1], currentValue: "low" }]),
  });
  expect(updated.config?.effortDefault).toBe("high");
  expect(updated.config?.contextWindowDefault).toBe(180000);
  const changedModel = sessionControlsReducer(updated, {
    type: "options", options: parseSessionConfigOptions([{ ...configOptions[0], currentValue: "gateway-other" }, configOptions[1]]),
  });
  expect(changedModel.config?.effortDefault).toBeNull();
  expect(changedModel.config?.contextWindowDefault).toBe(180000);
  const unsupported = sessionControlsReducer(updated, { type: "options", options: [] });
  expect(unsupported.config?.effortDefault).toBeNull();
  for (const value of [0, -1, NaN, "200000"]) {
    expect(parseSessionConfig({ ...snapshot, context_window_default: value })).toBeNull();
  }
  for (const value of ["", "   ", 42]) {
    expect(parseSessionConfig({ ...snapshot, effort_default: value })).toBeNull();
  }
});

test("automatic context default survives schema parsing and ACP updates", () => {
  const event = ChatEventSchema.parse({ ...snapshot, context_window_automatic: true });
  const parsed = parseSessionConfig(event);
  expect(parsed?.contextWindowAutomatic).toBe(true);
  const updated = sessionControlsReducer({ config: parsed, pendingConfigId: null }, { type: "options", options: [] });
  expect(updated.config?.contextWindowAutomatic).toBe(true);
  expect(parseSessionConfig({ ...snapshot, context_window_automatic: "true" })).toBeNull();
  expect(config().contextWindowAutomatic).toBe(false);
});

test("select parser preserves provider-specific values and option groups", () => {
  const options = parseSessionConfigOptions(configOptions);
  expect(options).toHaveLength(2);
  expect(findSessionConfigOption(options, "model")?.currentValue).toBe("gateway-custom[1m]");
  expect(options[0].options[0]).toEqual({
    value: "gateway-custom[1m]", name: "Custom model", description: "Provided by the agent", group: "Gateway",
  });
  expect(findSessionConfigOption(options, "effort")?.currentValue).toBe("high");
  expect(findSessionConfigOption([options[0]], "effort")).toBeUndefined();
});

test("malformed and non-select options are ignored without inventing a selection", () => {
  expect(parseSessionConfigOptions([
    null,
    { ...configOptions[0], id: undefined },
    { ...configOptions[0], currentValue: undefined },
    { ...configOptions[0], type: "boolean" },
    { ...configOptions[0], options: [null, { value: "bad" }] },
  ])).toEqual([]);
  const options = parseSessionConfigOptions([{ ...configOptions[0], currentValue: "unlisted-current" }]);
  expect(options[0].currentValue).toBe("unlisted-current");
  expect(options[0].options.some((option) => option.value === "unlisted-current")).toBe(false);
});

test("existing mode parsing uses the same grouped options", () => {
  const mode = parseModeFromConfigOptions([{ ...configOptions[0], category: "mode" }]);
  expect(mode?.currentValue).toBe("gateway-custom[1m]");
  expect(mode?.options[0].group).toBe("Gateway");
});

test("only advertised configuration and context choices can be sent", () => {
  const state = config();
  expect(canSetSessionConfigOption(state, "provider-model", "gateway-other")).toBe(true);
  expect(canSetSessionConfigOption(state, "provider-model", "invented-model")).toBe(false);
  expect(canSetSessionConfigOption(state, "effort", "max")).toBe(false);
  expect(canSetSessionConfigOption(state, CONTEXT_WINDOW_CONFIG_ID, "auto")).toBe(true);
  expect(canSetSessionConfigOption(state, CONTEXT_WINDOW_CONFIG_ID, "1000000")).toBe(true);
  expect(canSetSessionConfigOption(state, CONTEXT_WINDOW_CONFIG_ID, "1000001")).toBe(false);
  expect(canSetSessionConfigOption(state, CONTEXT_WINDOW_CONFIG_ID, "1e6")).toBe(false);
  expect(canSetSessionConfigOption(null, "effort", "high")).toBe(false);
});

test("unsupported context is never made editable by a fallback", () => {
  const state = parseSessionConfig({ ...snapshot, context_window_choices: [] });
  expect(state?.contextWindowEditable).toBe(false);
  expect(canSetSessionConfigOption(state, CONTEXT_WINDOW_CONFIG_ID, "auto")).toBe(false);
  expect(parseSessionConfig({ ...snapshot, context_window: NaN })).toBeNull();
  expect(parseSessionConfig({ ...snapshot, context_window: 0 })).toBeNull();
  const readonly = { ...config(), contextWindowEditable: false };
  expect(canSetSessionConfigOption(readonly, CONTEXT_WINDOW_CONFIG_ID, "200000")).toBe(false);
});

test("requests retain confirmed selections until a server snapshot arrives", () => {
  const confirmed = sessionControlsReducer(EMPTY_SESSION_CONTROLS, { type: "snapshot", config: config() });
  const pending = sessionControlsReducer(confirmed, { type: "request", configId: "effort" });
  expect(pending.config).toBe(confirmed.config);
  expect(pending.config?.configOptions[1].currentValue).toBe("high");
  expect(pending.pendingConfigId).toBe("effort");
  expect(sessionControlsReducer(pending, { type: "request", configId: "provider-model" })).toBe(pending);
  const updated = { ...config(), configOptions: parseSessionConfigOptions([
    configOptions[0], { ...configOptions[1], currentValue: "low" },
  ]) };
  const accepted = sessionControlsReducer(pending, { type: "snapshot", config: updated });
  expect(accepted.pendingConfigId).toBeNull();
  expect(accepted.config?.configOptions[1].currentValue).toBe("low");
});

test("errors preserve confirmed settings, reconnect resets, ACP updates do not acknowledge a request", () => {
  const pending = { config: config(), pendingConfigId: "effort" };
  const error = sessionControlsReducer(pending, { type: "settled" });
  expect(error.pendingConfigId).toBeNull();
  expect(error.config).toBe(pending.config);
  expect(sessionControlsReducer(pending, { type: "reset" })).toEqual(EMPTY_SESSION_CONTROLS);
  const update = sessionControlsReducer(pending, { type: "options", options: [] });
  expect(update.pendingConfigId).toBe("effort");
  expect(update.config?.contextWindowChoices).toEqual(config().contextWindowChoices);
});

test("usage is agent-reported, accepts zero usage and does not invent unknown capacity", () => {
  expect(parseContextUsage({ sessionUpdate: "usage_update", used: 0, size: 200000 }))
    .toEqual({ used: 0, size: 200000 });
  expect(parseContextUsage({ sessionUpdate: "usage_update", used: 210000, size: 200000 }))
    .toEqual({ used: 210000, size: 200000 });
  expect(parseContextUsage({ sessionUpdate: "usage_update", used: 42000 }))
    .toEqual({ used: 42000, size: null });
  for (const bad of [-1, Infinity, NaN, "100", 0.5]) {
    expect(parseContextUsage({ sessionUpdate: "usage_update", used: bad, size: 200000 })).toBeNull();
  }
  for (const bad of [0, -1, Infinity, "200000"]) {
    expect(parseContextUsage({ sessionUpdate: "usage_update", used: 100, size: bad })).toBeNull();
  }
  expect(parseContextUsage({ sessionUpdate: "agent_message_chunk", used: 1, size: 2 })).toBeNull();
});
