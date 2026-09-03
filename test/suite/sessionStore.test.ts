import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { SessionStore, SCHEMA_VERSION, SessionSnapshot } from '../../src/session/sessionStore';

function createMockMemento(): vscode.Memento & { _map: Map<string, unknown> } {
  const m = {
    _map: new Map<string, unknown>(),
    keys(): string[] {
      return [...this._map.keys()];
    },
    get<T>(key: string, defaultValue?: T): T | undefined {
      if (this._map.has(key)) {
        return this._map.get(key) as T;
      }
      return defaultValue as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) {
        this._map.delete(key);
      } else {
        this._map.set(key, value);
      }
    },
  };
  return m as unknown as vscode.Memento & { _map: Map<string, unknown> };
}

function createMockContext(storagePath: string): vscode.ExtensionContext {
  const globalState = createMockMemento();
  const workspaceState = createMockMemento();
  const storageUri = vscode.Uri.file(storagePath);
  return {
    subscriptions: [],
    workspaceState,
    globalState,
    secrets: {} as unknown as vscode.SecretStorage,
    extensionUri: vscode.Uri.file('/tmp'),
    extensionPath: '/tmp',
    environmentVariableCollection: {} as unknown as vscode.EnvironmentVariableCollection,
    asAbsolutePath: (p: string) => path.join('/tmp', p),
    storageUri,
    globalStorageUri: vscode.Uri.file(path.join(os.tmpdir(), 'global')),
    logUri: vscode.Uri.file('/tmp/log'),
    extensionMode: vscode.ExtensionMode.Test,
    extension: {} as unknown as vscode.Extension<unknown>,
    languageModelAccessInformation: {} as unknown as vscode.LanguageModelAccessInformation,
  } as unknown as vscode.ExtensionContext;
}

