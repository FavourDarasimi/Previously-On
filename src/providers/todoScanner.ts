import * as vscode from 'vscode';

export interface TodoItem {
  path: string;
  line: number;
  text: string;
  tag: string;
}

export interface TodoScannerOptions {
  todoTags?: string[] | string;
}

export class TodoScanner {
  constructor(private readonly options?: TodoScannerOptions) {}

  async scan(touchedPaths: string[]): Promise<TodoItem[]> {
    if (!touchedPaths || touchedPaths.length === 0) {
      return [];
    }

    const todoPattern = this.parseTodoPattern();
    const regex = new RegExp(`\\b(?:${todoPattern})\\b`, 'gi');
    const results: TodoItem[] = [];

    for (const touchedPath of touchedPaths) {
      const uri = await this.resolveUri(touchedPath);
      if (!uri) {
        continue;
      }

      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        const lines = text.split(/\r?\n/);

        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          const match = line.match(regex);
          if (!match || match.length === 0) {
            continue;
          }

          const tag = match[0].toUpperCase();
          const textValue = line.trim();
          results.push({
            path: touchedPath,
            line: index + 1,
            text: textValue,
            tag,
          });
        }
      } catch {
        continue;
      }
    }

    return results;
  }

  private parseTodoPattern(): string {
    const tags = Array.isArray(this.options?.todoTags)
      ? this.options.todoTags
      : typeof this.options?.todoTags === 'string'
        ? this.options.todoTags.split('|')
        : ['TODO', 'FIXME', 'HACK'];

    const normalized = tags
      .filter((tag) => tag && tag.trim().length > 0)
      .map((tag) => tag.trim())
      .map((tag) => this.escapeRegExp(tag))
      .join('|');

    return normalized || 'TODO|FIXME|HACK';
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async resolveUri(pathValue: string): Promise<vscode.Uri | undefined> {
    if (!pathValue) {
      return undefined;
    }

    const candidate = pathValue.startsWith('/') || pathValue.startsWith('\\')
      ? vscode.Uri.file(pathValue)
      : undefined;

    if (candidate) {
      try {
        await vscode.workspace.fs.stat(candidate);
        return candidate;
      } catch {
        return undefined;
      }
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const joined = vscode.Uri.joinPath(folder.uri, pathValue);
      try {
        await vscode.workspace.fs.stat(joined);
        return joined;
      } catch {
        continue;
      }
    }

    return undefined;
  }
}
