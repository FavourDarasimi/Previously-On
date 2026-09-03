import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SummaryViewModel } from '../summary/viewModel';
import { SessionStore } from '../session/sessionStore';
import { Strings } from '../strings';

export class SummaryWebviewPanel {
  public static currentPanel: SummaryWebviewPanel | undefined;
  public static readonly viewType = 'previouslyOn.recap';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _store: SessionStore | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _viewModel: SummaryViewModel;

  public static createOrShow(
    extensionUri: vscode.Uri,
    viewModel: SummaryViewModel,
    store?: SessionStore
  ): SummaryWebviewPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SummaryWebviewPanel.currentPanel) {
      SummaryWebviewPanel.currentPanel._viewModel = viewModel;
      SummaryWebviewPanel.currentPanel._panel.title = viewModel.title;
      SummaryWebviewPanel.currentPanel._panel.webview.html = SummaryWebviewPanel.currentPanel.getHtml(
        viewModel
      );
      SummaryWebviewPanel.currentPanel._panel.reveal(column);
      return SummaryWebviewPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      SummaryWebviewPanel.viewType,
      viewModel.title,
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'media')],
      }
    );

    const instance = new SummaryWebviewPanel(panel, extensionUri, viewModel, store);
    SummaryWebviewPanel.currentPanel = instance;
    return instance;
  }

  public static revive(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    viewModel: SummaryViewModel,
    store?: SessionStore
  ): void {
    new SummaryWebviewPanel(panel, extensionUri, viewModel, store);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    viewModel: SummaryViewModel,
    store?: SessionStore
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._viewModel = viewModel;
    this._store = store;

    this._panel.webview.html = this.getHtml(viewModel);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (msg: { command: string; path?: string; line?: number }) => {
        switch (msg.command) {
          case 'openFile':
            if (msg.path) {
              await this.handleOpenFile(msg.path);
            }
            break;
          case 'openTodo':
            if (msg.path) {
              await this.handleOpenFile(msg.path, msg.line);
            }
            break;
          case 'dismiss':
            this.dispose();
            break;
          case 'mute':
            if (this._store) {
              await this._store.setMutedForSession(true);
            }
            this.dispose();
            break;
          case 'openSCM':
            await vscode.commands.executeCommand('workbench.view.scm');
            break;
          default:
            break;
        }
      },
      null,
      this._disposables
    );
  }

  public reveal(viewModel: SummaryViewModel): void {
    this._viewModel = viewModel;
    this._panel.title = viewModel.title;
    this._panel.webview.html = this.getHtml(viewModel);
    this._panel.reveal();
  }

  public update(viewModel: SummaryViewModel): void {
    this._viewModel = viewModel;
    this._panel.webview.html = this.getHtml(viewModel);
  }

  public dispose(): void {
    SummaryWebviewPanel.currentPanel = undefined;

    this._panel.dispose();

    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }

  private async handleOpenFile(requestedPath: string, lineNumber?: number): Promise<void> {
    try {
      let uri: vscode.Uri;
      if (path.isAbsolute(requestedPath)) {
        uri = vscode.Uri.file(requestedPath);
      } else {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
          const candidate = vscode.Uri.joinPath(folders[0].uri, requestedPath);
          try {
            await vscode.workspace.fs.stat(candidate);
            uri = candidate;
          } catch {
            let found: vscode.Uri | undefined;
            for (const folder of folders) {
              const p = vscode.Uri.joinPath(folder.uri, requestedPath);
              try {
                await vscode.workspace.fs.stat(p);
                found = p;
                break;
              } catch {
                // continue
              }
            }
            uri = found ?? candidate;
          }
        } else {
          uri = vscode.Uri.file(requestedPath);
        }
      }

      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        void vscode.window.showInformationMessage(`${Strings.filesTouched.noLongerExists}: ${requestedPath}`);
        return;
      }

      const doc = await vscode.workspace.openTextDocument(uri);
      const options: vscode.TextDocumentShowOptions = { preview: false };
      if (typeof lineNumber === 'number' && Number.isFinite(lineNumber) && lineNumber > 0) {
        const start = new vscode.Position(Math.max(0, lineNumber - 1), 0);
        options.selection = new vscode.Selection(start, start);
      }
      await vscode.window.showTextDocument(doc, options);
    } catch (err) {
      console.warn(`[Previously On] Failed to open file ${requestedPath}: ${err}`);
      void vscode.window.showErrorMessage(`Could not open file: ${requestedPath}`);
    }
  }

  private getHtml(viewModel: SummaryViewModel): string {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let filesHtml = '';
    // Respect grouping by relevance: merge Files touched + Uncommitted changes into one list
    // so a file that was both touched and is dirty appears once with inline git status.
    if (folders.length > 1) {
      filesHtml = this.renderGroupedUnified(viewModel, folders);
    } else {
      filesHtml = this.renderUnifiedFiles(viewModel);
    }
    const todoHtml = folders.length > 1 ? '' : this.renderTodos(viewModel);
    // In multi-root, todos are grouped inside renderGroupedUnified via per-folder; but our grouped now handles files only,
    // so render todos separately grouped if needed
    let groupedTodoHtml = '';
    if (folders.length > 1 && viewModel.todos && viewModel.todos.length > 0) {
      groupedTodoHtml = this.renderGroupedTodos(viewModel, folders);
    }
    const footerHtml = this.renderFooter();

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${this._panel.webview.cspSource}; script-src 'nonce-${nonce}';">
  <title>${escapeHtml(viewModel.title)}</title>
  <style>
    html, body {
      overflow-x: clip;
      min-width: 0;
    }
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground, var(--vscode-editor-foreground));
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 0;
      line-height: 1.4;
    }
    .panel {
      max-width: 560px;
      padding: 12px 12px 16px;
      min-width: 0;
    }
    .header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBarSectionHeader-border, transparent));
      margin-bottom: 12px;
    }
    .header-main {
      min-width: 0;
      flex: 1;
    }
    .title {
      font-size: 13px;
      font-weight: 600;
      line-height: 1.3;
      margin: 0;
      color: var(--vscode-foreground, var(--vscode-editor-foreground));
      overflow-wrap: anywhere;
      min-width: 0;
    }
    .subtitle {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
      line-height: 1.35;
      overflow-wrap: anywhere;
      min-width: 0;
    }
    .close {
      width: 22px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 2px;
      background: transparent;
      color: var(--vscode-icon-foreground, var(--vscode-foreground));
      cursor: pointer;
      flex-shrink: 0;
      font-size: 14px;
      line-height: 1;
    }
    .close:hover {
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
    }
    .close:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .section {
      margin-bottom: 16px;
      min-width: 0;
    }
    .section:last-of-type {
      margin-bottom: 0;
    }
    .section-header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 6px;
      min-width: 0;
    }
    .section-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground, var(--vscode-editor-foreground));
      margin: 0;
      line-height: 1.3;
    }
    .section-count {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      font-weight: 400;
    }
    .section-desc {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin: 0 0 6px;
      line-height: 1.35;
    }
    .section-desc a, .link {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      cursor: pointer;
    }
    .section-desc a:hover, .link:hover {
      text-decoration: underline;
      color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
    }
    .section-desc a:focus-visible, .link:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    .list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 1px;
      min-width: 0;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 22px;
      padding: 2px 4px;
      border-radius: 2px;
      cursor: pointer;
      min-width: 0;
    }
    .row:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .row:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .row:active {
      background: var(--vscode-list-activeSelectionBackground);
    }
    .path {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-foreground, var(--vscode-editor-foreground));
    }
    .path.missing {
      color: var(--vscode-descriptionForeground);
      text-decoration: line-through;
    }
    .meta {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
      min-width: 0;
    }
    .time {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }
    .git {
      font-size: 12px;
      font-weight: 600;
      min-width: 10px;
      text-align: center;
      line-height: 1;
      flex-shrink: 0;
    }
    .git-M { color: var(--vscode-gitDecoration-modifiedResourceForeground, #1a85ff); }
    .git-A { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
    .git-D { color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c); }
    .git-U { color: var(--vscode-gitDecoration-untrackedResourceForeground, #73c991); }
    .git-R { color: var(--vscode-gitDecoration-renamedResourceForeground, var(--vscode-gitDecoration-modifiedResourceForeground, #1a85ff)); }
    .hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-left: 6px;
    }
    .more {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      padding: 4px 4px 0;
    }
    .todo-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 1px;
      min-width: 0;
    }
    .todo-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 4px 8px;
      padding: 4px 4px;
      border-radius: 2px;
      cursor: pointer;
      min-width: 0;
      align-items: start;
    }
    .todo-row:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .todo-row:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .todo-path {
      font-size: 12px;
      color: var(--vscode-textLink-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .todo-line {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .todo-snippet {
      grid-column: 1 / -1;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      line-height: 1.35;
    }
    .actions {
      display: flex;
      gap: 8px;
      padding-top: 12px;
      margin-top: 4px;
      border-top: 1px solid var(--vscode-panel-border, transparent);
      flex-wrap: wrap;
    }
    .btn {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      font-weight: 400;
      padding: 4px 12px;
      border-radius: 2px;
      border: 1px solid var(--vscode-button-border, transparent);
      cursor: pointer;
      min-height: 26px;
      white-space: nowrap;
    }
    .btn:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-color: var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
    }
    .btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .group {
      margin-bottom: 16px;
      min-width: 0;
    }
    .group-header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 4px 4px 4px 0;
      margin-bottom: 4px;
      border-bottom: 1px solid var(--vscode-panel-border, transparent);
      min-width: 0;
    }
    .group-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .group-count {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .group-empty {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    @media (max-width: 768px) {
      .panel { padding: 12px 12px 16px; }
    }
    @media (max-width: 414px) {
      .row { padding: 4px 4px; }
      .actions { gap: 6px; }
      .btn { flex: 1 1 auto; justify-content: center; text-align: center; }
    }
    @media (max-width: 320px) {
      .panel { padding-left: 10px; padding-right: 10px; }
      .time { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
      }
    }
  </style>
</head>
<body>
  <div class="panel">
    <div class="header">
      <div class="header-main">
        <h1 class="title">${escapeHtml(viewModel.title)}</h1>
        <div class="subtitle">${escapeHtml(viewModel.subtitle)}</div>
      </div>
      <button type="button" class="close" aria-label="Close recap" title="Close" onclick="dismiss()">×</button>
    </div>

    ${filesHtml}
    ${todoHtml}
    ${groupedTodoHtml}

    ${footerHtml}
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function openFile(filePath) {
      vscode.postMessage({ command: 'openFile', path: filePath });
    }
    function openTodo(filePath, line) {
      vscode.postMessage({ command: 'openTodo', path: filePath, line: Number(line) });
    }
    function openSCM() {
      vscode.postMessage({ command: 'openSCM' });
    }
    function dismiss() {
      vscode.postMessage({ command: 'dismiss' });
    }
    function mute() {
      vscode.postMessage({ command: 'mute' });
    }
    function handleKeyActivation(event, onActivate) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onActivate();
      }
    }
    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('.row[data-path]').forEach(el => {
        el.addEventListener('click', () => {
          const p = el.getAttribute('data-path');
          if (p) {
            const line = el.getAttribute('data-line');
            if (line) openTodo(p, line);
            else openFile(p);
          }
        });
        el.addEventListener('keydown', (event) => handleKeyActivation(event, () => {
          const p = el.getAttribute('data-path');
          if (p) {
            const line = el.getAttribute('data-line');
            if (line) openTodo(p, line);
            else openFile(p);
          }
        }));
      });
      const scmLink = document.getElementById('open-scm');
      if (scmLink) scmLink.addEventListener('click', (e) => { e.preventDefault(); openSCM(); });
      const dismissBtn = document.getElementById('btn-dismiss');
      if (dismissBtn) dismissBtn.addEventListener('click', dismiss);
      const muteBtn = document.getElementById('btn-mute');
      if (muteBtn) muteBtn.addEventListener('click', mute);
    });
  </script>
</body>
</html>`;
  }

  private renderUnifiedFiles(viewModel: SummaryViewModel): string {
    const hasFiles = viewModel.filesTouched && viewModel.filesTouched.length > 0;
    const hasGit = viewModel.gitStatus && viewModel.gitStatus.changes.length > 0;
    if (!hasFiles && !hasGit) {
      return '';
    }

    // Build map of git status by path for quick lookup (normalize to string)
    const gitMap = new Map<string, { status: string; label: string }>();
    if (viewModel.gitStatus) {
      for (const c of viewModel.gitStatus.changes) {
        gitMap.set(c.path, { status: c.status, label: c.label });
        // Also map by basename-relative for matching relative touched paths
        // We do second pass below for relative matching via folder resolution
      }
    }

    // Helper to find git entry for a touched path (handles relative vs absolute)
    const findGitForPath = (touchedPath: string): { status: string; label: string } | undefined => {
      if (gitMap.has(touchedPath)) return gitMap.get(touchedPath);
      // Try absolute resolution
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (!path.isAbsolute(touchedPath) && folders.length > 0) {
        for (const folder of folders) {
          const abs = path.join(folder.uri.fsPath, touchedPath);
          if (gitMap.has(abs)) return gitMap.get(abs);
        }
      }
      // Try suffix match (basename) as last resort for git absolute vs touched relative
      for (const [gitPath, v] of gitMap.entries()) {
        if (gitPath.endsWith('/' + touchedPath) || gitPath.endsWith('\\' + touchedPath)) {
          return v;
        }
      }
      return undefined;
    };

    const touchedSet = new Set(viewModel.filesTouched.map((f) => f.path));
    // Collect unified rows: start with touched files in most-recent-first order
    const rows: Array<{ path: string; time?: string; git?: { status: string; label: string }; missing: boolean }> = [];
    for (const f of viewModel.filesTouched) {
      const git = findGitForPath(f.path);
      rows.push({ path: f.path, time: f.relativeTime, git, missing: !this.pathExists(f.path) });
    }
    // Add git-only files not already in touched set (edited outside VS Code)
    if (viewModel.gitStatus) {
      for (const c of viewModel.gitStatus.changes) {
        const already = touchedSet.has(c.path) || rows.some((r) => r.path === c.path);
        // Check relative match
        let alreadyRelative = false;
        if (!already) {
          for (const r of rows) {
            if (c.path.endsWith('/' + r.path) || c.path.endsWith('\\' + r.path)) {
              alreadyRelative = true;
              break;
            }
          }
        }
        if (!already && !alreadyRelative) {
          // For git-only, try to show relative path if inside workspace
          let displayPath = c.path;
          const folders = vscode.workspace.workspaceFolders ?? [];
          for (const folder of folders) {
            const base = folder.uri.fsPath;
            if (c.path === base || c.path.startsWith(base + path.sep)) {
              displayPath = path.relative(base, c.path);
              break;
            }
          }
          rows.push({ path: displayPath, git: { status: c.status, label: c.label }, missing: false });
        }
      }
    }

    if (rows.length === 0) return '';

    const totalLabel = viewModel.totalFiles > rows.length ? `${rows.length} of ${viewModel.totalFiles}` : `${rows.length}`;
    // Build description that tells what to do — active voice, specific
    const gitCount = viewModel.gitStatus?.count ?? 0;
    let desc = '';
    if (gitCount > 0) {
      const noun = gitCount === 1 ? 'file has changes' : 'files have changes';
      desc = `${gitCount} ${noun} — <a href="#" id="open-scm" class="link">open in Source Control</a> to review`;
    } else {
      desc = `No uncommitted changes — working tree is clean`;
    }

    const items = rows
      .map((r) => {
        // Map status to single letter class: M/A/D/U/R
        const statusLetter = r.git ? r.git.label : '';
        const statusClass = r.git
          ? r.git.status === 'modified'
            ? 'git-M'
            : r.git.status === 'added'
              ? 'git-A'
              : r.git.status === 'deleted'
                ? 'git-D'
                : r.git.status === 'untracked'
                  ? 'git-U'
                  : 'git-R'
          : '';
        const gitSpan = r.git
          ? `<span class="git ${statusClass}" title="${escapeHtml(r.git.status)}">${escapeHtml(statusLetter)}</span>`
          : '';
        const timeSpan = r.time ? `<span class="time">${escapeHtml(r.time)}</span>` : '';
        const hint = r.missing ? `<span class="hint">(${escapeHtml(Strings.filesTouched.noLongerExists)})</span>` : '';
        const pathClass = r.missing ? 'path missing' : 'path';
        return `<li class="row" data-path="${escapeHtml(r.path)}" title="${escapeHtml(r.path)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(r.path)}">
            <span class="${pathClass}">${escapeHtml(r.path)}${hint}</span>
            <span class="meta">${timeSpan}${gitSpan}</span>
          </li>`;
      })
      .join('');

    const moreHint =
      viewModel.truncated && viewModel.totalFiles > rows.length
        ? `<div class="more">+${viewModel.totalFiles - rows.length} more</div>`
        : viewModel.truncated
          ? `<div class="more">+${viewModel.totalFiles - viewModel.filesTouched.length} more</div>`
          : '';

    return `<section class="section" id="files">
      <div class="section-header">
        <h2 class="section-title">${escapeHtml(Strings.filesTouched.title)}</h2>
        <span class="section-count">${escapeHtml(totalLabel)}</span>
      </div>
      <p class="section-desc">${desc}</p>
      <ul class="list">
        ${items}
      </ul>
      ${moreHint}
    </section>`;
  }

  private renderGroupedUnified(viewModel: SummaryViewModel, folders: readonly vscode.WorkspaceFolder[]): string {
    const groups = new Map<string, { files: NonNullable<SummaryViewModel['filesTouched']>; git: SummaryViewModel['gitStatus']; todos: NonNullable<SummaryViewModel['todos']> }>();

    for (const f of folders) {
      groups.set(f.name, { files: [], git: undefined, todos: [] });
    }

    const findFolderName = (p: string): string | undefined => {
      if (path.isAbsolute(p)) {
        for (const f of folders) {
          const rawBase = f.uri.fsPath;
          const base = rawBase.endsWith(path.sep) ? rawBase.slice(0, -1) : rawBase;
          if (p === base || p.startsWith(base + path.sep)) return f.name;
        }
        for (const f of folders) {
          const baseLower = f.uri.fsPath.toLowerCase();
          const pLower = p.toLowerCase();
          const baseNorm = baseLower.endsWith(path.sep) ? baseLower.slice(0, -1) : baseLower;
          if (pLower === baseNorm || pLower.startsWith(baseNorm + path.sep)) return f.name;
        }
        return folders[0]?.name;
      } else {
        for (const f of folders) {
          const candidate = path.join(f.uri.fsPath, p);
          try {
            if (fs.existsSync(candidate)) return f.name;
          } catch (_e) {
            // ignore missing
          }
        }
        return folders[0]?.name;
      }
    };

    for (const file of viewModel.filesTouched) {
      const name = findFolderName(file.path);
      if (name && groups.has(name)) groups.get(name)!.files.push(file);
    }
    if (viewModel.gitStatus) {
      for (const c of viewModel.gitStatus.changes) {
        const name = findFolderName(c.path);
        if (name && groups.has(name)) {
          const g = groups.get(name)!;
          if (!g.git) g.git = { hasRepository: true, count: 0, changes: [] } as any;
          (g.git as any).changes.push(c);
          (g.git as any).count = (g.git as any).changes.length;
        }
      }
    }
    if (viewModel.todos) {
      for (const t of viewModel.todos) {
        const name = findFolderName(t.path);
        if (name && groups.has(name)) groups.get(name)!.todos.push(t);
      }
    }

    let html = '';
    for (const [name, g] of groups.entries()) {
      const hasFiles = g.files.length > 0;
      const hasGit = !!g.git && g.git.count > 0;
      const hasTodos = g.todos.length > 0;
      if (!hasFiles && !hasGit && !hasTodos) {
        html += `<div class="group"><div class="group-header"><span class="group-name">${escapeHtml(name)}</span><span class="group-empty">no activity</span></div></div>`;
        continue;
      }
      const miniVm: SummaryViewModel = {
        title: viewModel.title,
        subtitle: viewModel.subtitle,
        filesTouched: g.files,
        totalFiles: g.files.length,
        truncated: false,
        hasContent: true,
        sessionEndedAt: viewModel.sessionEndedAt,
        gitStatus: g.git as any,
        todos: g.todos,
      };
      html += `<div class="group">
        <div class="group-header"><span class="group-name">${escapeHtml(name)}</span><span class="group-count">${g.files.length + (g.git?.count ?? 0)} items</span></div>
        ${this.renderUnifiedFiles(miniVm)}
        ${this.renderTodos(miniVm)}
      </div>`;
    }
    return html;
  }

  private renderGroupedTodos(_viewModel: SummaryViewModel, _folders: readonly vscode.WorkspaceFolder[]): string {
    // Used only when unified already handled files/git grouping but todos need separate grouping
    return '';
  }

  // Kept for backward compat — now delegates to unified; not used directly when unified is active
  private renderFilesTouched(viewModel: SummaryViewModel): string {
    return this.renderUnifiedFiles(viewModel);
  }

  private renderGitStatus(viewModel: SummaryViewModel): string {
    // Git is now inline in unified list — keep method for tests that may call it, but return semantic inline version
    if (!viewModel.gitStatus || viewModel.gitStatus.changes.length === 0) return '';
    // Fallback standalone (used only in old multi-root path if needed)
    const items = viewModel.gitStatus.changes
      .map((c) => {
        const cls =
          c.status === 'modified'
            ? 'git-M'
            : c.status === 'added'
              ? 'git-A'
              : c.status === 'deleted'
                ? 'git-D'
                : c.status === 'untracked'
                  ? 'git-U'
                  : 'git-R';
        return `<li class="row" data-path="${escapeHtml(c.path)}" title="${escapeHtml(c.path)}" tabindex="0" role="button"><span class="path">${escapeHtml(c.path)}</span><span class="git ${cls}">${escapeHtml(c.label)}</span></li>`;
      })
      .join('');
    return `<section class="section"><div class="section-header"><h2 class="section-title">${escapeHtml(Strings.gitStatus.title)}</h2><span class="section-count">${viewModel.gitStatus.count}</span></div><ul class="list">${items}</ul></section>`;
  }

  private renderTodos(viewModel: SummaryViewModel): string {
    if (!viewModel.todos || viewModel.todos.length === 0) {
      return '';
    }
    const items = viewModel.todos
      .map(
        (todo) =>
          `<li class="todo-row" data-path="${escapeHtml(todo.path)}" data-line="${todo.line}" title="${escapeHtml(todo.path)}:${todo.line}" tabindex="0" role="button" aria-label="Open ${escapeHtml(todo.path)} at line ${todo.line}">
            <span class="todo-path">${escapeHtml(todo.path)}:${todo.line}</span>
            <span class="todo-line">${todo.line}</span>
            <span class="todo-snippet">${escapeHtml(todo.text)}</span>
          </li>`
      )
      .join('');

    return `<section class="section" id="todos">
      <div class="section-header">
        <h2 class="section-title">${escapeHtml(Strings.todos.title)}</h2>
        <span class="section-count">${viewModel.todos.length}</span>
      </div>
      <p class="section-desc">Left behind in the files you touched — click to jump to the line</p>
      <ul class="todo-list">
        ${items}
      </ul>
    </section>`;
  }

  private pathExists(filePath: string): boolean {
    if (!filePath) {
      return false;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (path.isAbsolute(filePath)) {
      return fs.existsSync(filePath);
    }

    for (const folder of folders) {
      const candidate = vscode.Uri.joinPath(folder.uri, filePath).fsPath;
      if (fs.existsSync(candidate)) {
        return true;
      }
    }

    return false;
  }

  private renderFooter(): string {
    return `<div class="actions">
      <button class="btn btn-secondary" id="btn-dismiss" type="button">${escapeHtml(Strings.actions.dismiss)}</button>
      <button class="btn btn-secondary" id="btn-mute" type="button">${escapeHtml(Strings.actions.muteForSession)}</button>
    </div>`;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
