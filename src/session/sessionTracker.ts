import * as vscode from 'vscode';
import {
  SessionStore,
  SessionSnapshot,
  TouchedFileEntry,
  TouchedFileEventType,
  SCHEMA_VERSION,
  computeWorkspaceId,
} from './sessionStore';

export interface SessionTrackerOptions {
  maxFiles?: number;
  debounceMs?: number;
}

const DEFAULT_MAX_FILES = 50;
const DEFAULT_DEBOUNCE_MS = 10_000;

/**
 * SessionTracker: listens for workspace events and maintains a deduplicated,
 * capped in-memory list of touched files. Flushes to SessionStore on debounce
 * and on deactivate.
 */
export class SessionTracker implements vscode.Disposable {
  private readonly maxFiles: number;
  private readonly debounceMs: number;
  private readonly store: SessionStore;
  private readonly touchedFilesMap = new Map<string, TouchedFileEntry>();
  private disposables: vscode.Disposable[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private isDisposed = false;

  constructor(store: SessionStore, options?: SessionTrackerOptions) {
    this.store = store;
    this.maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
    this.debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /**
   * Start listening to VSCode events. Must be called after activate.
   * Subscriptions are pushed to the given array or context.subscriptions.
   */
  start(subscriptions?: vscode.Disposable[]): void {
    if (this.isDisposed) {
      return;
    }

    const d1 = vscode.workspace.onDidOpenTextDocument((doc) => {
      this.handleDidOpen(doc);
    });
    const d2 = vscode.workspace.onDidSaveTextDocument((doc) => {
      this.handleDidSave(doc);
    });
    const d3 = vscode.window.onDidChangeActiveTextEditor((editor) => {
      this.handleDidChangeActiveEditor(editor);
    });

    this.disposables.push(d1, d2, d3);
    if (subscriptions) {
      subscriptions.push(d1, d2, d3);
    }
  }

  // Testable handlers (pure-ish, accept vscode types but also test doubles)
  handleDidOpen(doc: vscode.TextDocument): void {
    if (!this.shouldTrackDocument(doc)) {
      return;
    }
    const filePath = this.toTrackedPath(doc);
    if (!filePath) {
      return;
    }
    this.recordFile(filePath, 'opened');
  }

  handleDidSave(doc: vscode.TextDocument): void {
    if (!this.shouldTrackDocument(doc)) {
      return;
    }
    const filePath = this.toTrackedPath(doc);
    if (!filePath) {
      return;
    }
    this.recordFile(filePath, 'saved');
  }

  handleDidChangeActiveEditor(editor: vscode.TextEditor | undefined): void {
    if (!editor) {
      return;
    }
    const doc = editor.document;
    if (!this.shouldTrackDocument(doc)) {
      return;
    }
    const filePath = this.toTrackedPath(doc);
    if (!filePath) {
      return;
    }
    this.recordFile(filePath, 'activated');
  }

  private shouldTrackDocument(doc: vscode.TextDocument): boolean {
    // Only track file scheme, ignore untitled, output, git, etc.
    if (doc.uri.scheme !== 'file') {
      return false;
    }
    // Ignore non-file? also check isUntitled
    if (doc.isUntitled) {
      return false;
    }
    return true;
  }

  private toTrackedPath(doc: vscode.TextDocument): string | undefined {
    try {
      // Prefer relative path if within workspace
      const wsFolders = vscode.workspace.workspaceFolders;
      if (wsFolders && wsFolders.length > 0) {
        // Use VSCode's asRelativePath which respects workspace root
        const relative = vscode.workspace.asRelativePath(doc.uri, false);
        // If relative is same as fsPath, it's outside workspace -> use fsPath
        // asRelativePath returns the input if outside workspace
        if (relative && relative !== doc.uri.fsPath) {
          return relative;
        }
      }
      return doc.uri.fsPath;
    } catch {
      return doc.uri.fsPath;
    }
  }

  /**
   * Record a file touch. Deduplicated by path, keeps most recent event.
   * Public for testing and for direct calls without VSCode document.
   */
  recordFile(filePath: string, eventType: TouchedFileEventType, at?: Date): void {
    if (!filePath) {
      return;
    }
    const now = at ?? new Date();
    const iso = now.toISOString();
    const existing = this.touchedFilesMap.get(filePath);
    if (existing) {
      // Keep most recent; overwrite
      existing.lastEventAt = iso;
      existing.eventType = eventType;
      // Move to end for LRU ordering (delete + set)
      this.touchedFilesMap.delete(filePath);
      this.touchedFilesMap.set(filePath, existing);
    } else {
      const entry: TouchedFileEntry = {
        path: filePath,
        lastEventAt: iso,
        eventType,
      };
      this.touchedFilesMap.set(filePath, entry);
    }

    // Enforce cap: keep most recent maxFiles
    this.enforceCap();

    // Schedule debounced flush
    this.scheduleFlush();
  }

  private enforceCap(): void {
    if (this.touchedFilesMap.size <= this.maxFiles) {
      return;
    }
    // Map is insertion-ordered, oldest first. Need to keep most recent.
    // Remove oldest until size == maxFiles
    const toRemove = this.touchedFilesMap.size - this.maxFiles;
    const keys = Array.from(this.touchedFilesMap.keys());
    for (let i = 0; i < toRemove; i++) {
      this.touchedFilesMap.delete(keys[i]);
    }
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.flush();
    }, this.debounceMs);
    // Ensure timer doesn't keep process alive unnecessarily in tests
    if (this.debounceTimer && typeof (this.debounceTimer as unknown as { unref?: () => void }).unref === 'function') {
      (this.debounceTimer as unknown as { unref: () => void }).unref();
    }
  }

  getTouchedFiles(): TouchedFileEntry[] {
    // Return most-recent-first sorted by lastEventAt descending
    const entries = Array.from(this.touchedFilesMap.values());
    entries.sort((a, b) => {
      const ta = new Date(a.lastEventAt).getTime();
      const tb = new Date(b.lastEventAt).getTime();
      return tb - ta;
    });
    return entries;
  }

  /**
   * For testing: inject entries directly
   */
  setTouchedFiles(entries: TouchedFileEntry[]): void {
    this.touchedFilesMap.clear();
    for (const e of entries) {
      this.touchedFilesMap.set(e.path, { ...e });
    }
    this.enforceCap();
  }

  clear(): void {
    this.touchedFilesMap.clear();
  }

  getCount(): number {
    return this.touchedFilesMap.size;
  }

  async flush(): Promise<void> {
    if (this.isDisposed) {
      return;
    }
    const touched = this.getTouchedFiles();
    const snapshot: SessionSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      workspaceId: computeWorkspaceId(),
      sessionEndedAt: new Date().toISOString(),
      touchedFiles: touched,
      todosFound: [],
    };
    try {
      await this.store.save(snapshot);
    } catch (err) {
      console.warn(`[Previously On] flush failed: ${err}`);
    }
  }

  /**
   * Synchronous flush for deactivate().
   * Writes current state with sessionEndedAt = now.
   */
  flushSync(): void {
    const touched = this.getTouchedFiles();
    const snapshot: SessionSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      workspaceId: computeWorkspaceId(),
      sessionEndedAt: new Date().toISOString(),
      touchedFiles: touched,
      todosFound: [],
    };
    try {
      this.store.saveSync(snapshot);
    } catch (err) {
      console.warn(`[Previously On] flushSync failed: ${err}`);
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  dispose(): void {
    this.isDisposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        // ignore
      }
    }
    this.disposables = [];
    // Do not clear map on dispose; deactivate will flush first.
  }
}
