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

        const fileChanges = [...(state.workingTreeChanges ?? []), ...(state.indexChanges ?? [])];
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

    const candidate = (change as { uri?: vscode.Uri; path?: string; fsPath?: string }).uri;
    if (candidate && 'fsPath' in candidate) {
      return candidate.fsPath;
    }

    const pathValue = (change as { path?: string; fsPath?: string }).path;
    if (pathValue) {
      return pathValue;
    }

    const fsPathValue = (change as { fsPath?: string }).fsPath;
    if (fsPathValue) {
      return fsPathValue;
    }

    return undefined;
  }

  private getChangeStatus(change: unknown): GitFileChange['status'] | undefined {
    if (!change || typeof change !== 'object') {
      return undefined;
    }

    const status = (change as { status?: number | string }).status;
    switch (status) {
      case 'ADD':
      case 'added':
      case 1:
        return 'added';
      case 'MODIFY':
      case 'modified':
      case 2:
        return 'modified';
      case 'DELETE':
      case 'deleted':
      case 3:
        return 'deleted';
      case 'RENAME':
      case 'renamed':
      case 4:
        return 'renamed';
      case 'UNTRACKED':
      case 'untracked':
      case 5:
        return 'untracked';
      default:
        return undefined;
    }
  }
}
