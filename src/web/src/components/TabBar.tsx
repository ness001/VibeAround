import { X } from "lucide-react";
import { useI18n } from "@va/i18n";

import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getGroupColor, STATUS_COLORS, type TerminalGroup, type ToolType } from "@/lib/terminal-types";
import { AddCliDropdown } from "./AddCliDropdown";

interface TabBarProps {
  groups: TerminalGroup[];
  activeTabId: string | null;
  onActivate: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  tmuxAvailable: boolean | null;
  tmuxSessions: string[];
  onAddCli: (tool: ToolType, projectPath: string) => Promise<void> | void;
  onAddProfileCli: (profileId: string, launchTarget: string, projectPath: string) => Promise<void> | void;
  onAttachTmux: (name: string) => void;
  onRefreshTmux: () => void;
}

export function TabBar({
  groups,
  activeTabId,
  onActivate,
  onClose,
  tmuxAvailable,
  tmuxSessions,
  onAddCli,
  onAddProfileCli,
  onAttachTmux,
  onRefreshTmux,
}: TabBarProps) {
  const { t } = useI18n();

  return (
    <nav className="flex shrink-0 items-stretch border-b border-border bg-muted/30 dark:bg-muted/50">
      <Tabs
        value={activeTabId ?? undefined}
        onValueChange={onActivate}
        className="min-w-0 flex-1 gap-0 overflow-hidden"
      >
        <TabsList
          variant="line"
          className="h-auto w-full justify-start gap-0 overflow-x-auto rounded-none p-0 scrollbar-none"
        >
          {groups.map((group) => {
            const gc = getGroupColor(group.color);
            return (
              <div key={group.id} className="flex shrink-0 items-stretch">
                <div className="relative flex shrink-0 items-center">
                  <div
                    className="flex h-full shrink-0 items-center gap-1.5 px-2.5 py-2"
                    style={{ backgroundColor: `${gc.bg}12` }}
                  >
                    <span
                      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: gc.bg }}
                    />
                    <span
                      className="whitespace-nowrap font-mono text-[10px] font-semibold"
                      style={{ color: gc.bg }}
                    >
                      {group.label}
                    </span>
                  </div>
                  <span
                    className="absolute inset-x-0 bottom-0 h-[2px]"
                    style={{ backgroundColor: gc.bg }}
                  />
                </div>
                {group.sessions.map((session) => {
                  const isActive = session.id === activeTabId;
                  return (
                    <div
                      key={session.id}
                      className="group relative flex shrink-0 items-center"
                    >
                      <TabsTrigger
                        value={session.id}
                        className="h-full max-w-[13rem] justify-start gap-1.5 rounded-none border-0 px-2.5 py-2 pr-5 font-mono text-[11px] font-normal after:hidden data-[state=active]:bg-background"
                      >
                        <span
                          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                            session.status === "running" ? "animate-pulse" : ""
                          }`}
                          style={{ backgroundColor: STATUS_COLORS[session.status] }}
                        />
                        <span className="truncate">{session.name}</span>
                      </TabsTrigger>
                      <span
                        className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px]"
                        style={{ backgroundColor: isActive ? gc.bg : `${gc.bg}50` }}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          onClose(session.id);
                        }}
                        className="absolute right-1 top-1/2 h-4 w-4 -translate-y-1/2 p-0 text-muted-foreground/30 opacity-0 hover:text-foreground group-hover:opacity-100"
                        title={t("Close session")}
                        aria-label={t("Close session")}
                      >
                        <X className="h-2.5 w-2.5" />
                      </Button>
                    </div>
                  );
                })}
                <div className="flex shrink-0 items-center border-l border-border/50 px-1" />
              </div>
            );
          })}
        </TabsList>
      </Tabs>
      <div className="relative flex shrink-0 items-center overflow-visible border-l border-border/50 px-1">
        <AddCliDropdown
          variant="top"
          currentWorkspacePath={groups.flatMap(group => group.sessions).find(session => session.id === activeTabId)?.cwd}
          tmuxAvailable={tmuxAvailable}
          tmuxSessions={tmuxSessions}
          onAddCli={onAddCli}
          onAddProfileCli={onAddProfileCli}
          onAttachTmux={onAttachTmux}
          onRefreshTmux={onRefreshTmux}
        />
      </div>
    </nav>
  );
}
