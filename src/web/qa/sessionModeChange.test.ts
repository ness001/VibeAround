import { expect, test } from "bun:test";
import { flushSessionMode, selectSessionMode, type ModeChangeContext, type QueuedModeChange } from "../src/components/chat/sessionModeChange";

const context: ModeChangeContext = {
  sessionId: "session-a", modelId: "model-a", connected: true, replaying: false, busy: false, pending: false,
  mode: { source: "config_option", configId: "permission", currentValue: "default", options: [
    { value: "default", name: "Manual" }, { value: "plan", name: "Plan" }, { value: "acceptEdits", name: "Accept edits" },
  ] },
};
function queued(): QueuedModeChange {
  const decision = selectSessionMode("plan", { ...context, busy: true });
  if (decision.type !== "queue") throw new Error("Expected queue");
  return decision.change;
}

test("idle mode changes use the advertised config option ID", () => {
  expect(selectSessionMode("plan", context)).toEqual({ type: "send", configId: "permission", payload: { type: "set_config_option", configId: "permission", value: "plan" } });
  expect(context.mode?.currentValue).toBe("default");
});

test("legacy modes use set_mode, not a fabricated config option", () => {
  const legacy = { ...context, mode: { ...context.mode!, source: "session_mode" as const, configId: undefined } };
  expect(selectSessionMode("plan", legacy)).toEqual({ type: "send", configId: "session_mode", payload: { type: "set_mode", modeId: "plan" } });
});

test("busy selection waits then consumes exactly once when idle", () => {
  let change: QueuedModeChange | null = queued();
  expect(flushSessionMode(change, { ...context, busy: true })).toEqual({ type: "wait" });
  expect(flushSessionMode(change, { ...context, pending: true })).toEqual({ type: "wait" });
  const sent = [];
  for (let frame = 0; frame < 3; frame++) {
    const decision = flushSessionMode(change, context);
    if (decision.type === "send") { change = null; sent.push(decision.payload); }
  }
  expect(sent).toHaveLength(1);
  expect(sent[0].value).toBe("plan");
});

test("last selection replaces queue and selecting current mode cancels", () => {
  const first = queued();
  const last = selectSessionMode("acceptEdits", { ...context, busy: true });
  expect(first.modeId).toBe("plan");
  expect(last.type === "queue" && last.change.modeId).toBe("acceptEdits");
  expect(selectSessionMode("default", { ...context, busy: true })).toEqual({ type: "cancel" });
  expect(flushSessionMode(null, context)).toEqual({ type: "wait" });
});

test("queued modes cannot cross sessions, models, replay, disconnect or capability changes", () => {
  for (const patch of [
    { sessionId: "session-b" }, { sessionId: undefined }, { modelId: "model-b" },
    { connected: false }, { replaying: true }, { mode: null },
    { mode: { ...context.mode!, options: [{ value: "default", name: "Manual" }] } },
    { mode: { ...context.mode!, currentValue: "plan" } },
    { mode: { ...context.mode!, configId: "different" } },
  ]) expect(flushSessionMode(queued(), { ...context, ...patch })).toEqual({ type: "cancel" });
});

test("invalid choices and busy drafts are rejected", () => {
  expect(selectSessionMode("invented", context)).toEqual({ type: "reject" });
  expect(selectSessionMode("plan", { ...context, busy: true, sessionId: undefined })).toEqual({ type: "reject" });
  expect(selectSessionMode("plan", { ...context, connected: false })).toEqual({ type: "reject" });
  expect(selectSessionMode("plan", { ...context, replaying: true })).toEqual({ type: "reject" });
});
