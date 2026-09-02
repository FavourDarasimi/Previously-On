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

      if (!api) {
        return { hasRepository: false, changes: [] };
      }

      // Support both api.repositories array and api.getRepository per folder (for delayed discovery)
      let repositories: unknown[] = [];
      if (Array.isArray(api.repositories)) {
        repositories = api.repositories;
      }

      // Fallback: if repositories empty but getRepository exists, try to resolve per workspace folder
      if (repositories.length === 0 && typeof (api as unknown as { getRepository?: (uri: vscode.Uri) => unknown }).getRepository === 'function') {
        try {
          const folders = vscode.workspace.workspaceFolders ?? [];
          for (const folder of folders) {
            try {
              const repo = (api as unknown as { getRepository: (uri: vscode.Uri) => unknown }).getRepository(folder.uri);
              if (repo) {
                repositories.push(repo);
              }
            } catch {
              // ignore per-folder lookup errors
            }
          }
        } catch {
          // ignore fallback errors
        }
      }

      // Startup race: git may not have discovered repos yet at onStartupFinished – brief poll (max ~750ms)
      if (repositories.length === 0) {
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
          if (Array.isArray(api.repositories) && api.repositories.length > 0) {
            repositories = api.repositories;
            break;
          }
          if (typeof (api as unknown as { getRepository?: (uri: vscode.Uri) => unknown }).getRepository === 'function') {
            try {
              const folders = vscode.workspace.workspaceFolders ?? [];
              const found: unknown[] = [];
              for (const folder of folders) {
                try {
                  const repo = (api as unknown as { getRepository: (uri: vscode.Uri) => unknown }).getRepository(folder.uri);
                  if (repo) {
                    found.push(repo);
                  }
                } catch {
                  // ignore
                }
              }
              if (found.length > 0) {
                repositories = found;
                break;
              }
            } catch {
              // ignore
            }
          }
        }
      }

      if (!Array.isArray(repositories)) {
        return { hasRepository: false, changes: [] };
      }

      const changes: GitFileChange[] = [];
      const seen = new Set<string>();

      for (const repository of repositories) {
        const state = (repository as { state?: unknown })?.state as
          | {
              workingTreeChanges?: unknown[];
              indexChanges?: unknown[];
              mergeChanges?: unknown[];
              untrackedChanges?: unknown[];
            }
          | undefined;
        if (!state) {
          continue;
        }

        const fileChanges = [
          ...(state.workingTreeChanges ?? []),
          ...(state.indexChanges ?? []),
          ...((state as unknown as { mergeChanges?: unknown[] }).mergeChanges ?? []),
          ...((state as unknown as { untrackedChanges?: unknown[] }).untrackedChanges ?? []),
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

      const hasRepository = Array.isArray(api.repositories)
        ? api.repositories.length > 0
        : repositories.length > 0;

      return {
        hasRepository,
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
      uri?: vscode.Uri | string;
      resourceUri?: vscode.Uri | string;
      originalUri?: vscode.Uri;
      path?: string;
      fsPath?: string;
    };

    const candidate = c.resourceUri ?? c.uri;
    if (candidate) {
      if (typeof candidate === 'string') {
        return candidate;
      }
      if (typeof candidate === 'object' && 'fsPath' in candidate) {
        const fsPath = (candidate as vscode.Uri).fsPath;
        if (typeof fsPath === 'string' && fsPath.length > 0) {
          return fsPath;
        }
      }
      // Some ResourceState shapes expose `path` on Uri-like object
      if (typeof candidate === 'object' && 'path' in candidate) {
        const maybePath = (candidate as { path?: unknown }).path;
        if (typeof maybePath === 'string' && maybePath.length > 0) {
          // Uri.path is not fsPath; prefer fsPath but fallback to path
          // We still try to return fsPath if available above; this is fallback
        }
      }
    }

    if (typeof c.path === 'string' && c.path.length > 0) {
      return c.path;
    }

    if (typeof c.fsPath === 'string' && c.fsPath.length > 0) {
      return c.fsPath;
    }

    // Fallback: some older Resource shapes expose `resourceUri` as string path
    const asAny = c as unknown as { resource?: string; uriString?: string };
    if (typeof asAny.resource === 'string' && asAny.resource.length > 0) {
      return asAny.resource;
    }
    if (typeof asAny.uriString === 'string' && asAny.uriString.length > 0) {
      return asAny.uriString;
    }

    return undefined;
  }

  private getChangeStatus(change: unknown): GitFileChange['status'] | undefined {
    if (!change || typeof change !== 'object') {
      return undefined;
    }

    const raw = change as {
      status?: number | string;
      statusString?: string;
      type?: number | string;
      letter?: string;
    };
    // ApiChange.status vs Resource.type vs legacy letter
    const status: unknown = raw.status ?? raw.type ?? raw.statusString ?? raw.letter;

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
