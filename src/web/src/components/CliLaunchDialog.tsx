import { useEffect, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { useI18n } from "@va/i18n";
import { addWorkspace, createWorkspace, getWorkspaces, type WorkspaceItem } from "@/api/sessions";
import { Button } from "@/components/ui/button";
import { NewChatWorkspacePicker } from "@/components/chat/NewChatWorkspacePicker";

export interface CliLaunchDialogProps {
  label: string;
  currentWorkspacePath?: string;
  onLaunch: (projectPath: string) => Promise<void> | void;
  onClose: () => void;
}

export function canLaunchCliFolder(path: string | undefined, loading: boolean, editing: boolean, pending: boolean): boolean {
  return Boolean(path?.trim()) && !loading && !editing && !pending;
}

export function CliLaunchDialog({ label, currentWorkspacePath, onLaunch, onClose }: CliLaunchDialogProps) {
  const { t } = useI18n();
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [defaultPath, setDefaultPath] = useState<string>();
  const [selectedPath, setSelectedPath] = useState(currentWorkspacePath);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string>();
  const busy = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getWorkspaces().then(response => {
      if (cancelled) return;
      setWorkspaces(response.workspaces);
      setDefaultPath(response.default_workspace);
      setSelectedPath(currentWorkspacePath ?? response.default_workspace);
    }).catch(reason => {
      if (!cancelled) {
        setSelectedPath(undefined);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentWorkspacePath]);

  async function chooseFolder(action: () => Promise<string>): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      const path = await action();
      setSelectedPath(path);
      setWorkspaces(previous => previous.some(item => item.path === path) ? previous : [
        ...previous, { path, is_default: false, is_builtin: false },
      ]);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function launch() {
    if (busy.current || !canLaunchCliFolder(selectedPath, loading, editing, pending)) return;
    busy.current = true;
    setLaunching(true);
    setError(undefined);
    try {
      await onLaunch(selectedPath!);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busy.current = false;
      setLaunching(false);
    }
  }

  return <Dialog.Root open onOpenChange={open => { if (!open && !busy.current) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-background p-4 shadow-xl"
        onEscapeKeyDown={event => { if (busy.current) event.preventDefault(); }}
        onPointerDownOutside={event => { if (busy.current) event.preventDefault(); }}>
        <Dialog.Title className="text-lg font-semibold">{t("Start {{name}}", { name: label })}</Dialog.Title>
        <Dialog.Description className="mb-4 mt-1 text-sm text-muted-foreground">{t("Choose the folder this CLI will run in.")}</Dialog.Description>
        <NewChatWorkspacePicker
          purpose="cli"
          workspaces={workspaces}
          selectedWorkspacePath={selectedPath}
          defaultWorkspacePath={defaultPath}
          loading={loading}
          creating={pending || launching}
          createError={error}
          onWorkspaceChange={setSelectedPath}
          onAddWorkspace={path => chooseFolder(() => addWorkspace(path))}
          onCreateWorkspace={(name, parent) => chooseFolder(async () => {
            const response = await createWorkspace(name, parent);
            setWorkspaces(response.workspaces);
            setDefaultPath(response.default_workspace);
            return response.workspace.path;
          })}
          onEditingChange={setEditing}
          onClearError={() => setError(undefined)}
          layout="panel"
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={pending || launching} onClick={onClose}>{t("Cancel")}</Button>
          <Button type="button" disabled={launching || !canLaunchCliFolder(selectedPath, loading, editing, pending)} onClick={() => void launch()}>
            {launching ? t("Starting…") : t("Start CLI")}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
