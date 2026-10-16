import { useI18n } from "@va/i18n";

import { EmptyTerminalState } from "@/components/EmptyTerminalState";
import { TerminalGridView } from "@/components/TerminalGridView";
import { TerminalPanel } from "@/components/TerminalPanel";
import type {
  TerminalGroup,
  TerminalStatus,
  ToolType,
  ViewMode,
} from "@/lib/terminal-types";

interface TerminalWorkspaceProps {
  isActive: boolean;
  groups: TerminalGroup[];
  activeTabId: string | null;
  maximizedSession: string | null;
  sessionsLoading: boolean;
  viewMode: ViewMode;
  tmuxAvailable: boolean | null;
  tmuxSessions: string[];
  onAddCli: (tool: ToolType, projectPath: string) => Promise<void> | void;
  onAddProfileCli: (profileId: string, launchTarget: string, projectPath: string) => Promise<void> | void;
  onAttachTmux: (name: string) => void;
  onRefreshTmux: () => void;
  onToggleMaximize: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onSessionState: (sessionId: string, tool: ToolType, status: TerminalStatus) => void;
}

export function TerminalWorkspace({
  isActive,
  groups,
  activeTabId,
  maximizedSession,
  sessionsLoading,
  viewMode,
  tmuxAvailable,
  tmuxSessions,
  onAddCli,
  onAddProfileCli,
  onAttachTmux,
  onRefreshTmux,
  onToggleMaximize,
  onCloseSession,
  onSessionState,
}: TerminalWorkspaceProps) {
  const { t } = useI18n();
  const sessions = groups.flatMap((g) => g.sessions);
  const activeSession = sessions.find((s) => s.id === activeTabId);
  const maximizedSessionData = maximizedSession
    ? sessions.find((s) => s.id === maximizedSession)
    : null;

  if (sessions.length === 0) {
    return (
      <div className="h-full p-2">
        {sessionsLoading ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground/40 font-mono">{t("Loading sessions…")}</p>
          </div>
        ) : (
          <EmptyTerminalState
            tmuxAvailable={tmuxAvailable}
            tmuxSessions={tmuxSessions}
            onAddCli={onAddCli}
            onAddProfileCli={onAddProfileCli}
            onAttachTmux={onAttachTmux}
            onRefreshTmux={onRefreshTmux}
          />
        )}
      </div>
    );
  }

  if (maximizedSessionData) {
    return (
      <div className="h-full p-2">
        <TerminalPanel
          session={maximizedSessionData}
          isActive={isActive}
          isMaximized
          viewMode={viewMode}
          onToggleMaximize={() => onToggleMaximize(maximizedSessionData.id)}
          onClose={() => onCloseSession(maximizedSessionData.id)}
          onSessionState={(tool, status) =>
            onSessionState(maximizedSessionData.id, tool, status)
          }
        />
      </div>
    );
  }

  if (viewMode === "grid" || viewMode === "nine") {
    return (
      <TerminalGridView
        groups={groups}
        isActive={isActive}
        viewMode={viewMode}
        onToggleMaximize={onToggleMaximize}
        onSessionState={onSessionState}
        onCloseSession={onCloseSession}
      />
    );
  }

  return (
    <div className="h-full p-2">
      {activeSession ? (
        <TerminalPanel
          session={activeSession}
          isActive={isActive}
          viewMode={viewMode}
          onToggleMaximize={() => onToggleMaximize(activeSession.id)}
          onClose={() => onCloseSession(activeSession.id)}
          onSessionState={(tool, status) => onSessionState(activeSession.id, tool, status)}
        />
      ) : (
        <EmptyTerminalState
          tmuxAvailable={tmuxAvailable}
          tmuxSessions={tmuxSessions}
          onAddCli={onAddCli}
          onAddProfileCli={onAddProfileCli}
          onAttachTmux={onAttachTmux}
          onRefreshTmux={onRefreshTmux}
        />
      )}
    </div>
  );
}
