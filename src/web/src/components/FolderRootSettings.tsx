import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@va/i18n";
import { getFolderRoot, setFolderRoot } from "@/api/sessions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function FolderRootSettings({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const id = useId();
  const [path, setPath] = useState("");
  const [configured, setConfigured] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string>();
  const busy = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getFolderRoot().then(result => {
      if (!cancelled) { setPath(result.configured_root ?? result.root); setConfigured(result.configured_root !== null); }
    }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!cancelled) setPending(false); });
    return () => { cancelled = true; };
  }, []);

  async function save(value: string | null) {
    if (pending || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      await setFolderRoot(value);
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return <form className="mt-3 space-y-3 rounded-lg border border-border p-3" onSubmit={event => { event.preventDefault(); void save(path.trim()); }}>
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium">{t("Folder browser root")}</label>
      <Input id={id} value={path} onChange={event => setPath(event.target.value)} disabled={pending} required spellCheck={false} autoComplete="off" />
      <p className="text-xs text-muted-foreground">{t("Configure once: chat and CLI browse folders inside this location. Existing sessions are unchanged.")}</p>
    </div>
    {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" size="sm" disabled={pending || !path.trim()}>{pending ? t("Applying…") : t("Save root folder")}</Button>
      {configured && <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void save(null)}>{t("Use app default")}</Button>}
      <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onCancel}>{t("Cancel")}</Button>
    </div>
  </form>;
}
