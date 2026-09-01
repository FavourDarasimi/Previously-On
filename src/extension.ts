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
import { SummaryWebviewPanel } from './webview/summaryWebviewPanel';
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
  const gitStatus = snapshot ? await gitStatusProvider.getStatus() : undefined;
  const todos = snapshot ? await todoScanner.scan(snapshot.touchedFiles.map((file) => file.path)) : [];

  // Decision tree (pure)
  const decision = shouldShowRecap(snapshot, { enabled, minIdleMinutes, mutedForSession }, now, gitStatus, todos);

  // If decision is to show, compose view-model and render
  if (decision.shouldShow && snapshot) {
    const viewModel = composeSummary(snapshot, gitStatus, todos, { now });
    if (viewModel && viewModel.hasContent) {
      try {
        SummaryWebviewPanel.createOrShow(context.extensionUri, viewModel, store);
      } catch (err) {
        console.warn(`[Previously On] failed to show panel: ${err}`);
      }
    } else {
      // No content to show — suppressed per FINAL_FLOW §4
      console.log('[Previously On] suppressed — no content');
    }
  } else {
    // Log reason for M1 observability (not user-visible)
    if (decision.reason === 'first_run') {
      // Optional subtle status bar hint for first run — non-blocking, dismissible
      const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
      status.text = `$(info) ${Strings.firstRunStatus}`;
      status.tooltip = 'Previously On will recap your session next time you reopen this workspace.';
      status.command = 'previouslyOn.showRecap';
      status.show();
      context.subscriptions.push(status);
      // Auto-hide after 10s
      setTimeout(() => status.dispose(), 10_000);
    }
    console.log(`[Previously On] recap suppressed: ${decision.reason}`);
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
        schemaVersion: 1 as const,
        workspaceId: computeWorkspaceId(),
        sessionEndedAt: new Date().toISOString(),
        touchedFiles: [],
        todosFound: [],
      };
      store.saveSync(fallbackSnapshot);
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
