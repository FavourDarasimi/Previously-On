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
    const filesHtml = this.renderFilesTouched(viewModel);
    const gitHtml = this.renderGitStatus(viewModel);
    const todoHtml = this.renderTodos(viewModel);
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
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      padding: 16px;
      margin: 0;
      line-height: 1.5;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
      padding-bottom: 12px;
      margin-bottom: 16px;
    }
    .header h1 {
      font-size: 1.2em;
      font-weight: 600;
      margin: 0;
    }
    .subtitle {
      color: var(--vscode-descriptionForeground);
      font-size: 0.95em;
      margin-bottom: 20px;
    }
    .section {
      margin-bottom: 20px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
      border-radius: 6px;
      overflow: hidden;
    }
    .section-header {
      font-weight: 600;
      padding: 10px 12px;
      background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background));
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .section-header .count {
      font-weight: 400;
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }
    .file-list {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .file-item, .todo-item, .git-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 8px 12px;
      cursor: pointer;
      border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground, transparent);
    }
    .file-item:last-child, .todo-item:last-child, .git-item:last-child {
      border-bottom: none;
    }
    .file-item:hover, .todo-item:hover, .git-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .file-item:active, .todo-item:active, .git-item:active {
      background: var(--vscode-list-activeSelectionBackground);
    }
    .file-path, .todo-path, .git-path {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .file-path::before {
      content: "📄 ";
    }
    .file-hint {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
      white-space: nowrap;
    }
    .git-status {
      min-width: 28px;
      text-align: center;
      font-weight: 600;
      color: var(--vscode-editor-foreground);
    }
    .todo-text {
      color: var(--vscode-descriptionForeground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file-time, .todo-meta {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
      white-space: nowrap;
    }
    .more-hint {
      padding: 8px 12px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      font-size: 0.9em;
    }
    .section-actions {
      padding: 12px;
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    }
    .actions {
      display: flex;
      justify-content: flex-start;
      gap: 10px;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    }
    .btn {
      padding: 6px 14px;
      border-radius: 2px;
      border: none;
      cursor: pointer;
      font-size: 13px;
      font-family: inherit;
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
      border: 1px solid var(--vscode-button-border, transparent);
    }
    .btn-secondary:hover {
      background: var(--vscode-list-hoverBackground);
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(viewModel.title)}</h1>
    <span aria-label="close" title="Close" style="cursor:pointer; padding: 4px 8px;" onclick="dismiss()">×</span>
  </div>
  <div class="subtitle">${escapeHtml(viewModel.subtitle)}</div>

  ${filesHtml}
  ${gitHtml}
  ${todoHtml}

  ${footerHtml}

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
    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('.file-item[data-path]').forEach(el => {
        el.addEventListener('click', () => {
          const p = el.getAttribute('data-path');
          if (p) openFile(p);
        });
      });
      document.querySelectorAll('.git-item[data-path]').forEach(el => {
        el.addEventListener('click', () => {
          const p = el.getAttribute('data-path');
          if (p) openFile(p);
        });
      });
      document.querySelectorAll('.todo-item[data-path]').forEach(el => {
        el.addEventListener('click', () => {
          const p = el.getAttribute('data-path');
          const line = el.getAttribute('data-line');
          if (p && line) openTodo(p, line);
        });
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
        return `<li class="file-item" data-path="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}">
            <span class="file-path">${escapeHtml(f.path)}${hint}</span>
            <span class="file-time">${escapeHtml(f.relativeTime)}</span>
          </li>`;
      })
      .join('');

    const moreHint = viewModel.truncated
      ? `<div class="more-hint">+${viewModel.totalFiles - viewModel.filesTouched.length} more</div>`
      : '';

    return `<div class="section" id="files-touched">
      <div class="section-header">
        <span>📝 ${escapeHtml(Strings.filesTouched.title)}</span>
        <span class="count">(${countLabel})</span>
      </div>
      <ul class="file-list">
        ${items}
      </ul>
      ${moreHint}
    </div>`;
  }

  private renderGitStatus(viewModel: SummaryViewModel): string {
    if (!viewModel.gitStatus || viewModel.gitStatus.changes.length === 0) {
      return '';
    }

    const items = viewModel.gitStatus.changes
      .map(
        (change) =>
          `<li class="git-item" data-path="${escapeHtml(change.path)}" title="${escapeHtml(change.path)}">
            <span class="git-status">${escapeHtml(change.label)}</span>
            <span class="git-path">${escapeHtml(change.path)}</span>
          </li>`
      )
      .join('');

    return `<div class="section" id="uncommitted-changes">
      <div class="section-header">
        <span>🔧 ${escapeHtml(Strings.gitStatus.title)}</span>
        <span class="count">(${viewModel.gitStatus.count})</span>
      </div>
      <ul class="file-list">
        ${items}
      </ul>
      <div class="section-actions">
        <button class="btn btn-secondary" id="btn-open-scm">${escapeHtml(Strings.actions.openSourceControl)}</button>
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
          `<li class="todo-item" data-path="${escapeHtml(todo.path)}" data-line="${todo.line}" title="${escapeHtml(todo.path)}:${todo.line}">
            <span class="todo-path">${escapeHtml(todo.path)}:${todo.line}</span>
            <span class="todo-text">${escapeHtml(todo.text)}</span>
          </li>`
      )
      .join('');

    return `<div class="section" id="todos-left">
      <div class="section-header">
        <span>📌 ${escapeHtml(Strings.todos.title)}</span>
        <span class="count">(${viewModel.todos.length})</span>
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
      <button class="btn btn-secondary" id="btn-dismiss">${escapeHtml(Strings.actions.dismiss)}</button>
      <button class="btn btn-secondary" id="btn-mute">${escapeHtml(Strings.actions.muteForSession)}</button>
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
