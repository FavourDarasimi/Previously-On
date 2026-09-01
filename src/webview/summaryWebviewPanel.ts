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
        // Restrict local resource roots if we had media files
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
    // Called when VS Code restores webview from persistence (not needed for M1 but stub)
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

    // Attach disposables to context? The caller will push panel to subscriptions,
    // but we also handle internal disposables.
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
    const footerHtml = this.renderFooter();

    // Multi-root support: when workspace has multiple folders, group sections by folder
    const folders = vscode.workspace.workspaceFolders ?? [];
    let groupedHtml = '';
    if (folders.length > 1) {
      groupedHtml = this.renderGroupedByFolder(viewModel, folders);
    }

    const filesHtml = groupedHtml || this.renderFilesTouched(viewModel);
    const gitHtml = groupedHtml ? '' : this.renderGitStatus(viewModel);
    const todoHtml = groupedHtml ? '' : this.renderTodos(viewModel);

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${this._panel.webview.cspSource}; script-src 'nonce-${nonce}';">
  <title>${escapeHtml(viewModel.title)}</title>
  <style>
    :root {
      color-scheme: light dark;
    }

    * {
      box-sizing: border-box;
    }

    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      padding: 12px 16px 18px;
      margin: 0;
      line-height: 1.5;
    }

    .panel {
      max-width: 540px;
    }

    .header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      padding-bottom: 10px;
   }

    .title-block {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }

    .header h1 {
      font-size: 1.2em;
      font-weight: 600;
      line-height: 1.25;
      letter-spacing: -0.01em;
      margin: 0;
    }

    .subtitle {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      max-width: 100%;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
      background: var(--vscode-editor-inactiveSelectionBackground, transparent);
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      line-height: 1.3;
    }

    .section {
      padding-top: 12px;
      margin-top: 12px;
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    }

    .section:first-of-type {
      border-top: none;
      margin-top: 0;
      padding-top: 0;
    }

    .section-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
    }

    .section-label {
      font-size: 0.78em;
      font-weight: 600;
      letter-spacing: 0.01em;
      color: var(--vscode-descriptionForeground);
    }

    .section-count {
      color: var(--vscode-descriptionForeground);
      font-size: 0.82em;
    }

    .file-list {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .file-item, .todo-item, .git-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 6px;
      border-radius: 4px;
      cursor: pointer;
      outline: none;
    }

    .file-item:hover, .todo-item:hover, .git-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .file-item:focus-visible, .todo-item:focus-visible, .git-item:focus-visible,
    .btn:focus-visible, .close-button:focus-visible {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }

    .file-item:active, .todo-item:active, .git-item:active {
      background: var(--vscode-list-activeSelectionBackground);
    }

    .file-path, .todo-path, .git-path {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-path {
      color: var(--vscode-textLink-foreground);
    }

    .file-path.missing {
      color: var(--vscode-descriptionForeground);
    }

    .file-hint,
    .file-time,
    .todo-meta,
    .list-meta {
      color: var(--vscode-descriptionForeground);
     font-size: 0.82em;
      white-space: nowrap;
    }

    .git-status {
      display: inline-block;
      min-width: 2.25em;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--vscode-badge-background, var(--vscode-editor-inactiveSelectionBackground));
      color: var(--vscode-badge-foreground, var(--vscode-editor-foreground));
      font-size: 0.78em;
      font-weight: 600;
      text-align: center;
    }

    .git-path,
    .todo-path {
      color: var(--vscode-editor-foreground);
    }

    .todo-item {
      flex-direction: column;
      align-items: stretch;
      gap: 4px;
    }

    .todo-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
    }

    .todo-path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-textLink-foreground);
    }

    .todo-text {
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
    }

    .more-hint {
      padding-top: 6px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.82em;
    }

    .actions {
      display: flex;
      justify-content: flex-start;
      gap: 10px;
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    }

    .btn,
    .close-button {
      font: inherit;
    }

    .btn {
      appearance: none;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 2px;
      background: var(--vscode-button-secondaryBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
      padding: 6px 12px;
      cursor: pointer;
      transition: background 0.1s ease;
    }

    .btn:hover,
    .close-button:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .close-button {
      width: 24px;
      height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid transparent;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 0;
    }

    .section-actions {
      margin-top: 8px;
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
        scroll-behavior: auto !important;
      }
    }
  </style>
