import { ArrowUp, ChevronRight, Folder, Loader2 } from "lucide-react";
import { useI18n } from "@va/i18n";
import type { FolderListing } from "@/api/sessions";
import { Button } from "@/components/ui/button";

interface FolderBrowserProps {
  listing: FolderListing | null;
  loading: boolean;
  disabled?: boolean;
  error?: string;
  onNavigate: (path?: string) => void;
  onRetry: () => void;
}

export function folderBreadcrumbs(root: string, path: string): { name: string; path: string }[] {
  const separator = root.includes("\\") ? "\\" : "/";
  let current = root.replace(/[\\/]+$/, "");
  return path.slice(root.length).split(/[\\/]+/).filter(Boolean).map(name => {
    current += separator + name;
    return { name, path: current };
  });
}

export function FolderBrowser({ listing, loading, disabled = false, error, onNavigate, onRetry }: FolderBrowserProps) {
  const { t } = useI18n();
  const busy = disabled || loading;
  return <div className="overflow-hidden rounded-lg border border-border" aria-busy={loading}>
    <div className="border-b border-border bg-muted/30 p-2">
      <nav aria-label={t("Folder location")} className="flex flex-wrap items-center gap-1 text-xs">
        <Button type="button" size="sm" variant="ghost" disabled={busy || !listing?.parent_path} aria-label={t("Up one folder")} onClick={() => listing?.parent_path && onNavigate(listing.parent_path)}>
          <ArrowUp className="h-4 w-4" />
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onNavigate()} title={listing?.root}>{t("Root folder")}</Button>
        {listing && folderBreadcrumbs(listing.root, listing.path).map(crumb => <span key={crumb.path} className="flex min-w-0 items-center gap-1">
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          <button type="button" disabled={busy} onClick={() => onNavigate(crumb.path)} className="max-w-40 truncate rounded px-1.5 py-1 hover:bg-muted disabled:opacity-50" title={crumb.path}>{crumb.name}</button>
        </span>)}
      </nav>
      {listing && <p className="mt-1 break-all px-1 text-xs text-muted-foreground" data-slot="browsed-folder">{listing.path}</p>}
    </div>
    {loading ? <p role="status" className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("Loading folders…")}</p>
      : error ? <div className="space-y-2 p-3"><p role="alert" className="break-words text-xs text-destructive">{error}</p><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onRetry}>{t("Retry")}</Button></div>
      : listing && <div className="max-h-56 overflow-y-auto" aria-label={t("Folders")}>
        {listing.folders.length === 0 ? <p className="p-4 text-xs text-muted-foreground">{t("No subfolders. You can use this folder or create a new one here.")}</p> : listing.folders.map(folder => <button
          key={folder.path} type="button" disabled={disabled} aria-label={t("Open folder {{name}}", { name: folder.name })} onClick={() => onNavigate(folder.path)}
          className="flex w-full items-center gap-2 border-b border-border/40 px-3 py-3 text-left text-sm last:border-0 hover:bg-muted focus-visible:bg-muted disabled:opacity-50">
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 break-words">{folder.name}</span><ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>)}
      </div>}
  </div>;
}
