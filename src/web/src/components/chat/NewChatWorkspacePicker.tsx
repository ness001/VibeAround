"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, Folder, FolderPlus, Loader2, Settings } from "lucide-react";
import type { WorkspaceItem } from "@va/client";
import { useI18n } from "@va/i18n";
import { browseFolders, type FolderListing } from "@/api/sessions";
import { FolderBrowser } from "@/components/FolderBrowser";
import { FolderRootSettings } from "@/components/FolderRootSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface NewChatWorkspacePickerProps {
  workspaces: WorkspaceItem[];
  defaultWorkspacePath?: string;
  selectedWorkspacePath?: string;
  loading?: boolean;
  creating?: boolean;
  createError?: string;
  layout?: "full" | "panel";
  purpose?: "chat" | "cli";
  onWorkspaceChange: (workspacePath: string) => void;
  onCreateWorkspace?: (name: string, parentPath: string) => Promise<boolean>;
  onAddWorkspace?: (path: string) => Promise<boolean>;
  onEditingChange?: (editing: boolean) => void;
  onClearError?: () => void;
  className?: string;
}

export function NewChatWorkspacePicker({
  workspaces,
  defaultWorkspacePath,
  selectedWorkspacePath,
  loading = false,
  creating = false,
  createError,
  layout = "full",
  purpose = "chat",
  onWorkspaceChange,
  onCreateWorkspace,
  onAddWorkspace,
  onEditingChange,
  onClearError,
  className,
}: NewChatWorkspacePickerProps) {
  const { t } = useI18n();
  const id = useId();
  const [mode, setMode] = useState<"current" | "choose" | "create">("current");
  const [name, setName] = useState("");
  const [rootSettingsOpen, setRootSettingsOpen] = useState(false);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const request = useRef<AbortController | null>(null);
  const destination = useRef<string | undefined>(undefined);
  const actionPending = useRef(false);
  const currentPath = selectedWorkspacePath ?? defaultWorkspacePath;
  const busy = loading || creating || submitting;

  useEffect(() => () => request.current?.abort(), []);

  async function navigate(path?: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    destination.current = path;
    setBrowsing(true);
    setBrowseError(undefined);
    onClearError?.();
    try {
      const result = await browseFolders(path, controller.signal);
      if (!controller.signal.aborted) setListing(result);
    } catch (error) {
      if (!controller.signal.aborted) setBrowseError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!controller.signal.aborted) setBrowsing(false);
    }
  }

  function changeMode(next: typeof mode) {
    if (busy || rootSettingsOpen) return;
    onClearError?.();
    setMode(next);
    onEditingChange?.(next !== "current");
    if (next === "current") {
      request.current?.abort();
      setBrowsing(false);
      setBrowseError(undefined);
    } else if (mode === "current" || !listing) {
      // Always begin at the server's root, not the last project's subdirectory.
      setListing(null);
      void navigate();
    }
  }

  async function submit() {
    if (busy || browsing || browseError || !listing || actionPending.current) return;
    actionPending.current = true;
    setSubmitting(true);
    try {
      let accepted: boolean | undefined;
      if (mode === "create") accepted = await onCreateWorkspace?.(name.trim(), listing.path);
      else if (onAddWorkspace) accepted = await onAddWorkspace(listing.path);
      else if (workspaces.some(workspace => workspace.path === listing.path)) {
        onWorkspaceChange(listing.path);
        accepted = true;
      }
      if (accepted) {
        setMode("current");
        setName("");
        onEditingChange?.(false);
      }
    } catch (error) {
      setBrowseError(error instanceof Error ? error.message : String(error));
    } finally {
      actionPending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section aria-label={t("Project folder")} className={cn("w-full rounded-xl border border-border p-3", layout !== "panel" && "mx-auto max-w-4xl", className)}>
      <div className="mb-2 flex items-center justify-between gap-2 text-sm font-medium">
        <span>{purpose === "cli" ? t("Where should this CLI run?") : t("Where should this chat work?")}</span>
        {busy ? <Loader2 aria-label={t("Loading")} className="h-4 w-4 animate-spin text-muted-foreground" /> : <Button type="button" size="icon-sm" variant="ghost" aria-label={t("Configure root folder")} title={t("Configure root folder")} disabled={rootSettingsOpen} onClick={() => {
          request.current?.abort();
          setBrowsing(false);
          setRootSettingsOpen(true);
          onEditingChange?.(true);
        }}><Settings className="h-4 w-4" /></Button>}
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("Folder options")}>
        <Button type="button" size="sm" variant={mode === "current" ? "secondary" : "ghost"} aria-pressed={mode === "current"} disabled={busy || rootSettingsOpen} onClick={() => changeMode("current")}>
          {mode === "current" ? <Check className="h-4 w-4" /> : <Folder className="h-4 w-4" />}{t("Use current folder")}
        </Button>
        <Button type="button" size="sm" variant={mode === "choose" ? "secondary" : "ghost"} aria-pressed={mode === "choose"} disabled={busy || rootSettingsOpen} onClick={() => changeMode("choose")}>
          <Folder className="h-4 w-4" />{t("Choose another folder")}
        </Button>
        {onCreateWorkspace && <Button type="button" size="sm" variant={mode === "create" ? "secondary" : "ghost"} aria-pressed={mode === "create"} disabled={busy || rootSettingsOpen} onClick={() => changeMode("create")}>
          <FolderPlus className="h-4 w-4" />{t("Create a new project folder")}
        </Button>}
      </div>
      {rootSettingsOpen ? <FolderRootSettings onCancel={() => { setRootSettingsOpen(false); onEditingChange?.(mode !== "current"); if (mode !== "current") void navigate(); }} onSaved={() => {
        setRootSettingsOpen(false);
        setListing(null);
        setMode("choose");
        onEditingChange?.(true);
        void navigate();
      }} /> : mode === "current" ? <p className="mt-2 break-all text-xs text-muted-foreground" data-slot="current-project-folder">{currentPath ?? t("Loading current folder…")}</p> : (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">{t("Browse folders on the computer running VibeAround.")}</p>
          <FolderBrowser listing={listing} loading={browsing} error={browseError} disabled={busy} onNavigate={path => void navigate(path)} onRetry={() => void navigate(destination.current)} />
          <form className="space-y-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
            {mode === "create" && <div className="space-y-1">
              <label htmlFor={`${id}-name`} className="text-xs font-medium">{t("New folder name")}</label>
              <Input id={`${id}-name`} value={name} onChange={event => setName(event.target.value)} placeholder={t("my-project")} required disabled={busy || browsing || Boolean(browseError)} />
              <p className="text-xs text-muted-foreground">{t("Created inside the folder shown above. Existing folders are never overwritten.")}</p>
            </div>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={busy || browsing || Boolean(browseError) || !listing || (mode === "create" && !name.trim())}>
                {creating || submitting ? t("Applying…") : mode === "create" ? t("Create and use folder") : t("Use this folder")}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy || rootSettingsOpen} onClick={() => changeMode("current")}>{t("Cancel")}</Button>
            </div>
          </form>
        </div>
      )}
      {createError && <p role="alert" className="mt-2 break-words text-xs text-destructive">{createError}</p>}
    </section>
  );
}