</head>
<body>
  <div class="panel">
    <div class="header">
      <div class="title-block">
        <h1>${escapeHtml(viewModel.title)}</h1>
        <div class="subtitle">${escapeHtml(viewModel.subtitle)}</div>
      </div>
      <button type="button" class="close-button" aria-label="Close recap" title="Close" onclick="dismiss()">×</button>
    </div>
 
    ${filesHtml}
    ${gitHtml}
    ${todoHtml}
 
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
      document.querySelectorAll('.file-item[data-path]').forEach(el => {
        el.addEventListener('click', () => {
          const p = el.getAttribute('data-path');
          if (p) openFile(p);
        });
        el.addEventListener('keydown', (event) => handleKeyActivation(event, () => {
          const p = el.getAttribute('data-path');
          if (p) openFile(p);
        }));
      });
      document.querySelectorAll('.git-item[data-path]').forEach(el => {
        el.addEventListener('click', () => {
          const p = el.getAttribute('data-path');
          if (p) openFile(p);
        });
        el.addEventListener('keydown', (event) => handleKeyActivation(event, () => {
          const p = el.getAttribute('data-path');
          if (p) openFile(p);
        }));
      });
      document.querySelectorAll('.todo-item[data-path]').forEach(el => {
        el.addEventListener('click', () => {
          const p = el.getAttribute('data-path');
          const line = el.getAttribute('data-line');
          if (p && line) openTodo(p, line);
        });
        el.addEventListener('keydown', (event) => handleKeyActivation(event, () => {
          const p = el.getAttribute('data-path');
          const line = el.getAttribute('data-line');
          if (p && line) openTodo(p, line);
        }));
      });
      const scmBtn = document.getElementById('btn-open-scm');
      if (scmBtn) scmBtn.addEventListener('click', openSCM);
      const dismissBtn = document.getElementById('btn-dismiss');
      if (dismissBtn) dismissBtn.addEventListener('click', dismiss);
      const muteBtn = document.getElementById('btn-mute');
      if (muteBtn) muteBtn.addEventListener('click', mute);
    });
  </script>
