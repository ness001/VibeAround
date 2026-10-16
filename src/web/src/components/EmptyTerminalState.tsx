import { Plus, Terminal } from "lucide-react";
import type { ToolType } from "@/lib/terminal-types";
import { AddCliDropdown } from "./AddCliDropdown";
import { useI18n } from "@va/i18n";
import { Button } from "@/components/ui/button";

interface EmptyTerminalStateProps {
  tmuxAvailable: boolean | null;
  tmuxSessions: string[];
  onAddCli: (tool: ToolType, projectPath: string) => Promise<void> | void;
  onAddProfileCli: (profileId: string, launchTarget: string, projectPath: string) => Promise<void> | void;
  onAttachTmux: (name: string) => void;
  onRefreshTmux: () => void;
}

export function EmptyTerminalState({
  tmuxAvailable,
  tmuxSessions,
  onAddCli,
  onAddProfileCli,
  onAttachTmux,
  onRefreshTmux,
}: EmptyTerminalStateProps) {
  const { t } = useI18n();

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Terminal className="h-8 w-8" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{t("No sessions yet")}</p>
        <p className="max-w-sm text-sm text-muted-foreground/60">
          {t("Add a CLI, launch a profile, or attach tmux to start.")}
        </p>
      </div>
      <AddCliDropdown
        variant="empty"
        tmuxAvailable={tmuxAvailable}
        tmuxSessions={tmuxSessions}
        onAddCli={onAddCli}
        onAddProfileCli={onAddProfileCli}
        onAttachTmux={onAttachTmux}
        onRefreshTmux={onRefreshTmux}
        trigger={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5 font-mono text-xs"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("Add CLI")}
          </Button>
        }
      />
    </div>
  );
}
