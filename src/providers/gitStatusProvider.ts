import * as vscode from 'vscode';

export interface GitFileChange {
  path: string;
  status: 'modified' | 'added' | 'untracked' | 'renamed' | 'deleted';
}

export interface GitStatusResult {
  hasRepository: boolean;
  changes: GitFileChange[];
}

export class GitStatusProvider {
  async getStatus(): Promise<GitStatusResult> {
    try {
      const gitExtension = vscode.extensions.getExtension('vscode.git');
      if (!gitExtension) {
        return { hasRepository: false, changes: [] };
      }

      if (!gitExtension.isActive) {
        await gitExtension.activate();
      }

      const api = gitExtension.exports && typeof gitExtension.exports.getAPI === 'function'
        ? gitExtension.exports.getAPI(1)
        : undefined;

      if (!api || !Array.isArray(api.repositories)) {
        return { hasRepository: false, changes: [] };
      }

      const changes: GitFileChange[] = [];
      const seen = new Set<string>();

      for (const repository of api.repositories) {
        const state = repository?.state;
        if (!state) {
          continue;
        }

        const fileChanges = [
          ...(state.workingTreeChanges ?? []),
          ...(state.indexChanges ?? []),
          ...((state as unknown as { mergeChanges?: unknown[] }).mergeChanges ?? []),
        ];
        for (const change of fileChanges) {
          const path = this.getChangePath(change);
          if (!path || seen.has(path)) {
            continue;
          }

          const status = this.getChangeStatus(change);
          if (!status) {
            continue;
          }

          changes.push({ path, status });
          seen.add(path);
        }
      }

      return {
        hasRepository: api.repositories.length > 0,
        changes,
      };
    } catch {
      return { hasRepository: false, changes: [] };
    }
  }

  private getChangePath(change: unknown): string | undefined {
    if (!change || typeof change !== 'object') {
      return undefined;
    }

    const c = change as {
      uri?: vscode.Uri;
      resourceUri?: vscode.Uri;
      originalUri?: vscode.Uri;
      path?: string;
      fsPath?: string;
    };

    const candidate = c.resourceUri ?? c.uri;
    if (candidate && typeof candidate === 'object' && 'fsPath' in candidate) {
      return (candidate as vscode.Uri).fsPath;
    }

    if (c.path) {
      return c.path;
    }

    if (c.fsPath) {
      return c.fsPath;
    }

    return undefined;
  }

  private getChangeStatus(change: unknown): GitFileChange['status'] | undefined {
    if (!change || typeof change !== 'object') {
      return undefined;
    }

    const raw = change as { status?: number | string; statusString?: string };
    const status: unknown = raw.status ?? raw.statusString;

    if (typeof status === 'string') {
      const s = status.toUpperCase();
      switch (s) {
        case 'INDEX_MODIFIED':
        case 'MODIFIED':
        case 'MODIFY':
        case 'M':
          return 'modified';
        case 'INDEX_ADDED':
        case 'ADDED':
        case 'ADD':
        case 'A':
          return 'added';
        case 'INDEX_DELETED':
        case 'DELETED':
        case 'DELETE':
        case 'D':
          return 'deleted';
        case 'INDEX_RENAMED':
        case 'RENAMED':
        case 'RENAME':
        case 'R':
          return 'renamed';
        case 'INDEX_COPIED':
        case 'COPIED':
          return 'added';
        case 'UNTRACKED':
        case '??':
          return 'untracked';
        case 'INTENT_TO_ADD':
          return 'added';
        case 'IGNORED':
        case '!!':
          return undefined;
        default:
          if (s === 'MODIFIED' || s.includes('MODIFIED')) return 'modified';
          return undefined;
      }
    }

    if (typeof status === 'number') {
      switch (status) {
        case 0: // INDEX_MODIFIED
        case 5: // MODIFIED
        case 16: // BOTH_MODIFIED
          return 'modified';
        case 1: // INDEX_ADDED
        case 4: // INDEX_COPIED
        case 9: // INTENT_TO_ADD
        case 10: // ADDED_BY_US
        case 11: // ADDED_BY_THEM
        case 14: // BOTH_ADDED
          return 'added';
        case 2: // INDEX_DELETED
        case 6: // DELETED
        case 12: // DELETED_BY_US
        case 13: // DELETED_BY_THEM
        case 15: // BOTH_DELETED
          return 'deleted';
        case 3: // INDEX_RENAMED
          return 'renamed';
        case 7: // UNTRACKED
          return 'untracked';
        case 8: // IGNORED
          return undefined;
        default:
          return 'modified';
      }
    }

    return undefined;
  }
}
