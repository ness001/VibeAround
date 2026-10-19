import { useState } from "react";
import { ChevronDown, SlidersHorizontal, X } from "lucide-react";
import { Popover } from "radix-ui";
import { useI18n } from "@va/i18n";
import { Button } from "@/components/ui/button";
import { chatToolbarButtonClassName, chatToolbarIconClassName } from "./chatToolbar";
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
  inline?: boolean;
  onChange?: (configId: string, value: string) => void;
}

export function ChatSessionControls({
  config,
  usage,
  pendingConfigId,
  sessionStarted = false,
  disabled = false,
  inline = false,
  onChange,
}: ChatSessionControlsProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
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

  const modelName = model?.options.find(choice => choice.value === model.currentValue)?.name ?? model?.currentValue ?? t("Model");
  const effortValue = effort?.currentValue === "default" || effort?.currentValue === "auto"
    ? config?.effortDefault : effort?.currentValue;
  const effortName = effort?.options.find(choice => choice.value === effortValue)?.name ?? effortValue;
  const used = usage && Number.isFinite(usage.used) && usage.used >= 0 ? usage.used : null;
  const capacity = usage?.size != null && Number.isFinite(usage.size) && usage.size > 0 ? usage.size : null;
  const percent = used !== null && capacity !== null ? used / capacity * 100 : null;
  const percentage = percent === null ? "—" : percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
  const usageDescription = used === null ? t("Context usage not reported yet") : capacity === null
    ? t("Context usage: {{used}} tokens (capacity unknown)", { used: used.toLocaleString() })
    : t("Context usage: {{used}} / {{size}} tokens", { used: used.toLocaleString(), size: capacity.toLocaleString() });

  return (
    <Popover.Root open={open} onOpenChange={value => { setOpen(value); if (value) setUsageOpen(false); }}>
      <div className={inline ? "flex min-w-[6.25rem] flex-1 items-center gap-1" : "flex min-w-0 items-center gap-2 border-t border-border/60 px-2 py-1"} data-slot="chat-session-controls">
        <Popover.Trigger asChild>
          <Button type="button" variant="ghost" size="sm" aria-label={t("Model, effort and context settings")} title={`${modelName}${effortName ? ` · ${effortName}` : ""}`} className={`${chatToolbarButtonClassName} min-w-0 max-w-full shrink`}>
            <SlidersHorizontal className={chatToolbarIconClassName} aria-hidden="true" />
            <span className={inline ? "hidden min-w-0 max-w-[20rem] truncate sm:block" : "max-w-[min(45vw,20rem)] truncate"}>{modelName}</span>
            {effortName && <span className="hidden shrink-0 sm:inline">· {effortName}</span>}
            <ChevronDown className="hidden h-3 w-3 shrink-0 sm:block" aria-hidden="true" />
          </Button>
        </Popover.Trigger>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {pendingConfigId && <span role="status" className="text-[11px] text-muted-foreground">{t("Applying…")}</span>}
          <Popover.Root open={usageOpen} onOpenChange={value => { setUsageOpen(value); if (value) setOpen(false); }}>
            <Popover.Trigger asChild>
              <Button type="button" variant="ghost" size="sm" aria-label={t("Context usage")} title={usageDescription} className={`${chatToolbarButtonClassName} shrink-0 tabular-nums`}>
            <span role="meter" aria-label={t("Agent-reported context usage")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === null ? undefined : Math.min(100, Math.max(0, percent))} aria-valuetext={usageDescription} className="relative inline-flex h-5 w-5 shrink-0">
              <svg viewBox="0 0 24 24" className="size-5 text-primary" aria-hidden="true">
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
                {percent !== null && <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" pathLength="100" strokeDasharray={`${Math.min(100, Math.max(0, percent))} 100`} transform="rotate(-90 12 12)" />}
                {percent === null && <text x="12" y="12" textAnchor="middle" dominantBaseline="central" fontSize="12" className="fill-muted-foreground">?</text>}
              </svg>
            </span>
            <span>{percentage}</span>
              </Button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content side="top" align="end" sideOffset={8} collisionPadding={16} aria-label={t("Context usage")} className="z-50 w-[min(18rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none">
                <p className="text-xs font-semibold">{t("Context usage")}</p>
                <p className="mt-1 text-xs tabular-nums text-muted-foreground">{usageDescription}</p>
                <p className="mt-2 text-[11px] text-muted-foreground">{t("Agent-reported context usage")}</p>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
      </div>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={8} collisionPadding={16} aria-label={t("Chat settings")} className="z-50 max-h-[var(--radix-popover-content-available-height)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg outline-none">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">{t("Chat settings")}</h3>
            <Popover.Close aria-label={t("Close settings")} className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"><X className="h-4 w-4" /></Popover.Close>
          </div>
          <div className="space-y-3">
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
        <label className="grid min-w-0 gap-1.5 text-xs text-muted-foreground">
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
      </div>
      {contextSupported && (
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          {contextDescription}
          {" "}{contextLockedDescription}
          {" "}{t("Default values come from the local agent and profile. Unreported values are not guessed.")}
        </p>
      )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const selectClassName = "h-9 min-w-0 w-full rounded-md border border-border/70 bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

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
    <label className="grid min-w-0 gap-1.5 text-xs text-muted-foreground">
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