</body>
</html>`;
  }

  private renderFilesTouched(viewModel: SummaryViewModel): string {
    if (!viewModel.filesTouched || viewModel.filesTouched.length === 0) {
      return '';
    }
    const countLabel = `${viewModel.totalFiles}`;
    const items = viewModel.filesTouched
      .map((f) => {
        const missing = !this.pathExists(f.path);
        const hint = missing ? ` <span class="file-hint">(${escapeHtml(Strings.filesTouched.noLongerExists)})</span>` : '';
        const className = missing ? 'file-path missing' : 'file-path';
        return `<li class="file-item" data-path="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(f.path)}">
            <span class="${className}">${escapeHtml(f.path)}${hint}</span>
            <span class="file-time">${escapeHtml(f.relativeTime)}</span>
          </li>`;
      })
      .join('');

    const moreHint = viewModel.truncated
      ? `<div class="more-hint">+${viewModel.totalFiles - viewModel.filesTouched.length} more</div>`
      : '';

    return `<div class="section" id="files-touched">
      <div class="section-header">
        <span class="section-label">${escapeHtml(Strings.filesTouched.title)}</span>
        <span class="section-count">${countLabel}</span>
      </div>
      <ul class="file-list">
        ${items}
      </ul>
      ${moreHint}
    </div>`;
  }

  /**
   * Group all three recap sections by workspace folder for multi-root workspaces.
   */
  private renderGroupedByFolder(viewModel: SummaryViewModel, folders: readonly vscode.WorkspaceFolder[]): string {
    // Build mapping: folderName -> { files: [], git: [], todos: [] }
    type Group = { files: NonNullable<SummaryViewModel['filesTouched']>; git: NonNullable<SummaryViewModel['gitStatus']> | undefined; todos: NonNullable<SummaryViewModel['todos']> };
    const groups = new Map<string, Group>();

    for (const f of folders) {
      groups.set(f.name, { files: [], git: undefined, todos: [] });
    }

    // Helper to find folder for a path
    const findFolderName = (p: string): string | undefined => {
      if (path.isAbsolute(p)) {
        for (const f of folders) {
          const base = f.uri.fsPath;
          if (p === base || p.startsWith(base + path.sep)) {
            return f.name;
          }
        }
      } else {
        // Relative path: try resolving against each folder and test existence
        for (const f of folders) {
          const candidate = path.join(f.uri.fsPath, p);
          try {
            if (fs.existsSync(candidate)) {
              return f.name;
            }
          } catch {
            // ignore
          }
        }
      }
      return undefined;
    };

    // Distribute files
    for (const file of viewModel.filesTouched) {
      const folderName = findFolderName(file.path);
      if (folderName && groups.has(folderName)) {
        groups.get(folderName)!.files.push(file);
      }
    }

    // Distribute git changes
    if (viewModel.gitStatus && viewModel.gitStatus.changes.length > 0) {
      for (const change of viewModel.gitStatus.changes) {
        const folderName = findFolderName(change.path);
        if (folderName && groups.has(folderName)) {
          const g = groups.get(folderName)!;
          if (!g.git) {
            g.git = { hasRepository: true, count: 0, changes: [] } as any;
          }
          (g.git as any).changes.push({ path: change.path, status: change.status, label: change.label });
          (g.git as any).count = (g.git as any).changes.length;
        }
      }
    }

    // Distribute todos
    if (viewModel.todos && viewModel.todos.length > 0) {
      for (const todo of viewModel.todos) {
        const folderName = findFolderName(todo.path);
        if (folderName) {
          const grp = groups.get(folderName);
          if (grp) {
            grp.todos.push(todo);
          }
        }
      }
    }

    // Render group blocks; skip empty folders (collapsed by default)
    let html = '';
    for (const [name, g] of groups.entries()) {
      const hasFiles = g.files && g.files.length > 0;
      const hasGit = g.git && g.git.count > 0;
      const hasTodos = g.todos && g.todos.length > 0;
      if (!hasFiles && !hasGit && !hasTodos) {
        // collapsed by default -> render a small header collapsed
        html += `<div class="section"><div class="section-header"><span>${escapeHtml(name)}</span><span class="count">(empty)</span></div></div>`;
        continue;
      }

      // Build a mini viewModel for folder and render its sections
      const miniVm: SummaryViewModel = {
        title: `${viewModel.title} — ${name}`,
        subtitle: viewModel.subtitle,
        filesTouched: g.files,
        totalFiles: g.files.length,
        truncated: false,
        hasContent: hasFiles || hasGit || hasTodos,
        sessionEndedAt: viewModel.sessionEndedAt,
        gitStatus: g.git as any,
        todos: g.todos,
      } as SummaryViewModel;

      html += `<div class="section" aria-label="folder-${escapeHtml(name)}">
        <div class="section-header"><span>${escapeHtml(name)}</span><span class="count"></span></div>
        ${this.renderFilesTouched(miniVm)}
        ${this.renderGitStatus(miniVm)}
        ${this.renderTodos(miniVm)}
      </div>`;
    }

    return html;
  }

  private renderGitStatus(viewModel: SummaryViewModel): string {
    if (!viewModel.gitStatus || viewModel.gitStatus.changes.length === 0) {
      return '';
    }

    const items = viewModel.gitStatus.changes
      .map(
        (change) =>
          `<li class="git-item" data-path="${escapeHtml(change.path)}" title="${escapeHtml(change.path)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(change.path)}">
            <span class="git-status">${escapeHtml(change.label)}</span>
            <span class="git-path">${escapeHtml(change.path)}</span>
          </li>`
      )
      .join('');

    return `<div class="section" id="uncommitted-changes">
      <div class="section-header">
        <span class="section-label">${escapeHtml(Strings.gitStatus.title)}</span>
        <span class="section-count">${viewModel.gitStatus.count}</span>
      </div>
      <ul class="file-list">
        ${items}
      </ul>
      <div class="section-actions">
        <button class="btn btn-secondary" id="btn-open-scm" type="button">${escapeHtml(Strings.actions.openSourceControl)}</button>
      </div>
    </div>`;
  }

  private renderTodos(viewModel: SummaryViewModel): string {
    if (!viewModel.todos || viewModel.todos.length === 0) {
      return '';
    }

    const items = viewModel.todos
      .map(
        (todo) =>
          `<li class="todo-item" data-path="${escapeHtml(todo.path)}" data-line="${todo.line}" title="${escapeHtml(todo.path)}:${todo.line}" tabindex="0" role="button" aria-label="Open ${escapeHtml(todo.path)} at line ${todo.line}">
            <div class="todo-row">
              <span class="todo-path">${escapeHtml(todo.path)}:${todo.line}</span>
              <span class="list-meta">line ${todo.line}</span>
            </div>
            <span class="todo-text">${escapeHtml(todo.text)}</span>
          </li>`
      )
      .join('');

    return `<div class="section" id="todos-left">
      <div class="section-header">
        <span class="section-label">${escapeHtml(Strings.todos.title)}</span>
        <span class="section-count">${viewModel.todos.length}</span>
      </div>
      <ul class="file-list">
        ${items}
      </ul>
    </div>`;
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
