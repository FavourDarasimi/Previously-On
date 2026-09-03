import * as vscode from 'vscode';
import {
  SessionStore,
  SessionSnapshot,
  TouchedFileEntry,
  TouchedFileEventType,
  SCHEMA_VERSION,
  computeWorkspaceId,
  CursorPosition,
  SymbolEdit,
  TerminalCommand,
  TestRun,
  LastActiveFile,
} from './sessionStore';

export interface SessionTrackerOptions {
  maxFiles?: number;
  debounceMs?: number;
  maxSymbolEdits?: number;
  maxTerminalCommands?: number;
  maxTestRuns?: number;
}

const DEFAULT_MAX_FILES = 50;
const DEFAULT_DEBOUNCE_MS = 10_000;
const DEFAULT_MAX_SYMBOL_EDITS = 30;
const DEFAULT_MAX_TERMINAL_COMMANDS = 20;
const DEFAULT_MAX_TEST_RUNS = 20;

/**
 * SessionTracker: listens for workspace events and maintains a deduplicated,
 * capped in-memory list of touched files. Flushes to SessionStore on debounce
 * and on deactivate.
 */
export class SessionTracker implements vscode.Disposable {
  private readonly maxFiles: number;
  private readonly debounceMs: number;
  private readonly maxSymbolEdits: number;
  private readonly maxTerminalCommands: number;
  private readonly maxTestRuns: number;
  private readonly store: SessionStore;
  private readonly touchedFilesMap = new Map<string, TouchedFileEntry>();
  private readonly visitCounts = new Map<string, number>();
  private readonly cursorPositions = new Map<string, CursorPosition>();
  private readonly symbolEdits: SymbolEdit[] = [];
  private readonly terminalCommands: TerminalCommand[] = [];
  private readonly testRuns: TestRun[] = [];
  private lastActiveFile: LastActiveFile | undefined;
  private gitBranch: string | undefined;
  private disposables: vscode.Disposable[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private isDisposed = false;

  constructor(store: SessionStore, options?: SessionTrackerOptions) {
    this.store = store;
    this.maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
    this.debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxSymbolEdits = options?.maxSymbolEdits ?? DEFAULT_MAX_SYMBOL_EDITS;
    this.maxTerminalCommands = options?.maxTerminalCommands ?? DEFAULT_MAX_TERMINAL_COMMANDS;
    this.maxTestRuns = options?.maxTestRuns ?? DEFAULT_MAX_TEST_RUNS;
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
    const d4 = vscode.window.onDidChangeTextEditorSelection((e) => {
      this.handleDidChangeSelection(e);
    });
    const d5 = vscode.workspace.onDidChangeTextDocument((e) => {
      this.handleDidChangeTextDocument(e);
    });

    this.disposables.push(d1, d2, d3, d4, d5);
    if (subscriptions) {
      subscriptions.push(d1, d2, d3, d4, d5);
    }

    // Terminal / test signals — best-effort, may not be available in all VS Code versions
    try {
      const maybeTasks = vscode.tasks as unknown as {
        onDidStartTask?: (cb: (e: unknown) => void) => vscode.Disposable;
        onDidEndTaskProcess?: (cb: (e: unknown) => void) => vscode.Disposable;
      };
      if (maybeTasks.onDidStartTask) {
        const d6 = maybeTasks.onDidStartTask((e) => this.handleTaskStart(e as { execution?: { task?: { name?: string; definition?: unknown; source?: string } } }));
        this.disposables.push(d6);
        if (subscriptions) subscriptions.push(d6);
      }
      if (maybeTasks.onDidEndTaskProcess) {
        const d7 = maybeTasks.onDidEndTaskProcess((e) => this.handleTaskEnd(e as { execution?: { task?: { name?: string } }; exitCode?: number }));
        this.disposables.push(d7);
        if (subscriptions) subscriptions.push(d7);
      }
    } catch {
      // ignore if tasks API not available
    }

    try {
      const maybeWindow = vscode.window as unknown as {
        onDidOpenTerminal?: (cb: (t: unknown) => void) => vscode.Disposable;
      };
      if (maybeWindow.onDidOpenTerminal) {
        const d8 = maybeWindow.onDidOpenTerminal(() => this.recordTerminalCommand('terminal opened'));
        this.disposables.push(d8);
        if (subscriptions) subscriptions.push(d8);
      }
    } catch {
      // ignore
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
    // Capture cursor for lastActiveFile
    try {
      const sel = editor.selection;
      const line = sel?.active?.line ?? 0;
      const ch = sel?.active?.character ?? 0;
      this.recordCursor(filePath, line, ch);
      this.setLastActiveFile(filePath, line, ch);
    } catch {
      // ignore
    }
  }

  handleDidChangeSelection(e: { textEditor: vscode.TextEditor; selections: readonly vscode.Selection[] }): void {
    try {
      const editor = e.textEditor;
      if (!editor || !editor.document) return;
      if (!this.shouldTrackDocument(editor.document)) return;
      const filePath = this.toTrackedPath(editor.document);
      if (!filePath) return;
      const sel = e.selections[0] ?? editor.selection;
      const line = sel?.active?.line ?? 0;
      const ch = sel?.active?.character ?? 0;
      this.recordCursor(filePath, line, ch);
      // Update last active without counting as file touch (cursor moves shouldn't duplicate touchedFiles)
      this.setLastActiveFile(filePath, line, ch);
      this.incrementVisit(filePath);
    } catch {
      // ignore
    }
  }

  handleDidChangeTextDocument(e: vscode.TextDocumentChangeEvent): void {
    try {
      const doc = e.document;
      if (!this.shouldTrackDocument(doc)) return;
      const filePath = this.toTrackedPath(doc);
      if (!filePath) return;
      // Record the file as touched via edit (treated as saved-like but keep eventType)
      // We don't call recordFile here to avoid double counting saved events — instead track symbol
      for (const change of e.contentChanges) {
        const lineText = doc.lineAt(Math.min(change.range.start.line, doc.lineCount - 1)).text;
        const symbol = this.extractSymbol(lineText);
        if (symbol) {
          this.recordSymbolEdit(filePath, symbol);
        } else if (lineText.trim().length > 0) {
          // Fallback: record file name as symbol if no function detected but edit is significant
          const trimmed = lineText.trim().slice(0, 40);
          if (trimmed.length > 3) this.recordSymbolEdit(filePath, trimmed);
        }
      }
      this.incrementVisit(filePath);
    } catch {
      // ignore
    }
  }

  handleTaskStart(e: { execution?: { task?: { name?: string; definition?: unknown; source?: string } } }): void {
    try {
      const name = e.execution?.task?.name ?? '';
      const low = name.toLowerCase();
      if (low.includes('test') || low.includes('jest') || low.includes('pytest') || low.includes('vitest') || low.includes('mocha') || low.includes('cargo test')) {
        this.recordTestRun(name);
      }
      // Also treat any task that looks like a terminal command as terminal
      if (name) this.recordTerminalCommand(name);
    } catch {
      // ignore
    }
  }

  handleTaskEnd(e: { execution?: { task?: { name?: string } }; exitCode?: number }): void {
    try {
      const name = e.execution?.task?.name ?? '';
      if (!name) return;
      const low = name.toLowerCase();
      if (low.includes('test')) {
        // Ensure test run is recorded even if start was missed
        this.recordTestRun(`${name}${e.exitCode !== undefined ? `:${e.exitCode}` : ''}`);
      }
    } catch {
      // ignore
    }
  }

  // --- "What was I doing?" helpers ---
  private extractSymbol(lineText: string): string | undefined {
    const t = lineText.trim();
    // Heuristics for common languages
    const patterns = [
      /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/,
      /^\s*(?:export\s+)?class\s+([A-Za-z0-9_]+)/,
      /^\s*def\s+([A-Za-z0-9_]+)\s*\(/,
      /^\s*(?:public|private|protected)?\s*(?:async\s+)?([A-Za-z0-9_]+)\s*\([^)]*\)\s*[:{]/, // TS method
      /^\s*const\s+([A-Za-z0-9_]+)\s*=\s*(?:\(.*\)\s*=>|function)/,
      /^\s*(?:it|test|describe)\s*\(\s*['"`]([^'"`]+)['"`]/,
    ];
    for (const re of patterns) {
      const m = t.match(re);
      if (m && m[1]) return m[1].slice(0, 60);
    }
    return undefined;
  }

  recordCursor(filePath: string, line: number, character: number, at?: Date): void {
    if (!filePath) return;
    const now = (at ?? new Date()).toISOString();
    this.cursorPositions.set(filePath, { path: filePath, line, character, at: now });
    // Cap cursor map
    if (this.cursorPositions.size > this.maxFiles) {
      const first = this.cursorPositions.keys().next().value;
      if (first) this.cursorPositions.delete(first);
    }
    this.scheduleFlush();
  }

  recordSymbolEdit(filePath: string, symbol: string, at?: Date): void {
    if (!filePath || !symbol) return;
    const now = (at ?? new Date()).toISOString();
    this.symbolEdits.push({ path: filePath, symbol, at: now });
    if (this.symbolEdits.length > this.maxSymbolEdits) {
      this.symbolEdits.splice(0, this.symbolEdits.length - this.maxSymbolEdits);
    }
    this.scheduleFlush();
  }

  incrementVisit(filePath: string): void {
    if (!filePath) return;
    const cur = this.visitCounts.get(filePath) ?? 0;
    this.visitCounts.set(filePath, cur + 1);
    this.scheduleFlush();
  }

  recordTerminalCommand(command: string, at?: Date): void {
    if (!command) return;
    const trimmed = command.trim().slice(0, 120);
    if (!trimmed) return;
    // Deduplicate consecutive identical commands
    const last = this.terminalCommands[this.terminalCommands.length - 1];
    if (last && last.command === trimmed) return;
    this.terminalCommands.push({ command: trimmed, at: (at ?? new Date()).toISOString() });
    if (this.terminalCommands.length > this.maxTerminalCommands) {
      this.terminalCommands.splice(0, this.terminalCommands.length - this.maxTerminalCommands);
    }
    this.scheduleFlush();
  }

  recordTestRun(command: string, at?: Date): void {
    if (!command) return;
    const trimmed = command.trim().slice(0, 120);
    if (!trimmed) return;
    this.testRuns.push({ command: trimmed, at: (at ?? new Date()).toISOString(), kind: 'task' });
    if (this.testRuns.length > this.maxTestRuns) {
      this.testRuns.splice(0, this.testRuns.length - this.maxTestRuns);
    }
    this.scheduleFlush();
  }

  setGitBranch(branch: string | undefined): void {
    if (!branch) return;
    const trimmed = branch.trim().slice(0, 80);
    if (!trimmed) return;
    this.gitBranch = trimmed;
    this.scheduleFlush();
  }

  setLastActiveFile(filePath: string, line: number, character: number, at?: Date): void {
    if (!filePath) return;
    this.lastActiveFile = { path: filePath, line, character, at: (at ?? new Date()).toISOString() };
    this.scheduleFlush();
  }

  getVisitCounts(): Record<string, number> {
    return Object.fromEntries(this.visitCounts.entries());
  }

  getCursorPositions(): CursorPosition[] {
    return Array.from(this.cursorPositions.values());
  }

  getSymbolEdits(): SymbolEdit[] {
    return [...this.symbolEdits];
  }

  getTerminalCommands(): TerminalCommand[] {
    return [...this.terminalCommands];
  }

  getTestRuns(): TestRun[] {
    return [...this.testRuns];
  }

  getLastActiveFile(): LastActiveFile | undefined {
    return this.lastActiveFile ? { ...this.lastActiveFile } : undefined;
  }

  getGitBranch(): string | undefined {
    return this.gitBranch;
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

    // Track visit frequency for "What was I doing?" — files repeatedly visited
    const curVisit = this.visitCounts.get(filePath) ?? 0;
    this.visitCounts.set(filePath, curVisit + 1);

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
    this.visitCounts.clear();
    this.cursorPositions.clear();
    this.symbolEdits.length = 0;
    this.terminalCommands.length = 0;
    this.testRuns.length = 0;
    this.lastActiveFile = undefined;
    this.gitBranch = undefined;
  }

  getCount(): number {
    return this.touchedFilesMap.size;
  }

  private refreshGitBranch(): void {
    try {
      const gitExtension = vscode.extensions.getExtension('vscode.git');
      const api = gitExtension?.exports?.getAPI?.(1) as unknown as { repositories?: Array<{ state?: { HEAD?: { name?: string } } }> } | undefined;
      const branch = api?.repositories?.[0]?.state?.HEAD?.name;
      if (typeof branch === 'string' && branch.length > 0) {
        this.gitBranch = branch;
      }
    } catch {
      // ignore
    }
  }

  async flush(): Promise<void> {
    if (this.isDisposed) {
      return;
    }
    this.refreshGitBranch();
    const touched = this.getTouchedFiles();
    const snapshot: SessionSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      workspaceId: computeWorkspaceId(),
      sessionEndedAt: new Date().toISOString(),
      touchedFiles: touched,
      todosFound: [],
      cursorPositions: this.getCursorPositions(),
      symbolEdits: this.getSymbolEdits(),
      visitCounts: this.getVisitCounts(),
      terminalCommands: this.getTerminalCommands(),
      testRuns: this.getTestRuns(),
      gitBranch: this.getGitBranch(),
      lastActiveFile: this.getLastActiveFile(),
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
    this.refreshGitBranch();
    const touched = this.getTouchedFiles();
    const snapshot: SessionSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      workspaceId: computeWorkspaceId(),
      sessionEndedAt: new Date().toISOString(),
      touchedFiles: touched,
      todosFound: [],
      cursorPositions: this.getCursorPositions(),
      symbolEdits: this.getSymbolEdits(),
      visitCounts: this.getVisitCounts(),
      terminalCommands: this.getTerminalCommands(),
      testRuns: this.getTestRuns(),
      gitBranch: this.getGitBranch(),
      lastActiveFile: this.getLastActiveFile(),
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
