"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  ChatEventSchema,
  formatErrorMessage,
  type AgentInfo,
  type LaunchSessionInfo,
  type MultiAgentTurn,
  type ThreadAgent,
} from "@va/client";
import { useI18n } from "@va/i18n";
import { getWebSocketUrl } from "@/lib/ws-url";
import type {
  ChatAttachment,
  ChatMessage,
  ChatMeta,
  ChatSessionSelection,
  ContextUsage,
  PendingPermission,
  SessionModeState,
} from "./chatTypes";
import { createMessageId, switchedAgentId } from "./chatFrameUtils";
import {
  appendErrorToStreamMessage,
  appendStandaloneAssistantMessage,
  mergeChatMessageSnapshots,
  setStreamProgressMessage,
  settleStreamActivitiesMessage,
} from "./chatMessageUpdates";
import { applyChatTranscriptUpdate } from "./chatTranscriptUpdates";
import { startReconnectingWebSocket } from "./reconnectingWebSocket";
import {
  readCachedChatSession,
  writeCachedChatSession,
} from "./chatSessionCache";
import { chatUserContentBlocks } from "./chatUserContent";
import {
  parseModeFromConfigOptions,
  parseSessionModeState,
} from "./chatSessionMode";
import { currentUnixSeconds } from "./chatTime";
import { flushSessionMode, selectSessionMode, type ModeChangeContext, type QueuedModeChange } from "./sessionModeChange";
import {
  canSetSessionConfigOption,
  findSessionConfigOption,
  EMPTY_SESSION_CONTROLS,
  parseContextUsage,
  parseSessionConfig,
  parseSessionConfigOptions,
  sessionControlsReducer,
} from "./chatSessionConfig";

interface UseWebChatConnectionOptions {
  chatId?: string;
  onAgentSelected?: (agentId: string, source: "config" | "system") => void;
}

const CACHE_WRITE_DEBOUNCE_MS = 350;
const SESSION_CONFIG_TIMEOUT_MS = 45_000;
const USER_CONTENT_PART_ID_PREFIX = "user-content";
const COMPACTION_NOTICE_DROP_RATIO = 0.55;
const COMPACTION_NOTICE_MIN_WINDOW_RATIO = 0.25;
const COMPACTION_NOTICE_MIN_DROP = 128;
interface SendChatMessageRequest {
  text: string;
  attachments?: ChatAttachment[];
  agentId: string;
  profileId?: string;
  workspacePath?: string;
  threadId?: string;
  sessionSelection: ChatSessionSelection;
  launchSession?: LaunchSessionInfo;
}

interface ResumeChatSessionRequest {
  agentId: string;
  profileId?: string;
  launchSession: LaunchSessionInfo;
}

type MessageUpdate = (prev: ChatMessage[]) => ChatMessage[];

type UsageSnapshot = {
  used: number;
  size: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function sessionUpdateName(update: unknown): string | undefined {
  const record = asRecord(update);
  const name = record?.sessionUpdate;
  return typeof name === "string" ? name : undefined;
}

function hasCompactionSignal(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || value === undefined) return false;
  if (typeof value === "string") {
    return value.toLowerCase().includes("compact");
  }
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => hasCompactionSignal(item, depth + 1));
  }
  return Object.entries(value).some(
    ([key, item]) =>
      key.toLowerCase().includes("compact") ||
      hasCompactionSignal(item, depth + 1),
  );
}

function isCompactionUpdate(update: unknown): boolean {
  const name = sessionUpdateName(update);
  if (name?.toLowerCase().includes("compact")) return true;
  return hasCompactionSignal(asRecord(update)?._meta);
}

function isCompactionUsageDrop(
  previous: UsageSnapshot | undefined,
  current: UsageSnapshot,
): boolean {
  if (!previous || previous.size !== current.size || previous.used <= current.used) {
    return false;
  }
  const drop = previous.used - current.used;
  const enoughDrop = drop >= Math.max(COMPACTION_NOTICE_MIN_DROP, current.size * 0.02);
  const enoughPriorContext =
    previous.used >= current.size * COMPACTION_NOTICE_MIN_WINDOW_RATIO;
  const sharpReset = current.used / previous.used <= COMPACTION_NOTICE_DROP_RATIO;
  return enoughDrop && enoughPriorContext && sharpReset;
}

interface TranscriptCacheContext {
  sessionId?: string;
  agentId?: string;
  workspace?: string;
  updatedAt?: number;
}

export interface ResumeReplayState {
  sessionId: string;
  title?: string;
  agentId?: string;
  workspace?: string;
  updatedAt?: number;
  blocking?: boolean;
}

