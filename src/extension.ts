import * as vscode from 'vscode';
import { SessionStore, computeWorkspaceId } from './session/sessionStore';

// Exported helper: clears muted flag when last activation gap exceeds threshold
export async function clearMuteIfLongGap(context: vscode.ExtensionContext, store: SessionStore, thresholdMs = 5 * 60 * 1000): Promise<void> {
  const lastActivation = context.globalState.get<number>('previouslyOn.lastActivation');
  const nowMs = Date.now();
  if (lastActivation && nowMs - lastActivation > thresholdMs) {
    await store.clearMutedForSession();
  }
  await context.globalState.update('previouslyOn.lastActivation', nowMs);
}

import { SessionTracker } from './session/sessionTracker';
import { GitStatusProvider } from './providers/gitStatusProvider';
import { TodoScanner } from './providers/todoScanner';
import { FailedTestsProvider } from './providers/failedTestsProvider';
import { SummaryWebviewPanel } from './webview/summaryWebviewPanel';
import { SummaryPopover } from './webview/summaryPopover';
import { composeSummary, shouldShowRecap } from './summary/summaryComposer';
import { registerCommands } from './commands';
import { Strings } from './strings';

let tracker: SessionTracker | undefined;
let store: SessionStore | undefined;

/**
 * Activate is called on `onStartupFinished` per package.json.
 * It must not do slow/blocking work before VS Code's own restore.
 * We load snapshot, run decision tree, render if needed, start tracking.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  store = new SessionStore(context);

  // Register commands early so they are available even if recap is suppressed
  // We will init tracker before registering to pass it in
  tracker = new SessionTracker(store);

  registerCommands(context, store, tracker);

  // Permanent status-bar item — tiny, always visible, click to open recap
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '$(circle-filled) Previously On';
  statusBar.tooltip = 'Open last session recap';
  statusBar.command = 'previouslyOn.showRecap';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Load snapshot (async but fast — JSON file bounded by touched files)
  let snapshot: Awaited<ReturnType<SessionStore['load']>>;
  try {
    snapshot = await store.load();
  } catch (err) {
    console.warn(`[Previously On] load snapshot failed: ${err}`);
    snapshot = undefined;
  }

  // Read configuration
  const config = vscode.workspace.getConfiguration('previouslyOn');
  const enabled = config.get<boolean>('enabled', true);
  const minIdleMinutes = config.get<number>('minIdleMinutes', 0);
  const todoTags = config.get<string>('todoTags', 'TODO|FIXME|HACK');
  // Determine whether muted should be cleared due to a long gap between activations.
  // Use a persisted last-activation timestamp in globalState to distinguish Reload Window
  // (short gap) from a real close+reopen (long gap). Threshold chosen: 5 minutes.
  const mutedForSession = store.getMutedForSession();
  void clearMuteIfLongGap(context, store, 5 * 60 * 1000).catch((err) => {
    console.warn(`[Previously On] activation: failed to evaluate session boundary: ${err}`);
  });


  const now = new Date();
  const gitStatusProvider = new GitStatusProvider();
  const todoScanner = new TodoScanner({ todoTags });
  const failedTestsProvider = new FailedTestsProvider();
  const gitStatus = snapshot ? await gitStatusProvider.getStatus() : undefined;
  const todos = snapshot ? await todoScanner.scan(snapshot.touchedFiles.map((file) => file.path)) : [];
  const failedTestsRes = snapshot ? await failedTestsProvider.getFailedTests(snapshot) : { items: [] };
  const failedTests = failedTestsRes.items;

  // Decision tree (pure)
  const decision = shouldShowRecap(snapshot, { enabled, minIdleMinutes, mutedForSession }, now, gitStatus, todos, failedTests);

  // If decision is to show, compose view-model and render as popover (not full-screen webview)
  if (decision.shouldShow && snapshot) {
    const viewModel = composeSummary(snapshot, gitStatus, todos, failedTests, { now });
    if (viewModel && viewModel.hasContent) {
      try {
        const pop = SummaryPopover.show(viewModel, store);
        // Fallback to webview if popover could not be shown (e.g., in tests without QuickPick stub)
        if (!pop) {
          SummaryWebviewPanel.createOrShow(context.extensionUri, viewModel, store);
        }
      } catch (err) {
        console.warn(`[Previously On] failed to show popover: ${err}`);
        try {
          SummaryWebviewPanel.createOrShow(context.extensionUri, viewModel, store);
        } catch (_e) {
          // ignore fallback failure
        }
      }
    } else {
      // No content to show — suppressed per FINAL_FLOW §4
      console.log('[Previously On] suppressed — no content');
    }
  } else {
    console.log(`[Previously On] recap suppressed: ${decision.reason}`);
  }

  // Background refresh for git discovery race: git may not be ready at onStartupFinished.
  // If initial git was empty, re-query shortly and show popover if fresh data has content.
  if (snapshot && enabled && !mutedForSession) {
    const initialHasGit = !!gitStatus?.hasRepository && (gitStatus?.changes.length ?? 0) > 0;
    if (!initialHasGit) {
      const bgTimer = setTimeout(async () => {
        try {
          if (!store || !snapshot) return;
          if (store.getMutedForSession()) return;
          // Don't re-show if a popover or panel is already visible
          if (SummaryPopover.current || SummaryWebviewPanel.currentPanel) return;
          const freshGit = await new GitStatusProvider().getStatus();
          const freshFailedRes = await new FailedTestsProvider().getFailedTests(snapshot);
          const freshFailed = freshFailedRes.items;
          const hasFreshGit = !!freshGit?.hasRepository && (freshGit?.changes.length ?? 0) > 0;
          const hasFreshFailed = freshFailed.length > 0;
          if (!hasFreshGit && !hasFreshFailed) return;
          const freshTodos = await new TodoScanner({ todoTags }).scan(snapshot.touchedFiles.map((file) => file.path));
          const freshNow = new Date();
          const gapMs = freshNow.getTime() - new Date(snapshot.sessionEndedAt).getTime();
          if (gapMs < minIdleMinutes * 60 * 1000) return;
          const freshDecision = shouldShowRecap(snapshot, { enabled, minIdleMinutes, mutedForSession: false }, freshNow, freshGit, freshTodos, freshFailed);
          if (!freshDecision.shouldShow) return;
          const freshVm = composeSummary(snapshot, freshGit, freshTodos, freshFailed, { now: freshNow });
          if (!freshVm?.hasContent) return;
          try {
              const pop = SummaryPopover.show(freshVm, store);
              if (!pop) SummaryWebviewPanel.createOrShow(context.extensionUri, freshVm, store);
            } catch (err) {
              console.warn(`[Previously On] background create popover failed: ${err}`);
              try {
                SummaryWebviewPanel.createOrShow(context.extensionUri, freshVm, store);
              } catch (_e) {
                // ignore
              }
            }
        } catch (err) {
          console.warn(`[Previously On] background git refresh failed: ${err}`);
        }
      }, 1200);
      if (typeof (bgTimer as unknown as { unref?: () => void }).unref === 'function') {
        (bgTimer as unknown as { unref: () => void }).unref();
      }
    }
  }

  // Start tracking the new session regardless of whether recap was shown
  // Push tracker disposables to context.subscriptions
  try {
    tracker.start(context.subscriptions);
    context.subscriptions.push(tracker);
  } catch (err) {
    console.warn(`[Previously On] failed to start tracker: ${err}`);
  }

  // Also track workspaceId for completeness (not strictly needed for M1 but persists)
  // Ensure storageUri exists for future saves
  try {
    if (context.storageUri) {
      await vscode.workspace.fs.createDirectory(context.storageUri);
    }
    // Ensure snapshot has workspaceId if missing — will be set on next flush
    void computeWorkspaceId();
  } catch {
    // ignore
  }
}

export function deactivate(): void {
  // Synchronous flush — VS Code allows a short sync window
  try {
    if (tracker) {
      tracker.flushSync();
    } else if (store) {
      // Fallback if tracker not initialized
      const fallbackSnapshot = {
        schemaVersion: 2 as const,
        workspaceId: computeWorkspaceId(),
        sessionEndedAt: new Date().toISOString(),
        touchedFiles: [],
        todosFound: [],
        cursorPositions: [],
        symbolEdits: [],
        visitCounts: {},
        terminalCommands: [],
        testRuns: [],
        gitBranch: undefined,
        lastActiveFile: undefined,
      };
      store.saveSync(fallbackSnapshot as unknown as import('./session/sessionStore').SessionSnapshot);
    }
  } catch (err) {
    console.warn(`[Previously On] deactivate flush failed: ${err}`);
  }

  // Previously the muted flag was cleared unconditionally on deactivate which
  // caused Reload Window to also clear the mute. M3 refines this behavior: the
  // mute is now cleared on activation when a long gap (see activate) is detected.
  // Avoid clearing here to preserve mute across Reload Window.

  // Dispose tracker
  try {
    tracker?.dispose();
  } catch {
    // ignore
  }
  tracker = undefined;
  store = undefined;
}

// Exported for testing
export function getTrackerForTesting(): SessionTracker | undefined {
  return tracker;
}
export function getStoreForTesting(): SessionStore | undefined {
  return store;
}
