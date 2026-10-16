/**
 * Sessions API: list, create, delete. Base URL follows current page (works with tunnel).
 */

import { z } from "zod";
import {
  browserBaseUrl,
  ChatUploadResponseSchema,
  CreateSessionResponseSchema,
  LaunchSessionListSchema,
  ProfileLaunchOptionsSchema,
  SessionListSchema,
  TmuxSessionsResponseSchema,
  WorkspaceThreadInitResponseSchema,
  WorkspaceItemSchema,
  WorkspacesResponseSchema,
  type ChatUploadResponse,
  type CreateSessionResponse,
  type LaunchSessionInfo,
  type ProfileLaunchOption,
  type PtyTool,
  type SessionListItem,
  type TmuxSessionsResponse,
  type WorkspaceItem,
  type WorkspaceThreadInitResponse,
  type WorkspacesResponse,
} from "@va/client";

export type {
  ChatUploadResponse,
  CreateSessionResponse,
  LaunchSessionInfo,
  ProfileLaunchOption,
  SessionListItem,
  TmuxSessionsResponse,
  WorkspaceItem,
  WorkspaceThreadInitResponse,
  WorkspacesResponse,
};

export interface CreateSessionBody {
  tool?: PtyTool;
  profile_id?: string;
  launch_target?: string;
  resume_session_id?: string;
  project_path?: string;
  tmux_session?: string;
  /** "dark" | "light" — sets COLORFGBG in PTY env as fallback for non-OSC programs. */
  theme?: string;
  /** Initial terminal columns (from client fit). Server falls back to 80 if absent. */
  cols?: number;
  /** Initial terminal rows (from client fit). Server falls back to 24 if absent. */
  rows?: number;
}

const CreateWorkspaceResponseSchema = WorkspacesResponseSchema.extend({
  workspace: WorkspaceItemSchema,
});

export type CreateWorkspaceResponse = WorkspacesResponse & {
  workspace: WorkspaceItem;
};

export async function getSessions(): Promise<SessionListItem[]> {
  const res = await fetch(`${browserBaseUrl()}/api/sessions`);
  if (!res.ok) throw new Error(`GET /api/sessions: ${res.status}`);
  return SessionListSchema.parse(await res.json());
}

export async function getProfiles(): Promise<ProfileLaunchOption[]> {
  const res = await fetch(`${browserBaseUrl()}/api/profiles`);
  if (!res.ok) throw new Error(`GET /api/profiles: ${res.status}`);
  return ProfileLaunchOptionsSchema.parse(await res.json());
}

export async function getWorkspaces(): Promise<WorkspacesResponse> {
  const res = await fetch(`${browserBaseUrl()}/api/workspaces`);
  if (!res.ok) throw new Error(`GET /api/workspaces: ${res.status}`);
  return WorkspacesResponseSchema.parse(await res.json());
}

export const FolderListingSchema = z.object({
  root: z.string().min(1),
  path: z.string().min(1),
  parent_path: z.string().nullable(),
  folders: z.array(z.object({ name: z.string().min(1), path: z.string().min(1) })),
});

export type FolderListing = z.infer<typeof FolderListingSchema>;

export async function browseFolders(path?: string, signal?: AbortSignal): Promise<FolderListing> {
  const query = path ? `?${new URLSearchParams({ path })}` : "";
  const response = await fetch(`${browserBaseUrl()}/api/workspaces/browse${query}`, { signal });
  if (!response.ok) throw new Error(await response.text() || `Unable to browse folders (${response.status})`);
  return FolderListingSchema.parse(await response.json());
}

const FolderRootSchema = z.object({ root: z.string().min(1), configured_root: z.string().nullable() });

export async function getFolderRoot() {
  const response = await fetch(`${browserBaseUrl()}/api/workspaces/browser-root`);
  if (!response.ok) throw new Error(await response.text() || "Unable to load folder root");
  return FolderRootSchema.parse(await response.json());
}

export async function setFolderRoot(path: string | null) {
  const response = await fetch(`${browserBaseUrl()}/api/workspaces/browser-root`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) throw new Error(await response.text() || "Unable to save folder root");
  return FolderRootSchema.parse(await response.json());
}

