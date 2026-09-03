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
    /* Hallmark · pre-emit critique: P5 H4 E5 S4 R5 V5 */
    /* Hallmark · genre: modern-minimal · macrostructure: Narrative Workflow · theme: Cobalt · enrichment: none · nav: N1a · footer: Ft2 */
    :root {
      color-scheme: light dark;
      /* Locked tokens — every color / font below references these */
      --color-paper: var(--vscode-editor-background, oklch(98.5% 0.006 240));
      --color-paper-2: var(--vscode-sideBar-background, oklch(96.2% 0.012 240));
      --color-paper-3: var(--vscode-editor-inactiveSelectionBackground, oklch(94% 0.015 240));
      --color-ink: var(--vscode-editor-foreground, oklch(22% 0.02 264));
      --color-ink-2: var(--vscode-descriptionForeground, oklch(48% 0.02 264));
      --color-ink-3: var(--vscode-disabledForeground, oklch(62% 0.015 240));
      --color-rule: var(--vscode-panel-border, oklch(88% 0.015 240));
      --color-rule-strong: var(--vscode-panel-border, oklch(82% 0.02 240));
      --color-accent: oklch(58% 0.22 264);
      --color-accent-ink: oklch(100% 0 0);
      --color-accent-soft: oklch(96% 0.03 264);
      --color-focus: var(--vscode-focusBorder, oklch(58% 0.22 264));
      --color-badge-bg: var(--vscode-badge-background, oklch(92% 0.04 264));
      --color-badge-fg: var(--vscode-badge-foreground, oklch(22% 0.02 264));
      --font-display: var(--vscode-font-family, "Space Grotesk", system-ui, -apple-system, sans-serif);
      --font-body: var(--vscode-font-family, Inter, system-ui, -apple-system, sans-serif);
      --font-mono: var(--vscode-editor-font-family, "JetBrains Mono", ui-monospace, monospace);
      --space-3xs: 0.25rem;
      --space-2xs: 0.5rem;
      --space-xs: 0.75rem;
      --space-sm: 1rem;
      --space-md: 1.5rem;
      --space-lg: 2rem;
      --space-xl: 3rem;
      --space-2xl: 4.5rem;
      --text-xs: 0.75rem;
      --text-sm: 0.875rem;
      --text-md: 1rem;
      --text-lg: 1.125rem;
      --text-xl: 1.5rem;
      --text-display: clamp(1.35rem, 3.5vw, 1.85rem);
      --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
      --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
      --dur-short: 180ms;
      --dur-mid: 260ms;
      --radius-sm: 4px;
      --radius-md: 6px;
      --radius-pill: 999px;
    }

    html, body {
      overflow-x: clip;
      min-width: 0;
    }
    * {
      box-sizing: border-box;
    }
    body {
      font-family: var(--font-body);
      font-size: var(--vscode-font-size, 13px);
      color: var(--color-ink);
      background: var(--color-paper);
      padding: 0;
      margin: 0;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }
    .panel {
      max-width: 560px;
      margin: 0 auto;
      padding: 16px 16px 20px;
      min-width: 0;
    }

    /* ── Hero ── */
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-2xs);
      padding: 14px 0 18px;
      border-bottom: 2px solid var(--color-rule-strong);
      margin-bottom: var(--space-sm);
    }
    .hero__top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-sm);
    }
    .hero__kicker {
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.09em;
      text-transform: uppercase;
      color: var(--color-accent);
      line-height: 1;
    }
    .hero__title {
      font-family: var(--font-display);
      font-size: var(--text-display);
      font-weight: 700;
      font-style: normal;
      letter-spacing: -0.025em;
      line-height: 1.05;
      color: var(--color-ink);
      margin: 2px 0 0;
      overflow-wrap: anywhere;
      min-width: 0;
    }
    .hero__subtitle {
      display: inline-flex;
      max-width: 100%;
      align-items: center;
      gap: 6px;
      margin-top: 6px;
      padding: 5px 10px;
      background: var(--color-accent-soft);
      border: 1px solid color-mix(in oklch, var(--color-accent) 18%, transparent);
      border-radius: var(--radius-pill);
      font-family: var(--font-mono);
      font-size: 11px;
      line-height: 1.3;
      color: var(--color-ink-2);
      overflow-wrap: anywhere;
      min-width: 0;
    }
    .hero__dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--color-accent);
      flex-shrink: 0;
    }

    /* ── Workflow ── */
    .workflow {
      display: grid;
      gap: 0;
    }
    .stage {
      position: relative;
      display: grid;
      gap: var(--space-xs);
      padding: 14px 0 16px 22px;
      margin-left: 7px;
      border-left: 2px solid var(--color-rule);
      min-width: 0;
    }
    .stage:first-of-type {
      border-left-color: var(--color-accent);
    }
    .stage:last-of-type {
      border-left-color: transparent;
      /* keep alignment but fade */
      border-left-color: var(--color-rule);
      padding-bottom: 4px;
    }
    .stage__rail {
      position: absolute;
      left: -9px;
      top: 16px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--color-paper);
      border: 2px solid var(--color-rule-strong);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-family: var(--font-mono);
      font-size: 7px;
      font-weight: 800;
      letter-spacing: 0.02em;
      color: var(--color-ink-3);
      line-height: 1;
    }
    .stage--active .stage__rail {
      background: var(--color-accent);
      border-color: var(--color-accent);
      color: var(--color-accent-ink);
    }
    .stage__head {
      display: flex;
      align-items: baseline;
      gap: var(--space-xs);
      min-width: 0;
      flex-wrap: wrap;
    }
    .stage__kicker {
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.085em;
      text-transform: uppercase;
      color: var(--color-accent);
      white-space: nowrap;
    }
    .stage__title {
      font-family: var(--font-display);
      font-size: 13px;
      font-weight: 650;
      font-style: normal;
      letter-spacing: -0.01em;
      color: var(--color-ink);
      line-height: 1.2;
      overflow-wrap: anywhere;
      min-width: 0;
    }
    .stage__count {
      margin-left: auto;
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: var(--color-ink-2);
      background: var(--color-paper-2);
      border: 1px solid var(--color-rule);
      padding: 2px 7px;
      border-radius: var(--radius-pill);
      white-space: nowrap;
    }
    .stage__meta {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--color-ink-3);
      margin-top: -2px;
      overflow-wrap: anywhere;
      min-width: 0;
    }

    .file-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .file-item, .todo-item, .git-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 7px 8px;
      border-radius: var(--radius-md);
      cursor: pointer;
      outline: none;
      border: 1px solid transparent;
      background: transparent;
      min-width: 0;
      transition: background var(--dur-short) var(--ease-out), border-color var(--dur-short) var(--ease-out), transform 120ms var(--ease-out);
    }
    .file-item:hover, .todo-item:hover, .git-item:hover {
      background: var(--color-paper-2);
      border-color: var(--color-rule);
    }
    .file-item:focus-visible, .todo-item:focus-visible, .git-item:focus-visible,
    .btn:focus-visible, .close-button:focus-visible, .btn-ghost:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: 2px;
    }
    .file-item:active, .todo-item:active, .git-item:active {
      transform: translateY(1px);
      background: var(--color-paper-3);
    }
    .file-path, .todo-path, .git-path {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.35;
    }
    .file-path {
      color: var(--color-ink);
      font-weight: 500;
    }
    .file-path.missing {
      color: var(--color-ink-3);
      text-decoration: line-through;
      text-decoration-thickness: 1px;
    }
    .file-hint,
    .file-time,
    .todo-meta,
    .list-meta {
      font-family: var(--font-mono);
      color: var(--color-ink-3);
      font-size: 11px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .file-time {
      background: var(--color-paper-2);
      border: 1px solid var(--color-rule);
      padding: 1px 6px;
      border-radius: var(--radius-pill);
      font-size: 10px;
    }
    .git-status {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 28px;
      height: 20px;
      padding: 0 6px;
      border-radius: var(--radius-pill);
      background: var(--color-badge-bg);
      color: var(--color-badge-fg);
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.04em;
      flex-shrink: 0;
      border: 1px solid color-mix(in oklch, var(--color-rule) 80%, transparent);
    }
    .git-path,
    .todo-path {
      color: var(--color-ink);
    }
    .todo-item {
      flex-direction: column;
      align-items: stretch;
      gap: 4px;
      padding: 8px 8px;
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
      color: var(--color-ink);
      font-weight: 600;
    }
    .todo-text {
      font-family: var(--font-body);
      color: var(--color-ink-2);
      font-size: 12.5px;
      line-height: 1.45;
      overflow-wrap: anywhere;
      min-width: 0;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .more-hint {
      padding-top: 6px;
      font-family: var(--font-mono);
      color: var(--color-ink-3);
      font-size: 11px;
    }
    .actions {
      display: flex;
      justify-content: flex-start;
      gap: 8px;
      margin-top: 6px;
      padding-top: 14px;
      border-top: 1px solid var(--color-rule);
      flex-wrap: wrap;
    }
    .btn, .btn-ghost, .close-button {
      font-family: var(--font-body);
      font-weight: 600;
      white-space: nowrap;
    }
    .btn {
      appearance: none;
      border: 1px solid var(--color-accent);
      border-radius: var(--radius-pill);
      background: var(--color-accent);
      color: var(--color-accent-ink);
      padding: 7px 14px;
      font-size: 12.5px;
      line-height: 1;
      cursor: pointer;
      transition: transform 120ms var(--ease-out), background var(--dur-short) var(--ease-out), border-color var(--dur-short) var(--ease-out);
      min-height: 32px;
    }
    .btn:hover {
      transform: translateY(-1px);
      background: color-mix(in oklch, var(--color-accent) 92%, black);
    }
    .btn:active {
      transform: translateY(0px);
    }
    .btn-ghost {
      appearance: none;
      border: 1px solid var(--color-rule-strong);
      border-radius: var(--radius-pill);
      background: var(--color-paper);
      color: var(--color-ink);
      padding: 7px 14px;
      font-size: 12.5px;
      line-height: 1;
      cursor: pointer;
      min-height: 32px;
      transition: background var(--dur-short) var(--ease-out), border-color var(--dur-short) var(--ease-out);
    }
    .btn-ghost:hover {
      background: var(--color-paper-2);
      border-color: var(--color-ink-3);
    }
    .close-button {
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--color-rule);
      border-radius: var(--radius-pill);
      background: var(--color-paper);
      color: var(--color-ink-2);
      cursor: pointer;
      flex-shrink: 0;
      transition: background var(--dur-short) var(--ease-out), color var(--dur-short) var(--ease-out);
    }
    .close-button:hover {
      background: var(--color-paper-2);
      color: var(--color-ink);
    }
    .section-actions {
      margin-top: 8px;
    }
    .btn-scm {
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.02em;
    }
    /* Grouped multi-root */
    .group-block {
      border: 1px solid var(--color-rule);
      border-radius: var(--radius-md);
      padding: 10px 10px 8px;
      background: color-mix(in oklch, var(--color-paper) 96%, var(--color-paper-2));
      margin-bottom: 10px;
    }
    .group-block__head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      padding-bottom: 8px;
      border-bottom: 1px dashed var(--color-rule);
    }
    .group-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--color-accent);
      flex-shrink: 0;
    }
    .group-name {
      font-family: var(--font-display);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: -0.01em;
      color: var(--color-ink);
    }
    .group-empty {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--color-ink-3);
    }

    @media (max-width: 768px) {
      .panel { padding-inline: clamp(12px, 4vw, 16px); }
      .hero__title { font-size: clamp(1.25rem, 5vw, 1.7rem); }
      .stage { padding-left: 18px; }
    }
    @media (max-width: 414px) {
      .stage__head { gap: 6px; }
      .file-item, .git-item { padding: 8px 8px; }
      .actions { gap: 6px; }
      .btn, .btn-ghost { flex: 1 1 auto; justify-content: center; }
    }
    @media (max-width: 375px) {
      .hero__subtitle { font-size: 10.5px; }
    }
    @media (max-width: 320px) {
      .panel { padding-inline: 12px; }
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
    <div class="hero">
      <div class="hero__top">
        <span class="hero__kicker">Previously on · Session recap</span>
        <button type="button" class="close-button" aria-label="Close recap" title="Close" onclick="dismiss()">×</button>
      </div>
      <h1 class="hero__title">${escapeHtml(viewModel.title)}</h1>
      <div class="hero__subtitle"><span class="hero__dot" aria-hidden="true"></span>${escapeHtml(viewModel.subtitle)}</div>
    </div>
 
    <div class="workflow">
      ${filesHtml}
      ${gitHtml}
      ${todoHtml}
    </div>
 
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

    return `<section class="stage stage--active" id="files-touched" aria-label="Files touched">
      <span class="stage__rail" aria-hidden="true">01</span>
      <div class="stage__head">
        <span class="stage__kicker">01 · Files</span>
        <h2 class="stage__title">${escapeHtml(Strings.filesTouched.title)}</h2>
        <span class="stage__count">${countLabel}</span>
      </div>
      <ul class="file-list">
        ${items}
      </ul>
      ${moreHint}
    </section>`;
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

    // Helper to find folder for a path – falls back to first folder to avoid dropping items in multi-root
    const findFolderName = (p: string): string | undefined => {
      if (path.isAbsolute(p)) {
        for (const f of folders) {
          const rawBase = f.uri.fsPath;
          const base = rawBase.endsWith(path.sep) ? rawBase.slice(0, -1) : rawBase;
          if (p === base || p.startsWith(base + path.sep)) {
            return f.name;
          }
        }
        // Fallback: absolute path outside known roots – assign to first folder rather than dropping
        // Also try case-insensitive / normalized check for Windows
        for (const f of folders) {
          const baseLower = f.uri.fsPath.toLowerCase();
          const pLower = p.toLowerCase();
          const baseNorm = baseLower.endsWith(path.sep) ? baseLower.slice(0, -1) : baseLower;
          if (pLower === baseNorm || pLower.startsWith(baseNorm + path.sep)) {
            return f.name;
          }
        }
        return folders[0]?.name;
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
        // Fallback: assign relative paths to first folder when existence check fails (file deleted/untracked)
        return folders[0]?.name;
      }
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
        html += `<div class="group-block" aria-label="folder-${escapeHtml(name)}"><div class="group-block__head"><span class="group-dot" aria-hidden="true"></span><span class="group-name">${escapeHtml(name)}</span><span class="group-empty">(empty)</span></div></div>`;
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

      html += `<div class="group-block" aria-label="folder-${escapeHtml(name)}">
        <div class="group-block__head"><span class="group-dot" aria-hidden="true"></span><span class="group-name">${escapeHtml(name)}</span></div>
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

    return `<section class="stage" id="uncommitted-changes" aria-label="Uncommitted changes">
      <span class="stage__rail" aria-hidden="true">02</span>
      <div class="stage__head">
        <span class="stage__kicker">02 · Changes</span>
        <h2 class="stage__title">${escapeHtml(Strings.gitStatus.title)}</h2>
        <span class="stage__count">${viewModel.gitStatus.count}</span>
      </div>
      <ul class="file-list">
        ${items}
      </ul>
      <div class="section-actions">
        <button class="btn-ghost btn-scm" id="btn-open-scm" type="button">${escapeHtml(Strings.actions.openSourceControl)}</button>
      </div>
    </section>`;
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

    return `<section class="stage" id="todos-left" aria-label="TODOs left">
      <span class="stage__rail" aria-hidden="true">03</span>
      <div class="stage__head">
        <span class="stage__kicker">03 · Todos</span>
        <h2 class="stage__title">${escapeHtml(Strings.todos.title)}</h2>
        <span class="stage__count">${viewModel.todos.length}</span>
      </div>
      <ul class="file-list">
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
      <button class="btn-ghost" id="btn-dismiss" type="button">${escapeHtml(Strings.actions.dismiss)}</button>
      <button class="btn" id="btn-mute" type="button">${escapeHtml(Strings.actions.muteForSession)}</button>
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
