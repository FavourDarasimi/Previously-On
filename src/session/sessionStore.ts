import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export const SCHEMA_VERSION = 1;
export const SNAPSHOT_FILE_NAME = 'session.json';
export const WORKSPACE_STATE_KEY_META = 'previouslyOn.snapshotMeta';
export const WORKSPACE_STATE_KEY_MUTED = 'previouslyOn.mutedForSession';

export type TouchedFileEventType = 'opened' | 'saved' | 'activated';

export interface TouchedFileEntry {
  path: string;
  lastEventAt: string; // ISO string
  eventType: TouchedFileEventType;
}

export interface SessionSnapshot {
  schemaVersion: number;
  workspaceId?: string;
  sessionEndedAt: string; // ISO string
  touchedFiles: TouchedFileEntry[];
  todosFound?: unknown[];
}

export interface StoreMeta {
  sessionEndedAt?: string;
  workspaceId?: string;
}

/**
 * SessionStore: thin persistence wrapper.
 * - Metadata in workspaceState
 * - Full snapshot JSON under storageUri
 * Handles missing/corrupt files gracefully.
 */
export class SessionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private get storageFileUri(): vscode.Uri | undefined {
    if (!this.context.storageUri) {
      return undefined;
    }
    return vscode.Uri.joinPath(this.context.storageUri, SNAPSHOT_FILE_NAME);
  }

  private get fsPath(): string | undefined {
    return this.storageFileUri?.fsPath;
  }

  async load(): Promise<SessionSnapshot | undefined> {
    // Try to read from storageUri JSON file first
    const fileUri = this.storageFileUri;
    if (fileUri) {
      try {
        // Ensure file exists before reading
        const data = await vscode.workspace.fs.readFile(fileUri);
        const text = Buffer.from(data).toString('utf8');
        const parsed = JSON.parse(text) as SessionSnapshot;
        if (!parsed || typeof parsed !== 'object') {
          throw new Error('Invalid snapshot shape');
        }
        // Validate schemaVersion
        if (typeof parsed.schemaVersion !== 'number') {
          // Old file without schemaVersion -> treat as invalid, will be migrated
          console.warn(`[Previously On] Snapshot missing schemaVersion, treating as corrupt`);
          return this.loadFromWorkspaceStateFallback();
        }
        // Basic validation
        if (!Array.isArray(parsed.touchedFiles)) {
          parsed.touchedFiles = [];
        }
        return parsed;
      } catch (err) {
        // Check if file not found -> first run
        const isFileNotFound =
          err instanceof vscode.FileSystemError && err.code === 'FileNotFound';
        if (isFileNotFound) {
          return this.loadFromWorkspaceStateFallback();
        }
        // Try Node fs fallback for better error detection (e.g., ENOENT)
        if (isNodeErrorWithCode(err, 'ENOENT') || isNodeErrorWithCode(err, 'FileNotFound')) {
          return this.loadFromWorkspaceStateFallback();
        }
        // Corrupt file -> log warning and treat as first run
        console.warn(`[Previously On] Failed to load snapshot: ${err}`);
        // Fallback to workspaceState if available
        const fallback = this.loadFromWorkspaceStateFallback();
        if (fallback) {
          return fallback;
        }
        return undefined;
      }
    }
    // No storageUri (e.g., no workspace folder) -> fallback to workspaceState
    return this.loadFromWorkspaceStateFallback();
  }

  private loadFromWorkspaceStateFallback(): SessionSnapshot | undefined {
    try {
      const meta = this.context.workspaceState.get<StoreMeta>(WORKSPACE_STATE_KEY_META);
      if (meta && meta.sessionEndedAt) {
        // Return minimal snapshot from workspaceState
        return {
          schemaVersion: SCHEMA_VERSION,
          workspaceId: meta.workspaceId,
          sessionEndedAt: meta.sessionEndedAt,
          touchedFiles: [],
        };
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  async save(snapshot: SessionSnapshot): Promise<void> {
    // Ensure snapshot has schemaVersion
    const toSave: SessionSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      workspaceId: snapshot.workspaceId,
      sessionEndedAt: snapshot.sessionEndedAt,
      touchedFiles: snapshot.touchedFiles ?? [],
      todosFound: snapshot.todosFound ?? [],
    };

    // Persist meta to workspaceState
    try {
      await this.context.workspaceState.update(WORKSPACE_STATE_KEY_META, {
        sessionEndedAt: toSave.sessionEndedAt,
        workspaceId: toSave.workspaceId,
      } as StoreMeta);
    } catch (err) {
      console.warn(`[Previously On] Failed to update workspaceState: ${err}`);
    }

    // Persist full JSON to storageUri
    const fileUri = this.storageFileUri;
    if (!fileUri) {
      return;
    }
    try {
      await vscode.workspace.fs.createDirectory(this.context.storageUri!);
      const text = JSON.stringify(toSave, null, 2);
      const data = Buffer.from(text, 'utf8');
      await vscode.workspace.fs.writeFile(fileUri, data);
    } catch (err) {
      console.warn(`[Previously On] Failed to write snapshot file: ${err}`);
    }
  }

  /**
   * Synchronous save for deactivate().
   * Uses Node fs synchronously because VS Code only allows a short sync window on deactivate.
   */
  saveSync(snapshot: SessionSnapshot): void {
    const toSave: SessionSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      workspaceId: snapshot.workspaceId,
      sessionEndedAt: snapshot.sessionEndedAt,
      touchedFiles: snapshot.touchedFiles ?? [],
      todosFound: snapshot.todosFound ?? [],
    };

    // Sync workspaceState update is not possible (async only), so we best-effort update via globalState sync?
    // We attempt to update workspaceState asynchronously but don't await.
    // For sync path, we rely on file write.
    try {
      // Fire-and-forget
      void this.context.workspaceState.update(WORKSPACE_STATE_KEY_META, {
        sessionEndedAt: toSave.sessionEndedAt,
        workspaceId: toSave.workspaceId,
      } as StoreMeta);
    } catch {
      // ignore
    }

    const fsPath = this.fsPath;
    if (!fsPath) {
      return;
    }
    try {
      const dir = path.dirname(fsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const text = JSON.stringify(toSave, null, 2);
      fs.writeFileSync(fsPath, text, 'utf8');
    } catch (err) {
      console.warn(`[Previously On] saveSync failed: ${err}`);
    }
  }

  async clear(): Promise<void> {
    try {
      await this.context.workspaceState.update(WORKSPACE_STATE_KEY_META, undefined);
      await this.context.workspaceState.update(WORKSPACE_STATE_KEY_MUTED, undefined);
    } catch {
      // ignore
    }
    const fileUri = this.storageFileUri;
    if (fileUri) {
      try {
        await vscode.workspace.fs.delete(fileUri, { useTrash: false });
      } catch (err) {
        if (!(err instanceof vscode.FileSystemError && err.code === 'FileNotFound')) {
          console.warn(`[Previously On] Failed to delete snapshot: ${err}`);
        }
      }
    }
  }

  getMutedForSession(): boolean {
    try {
      return !!this.context.workspaceState.get<boolean>(WORKSPACE_STATE_KEY_MUTED);
    } catch {
      return false;
    }
  }

  async setMutedForSession(muted: boolean): Promise<void> {
    try {
      await this.context.workspaceState.update(WORKSPACE_STATE_KEY_MUTED, muted ? true : undefined);
    } catch (err) {
      console.warn(`[Previously On] Failed to set muted flag: ${err}`);
    }
  }

  setMutedForSessionSync(muted: boolean): void {
    try {
      void this.context.workspaceState.update(WORKSPACE_STATE_KEY_MUTED, muted ? true : undefined);
    } catch {
      // ignore
    }
  }

  async clearMutedForSession(): Promise<void> {
    await this.setMutedForSession(false);
  }
}

function isNodeErrorWithCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === code
  );
}

// Helper to compute workspaceId (hash of workspace root) - simple implementation for M1
export function computeWorkspaceId(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  // Use first folder's fsPath as id; in multi-root, join sorted paths
  const sorted = folders
    .map((f) => f.uri.fsPath)
    .sort()
    .join('|');
  // Simple hash: not cryptographic, just deterministic
  let hash = 0;
  for (let i = 0; i < sorted.length; i++) {
    const chr = sorted.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return `ws-${Math.abs(hash).toString(16)}`;
}
