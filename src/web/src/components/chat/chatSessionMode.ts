import type { SessionModeState } from "./chatTypes";
import { parseSelectOptions } from "./chatSessionConfig";

export function parseSessionModeState(value: unknown): SessionModeState | null {
  if (!isRecord(value)) return null;
  const source = value.source;
  if (source !== "config_option" && source !== "session_mode") return null;
  const currentValue = stringValue(value.currentValue);
  const options = parseSelectOptions(value.options);
  if (!currentValue || options.length === 0) return null;
  return {
    source,
    configId: stringValue(value.configId),
    name: stringValue(value.name),
    description: stringValue(value.description),
    currentValue,
    options,
  };
}

export function parseModeFromConfigOptions(
  configOptions: unknown,
): SessionModeState | null {
  if (!Array.isArray(configOptions)) return null;
  const option = configOptions.find((item) => {
    if (!isRecord(item)) return false;
    return item.category === "mode" || item.id === "mode";
  });
  if (!isRecord(option) || option.type !== "select") return null;
  const currentValue = stringValue(option.currentValue);
  const options = parseSelectOptions(option.options);
  if (!currentValue || options.length === 0) return null;
  return {
    source: "config_option",
    configId: stringValue(option.id),
    name: stringValue(option.name),
    description: stringValue(option.description),
    currentValue,
    options,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
