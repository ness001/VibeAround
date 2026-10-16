import { useI18n } from "@va/i18n";
import { CONTEXT_WINDOW_CONFIG_ID, findSessionConfigOption } from "./chatSessionConfig";
import type {
  ContextUsage,
  SessionConfigOption,
  SessionConfigState,
  SessionModeOption,
} from "./chatTypes";

export interface ChatSessionControlsProps {
  config: SessionConfigState | null;
  usage?: ContextUsage | null;
  pendingConfigId?: string | null;
  sessionStarted?: boolean;
  disabled?: boolean;
  onChange?: (configId: string, value: string) => void;
}

export function ChatSessionControls({
  config,
  usage,
  pendingConfigId,
  sessionStarted = false,
  disabled = false,
  onChange,
}: ChatSessionControlsProps) {
  const { t } = useI18n();
  const model = findSessionConfigOption(config?.configOptions ?? [], "model");
  const effort = findSessionConfigOption(config?.configOptions ?? [], "effort");
  const unavailable = sessionStarted
    ? t("Not supported by this agent")
    : config?.configOptions.length ? t("Not supported by this agent") : t("Loading session options…");
  const controlsDisabled = disabled || Boolean(pendingConfigId) || !onChange;
  const contextDescription = t("Auto-compaction budget; does not expand model context. Applies to this chat.");
  const contextLockedDescription = t("Choose the auto-compaction budget before the session starts. Start a new chat to change it.");
  const contextSupported = Boolean(config?.contextWindowChoices.length);
  const contextValue = config?.contextWindow === null || !config
    ? "auto"
    : String(config.contextWindow);

  return (
    <div className="space-y-1.5 border-t border-border/60 px-3 py-2" data-slot="chat-session-controls">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <ConfigSelect
          label={t("Model")}
          option={model}
          unavailable={unavailable}
          disabled={controlsDisabled}
          onChange={onChange}
        />
        <ConfigSelect
          label={t("Effort")}
          option={effort}
          defaultValue={config?.effortDefault ?? null}
          unavailable={unavailable}
          disabled={controlsDisabled}
          onChange={onChange}
        />
        <label className="flex min-w-0 max-w-full items-center gap-1.5 text-xs text-muted-foreground">
          <span>{t("Context")}</span>
          <select
            aria-label={t("Auto-compaction budget")}
            title={contextSupported
              ? config?.contextWindowEditable ? contextDescription : contextLockedDescription
              : t("Not supported by this agent")}
            className={selectClassName}
            value={contextSupported ? contextValue : ""}
            disabled={controlsDisabled || !config?.contextWindowEditable}
            onChange={(event) => onChange?.(CONTEXT_WINDOW_CONFIG_ID, event.target.value)}
          >
            {contextSupported ? (
              <>
                <option value="auto">{t("Agent default ({{value}})", {
                  value: config?.contextWindowDefault != null
                    ? formatBudget(config.contextWindowDefault)
                    : config?.contextWindowAutomatic ? t("automatic") : t("not reported"),
                })}</option>
                {config?.contextWindow !== null && config?.contextWindow !== undefined
                  && !config.contextWindowChoices.includes(config.contextWindow) && (
                    <option value={contextValue} disabled>{formatBudget(config.contextWindow)}</option>
                  )}
                {config?.contextWindowChoices.map((choice) => (
                  <option key={choice} value={String(choice)}>{formatBudget(choice)}</option>
                ))}
              </>
            ) : <option value="">{t("Unavailable")}</option>}
          </select>
        </label>
        {pendingConfigId && (
          <span role="status" className="text-xs text-muted-foreground">{t("Applying…")}</span>
        )}
      </div>
      {contextSupported && (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {contextDescription}
          {" "}{contextLockedDescription}
          {" "}{t("Default values come from the local agent and profile. Unreported values are not guessed.")}
        </p>
      )}
      {usage && (
        <p className="text-[11px] leading-snug text-muted-foreground" title={t("Agent-reported context usage")}>
          {usage.size === null
            ? t("Context usage: {{used}} tokens (capacity unknown)", { used: usage.used.toLocaleString() })
            : t("Context usage: {{used}} / {{size}} tokens", {
                used: usage.used.toLocaleString(),
                size: usage.size.toLocaleString(),
              })}
        </p>
      )}
    </div>
  );
}

const selectClassName = "h-8 min-w-0 max-w-[16rem] rounded-md border border-border/70 bg-background px-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

function ConfigSelect({
  label,
  option,
  defaultValue,
  unavailable,
  disabled,
  onChange,
}: {
  label: string;
  option?: SessionConfigOption;
  defaultValue?: string | null;
  unavailable: string;
  disabled: boolean;
  onChange?: (configId: string, value: string) => void;
}) {
  const { t } = useI18n();
  const defaultName = defaultValue && defaultValue !== "default" && defaultValue !== "auto"
    ? option?.options.find((choice) => choice.value === defaultValue)?.name ?? defaultValue
    : t("not reported");
  const grouped = new Map<string, SessionModeOption[]>();
  for (const choice of option?.options ?? []) {
    const group = choice.group ?? "";
    grouped.set(group, [...(grouped.get(group) ?? []), choice]);
  }
  const renderOption = (choice: SessionModeOption) => (
    <option key={choice.value} value={choice.value} title={choice.description ?? undefined}>
      {defaultValue !== undefined && (choice.value === "default" || choice.value === "auto")
        ? t("{{name}} ({{value}})", { name: choice.name, value: defaultName })
        : choice.name}
    </option>
  );

  return (
    <label className="flex min-w-0 max-w-full items-center gap-1.5 text-xs text-muted-foreground">
      <span>{label}</span>
      <select
        aria-label={label}
        title={option?.description ?? (option ? option.name : unavailable)}
        className={selectClassName}
        value={option?.currentValue ?? ""}
        disabled={disabled || !option}
        onChange={(event) => option && onChange?.(option.configId, event.target.value)}
      >
        {!option ? <option value="">{unavailable}</option> : (
          <>
            {!option.options.some((choice) => choice.value === option.currentValue) && (
              <option value={option.currentValue} disabled>{option.currentValue}</option>
            )}
            {[...grouped].map(([group, choices]) => group
              ? <optgroup key={group} label={group}>{choices.map(renderOption)}</optgroup>
              : choices.map(renderOption))}
          </>
        )}
      </select>
    </label>
  );
}

function formatBudget(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return tokens.toLocaleString();
}
