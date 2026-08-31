import * as vscode from 'vscode';
import * as path from 'path';
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
      async (msg: { command: string; path?: string }) => {
        switch (msg.command) {
          case 'openFile':
            if (msg.path) {
              await this.handleOpenFile(msg.path);
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

  private async handleOpenFile(requestedPath: string): Promise<void> {
    try {
      let uri: vscode.Uri;
      if (path.isAbsolute(requestedPath)) {
        uri = vscode.Uri.file(requestedPath);
      } else {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
          // Try to resolve relative to first folder, or find matching folder
          const candidate = vscode.Uri.joinPath(folders[0].uri, requestedPath);
          // Check if file exists via fs stat; if not, fallback to search
          try {
            await vscode.workspace.fs.stat(candidate);
            uri = candidate;
          } catch {
            // Try absolute fallback scanning all folders
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
        // File no longer exists - still try to open, VS Code will show error
        void vscode.window.showInformationMessage(`${Strings.filesTouched.noLongerExists}: ${requestedPath}`);
        return;
      }

      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err) {
      console.warn(`[Previously On] Failed to open file ${requestedPath}: ${err}`);
      void vscode.window.showErrorMessage(`Could not open file: ${requestedPath}`);
    }
  }

  private getHtml(viewModel: SummaryViewModel): string {
    const filesHtml = this.renderFilesTouched(viewModel);
    const footerHtml = this.renderFooter();

    // Nonce for CSP if needed (not strictly required for inline scripts when enableScripts true but good practice)
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
    .file-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      cursor: pointer;
      border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground, transparent);
    }
    .file-item:last-child {
      border-bottom: none;
    }
    .file-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .file-item:active {
      background: var(--vscode-list-activeSelectionBackground);
    }
    .file-path {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-right: 12px;
    }
    .file-path::before {
      content: "📄 ";
    }
    .file-time {
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
    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
      border: 1px solid var(--vscode-button-border, transparent);
    }
    .btn-secondary:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .empty {
      padding: 12px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
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

  ${footerHtml}

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function openFile(filePath) {
      vscode.postMessage({ command: 'openFile', path: filePath });
    }
    function dismiss() {
      vscode.postMessage({ command: 'dismiss' });
    }
    function mute() {
      vscode.postMessage({ command: 'mute' });
    }
    // Attach click handlers after DOM ready
    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('.file-item[data-path]').forEach(el => {
        el.addEventListener('click', () => {
          const p = el.getAttribute('data-path');
          if (p) openFile(p);
        });
      });
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
      // M1: omit section entirely if empty (per FINAL_FLOW §5: Any section with zero items is omitted)
      return '';
    }
    const countLabel = `${viewModel.totalFiles}`;
    const items = viewModel.filesTouched
      .map(
        (f) =>
          `<li class="file-item" data-path="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}">
            <span class="file-path">${escapeHtml(f.path)}</span>
            <span class="file-time">${escapeHtml(f.relativeTime)}</span>
          </li>`
      )
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