export function useWebChatConnection({
  chatId,
  onAgentSelected,
}: UseWebChatConnectionOptions = {}) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [meta, setMeta] = useState<ChatMeta>({});
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);
  const [sessionMode, setSessionModeState] = useState<SessionModeState | null>(null);
  const [queuedModeId, setQueuedModeId] = useState<string | null>(null);
  const queuedModeRef = useRef<QueuedModeChange | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const modeStateRef = useRef<SessionModeState | null>(null);
  modeStateRef.current = sessionMode;
  const cancelQueuedMode = useCallback(() => {
    queuedModeRef.current = null;
    setQueuedModeId(null);
  }, []);
  const [sessionControls, setSessionControls] = useState(EMPTY_SESSION_CONTROLS);
  const sessionControlsRef = useRef(EMPTY_SESSION_CONTROLS);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const updateSessionControls = useCallback((action: Parameters<typeof sessionControlsReducer>[1]) => {
    const next = sessionControlsReducer(sessionControlsRef.current, action);
    sessionControlsRef.current = next;
    const queued = queuedModeRef.current;
    if (queued && (action.type === "snapshot" || action.type === "options")) {
      const options = next.config?.configOptions ?? [];
      const model = findSessionConfigOption(options, "model")?.currentValue ?? null;
      const mode = options.find(option => option.configId === queued.configId);
      if (model !== queued.modelId || (queued.source === "config_option"
        && (!mode?.options.some(option => option.value === queued.modeId) || mode.currentValue === queued.modeId))) {
        queuedModeRef.current = null;
        setQueuedModeId(null);
      }
    }
    setSessionControls(next);
  }, []);
  const [resumeReplay, setResumeReplay] = useState<ResumeReplayState | null>(null);
  const [multiAgentTurns, setMultiAgentTurns] = useState<MultiAgentTurn[]>([]);
  const [subagents, setSubagents] = useState<ThreadAgent[]>([]);
  const subagentsRef = useRef<ThreadAgent[]>([]);
  subagentsRef.current = subagents;
  const [subagentMessages, setSubagentMessages] = useState<
    Record<string, ChatMessage[]>
  >({});
  const [lastTurnCompletedAt, setLastTurnCompletedAt] = useState<number | undefined>();
  const wsRef = useRef<WebSocket | null>(null);
  const promptInFlightRef = useRef(false);
  const turnActiveRef = useRef(false);
  const resumeReplayRef = useRef<ResumeReplayState | null>(null);
  const resumeRequestIdRef = useRef(0);
  const messagesRef = useRef<ChatMessage[]>([]);
  /// Session whose transcript the server is currently replaying to this
  /// connection, between replay_start and replay_done.
  const replayingSessionRef = useRef<string | null>(null);
  const ignoredReplaySessionsRef = useRef<Set<string>>(new Set());
  const usageBySessionRef = useRef<Map<string, UsageSnapshot>>(new Map());
  const compactionNoticeKeysRef = useRef<Set<string>>(new Set());
  const replayCacheContextRef = useRef<ResumeReplayState | null>(null);
  const replayCacheWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const activeTranscriptCacheRef = useRef<TranscriptCacheContext | null>(null);
  const activeTranscriptCacheWriteTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  const updateResumeReplay = useCallback((next: ResumeReplayState | null) => {
    resumeReplayRef.current = next;
    setResumeReplay(next);
  }, []);

  const clearReplayCacheWriteTimer = useCallback(() => {
    if (!replayCacheWriteTimerRef.current) return;
    clearTimeout(replayCacheWriteTimerRef.current);
    replayCacheWriteTimerRef.current = null;
  }, []);

  const clearActiveTranscriptCacheWriteTimer = useCallback(() => {
    if (!activeTranscriptCacheWriteTimerRef.current) return;
    clearTimeout(activeTranscriptCacheWriteTimerRef.current);
    activeTranscriptCacheWriteTimerRef.current = null;
  }, []);

  const clearReplayCacheContext = useCallback(() => {
    replayCacheContextRef.current = null;
    clearReplayCacheWriteTimer();
  }, [clearReplayCacheWriteTimer]);

  const cacheTranscript = useCallback((
    context: TranscriptCacheContext,
    messagesToCache = messagesRef.current,
  ) => {
    if (
      !context.sessionId ||
      !context.agentId ||
      !context.workspace ||
      context.updatedAt === undefined
    ) {
      return;
    }
    if (messagesToCache.length === 0) return;
    void writeCachedChatSession({
      agentId: context.agentId,
      workspace: context.workspace,
      sessionId: context.sessionId,
      updatedAt: context.updatedAt,
      messages: messagesToCache,
    }).catch((error) => {
      console.warn("[ChatView] failed to cache chat session:", error);
    });
  }, []);

  const cacheResumeReplay = useCallback((
    replay: ResumeReplayState,
    messagesToCache = messagesRef.current,
  ) => {
    cacheTranscript(replay, messagesToCache);
  }, [cacheTranscript]);

  const scheduleReplayCacheWrite = useCallback(
    (replay = replayCacheContextRef.current) => {
      if (!replay?.agentId || !replay.workspace || replay.updatedAt === undefined) {
        return;
      }
      if (messagesRef.current.length === 0) return;
      clearReplayCacheWriteTimer();
      replayCacheWriteTimerRef.current = setTimeout(() => {
        cacheResumeReplay(replay);
      }, CACHE_WRITE_DEBOUNCE_MS);
    },
    [cacheResumeReplay, clearReplayCacheWriteTimer],
  );

  const scheduleActiveTranscriptCacheWrite = useCallback(
    (context = activeTranscriptCacheRef.current) => {
      if (
        !context?.sessionId ||
        !context.agentId ||
        !context.workspace ||
        context.updatedAt === undefined
      ) {
        return;
      }
      if (messagesRef.current.length === 0) return;
      clearActiveTranscriptCacheWriteTimer();
      activeTranscriptCacheWriteTimerRef.current = setTimeout(() => {
        cacheTranscript(context);
      }, CACHE_WRITE_DEBOUNCE_MS);
    },
    [cacheTranscript, clearActiveTranscriptCacheWriteTimer],
  );

  const applyMessageUpdate = useCallback((updater: MessageUpdate) => {
    setMessages(updater);
  }, []);

  useEffect(() => {
    const configId = sessionControls.pendingConfigId;
    if (!configId) return;
    const timeout = setTimeout(() => {
      if (sessionControlsRef.current.pendingConfigId !== configId) return;
      cancelQueuedMode();
      updateSessionControls({ type: "settled" });
      applyMessageUpdate((previous) => appendStandaloneAssistantMessage(
        previous,
        t("Chat settings request timed out. The change was not confirmed. Reconnect before retrying."),
      ));
    }, SESSION_CONFIG_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [applyMessageUpdate, cancelQueuedMode, sessionControls.pendingConfigId, t, updateSessionControls]);

  useEffect(() => {
    messagesRef.current = messages;
    scheduleReplayCacheWrite();
    scheduleActiveTranscriptCacheWrite();
  }, [messages, scheduleActiveTranscriptCacheWrite, scheduleReplayCacheWrite]);

  /// Drop any pending resume/replay bookkeeping without touching messages.
  const abortResumeState = useCallback(() => {
    replayingSessionRef.current = null;
    clearReplayCacheContext();
    updateResumeReplay(null);
  }, [clearReplayCacheContext, updateResumeReplay]);

  useEffect(() => {
    function markDisconnected(clearPermissions: boolean) {
      cancelQueuedMode();
      setConnected(false);
      setStreaming(false);
      updateSessionControls({ type: "settled" });
      setMessages((prev) => settleStreamActivitiesMessage(prev));
      promptInFlightRef.current = false;
      turnActiveRef.current = false;
      if (clearPermissions) setPendingPermissions([]);
      // The replay mute set is scoped to one connection: carrying it across a
      // reconnect (e.g. a daemon restart) silently drops every live
      // acp_notification for a muted session while the tab still looks
      // healthy — connection state and agent_ready are unfiltered.
      ignoredReplaySessionsRef.current.clear();
      abortResumeState();
    }

    cancelQueuedMode();
    sessionIdRef.current = undefined;
    setConnected(false);
    updateSessionControls({ type: "reset" });
    setSessionModeState(null);
    setContextUsage(null);
    usageBySessionRef.current.clear();
    if (!chatId) {
      return;
    }

    const closeSocket = startReconnectingWebSocket({
      socketRef: wsRef,
      url: () =>
        getWebSocketUrl(`/ws/chat?chat_id=${encodeURIComponent(chatId)}`),
      onOpen: () => {
        setConnected(true);
        updateSessionControls({ type: "reset" });
        wsRef.current?.send(JSON.stringify({ type: "get_session_config" }));
      },
      onMessage: handleSocketMessage,
      onError: () => markDisconnected(false),
      onClose: () => markDisconnected(true),
      onCreateError: (error) => {
        console.warn("[ChatView] failed to create chat websocket:", error);
        markDisconnected(true);
      },
    });

    function handleSocketMessage(event: MessageEvent) {
      if (typeof event.data !== "string") return;

      let parsed;
      try {
        parsed = ChatEventSchema.parse(JSON.parse(event.data));
      } catch (e) {
        console.warn("[ChatView] bad chat frame, dropping:", e);
        return;
      }

      switch (parsed.kind) {
        case "config": {
          setAgents(parsed.agents);
          setMeta((prev) => ({ ...prev, channelId: parsed.channel_id }));
          onAgentSelected?.(parsed.default_agent, "config");
          break;
        }
        case "agent_ready": {
          setMeta((prev) => ({
            ...prev,
            agentName: parsed.agent,
            agentVersion: parsed.version,
          }));
          break;
        }
        case "session_ready": {
          const pendingResume = resumeReplayRef.current;
          if (!pendingResume && ignoredReplaySessionsRef.current.has(parsed.session_id)) {
            break;
          }
          if (pendingResume && pendingResume.sessionId !== parsed.session_id) {
            break;
          }
          if (sessionIdRef.current !== parsed.session_id) cancelQueuedMode();
          sessionIdRef.current = parsed.session_id;
          setMeta((prev) => ({ ...prev, sessionId: parsed.session_id }));
          setSessionModeState(null);
          setContextUsage(null);
          if (activeTranscriptCacheRef.current) {
            activeTranscriptCacheRef.current = {
              ...activeTranscriptCacheRef.current,
              sessionId: parsed.session_id,
            };
            cacheTranscript(activeTranscriptCacheRef.current);
          }
          if (pendingResume?.sessionId === parsed.session_id) {
            // Resume acknowledged. Either the cache was fresh (nothing else
            // arrives) or a replay_start follows and rebuilds the view.
            updateResumeReplay(null);
          }
          break;
        }
        case "session_info": {
          // The server's own answer, which outranks anything this tab chose.
          const info = parsed.info;
          if (info.sessionId && sessionIdRef.current !== info.sessionId) {
            cancelQueuedMode();
            sessionIdRef.current = info.sessionId;
          }
          setMeta((prev) => ({
            ...prev,
            threadId: info.threadId,
            workspacePath: info.workspacePath,
            agentId: info.agent.id,
            agentName: info.agent.name,
            agentVersion: info.agent.version,
            profileId: info.agent.profileId,
          }));
          if (info.updatedAt !== undefined) {
            // Rebase cache stamps onto the server-issued value.
            if (activeTranscriptCacheRef.current?.sessionId === info.sessionId) {
              activeTranscriptCacheRef.current = {
                ...activeTranscriptCacheRef.current,
                updatedAt: Math.max(
                  activeTranscriptCacheRef.current.updatedAt ?? 0,
                  info.updatedAt,
                ),
              };
            }
            const replayContext = replayCacheContextRef.current;
            if (replayContext?.sessionId === info.sessionId) {
              replayCacheContextRef.current = {
                ...replayContext,
                updatedAt: Math.max(replayContext.updatedAt ?? 0, info.updatedAt),
              };
            }
          }
          break;
        }
        case "replay_start": {
          cancelQueuedMode();
          // The server re-renders this session's transcript from the agent's
          // own record; drop the local view and rebuild from the frames.
          replayingSessionRef.current = parsed.session_id;
          ignoredReplaySessionsRef.current.delete(parsed.session_id);
          messagesRef.current = [];
          setMessages([]);
          setMeta((prev) => ({ ...prev, sessionId: parsed.session_id }));
          break;
        }
        case "replay_done": {
          if (replayingSessionRef.current !== parsed.session_id) break;
          replayingSessionRef.current = null;
          // The replay frames may still be batched in React state updates,
          // so settle through a functional update and let the debounced
          // cache write read the synced snapshot afterwards.
          setMessages((prev) => {
            const settled = settleStreamActivitiesMessage(prev);
            messagesRef.current = settled;
            return settled;
          });
          const replayContext = replayCacheContextRef.current;
          if (replayContext?.sessionId === parsed.session_id) {
            scheduleReplayCacheWrite(replayContext);
          }
          updateResumeReplay(null);
          break;
        }
        case "session_config": {
          const config = parseSessionConfig(parsed);
          if (config) {
            updateSessionControls({ type: "snapshot", config });
            const mode = parseModeFromConfigOptions(parsed.config_options);
            setSessionModeState((previous) => mode
              ?? (previous?.source === "session_mode" ? previous : null));
          }
          break;
        }
        case "session_mode": {
          setSessionModeState(parseSessionModeState(parsed.session_mode));
          if (sessionControlsRef.current.pendingConfigId === "session_mode") {
            updateSessionControls({ type: "settled" });
          }
          break;
        }
        case "system_text": {
          appendStandaloneAssistant(parsed.text);
          abortResumeState();
          const agentId = switchedAgentId(parsed.text);
          if (agentId) {
            cancelQueuedMode();
            sessionIdRef.current = undefined;
            updateSessionControls({ type: "reset" });
            setContextUsage(null);
            setSessionModeState(null);
            onAgentSelected?.(agentId, "system");
            setMeta((prev) => ({
              ...prev,
              agentName: undefined,
              agentTitle: undefined,
              agentVersion: undefined,
              sessionId: undefined,
            }));
          }
          break;
        }
        case "error": {
          cancelQueuedMode();
          updateSessionControls({ type: "settled" });
          appendErrorToStream(formatErrorMessage(parsed.error));
          setStreaming(false);
          promptInFlightRef.current = false;
          abortResumeState();
          break;
        }
        case "turn_status": {
          const wasActive = turnActiveRef.current;
          turnActiveRef.current = parsed.active;
          if (wasActive && !parsed.active) {
            settleStreamActivities();
            setPendingPermissions([]);
            if (activeTranscriptCacheRef.current) {
              activeTranscriptCacheRef.current = {
                ...activeTranscriptCacheRef.current,
                updatedAt: Math.max(
                  activeTranscriptCacheRef.current.updatedAt ?? 0,
                  currentUnixSeconds(),
                ),
              };
              cacheTranscript(activeTranscriptCacheRef.current);
            }
            setLastTurnCompletedAt(Date.now());
          }
          setStreaming(parsed.active);
          promptInFlightRef.current = parsed.active;
          break;
        }
        case "acp_notification": {
          handleAcpNotification(parsed.payload as SessionNotification);
          break;
        }
        case "command_menu":
          break;
        case "permission_request": {
          setPendingPermissions((prev) => [
            ...prev.filter((permission) => permission.requestId !== parsed.request_id),
            { requestId: parsed.request_id, request: parsed.request },
          ]);
          break;
        }
        case "multi_agent_turn": {
          setMultiAgentTurns((prev) => mergeById(prev, [parsed.turn]));
          subagentsRef.current = mergeById(subagentsRef.current, parsed.agents);
          setSubagents(subagentsRef.current);
          break;
        }
        case "subagent_status": {
          subagentsRef.current = mergeById(subagentsRef.current, [parsed.agent]);
          setSubagents(subagentsRef.current);
          break;
        }
        case "subagent_acp_notification": {
          const notif = parsed.payload as SessionNotification;
          setSubagentMessages((prev) => ({
            ...prev,
            [parsed.agent.id]: applySubagentAcpNotification(
              prev[parsed.agent.id] ?? [],
              notif,
            ),
          }));
          break;
        }
      }
    }

    function handleAcpNotification(notif: SessionNotification) {
      if (ignoredReplaySessionsRef.current.has(notif.sessionId)) {
        return;
      }
      const pendingResume = resumeReplayRef.current;
      if (pendingResume && notif.sessionId !== pendingResume.sessionId) {
        return;
      }
      const replaying = replayingSessionRef.current === notif.sessionId;
      const update = notif.update;
      const applyTranscriptUpdate = (
        options?: Parameters<typeof applyChatTranscriptUpdate>[2],
      ) => {
        applyMessageUpdate((prev) => applyChatTranscriptUpdate(prev, update, options));
      };

      const usage = parseContextUsage(update);
      if (usage) setContextUsage(usage);
      if (usage && usage.size !== null) {
        const snapshot = { used: usage.used, size: usage.size };
        const previous = usageBySessionRef.current.get(notif.sessionId);
        usageBySessionRef.current.set(notif.sessionId, snapshot);
        if (isCompactionUsageDrop(previous, snapshot)) {
          appendCompactionNotice(
            notif.sessionId,
            `usage:${previous?.used}->${usage.used}/${usage.size}`,
          );
        }
      }
      if (isCompactionUpdate(update)) {
        appendCompactionNotice(
          notif.sessionId,
          `update:${sessionUpdateName(update) ?? "meta"}:${usage?.used ?? ""}/${usage?.size ?? ""}`,
        );
      }

      switch (update.sessionUpdate) {
        case "user_message_chunk": {
          applyTranscriptUpdate({
            userMessage: {
              forceNewMessage: replaying && !update.messageId,
              dedupeExistingText: !replaying,
            },
          });
          break;
        }
        case "agent_message_chunk": {
          applyTranscriptUpdate();
          break;
        }
        case "agent_thought_chunk": {
          applyTranscriptUpdate({ thinkingLabel: t("Thinking") });
          break;
        }
        case "tool_call":
        case "tool_call_update": {
          applyTranscriptUpdate({
            toolProgressLabel: (tool) =>
              t("Using tool: {{tool}}…", { tool }),
          });
          break;
        }
        case "plan": {
          applyTranscriptUpdate();
          break;
        }
        case "config_option_update": {
          const configOptions = (update as { configOptions?: unknown }).configOptions;
          updateSessionControls({
            type: "options",
            options: parseSessionConfigOptions(configOptions),
          });
          const mode = parseModeFromConfigOptions(configOptions);
          setSessionModeState((previous) => mode
            ?? (previous?.source === "session_mode" ? previous : null));
          break;
        }
        case "current_mode_update": {
          const modeId = (update as { modeId?: unknown }).modeId;
          if (typeof modeId === "string" && modeId.trim()) {
            setSessionModeState((prev) =>
              prev?.source === "session_mode"
                ? { ...prev, currentValue: modeId.trim() }
                : prev,
            );
          }
          break;
        }
        // Non-transcript ACP updates are handled by surrounding UI state.
        default:
          break;
      }
    }

    function appendCompactionNotice(sessionId: string, noticeKey: string) {
      const key = `${sessionId}:${noticeKey}`;
      if (compactionNoticeKeysRef.current.has(key)) return;
      compactionNoticeKeysRef.current.add(key);
      appendStandaloneAssistant(
        t("Context compacted. Continuing from a compressed summary."),
      );
    }

    function appendStandaloneAssistant(text: string) {
      applyMessageUpdate((prev) => appendStandaloneAssistantMessage(prev, text));
    }

    function settleStreamActivities() {
      applyMessageUpdate((prev) => settleStreamActivitiesMessage(prev));
    }

    function appendErrorToStream(error: string) {
      applyMessageUpdate(
        (prev) => appendErrorToStreamMessage(prev, t("Error: {{error}}", { error })),
      );
    }

    return () => {
      closeSocket();
      clearReplayCacheWriteTimer();
      clearActiveTranscriptCacheWriteTimer();
    };
  }, [
    abortResumeState,
    applyMessageUpdate,
    cacheTranscript,
    cancelQueuedMode,
    chatId,
    clearActiveTranscriptCacheWriteTimer,
    clearReplayCacheWriteTimer,
    onAgentSelected,
    scheduleReplayCacheWrite,
    t,
    updateResumeReplay,
    updateSessionControls,
  ]);

  const sendMessage = useCallback(
    ({
      text,
      attachments = [],
      agentId,
      profileId,
      workspacePath,
      threadId,
      sessionSelection,
      launchSession,
    }: SendChatMessageRequest) => {
      const trimmed = text.trim();
      if (queuedModeRef.current || sessionControlsRef.current.pendingConfigId) return false;
      const ws = wsRef.current;
      if ((!trimmed && attachments.length === 0) || !ws || ws.readyState !== WebSocket.OPEN) {
        return false;
      }
      if (promptInFlightRef.current || sessionControlsRef.current.pendingConfigId) return false;

      const uniqueAttachments = dedupeChatAttachments(attachments);
      promptInFlightRef.current = true;
      const messageId = createMessageId();
      const contentParts = chatUserContentBlocks(trimmed, uniqueAttachments).map((block, index) => ({
        id: `${USER_CONTENT_PART_ID_PREFIX}-${Date.now()}-${index}`,
        kind: "content" as const,
        block,
      }));
      const optimisticMessage: ChatMessage = {
        role: "user",
        content: trimmed,
        parts: contentParts,
        messageId,
        optimistic: true,
      };
      const optimisticMessages = [...messagesRef.current, optimisticMessage];
      messagesRef.current = optimisticMessages;
      setMessages(optimisticMessages);
      setStreaming(true);
      const submittedAt = currentUnixSeconds();

      try {
        const payload: Record<string, unknown> = {
          type: "message",
          messageId,
          text: trimmed,
          agent: agentId,
        };
        if (uniqueAttachments.length > 0) {
          payload.attachments = uniqueAttachments.map((attachment) => ({
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.size,
            uri: attachment.uri,
          }));
        }
        if (profileId !== undefined) {
          payload.profileId = profileId;
        }
        // The route already runs the session this chat is about: init bound it,
        // and `resume_session` is what asks for a different one. Restating it
        // on every turn only gives the server a stale claim to act on.
        const resumedSessionId =
          sessionSelection.kind === "resume" && launchSession
            ? launchSession.session_id
            : meta.sessionId;
        if (threadId) {
          payload.threadId = threadId;
        }
        ws.send(JSON.stringify(payload));
        const cacheContext: TranscriptCacheContext = {
          sessionId: resumedSessionId,
          agentId,
          workspace: launchSession?.workspace ?? workspacePath,
          updatedAt: Math.max(launchSession?.updated_at ?? 0, submittedAt),
        };
        activeTranscriptCacheRef.current = cacheContext;
        cacheTranscript(cacheContext);
        clearReplayCacheContext();
        return true;
      } catch (error) {
        console.warn("[ChatView] failed to send chat message:", error);
        activeTranscriptCacheRef.current = null;
        clearActiveTranscriptCacheWriteTimer();
        promptInFlightRef.current = false;
        setStreaming(false);
        setMessages((prev) => prev.filter((message) => message.messageId !== messageId));
        return false;
      }
    },
    [
      cacheTranscript,
      clearActiveTranscriptCacheWriteTimer,
      clearReplayCacheContext,
      meta.sessionId,
    ],
  );

  const sendSessionConfig = useCallback((configId: string, payload: Record<string, string>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || promptInFlightRef.current
      || turnActiveRef.current || resumeReplayRef.current
      || sessionControlsRef.current.pendingConfigId) return false;
    updateSessionControls({ type: "request", configId });
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      updateSessionControls({ type: "settled" });
      applyMessageUpdate((previous) => appendStandaloneAssistantMessage(
        previous, t("Unable to apply chat settings. Reconnect and try again."),
      ));
      console.warn("[ChatView] failed to set session config:", error);
      return false;
    }
  }, [applyMessageUpdate, t, updateSessionControls]);

  const modeChangeContext = useCallback((): ModeChangeContext => ({
    sessionId: sessionIdRef.current,
    mode: modeStateRef.current,
    modelId: findSessionConfigOption(sessionControlsRef.current.config?.configOptions ?? [], "model")?.currentValue ?? null,
    connected: wsRef.current?.readyState === WebSocket.OPEN,
    replaying: Boolean(resumeReplayRef.current || replayingSessionRef.current),
    busy: promptInFlightRef.current || turnActiveRef.current || subagentsRef.current.some(agent => agent.status === "running"),
    pending: Boolean(sessionControlsRef.current.pendingConfigId),
  }), []);

  const setSessionMode = useCallback((modeId: string) => {
    const decision = selectSessionMode(modeId, modeChangeContext());
    if (decision.type === "reject") return false;
    cancelQueuedMode();
    if (decision.type === "queue") {
      queuedModeRef.current = decision.change;
      setQueuedModeId(modeId);
      return true;
    }
    if (decision.type === "send") return sendSessionConfig(decision.configId, decision.payload);
    return true;
  }, [cancelQueuedMode, modeChangeContext, sendSessionConfig]);

  useEffect(() => {
    const decision = flushSessionMode(queuedModeRef.current, modeChangeContext());
    if (decision.type === "cancel") cancelQueuedMode();
    if (decision.type === "send") {
      // Consume before dispatch, so rerenders/duplicate idle frames cannot retry.
      cancelQueuedMode();
      sendSessionConfig(decision.configId, decision.payload);
    }
  }, [cancelQueuedMode, connected, meta.sessionId, modeChangeContext, queuedModeId,
    resumeReplay, sendSessionConfig, sessionControls, sessionMode, streaming, subagents]);

  const setSessionConfigOption = useCallback((configId: string, value: string) => {
    if (!canSetSessionConfigOption(sessionControlsRef.current.config, configId, value)) return false;
    return sendSessionConfig(configId, { type: "set_config_option", configId, value });
  }, [sendSessionConfig]);

  const clearConversationView = useCallback((options?: {
    abortReplay?: boolean;
    preserveMessages?: boolean;
    sendStop?: boolean;
  }) => {
    cancelQueuedMode();
    sessionIdRef.current = undefined;
    const ws = wsRef.current;
    const replayContext = resumeReplayRef.current ?? replayCacheContextRef.current;
    const abortedSessionId = replayContext?.sessionId;
    if (options?.abortReplay) {
      resumeRequestIdRef.current += 1;
    }
    if (
      options?.abortReplay &&
      options.sendStop !== false &&
      replayContext &&
      ws?.readyState === WebSocket.OPEN
    ) {
      try {
        ws.send(JSON.stringify({ type: "cancel" }));
      } catch (error) {
        console.warn("[ChatView] failed to abort session replay:", error);
      }
    }
    if (options?.abortReplay && abortedSessionId) {
      ignoredReplaySessionsRef.current.add(abortedSessionId);
    }
    clearReplayCacheContext();
    activeTranscriptCacheRef.current = null;
    clearActiveTranscriptCacheWriteTimer();
    replayingSessionRef.current = null;
    promptInFlightRef.current = false;
    turnActiveRef.current = false;
    setStreaming(false);
    setPendingPermissions([]);
    updateSessionControls({ type: "reset" });
    setSessionModeState(null);
    setContextUsage(null);
    updateResumeReplay(null);
    if (!options?.preserveMessages) {
      messagesRef.current = [];
      setMessages([]);
    }
    setMeta((prev) => ({
      ...prev,
      sessionId: undefined,
      agentName: undefined,
      agentTitle: undefined,
      agentVersion: undefined,
    }));
  }, [
    cancelQueuedMode,
    clearActiveTranscriptCacheWriteTimer,
    clearReplayCacheContext,
    updateResumeReplay,
    updateSessionControls,
  ]);

  const resumeSession = useCallback(
    (
      { agentId, profileId, launchSession }: ResumeChatSessionRequest,
      options?: { forceReplay?: boolean },
    ) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return false;

      clearConversationView({
        abortReplay: true,
        preserveMessages: true,
        sendStop: false,
      });
      const requestId = resumeRequestIdRef.current + 1;
      resumeRequestIdRef.current = requestId;
      ignoredReplaySessionsRef.current.delete(launchSession.session_id);
      const replay: ResumeReplayState = {
        sessionId: launchSession.session_id,
        title: launchSession.title,
        agentId,
        workspace: launchSession.workspace,
        updatedAt: launchSession.updated_at,
        blocking: true,
      };
      replayCacheContextRef.current = replay;
      updateResumeReplay(replay);
      setMeta((prev) => ({ ...prev, sessionId: launchSession.session_id }));

      void (async () => {
        // Hydrate from the local cache first; its stamp then tells the server
        // whether a replay is needed at all.
        let cacheUpdatedAt: number | undefined;
        if (!options?.forceReplay) {
          try {
            const cached = await readCachedChatSession({
              agentId,
              workspace: launchSession.workspace,
              sessionId: launchSession.session_id,
              updatedAt: launchSession.updated_at,
            });
            if (resumeRequestIdRef.current !== requestId) return;
            if (cached) {
              cacheUpdatedAt = cached.updatedAt;
              const backgroundReplay = { ...replay, blocking: false };
              replayCacheContextRef.current = backgroundReplay;
              updateResumeReplay(backgroundReplay);
              const settledCachedMessages = settleStreamActivitiesMessage(
                cached.messages,
              );
              setMessages((prev) => {
                const mergedMessages = mergeChatMessageSnapshots(
                  prev,
                  settledCachedMessages,
                );
                messagesRef.current = mergedMessages;
                return mergedMessages;
              });
              activeTranscriptCacheRef.current = {
                sessionId: launchSession.session_id,
                agentId,
                workspace: launchSession.workspace,
                updatedAt: cached.updatedAt,
              };
            }
          } catch (error) {
            console.warn("[ChatView] failed to read cached session:", error);
          }
        }

        if (resumeRequestIdRef.current !== requestId) return;
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          abortResumeState();
          return;
        }

        try {
          const payload: Record<string, unknown> = {
            type: "resume_session",
            agent: agentId,
            sessionId: launchSession.session_id,
            sessionWorkspace: launchSession.workspace,
          };
          if (profileId !== undefined) {
            payload.profileId = profileId;
          }
          if (options?.forceReplay) {
            payload.replay = true;
          } else if (cacheUpdatedAt !== undefined) {
            // No explicit wish: the server compares this against the native
            // store and replays only when the cache missed something.
            payload.cacheUpdatedAt = cacheUpdatedAt;
          }
          ws.send(JSON.stringify(payload));
        } catch (error) {
          console.warn("[ChatView] failed to resume chat session:", error);
          abortResumeState();
        }
      })();

      return true;
    },
    [abortResumeState, clearConversationView, updateResumeReplay],
  );

  const stopStreaming = useCallback(() => {
    const ws = wsRef.current;
    const replayContext = resumeReplayRef.current ?? replayCacheContextRef.current;
    const abortedSessionId = replayContext?.sessionId;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "cancel" }));
      setMessages((prev) =>
        setStreamProgressMessage(prev, t("Stopping…"), "tool"),
      );
    } catch (error) {
      console.warn("[ChatView] failed to stop chat message:", error);
      return;
    }
    if (abortedSessionId) {
      ignoredReplaySessionsRef.current.add(abortedSessionId);
    }
    replayingSessionRef.current = null;
    clearReplayCacheContext();
    updateResumeReplay(null);
  }, [clearReplayCacheContext, t, updateResumeReplay]);

  const sendPermissionResponse = useCallback((requestId: string, optionId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "permission_response", requestId, optionId }));
    setPendingPermissions((prev) =>
      prev.filter((permission) => permission.requestId !== requestId),
    );
  }, []);

  const cancelPermissionRequest = useCallback((requestId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(
      JSON.stringify({ type: "permission_response", requestId, outcome: "cancelled" }),
    );
    setPendingPermissions((prev) =>
      prev.filter((permission) => permission.requestId !== requestId),
    );
  }, []);

  return {
    messages,
    connected,
    streaming,
    meta,
    agents,
    pendingPermissions,
    sessionMode,
    queuedModeId,
    cancelQueuedMode,
    sessionConfig: sessionControls.config,
    pendingConfigId: sessionControls.pendingConfigId,
    contextUsage,
    resumeReplay,
    multiAgentTurns,
    subagents,
    subagentMessages,
    lastTurnCompletedAt,
    sendMessage,
    resumeSession,
    clearConversationView,
    setSessionMode,
    setSessionConfigOption,
    stopStreaming,
    sendPermissionResponse,
    cancelPermissionRequest,
  };
}

function applySubagentAcpNotification(
  prev: ChatMessage[],
  notif: SessionNotification,
): ChatMessage[] {
  return applyChatTranscriptUpdate(prev, notif.update, {
    userMessage: {
        dedupeExistingText: true,
    },
    toolProgressLabel: (tool) => `Using tool: ${tool}...`,
  });
}

function mergeById<T extends { id: string }>(prev: T[], nextItems: T[]): T[] {
  const byId = new Map(prev.map((item) => [item.id, item]));
  for (const item of nextItems) {
    byId.set(item.id, item);
  }
  return Array.from(byId.values());
}

function dedupeChatAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  const seen = new Set<string>();
  const out: ChatAttachment[] = [];
  for (const attachment of attachments) {
    const key = [
      attachment.name,
      attachment.size,
      attachment.mimeType,
      attachment.uri,
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(attachment);
  }
  return out;
}
