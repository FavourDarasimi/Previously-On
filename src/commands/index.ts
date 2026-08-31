import * as vscode from 'vscode';
import { SessionStore } from '../session/sessionStore';
import { SessionTracker } from '../session/sessionTracker';
import { SummaryWebviewPanel } from '../webview/summaryWebviewPanel';
import { composeSummary } from '../summary/summaryComposer';

export function registerCommands(
  context: vscode.ExtensionContext,
  store: SessionStore,
  tracker?: SessionTracker
): void {
  // Show Last Session Recap — on-demand, ignores idle threshold but respects enabled
  const showRecap = vscode.commands.registerCommand('previouslyOn.showRecap', async () => {
    const config = vscode.workspace.getConfiguration('previouslyOn');
    const enabled = config.get<boolean>('enabled', true);
    if (!enabled) {
      void vscode.window.showInformationMessage('Previously On is disabled (previouslyOn.enabled = false).');
      return;
    }

    const snapshot = await store.load();
    if (!snapshot) {
      void vscode.window.showInformationMessage('No previous session to recap (first run).');
      return;
    }

    // For on-demand, ignore idle threshold but still respect hasContent suppression
    const viewModel = composeSummary(snapshot, { now: new Date() });
    if (!viewModel || !viewModel.hasContent) {
      void vscode.window.showInformationMessage('No activity to recap from last session.');
      return;
    }

    SummaryWebviewPanel.createOrShow(context.extensionUri, viewModel, store);
  });

  // Mute for this session
  const muteForSession = vscode.commands.registerCommand('previouslyOn.muteForSession', async () => {
    await store.setMutedForSession(true);
    // Close current panel if open
    if (SummaryWebviewPanel.currentPanel) {
      SummaryWebviewPanel.currentPanel.dispose();
    }
    void vscode.window.showInformationMessage('Previously On muted for this session.');
  });

  // Dismiss (used internally, but also exposed as command)
  const dismissRecap = vscode.commands.registerCommand('previouslyOn.dismissRecap', () => {
    if (SummaryWebviewPanel.currentPanel) {
      SummaryWebviewPanel.currentPanel.dispose();
    }
  });

  // Optional: clear muted state (useful for testing, not exposed in package.json but handy)
  const clearMute = vscode.commands.registerCommand('previouslyOn.clearMute', async () => {
    await store.clearMutedForSession();
    void vscode.window.showInformationMessage('Previously On mute cleared.');
  });

  context.subscriptions.push(showRecap, muteForSession, dismissRecap, clearMute);

  void tracker;
}
