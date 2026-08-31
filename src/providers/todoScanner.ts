/**
 * TodoScanner — stub for M1.
 * In M2 this will scan touched files for TODO/FIXME/HACK comments.
 */

export interface TodoItem {
  path: string;
  line: number;
  text: string;
  tag: string;
}

export interface TodoScannerOptions {
  todoTags?: string[]; // e.g., ['TODO','FIXME','HACK']
}

export class TodoScanner {
  constructor(private readonly options?: TodoScannerOptions) {}

  /**
   * M1 stub: returns empty list.
   * Signature preserved for M2: will accept file paths and read via workspace.fs.readFile.
   */
  async scan(touchedPaths: string[]): Promise<TodoItem[]> {
    void touchedPaths;
    void this.options;
    return [];
  }
}
