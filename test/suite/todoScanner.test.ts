import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TodoScanner } from '../../src/providers/todoScanner';

describe('TodoScanner', () => {
  const root = path.resolve(__dirname, '../../..');
  const fixtureDir = path.join(root, 'test', 'fixtures', 'todo-scan');

  beforeEach(async () => {
    await fs.promises.mkdir(fixtureDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(fixtureDir, 'a.ts'),
      ['const x = 1;', '// TODO: handle retry', 'function y() {', '  // FIXME: cleanup', '}', ''].join('\n'),
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(fixtureDir, 'b.ts'),
      ['// HACK: quick patch', 'export const z = 2;', ''].join('\n'),
      'utf8'
    );
    await fs.promises.writeFile(
      path.join(fixtureDir, 'c.ts'),
      ['const ok = true;', ''].join('\n'),
      'utf8'
    );
  });

  afterEach(async () => {
    await fs.promises.rm(fixtureDir, { recursive: true, force: true });
  });

  it('scans only touched files and matches configured TODO tags', async () => {
    const scanner = new TodoScanner({ todoTags: 'TODO|FIXME|HACK' });
    const items = await scanner.scan([
      'test/fixtures/todo-scan/a.ts',
      'test/fixtures/todo-scan/b.ts',
      'test/fixtures/todo-scan/c.ts',
    ]);

    assert.strictEqual(items.length, 3);
    assert.strictEqual(items[0].path, 'test/fixtures/todo-scan/a.ts');
    assert.strictEqual(items[0].line, 2);
    assert.strictEqual(items[0].tag, 'TODO');
    assert.strictEqual(items[1].path, 'test/fixtures/todo-scan/a.ts');
    assert.strictEqual(items[1].line, 4);
    assert.strictEqual(items[1].tag, 'FIXME');
    assert.strictEqual(items[2].path, 'test/fixtures/todo-scan/b.ts');
    assert.strictEqual(items[2].tag, 'HACK');
  });

  it('ignores missing files and only returns real TODO matches', async () => {
    const scanner = new TodoScanner({ todoTags: ['TODO', 'FIXME'] });
    const items = await scanner.scan([
      'test/fixtures/todo-scan/a.ts',
      'test/fixtures/todo-scan/does-not-exist.ts',
    ]);

    assert.ok(items.every((item) => item.path === 'test/fixtures/todo-scan/a.ts'));
    assert.strictEqual(items.length, 2);
  });
});
