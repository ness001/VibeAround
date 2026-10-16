import type { SessionModeState } from "./chatTypes";

export interface QueuedModeChange {
  sessionId: string;
  modeId: string;
  source: SessionModeState["source"];
  configId: string | null;
  modelId: string | null;
}

export interface ModeChangeContext {
  sessionId?: string;
  mode: SessionModeState | null;
  modelId: string | null;
  connected: boolean;
  replaying: boolean;
  busy: boolean;
  pending: boolean;
}

export type ModeChangeDecision =
  | { type: "reject" | "cancel" | "wait" }
  | { type: "queue"; change: QueuedModeChange }
  | { type: "send"; configId: string; payload: Record<string, string> };

function modeRequest(mode: SessionModeState, modeId: string): ModeChangeDecision {
  return mode.source === "config_option" && mode.configId
    ? { type: "send", configId: mode.configId, payload: { type: "set_config_option", configId: mode.configId, value: modeId } }
    : { type: "send", configId: "session_mode", payload: { type: "set_mode", modeId } };
}

export function selectSessionMode(modeId: string, context: ModeChangeContext): ModeChangeDecision {
  const { mode } = context;
  if (!context.connected || context.replaying || !mode
    || !mode.options.some(option => option.value === modeId)
    || (mode.source === "config_option" && !mode.configId)) return { type: "reject" };
  if (mode.currentValue === modeId) return { type: "cancel" };
  if (context.busy || context.pending) {
    if (!context.sessionId) return { type: "reject" };
    return { type: "queue", change: {
      sessionId: context.sessionId, modeId, source: mode.source,
      configId: mode.configId ?? null, modelId: context.modelId,
    } };
  }
  return modeRequest(mode, modeId);
}

export function flushSessionMode(change: QueuedModeChange | null, context: ModeChangeContext): ModeChangeDecision {
  if (!change) return { type: "wait" };
  const { mode } = context;
  if (!context.connected || context.replaying || !mode
    || context.sessionId !== change.sessionId || context.modelId !== change.modelId
    || mode.source !== change.source || (mode.configId ?? null) !== change.configId
    || !mode.options.some(option => option.value === change.modeId)
    || mode.currentValue === change.modeId) return { type: "cancel" };
  if (context.busy || context.pending) return { type: "wait" };
  return modeRequest(mode, change.modeId);
}
