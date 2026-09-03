import * as vscode from 'vscode';
import * as path from 'path';
import { SummaryViewModel } from '../summary/viewModel';
import { SessionStore } from '../session/sessionStore';
import { Strings } from '../strings';

/**
 * SummaryPopover — QuickPick-based popover that appears at startup.
 * It does NOT take the whole editor area like a WebviewPanel.
 * Uses native VS Code QuickPick (centered popover) with separators and inline actions.
 * Keeps the same viewModel as the webview, but rendered as native list with VS Code theme tokens.
 * Falls back to no-op if QuickPick is not available (e.g. in tests without stub).
 */
export class SummaryPopover {
  public static current: vscode.QuickPick<vscode.QuickPickItem> | undefined;

  public static show(viewModel: SummaryViewModel, store?: SessionStore): vscode.QuickPick<vscode.QuickPickItem> | undefined {
    // Dismiss any existing popover
    try {
      SummaryPopover.current?.hide();
      SummaryPopover.current?.dispose();
    } catch {
      // ignore
    }

    let quickPick: vscode.QuickPick<vscode.QuickPickItem>;
    try {
      quickPick = vscode.window.createQuickPick();
    } catch {
      return undefined;
    }
    SummaryPopover.current = quickPick;

    const canUseSeparators =
      typeof (vscode as unknown as { QuickPickItemKind?: { Separator: number } }).QuickPickItemKind?.Separator === 'number';

    // Title / placeholder — active voice, specific, no middot/ALL-CAPS eyebrow
    quickPick.title = `${viewModel.title} — ${viewModel.subtitle}`;
    quickPick.placeholder = 'Pick a file to reopen, or choose an action below';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.canSelectMany = false;
    quickPick.ignoreFocusOut = false;

    // Buttons: Dismiss and Mute — use ThemeIcon without decorative accent
    const dismissButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('close'),
      tooltip: Strings.actions.dismiss,
    };
    const muteButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('mute'),
      tooltip: Strings.actions.muteForSession,
    };
    const scmButton: vscode.QuickInputButton | undefined = viewModel.gitStatus
      ? { iconPath: new vscode.ThemeIcon('source-control'), tooltip: Strings.actions.openSourceControl }
      : undefined;

    quickPick.buttons = scmButton ? [scmButton, dismissButton, muteButton] : [dismissButton, muteButton];

    // Build items — three explicit sections: Files touched, Uncommitted changes, TODOs
    const items: vscode.QuickPickItem[] = [];

    const gitIconFor = (status: string): string => {
      switch (status) {
        case 'modified':
          return '$(edit)';
        case 'added':
          return '$(add)';
        case 'deleted':
          return '$(trash)';
        case 'untracked':
          return '$(question)';
        case 'renamed':
          return '$(arrow-right)';
        default:
          return '$(circle-outline)';
      }
    };

    const hasFiles = viewModel.filesTouched.length > 0;
    const hasGit = !!viewModel.gitStatus && viewModel.gitStatus.count > 0;

    // 0) What were you doing? — deterministic activity summary at top
    if (viewModel.activity) {
      if (canUseSeparators) {
        items.push({
          label: Strings.activity.title,
          kind: (vscode as unknown as { QuickPickItemKind: { Separator: number } }).QuickPickItemKind.Separator,
        } as vscode.QuickPickItem);
      }
      const act = viewModel.activity;
      // Main intent as label, details as description, flow as detail — all plain text, no decorative accent
      items.push({
        label: act.intent,
        description: act.details ?? '',
        detail: act.flow.length > 0 ? act.flow.join(' → ') : undefined,
      } as vscode.QuickPickItem & { _path?: string; _line?: number });
      if (act.focusFile) {
        const last = items[items.length - 1] as unknown as { _path: string; _line?: number };
        last._path = act.focusFile.path;
        if (act.focusFile.line !== undefined) last._line = act.focusFile.line + 1;
      }
    }

    // 1) Files touched — changed files from last session
    if (hasFiles) {
      if (canUseSeparators) {
        items.push({
          label: Strings.filesTouched.title,
          kind: (vscode as unknown as { QuickPickItemKind: { Separator: number } }).QuickPickItemKind.Separator,
        } as vscode.QuickPickItem);
      }
      for (const f of viewModel.filesTouched) {
        const missing = f.path.includes('no longer exists') ? '' : '';
        void missing;
        items.push({
          label: `$(file) ${f.path}`,
          description: f.relativeTime,
          detail: undefined,
        } as vscode.QuickPickItem & { _path: string });
        (items[items.length - 1] as unknown as { _path: string })._path = f.path;
      }
      if (viewModel.truncated) {
        items.push({
          label: `+${viewModel.totalFiles - viewModel.filesTouched.length} more files not shown`,
          description: '',
          detail: undefined,
        } as vscode.QuickPickItem);
      }
    }

    // 2) Uncommitted files — live git status (always separate so user sees both)
    if (hasGit) {
      if (canUseSeparators) {
        items.push({
          label: Strings.gitStatus.title,
          kind: (vscode as unknown as { QuickPickItemKind: { Separator: number } }).QuickPickItemKind.Separator,
        } as vscode.QuickPickItem);
      }
      for (const c of viewModel.gitStatus!.changes) {
        // Show relative path for readability
        let displayPath = c.path;
        const folders = vscode.workspace.workspaceFolders ?? [];
        for (const folder of folders) {
          const base = folder.uri.fsPath;
          if (c.path === base || c.path.startsWith(base + path.sep)) {
            displayPath = path.relative(base, c.path);
            break;
          }
        }
        items.push({
          label: `${gitIconFor(c.status)} ${displayPath}`,
          description: `${c.label} ${c.status}`,
          detail: undefined,
        } as vscode.QuickPickItem & { _path: string });
        (items[items.length - 1] as unknown as { _path: string })._path = c.path;
      }
      // Inline action to open SCM — keeps primary action one click away
      const count = viewModel.gitStatus!.count;
      const noun = count === 1 ? 'file has changes' : 'files have changes';
      items.push({
        label: `$(source-control) Open Source Control`,
        description: `${count} ${noun} to review`,
        detail: undefined,
      } as vscode.QuickPickItem & { _action: 'openSCM' });
      (items[items.length - 1] as unknown as { _action: string })._action = 'openSCM';
    }

    // TODOs — separate section because they are code locations, not file status
    if (viewModel.todos && viewModel.todos.length > 0) {
      if (canUseSeparators) {
        items.push({
          label: Strings.todos.title,
          kind: (vscode as unknown as { QuickPickItemKind: { Separator: number } }).QuickPickItemKind.Separator,
        } as vscode.QuickPickItem);
      }
      for (const todo of viewModel.todos) {
        // Path:line is code, so keep mono-like detail; label is file
        items.push({
          label: `$(comment) ${todo.path}:${todo.line}`,
          description: todo.tag,
          detail: todo.text,
        } as vscode.QuickPickItem & { _path: string; _line: number });
        const last = items[items.length - 1] as unknown as { _path: string; _line: number };
        last._path = todo.path;
        last._line = todo.line;
      }
    }

    quickPick.items = items as vscode.QuickPickItem[];

    // Selection handler — one click opens file / todo / SCM
    const toDispose: vscode.Disposable[] = [];
    toDispose.push(
      quickPick.onDidAccept(async () => {
        const selected = quickPick.selectedItems[0] as unknown as { _path?: string; _line?: number; _action?: string; label?: string } | undefined;
        if (!selected) return;
        if (selected._action === 'openSCM') {
          await vscode.commands.executeCommand('workbench.view.scm');
          return;
        }
        // Ignore separator / more hint
        if (!selected._path) return;
        // Determine if it's a todo (has line)
        if (typeof selected._line === 'number') {
          await openPath(selected._path, selected._line);
        } else {
          await openPath(selected._path);
        }
        quickPick.hide();
      })
    );

    toDispose.push(
      quickPick.onDidTriggerButton(async (button) => {
        if (button.tooltip === Strings.actions.dismiss) {
          quickPick.hide();
        } else if (button.tooltip === Strings.actions.muteForSession) {
          if (store) await store.setMutedForSession(true);
          quickPick.hide();
        } else if (button.tooltip === Strings.actions.openSourceControl) {
          await vscode.commands.executeCommand('workbench.view.scm');
        }
      })
    );

    toDispose.push(
      quickPick.onDidHide(() => {
        for (const d of toDispose) {
          try {
            d.dispose();
          } catch (_e) {
            // ignore
          }
        }
        try {
          quickPick.dispose();
        } catch (_e) {
          // ignore
        }
        if (SummaryPopover.current === quickPick) SummaryPopover.current = undefined;
      })
    );

    quickPick.show();
    return quickPick;
  }
}

async function openPath(requestedPath: string, lineNumber?: number): Promise<void> {
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
        } catch (_e) {
          let found: vscode.Uri | undefined;
          for (const folder of folders) {
            const p = vscode.Uri.joinPath(folder.uri, requestedPath);
            try {
              await vscode.workspace.fs.stat(p);
              found = p;
              break;
            } catch (_e2) {
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
    const opts: vscode.TextDocumentShowOptions = { preview: false };
    if (typeof lineNumber === 'number' && Number.isFinite(lineNumber) && lineNumber > 0) {
      const start = new vscode.Position(Math.max(0, lineNumber - 1), 0);
      opts.selection = new vscode.Selection(start, start);
    }
    await vscode.window.showTextDocument(doc, opts);
  } catch (err) {
    console.warn(`[Previously On] Failed to open file ${requestedPath}: ${err}`);
    void vscode.window.showErrorMessage(`Could not open file: ${requestedPath}`);
  }
}
