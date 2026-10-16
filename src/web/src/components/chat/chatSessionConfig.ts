import type {
  ContextUsage,
  SessionConfigOption,
  SessionConfigState,
  SessionModeOption,
} from "./chatTypes";

export const CONTEXT_WINDOW_CONFIG_ID = "vibearound.context_window";

export function parseSelectOptions(value: unknown): SessionModeOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    if (Array.isArray(item.options)) {
      const group = stringValue(item.name);
      return parseSelectOptions(item.options).map((option) => ({
        ...option,
        group: option.group ?? group,
      }));
    }
    const optionValue = stringValue(item.value);
    const name = stringValue(item.name);
    if (!optionValue || !name) return [];
    return [{
      value: optionValue,
      name,
      description: stringValue(item.description),
      group: stringValue(item.group),
    }];
  });
}

export function parseSessionConfigOptions(value: unknown): SessionConfigOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || item.type !== "select") return [];
    const configId = stringValue(item.id);
    const currentValue = stringValue(item.currentValue);
    const options = parseSelectOptions(item.options);
    if (!configId || !currentValue || options.length === 0) return [];
    return [{
      configId,
      category: stringValue(item.category),
      name: stringValue(item.name) ?? configId,
      description: stringValue(item.description),
      currentValue,
      options,
    }];
  });
}

export function findSessionConfigOption(
  options: SessionConfigOption[],
  category: "model" | "effort",
): SessionConfigOption | undefined {
  return options.find((option) => option.category === category)
    ?? options.find((option) => option.configId === category
      || (category === "effort" && option.category === "thought_level"));
}

export function parseSessionConfig(value: unknown): SessionConfigState | null {
  if (!isRecord(value) || !Array.isArray(value.config_options)
    || typeof value.context_window_editable !== "boolean"
    || !Array.isArray(value.context_window_choices)) return null;
  if (value.context_window !== null && !positiveInteger(value.context_window)) return null;
  if (value.context_window_default != null && !positiveInteger(value.context_window_default)) return null;
  if (value.effort_default != null && !stringValue(value.effort_default)) return null;
  if (value.context_window_automatic !== undefined && typeof value.context_window_automatic !== "boolean") return null;
  const choices = [...new Set(value.context_window_choices.filter(positiveInteger))];
  return {
    configOptions: parseSessionConfigOptions(value.config_options),
    contextWindow: value.context_window,
    effortDefault: stringValue(value.effort_default) ?? null,
    contextWindowDefault: positiveInteger(value.context_window_default) ? value.context_window_default : null,
    contextWindowAutomatic: value.context_window_automatic === true,
    contextWindowEditable: value.context_window_editable && choices.length > 0,
    contextWindowChoices: choices,
  };
}

export function parseContextUsage(value: unknown): ContextUsage | null {
  if (!isRecord(value) || value.sessionUpdate !== "usage_update"
    || typeof value.used !== "number" || !Number.isSafeInteger(value.used)
    || value.used < 0) return null;
  if (value.size !== undefined && value.size !== null && !positiveInteger(value.size)) return null;
  return { used: value.used, size: positiveInteger(value.size) ? value.size : null };
}

export type SessionControlsState = {
  config: SessionConfigState | null;
  pendingConfigId: string | null;
};

export const EMPTY_SESSION_CONTROLS: SessionControlsState = {
  config: null,
  pendingConfigId: null,
};

type SessionControlsAction =
  | { type: "snapshot"; config: SessionConfigState }
  | { type: "options"; options: SessionConfigOption[] }
  | { type: "request"; configId: string }
  | { type: "settled" }
  | { type: "reset" };

export function sessionControlsReducer(
  state: SessionControlsState,
  action: SessionControlsAction,
): SessionControlsState {
  switch (action.type) {
    case "snapshot":
      return { config: action.config, pendingConfigId: null };
    case "options": {
      const modelChanged = findSessionConfigOption(state.config?.configOptions ?? [], "model")?.currentValue
        !== findSessionConfigOption(action.options, "model")?.currentValue;
      return {
        ...state,
        config: {
          configOptions: action.options,
          contextWindow: state.config?.contextWindow ?? null,
          effortDefault: modelChanged || !findSessionConfigOption(action.options, "effort")
            ? null
            : state.config?.effortDefault ?? null,
          contextWindowDefault: state.config?.contextWindowDefault ?? null,
          contextWindowAutomatic: state.config?.contextWindowAutomatic ?? false,
          contextWindowEditable: state.config?.contextWindowEditable ?? false,
          contextWindowChoices: state.config?.contextWindowChoices ?? [],
        },
      };
    }
    case "request":
      return state.pendingConfigId ? state : { ...state, pendingConfigId: action.configId };
    case "settled":
      return { ...state, pendingConfigId: null };
    case "reset":
      return EMPTY_SESSION_CONTROLS;
  }
}

export function canSetSessionConfigOption(
  config: SessionConfigState | null,
  configId: string,
  value: string,
): boolean {
  if (!config) return false;
  if (configId === CONTEXT_WINDOW_CONFIG_ID) {
    return config.contextWindowEditable && (value === "auto"
      || config.contextWindowChoices.some((choice) => String(choice) === value));
  }
  return config.configOptions.some((option) => option.configId === configId
    && option.options.some((choice) => choice.value === value));
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
