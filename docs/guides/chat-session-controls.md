# Chat session controls

The chat composer exposes **Model**, **Effort**, and **Context**, for the current conversation rather than changing global CLI defaults.

## Controls

| Control | Meaning | Availability |
|---|---|---|
| Model | Select a model advertised by the coding-agent adapter, including custom gateway models | Available while creating a new Claude chat, before the first prompt; disabled while work is running |
| Effort | Select a reasoning-effort value advertised for the current model | Available before the first prompt when supported; disabled while work is running |
| Context | Set the new Claude session's automatic-compaction budget: Agent default, 100K, 200K, 500K, or 1M | Before the first native session starts; existing sessions require a new chat to change it |
| Context usage | Agent-reported tokens used and total capacity, if known | Appears after a usage notification; not inferred from the selected budget |

**Context is a compaction budget, not a way to increase the model's maximum context window.** A selected 1M budget does not establish that the provider supports 1M, and a model can impose its own cap. Agent default preserves existing profile and CLI behavior.

The initial model/effort list is not invented by the web UI. Opening a new Claude chat initializes a disposable capability probe without sending a model prompt, records its advertised choices, and shuts it down. Select Model, Effort, and Context before sending the first message. Choosing another model refreshes its supported effort values. An unsupported control remains unavailable.

## Behavior

- Controls are available in both the new-chat composer and the conversation composer, and wrap on narrow screens.
- A selection remains pending until the server reports the confirmed value. Errors do not silently replace the displayed current value.
- Model/effort updates use ACP `session/set_config_option`; unsupported values and updates during active prompts/subagents are rejected.
- Context is persisted on the thread before the first native session and supplied only to that Claude child through `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Existing chats are not restarted.
- Saved model/effort preferences are reapplied on a resumed host when still supported. Unsupported stale preferences do not prevent opening the conversation.
- Provider credentials, repository-wide model defaults, and other chats are not changed by these controls.

## Gateway compatibility

A model can appear in the adapter's catalog yet fail Claude CLI's live model-switch validation probe. In the current custom gateway, changing an already-started session's model was rejected because the probe requested one output token but the upstream API requires at least 16. The picker preserves the current model and reports this incompatibility.

**New-chat model selection works:** the chosen model is supplied to the fresh child process before any prompt, rather than switching an already-started model. A disposable capability probe confirms the selection first. A live browser test selected a different gateway model, Low effort, and a 500K budget with zero prompts sent; the first response then retained that model and effort. This does not change or relax the gateway's live-switch validation.

## Verification

Verified on 2026-09-19: frontend tests, native session-control tests, pre-prompt preparation guards, and context lifecycle tests passed. In a real mobile-sized browser, all three controls were selected with **zero prompts sent**: a different gateway model, Low effort, and a 500K compaction budget. The first prompt completed with the chosen model and effort preserved, and the context budget became read-only afterward. Existing-session model-switch gateway incompatibility remains separate from working creation-time selection.

Frontend parsing/rendering tests cover advertised choices, groups, unsupported controls, confirmed selections, usage, pending states, and read-only context. Native tests cover validation, busy-state rejection, thread-scoped persistence, and refusing context changes on existing sessions.

The optional `local-tools/phone-test/verify-chat-controls.cjs` exercises an isolated real instance and must not target the main running app. It requires external Playwright tooling, private `VIBEAROUND_DATA_DIR`, and an isolated daemon port. Never copy tokens or session data into the repository.

## Source anchors

- `src/web/src/components/chat/ChatSessionControls.tsx`
- `src/web/src/components/chat/chatSessionConfig.ts`
- `src/web/src/components/chat/useWebChatConnection.ts`
- `src/core/src/workspace/threads/session_config.rs`
- `src/core/src/workspace/threads/runtime_config.rs`
- `src/server/src/web_server/ws_chat.rs`

*Local implementation, 2026-09-19. Actual capability availability is agent- and model-dependent.*
