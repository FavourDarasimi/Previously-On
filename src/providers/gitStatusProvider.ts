/**
 * GitStatusProvider — stub for M1.
 * In M2 this will read live status via vscode.git extension API.
 * For M1, we omit Git status from the recap entirely.
 */

export interface GitFileChange {
  path: string;
  status: 'modified' | 'added' | 'untracked' | 'renamed' | 'deleted';
}

export interface GitStatusResult {
  hasRepository: boolean;
  changes: GitFileChange[];
}

export class GitStatusProvider {
  /**
   * M1 stub: always returns no repository / empty changes.
   * Preserves interface so SummaryComposer can stay pure and future M2 can plug in.
   */
  async getStatus(): Promise<GitStatusResult> {
    return {
      hasRepository: false,
      changes: [],
    };
  }
}