export async function addWorkspace(path: string): Promise<string> {
  const res = await fetch(`${browserBaseUrl()}/api/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(await res.text() || `Failed to use folder (${res.status})`);
  const result: unknown = await res.json();
  if (!result || typeof result !== "object" || !("added" in result) || typeof result.added !== "string") {
    throw new Error("The server did not confirm the selected folder.");
  }
  return result.added;
}

export async function createWorkspace(name: string, parentPath?: string): Promise<CreateWorkspaceResponse> {
  const res = await fetch(`${browserBaseUrl()}/api/workspaces/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, parent_path: parentPath }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Failed to create workspace (${res.status})`);
  }
  return CreateWorkspaceResponseSchema.parse(await res.json());
}

export async function getLaunchSessions(
  agentId: string,
  includeArchived = false,
  workspacePath?: string,
): Promise<LaunchSessionInfo[]> {
  const params = new URLSearchParams();
  if (includeArchived) params.set("include_archived", "true");
  if (workspacePath) params.set("workspace_path", workspacePath);
  const query = params.toString();
  const path = `/api/agents/${encodeURIComponent(agentId)}/launch-sessions${query ? `?${query}` : ""}`;
  const res = await fetch(`${browserBaseUrl()}${path}`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return LaunchSessionListSchema.parse(await res.json());
}

export async function getLaunchSessionsBatch(
  agentIds: string[],
  includeArchived = false,
  workspacePaths: string[] = [],
): Promise<LaunchSessionInfo[]> {
  if (agentIds.length === 0) return [];
  const path = "/api/launch-sessions";
  const res = await fetch(`${browserBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_ids: agentIds,
      workspace_paths: workspacePaths,
      include_archived: includeArchived,
    }),
  });
  if (!res.ok) throw new Error(`POST ${path}: ${res.status}`);
  return LaunchSessionListSchema.parse(await res.json());
}

export interface InitWorkspaceThreadRequest {
  /** Adopt this existing thread. The thread already knows its agent, profile
   *  and workspace, so the other fields are ignored when it is set. */
  thread_id?: string;
  agent_id?: string;
  profile_id?: string;
  session_id?: string;
  workspace_path?: string;
}

export async function initWorkspaceThread(
  body: InitWorkspaceThreadRequest,
): Promise<WorkspaceThreadInitResponse> {
  const path = "/api/workspace-threads/init";
  const res = await fetch(`${browserBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `POST ${path}: ${res.status}`);
  }
  return WorkspaceThreadInitResponseSchema.parse(await res.json());
}

export async function archiveLaunchSession(
  agentId: string,
  sessionId: string,
  workspacePath: string,
): Promise<void> {
  const path = `/api/agents/${encodeURIComponent(agentId)}/launch-sessions/${encodeURIComponent(
    sessionId,
  )}/archive`;
  const res = await fetch(`${browserBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace_path: workspacePath }),
  });
  if (!res.ok && res.status !== 204) throw new Error(`POST ${path}: ${res.status}`);
}

export async function unarchiveLaunchSession(
  agentId: string,
  sessionId: string,
  workspacePath: string,
): Promise<void> {
  const path = `/api/agents/${encodeURIComponent(agentId)}/launch-sessions/${encodeURIComponent(
    sessionId,
  )}/unarchive`;
  const res = await fetch(`${browserBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace_path: workspacePath }),
  });
  if (!res.ok && res.status !== 204) throw new Error(`POST ${path}: ${res.status}`);
}

export async function createSession(body: CreateSessionBody): Promise<CreateSessionResponse> {
  const res = await fetch(`${browserBaseUrl()}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/sessions: ${res.status} ${text}`);
  }
  return CreateSessionResponseSchema.parse(await res.json());
}

export async function deleteSession(sessionId: string): Promise<void> {
  const res = await fetch(`${browserBaseUrl()}/api/sessions/${sessionId}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(`DELETE /api/sessions: ${res.status}`);
}

export async function getTmuxSessions(): Promise<TmuxSessionsResponse> {
  const res = await fetch(`${browserBaseUrl()}/api/tmux/sessions`);
  if (!res.ok) throw new Error(`GET /api/tmux/sessions: ${res.status}`);
  return TmuxSessionsResponseSchema.parse(await res.json());
}

async function uploadChatFileTo(
  path: string,
  file: File,
): Promise<ChatUploadResponse> {
  const params = new URLSearchParams();
  const mimeType = uploadMimeType(file);
  params.set("filename", file.name || "attachment");
  if (mimeType) params.set("mime_type", mimeType);
  const res = await fetch(`${browserBaseUrl()}${path}?${params.toString()}`, {
    method: "POST",
    headers: mimeType ? { "Content-Type": mimeType } : undefined,
    body: file,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path}: ${res.status} ${text}`);
  }
  return ChatUploadResponseSchema.parse(await res.json());
}

export async function uploadChatFile(file: File): Promise<ChatUploadResponse> {
  return uploadChatFileTo("/api/chat/uploads", file);
}

export async function uploadPreviewChatFile(
  previewSlug: string,
  file: File,
): Promise<ChatUploadResponse> {
  return uploadChatFileTo(
    `/preview/u/${encodeURIComponent(previewSlug)}/chat/uploads`,
    file,
  );
}

function uploadMimeType(file: File): string | undefined {
  const mime = file.type.split(";")[0]?.trim();
  if (!mime || isGenericUploadMime(mime)) return undefined;
  return mime;
}

function isGenericUploadMime(mime: string): boolean {
  const normalized = mime.toLowerCase();
  return normalized === "application/octet-stream" || normalized === "binary/octet-stream";
}
