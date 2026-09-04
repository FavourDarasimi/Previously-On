import * as vscode from 'vscode';
import { SessionSnapshot } from '../session/sessionStore';

export interface FailedTestItem {
  path?: string;
  message: string;
  severity: 'error' | 'warning' | 'test';
  line?: number;
}

export interface FailedTestsResult {
  items: FailedTestItem[];
}

export class FailedTestsProvider {
  async getFailedTests(snapshot?: SessionSnapshot): Promise<FailedTestsResult> {
    const items: FailedTestItem[] = [];

    // 1) Test runs from snapshot (recorded via tasks onDidEndTaskProcess with non-zero exit)
    if (snapshot) {
      const testRuns = (snapshot as unknown as { testRuns?: Array<{ command: string; at: string }> }).testRuns ?? [];
      for (const run of testRuns.slice(-5)) {
        // Heuristic: if command contains :1, :2 etc, it had exit code 1
        const m = run.command.match(/:(\d+)$/);
        const exitCode = m ? parseInt(m[1], 10) : undefined;
        // Consider any test run as potential failure if we have no exit code, but limit to recent
        // For determinism, treat any test task as "run" and show as info; only show as failed if exitCode !==0
        if (exitCode !== undefined && exitCode !== 0) {
          items.push({ message: `Test failed: ${run.command.replace(/:\d+$/, '')}`, severity: 'test' });
        } else if (testRuns.length > 0 && run.command.toLowerCase().includes('test')) {
          // Show last test run as context even if not failed — but only if we have few items
          // We keep it subtle: only push if no other errors and test was recent
        }
      }
    }

    // 2) Diagnostics — live errors from Problems panel (getDiagnostics)
    try {
      const diags = vscode.languages.getDiagnostics();
      for (const [uri, diagnostics] of diags) {
        for (const d of diagnostics) {
          if (d.severity === 0) { // Error
            // Only include if file is in touched set or recently active, to keep note small
            const isRelevant =
              !snapshot ||
              snapshot.touchedFiles.some((f) => uri.fsPath.endsWith(f.path) || f.path.endsWith(uri.path.split('/').pop() ?? ''));
            if (!isRelevant && items.length >= 3) continue;
            items.push({
              path: vscode.workspace.asRelativePath(uri, false) || uri.fsPath,
              message: d.message,
              severity: 'error',
              line: d.range.start.line + 1,
            });
            if (items.length >= 5) break;
          }
        }
        if (items.length >= 5) break;
      }
    } catch {
      // ignore if diagnostics not available
    }

    // 3) Fallback: if no errors but we have terminalCommands that look like failures
    if (items.length === 0 && snapshot) {
      const tcs = (snapshot as unknown as { terminalCommands?: Array<{ command: string }> }).terminalCommands ?? [];
      const last = tcs.slice(-1)[0];
      if (last && /fail|error|exception/i.test(last.command)) {
        items.push({ message: last.command, severity: 'test' });
      }
    }

    return { items: items.slice(0, 5) };
  }
}