describe('SessionStore', () => {
  let tmpDir: string;
  let context: vscode.ExtensionContext;
  let store: SessionStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'previously-on-test-'));
    context = createMockContext(tmpDir);
    store = new SessionStore(context);
    // Ensure storage dir exists for workspace.fs operations
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(tmpDir));
    } catch {
      // Fallback to Node fs
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
    }
  });

  afterEach(async () => {
    try {
      // Clean up via Node fs (since vscode.workspace.fs.delete may not handle outside workspace)
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  it('load returns undefined on first run (no snapshot)', async () => {
    const snap = await store.load();
    assert.strictEqual(snap, undefined);
  });

  it('save and load round-trip preserves schemaVersion and touched files', async () => {
    const snapshot: SessionSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      workspaceId: 'ws-123',
      sessionEndedAt: new Date('2026-08-29T18:00:00Z').toISOString(),
      touchedFiles: [
        { path: 'src/a.ts', lastEventAt: new Date('2026-08-29T17:00:00Z').toISOString(), eventType: 'saved' },
        { path: 'src/b.ts', lastEventAt: new Date('2026-08-29T17:30:00Z').toISOString(), eventType: 'opened' },
      ],
      todosFound: [],
    };
    await store.save(snapshot);
    const loaded = await store.load();
    assert.ok(loaded);
    assert.strictEqual(loaded!.schemaVersion, SCHEMA_VERSION);
    assert.strictEqual(loaded!.workspaceId, 'ws-123');
    assert.strictEqual(loaded!.sessionEndedAt, snapshot.sessionEndedAt);
    assert.strictEqual(loaded!.touchedFiles.length, 2);
    assert.strictEqual(loaded!.touchedFiles[0].path, 'src/a.ts');
  });

  it('saveSync writes synchronously and can be loaded', async () => {
    const snapshot: SessionSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      sessionEndedAt: new Date().toISOString(),
      touchedFiles: [{ path: 'src/c.ts', lastEventAt: new Date().toISOString(), eventType: 'activated' }],
    };
    store.saveSync(snapshot);
    // Brief delay to ensure file written
    await new Promise((r) => setTimeout(r, 10));
    const loaded = await store.load();
    assert.ok(loaded);
    assert.strictEqual(loaded!.touchedFiles[0].path, 'src/c.ts');
  });

  it('load handles corrupt JSON gracefully (returns undefined, not throw)', async () => {
    // Write corrupt file directly via Node fs
    const filePath = path.join(tmpDir, 'session.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{ corrupt json', 'utf8');
    const loaded = await store.load();
    // Should treat as first run, not throw
    assert.strictEqual(loaded, undefined);
  });

  it('load handles empty touchedFiles as valid', async () => {
    const snapshot: SessionSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      sessionEndedAt: new Date().toISOString(),
      touchedFiles: [],
    };
    await store.save(snapshot);
    const loaded = await store.load();
    assert.ok(loaded);
    assert.strictEqual(loaded!.touchedFiles.length, 0);
    assert.strictEqual(loaded!.hasOwnProperty('schemaVersion'), true);
  });

  it('schemaVersion exists from day one', async () => {
    const snapshot: SessionSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      sessionEndedAt: new Date().toISOString(),
      touchedFiles: [],
    };
    await store.save(snapshot);
    const loaded = await store.load();
    assert.ok(loaded);
    assert.strictEqual(loaded!.schemaVersion, SCHEMA_VERSION);
  });

  it('muted flag persists via workspaceState', async () => {
    assert.strictEqual(store.getMutedForSession(), false);
    await store.setMutedForSession(true);
    assert.strictEqual(store.getMutedForSession(), true);
    await store.setMutedForSession(false);
    assert.strictEqual(store.getMutedForSession(), false);
  });

  it('clear removes snapshot and muted flag', async () => {
    const snapshot: SessionSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      sessionEndedAt: new Date().toISOString(),
      touchedFiles: [{ path: 'src/a.ts', lastEventAt: new Date().toISOString(), eventType: 'saved' }],
    };
    await store.save(snapshot);
    await store.setMutedForSession(true);
    await store.clear();
    const loaded = await store.load();
    // After clear, fallback to workspaceState which was cleared, so undefined
    // But note load may return fallback with empty touchedFiles if workspaceState still has sessionEndedAt?
    // Our clear deletes both, so undefined
    assert.strictEqual(loaded, undefined);
    assert.strictEqual(store.getMutedForSession(), false);
  });

  it('persists to storageUri file with JSON formatting', async () => {
    const snapshot: SessionSnapshot = {
      schemaVersion: SCHEMA_VERSION,
      sessionEndedAt: new Date('2026-08-29T18:42:00Z').toISOString(),
      touchedFiles: [{ path: 'src/auth/login.ts', lastEventAt: new Date('2026-08-29T18:40:11Z').toISOString(), eventType: 'saved' }],
      todosFound: [],
    };
    await store.save(snapshot);
    const filePath = path.join(tmpDir, 'session.json');
    assert.ok(fs.existsSync(filePath), 'session.json should exist');
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.schemaVersion, SCHEMA_VERSION);
    assert.strictEqual(parsed.touchedFiles[0].path, 'src/auth/login.ts');
  });

  it('workspaceState fallback when file missing but meta exists', async () => {
    // Simulate old behavior where only workspaceState had data
    const fakeMeta = { sessionEndedAt: new Date().toISOString(), workspaceId: 'ws-fallback' };
    await context.workspaceState.update('previouslyOn.snapshotMeta', fakeMeta);
    // Create a new store that will try file first, then fallback
    const freshContext = createMockContext(path.join(os.tmpdir(), 'nonexistent-' + Date.now()));
    // Share workspaceState directly (so fallback can find meta)
    (freshContext as unknown as { workspaceState: vscode.Memento }).workspaceState = context.workspaceState;
    const freshStore = new SessionStore(freshContext);
    // Ensure storageUri points to non-existent dir, so load falls back
    const loaded = await freshStore.load();
    assert.ok(loaded);
    assert.strictEqual(loaded!.sessionEndedAt, fakeMeta.sessionEndedAt);
  });
});
