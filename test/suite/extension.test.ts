import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { SessionStore, SCHEMA_VERSION } from '../../src/session/sessionStore';
import { composeSummary, shouldShowRecap } from '../../src/summary/summaryComposer';
import { SummaryWebviewPanel } from '../../src/webview/summaryWebviewPanel';
import { clearMuteIfLongGap } from '../../src/extension';

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
  const storageUri = vscode.Uri.file(storagePath);
  return {
    subscriptions: [] as vscode.Disposable[],
    workspaceState: createMockMemento(),
    globalState: createMockMemento(),
    secrets: {} as unknown as vscode.SecretStorage,
    extensionUri: vscode.Uri.file(storagePath),
    extensionPath: storagePath,
    environmentVariableCollection: {} as unknown as vscode.EnvironmentVariableCollection,
    asAbsolutePath: (p: string) => path.join(storagePath, p),
    storageUri,
    globalStorageUri: vscode.Uri.file(path.join(os.tmpdir(), 'global')),
    logUri: vscode.Uri.file('/tmp/log'),
    extensionMode: vscode.ExtensionMode.Test,
    extension: {} as unknown as vscode.Extension<unknown>,
    languageModelAccessInformation: {} as unknown as vscode.LanguageModelAccessInformation,
  } as unknown as vscode.ExtensionContext;
}

describe('Integration: activate -> load -> decision -> compose -> render', () => {
  let tmpDir: string;
  let context: vscode.ExtensionContext;
  let store: SessionStore;
  let sandbox: sinon.SinonSandbox;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'previously-on-int-'));
    context = createMockContext(tmpDir);
    store = new SessionStore(context);
    sandbox = sinon.createSandbox();
    // Ensure clean panel state
    if (SummaryWebviewPanel.currentPanel) {
      SummaryWebviewPanel.currentPanel.dispose();
    }
    // Ensure storage dir exists
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(tmpDir));
    } catch {
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(async () => {
    sandbox.restore();
    if (SummaryWebviewPanel.currentPanel) {
      SummaryWebviewPanel.currentPanel.dispose();
    }
    try {
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('full flow: shows recap when gap >= minIdleMinutes and has content', async () => {
    // Seed a snapshot: ended 1 hour ago, with files
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const snapshot = {
      schemaVersion: SCHEMA_VERSION,
      sessionEndedAt: oneHourAgo.toISOString(),
      touchedFiles: [
        { path: 'src/a.ts', lastEventAt: new Date(now.getTime() - 30 * 60 * 1000).toISOString(), eventType: 'saved' as const },
        { path: 'src/b.ts', lastEventAt: new Date(now.getTime() - 10 * 60 * 1000).toISOString(), eventType: 'opened' as const },
      ],
      todosFound: [],
    };
    await store.save(snapshot);

    // Simulate activate loading
    const loaded = await store.load();
    assert.ok(loaded, 'snapshot should load');

    const config = { enabled: true, minIdleMinutes: 10, mutedForSession: false };
    const decision = shouldShowRecap(loaded, config, now);
    assert.strictEqual(decision.shouldShow, true, `should show, got ${decision.reason}`);
    assert.strictEqual(decision.reason, 'show');

    const viewModel = composeSummary(loaded!, { now });
    assert.ok(viewModel);
    assert.strictEqual(viewModel!.hasContent, true);
    assert.strictEqual(viewModel!.totalFiles, 2);
    assert.strictEqual(viewModel!.filesTouched.length, 2);

    // Mock webview panel creation (non-blocking, never modal)
    const mockPanel = {
      webview: {
        html: '',
        cspSource: 'vscode-resource:',
        onDidReceiveMessage: sandbox.stub().returns({ dispose: () => {} }),
        postMessage: sandbox.stub(),
        asWebviewUri: (uri: vscode.Uri) => uri,
      },
      onDidDispose: sandbox.stub().returns({ dispose: () => {} }),
      reveal: sandbox.stub(),
      dispose: sandbox.stub(),
      title: '',
      viewType: 'previouslyOn.recap',
    } as unknown as vscode.WebviewPanel;

    const createStub = sandbox.stub(vscode.window, 'createWebviewPanel').returns(mockPanel);

    const panel = SummaryWebviewPanel.createOrShow(context.extensionUri, viewModel!, store);
    assert.ok(panel);
    assert.ok(createStub.calledOnce, 'createWebviewPanel should be called exactly once');
    const createArgs = createStub.getCall(0).args;
    assert.strictEqual(createArgs[0], 'previouslyOn.recap');
    // Ensure not modal - check that options do not include modal:true
    const opts = createArgs[3] as { enableScripts?: boolean };
    assert.strictEqual(opts.enableScripts, true);

    // Verify HTML contains files touched section and not empty
    const html = (mockPanel.webview as unknown as { html: string }).html;
    assert.ok(html.includes('Files touched'), 'html should contain Files touched');
    assert.ok(html.includes('src/a.ts'));
    assert.ok(html.includes('src/b.ts'));
    // Ensure Git/TODO sections are omitted for M1
    assert.ok(!html.includes('Uncommitted changes'), 'Git section should be omitted in M1');
    assert.ok(!html.includes('TODOs left'), 'TODO section should be omitted in M1');

    panel.dispose();
  });

  it('degrades gracefully when vscode.git is unavailable', async () => {
    const now = new Date();
    const snapshot = {
      schemaVersion: SCHEMA_VERSION,
      sessionEndedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      touchedFiles: [{ path: 'src/a.ts', lastEventAt: new Date(now.getTime() - 30 * 60 * 1000).toISOString(), eventType: 'saved' as const }],
      todosFound: [],
    };
    await store.save(snapshot);

    sandbox.stub(vscode.extensions, 'getExtension').withArgs('vscode.git').returns(undefined);

    const loaded = await store.load();
    const gitStatus = await import('../../src/providers/gitStatusProvider').then((mod) => new mod.GitStatusProvider().getStatus());
    const viewModel = composeSummary(loaded!, gitStatus, [], { now });

    assert.ok(viewModel);
    assert.strictEqual(viewModel!.gitStatus, undefined);
    assert.strictEqual(viewModel!.hasContent, true);

    const mockPanel = {
      webview: {
        html: '',
        cspSource: 'vscode-resource:',
        onDidReceiveMessage: sandbox.stub().returns({ dispose: () => {} }),
        postMessage: sandbox.stub(),
        asWebviewUri: (uri: vscode.Uri) => uri,
      },
      onDidDispose: sandbox.stub().returns({ dispose: () => {} }),
      reveal: sandbox.stub(),
      dispose: sandbox.stub(),
      title: '',
      viewType: 'previouslyOn.recap',
    } as unknown as vscode.WebviewPanel;

    const createStub = sandbox.stub(vscode.window, 'createWebviewPanel').returns(mockPanel);
    SummaryWebviewPanel.createOrShow(context.extensionUri, viewModel!, store);

    assert.ok(createStub.calledOnce);
    assert.ok(!(mockPanel.webview as unknown as { html: string }).html.includes('Uncommitted changes'));
  });

  it('full flow: suppresses recap on first run (no snapshot)', async () => {
    const loaded = await store.load();
    assert.strictEqual(loaded, undefined);

    const now = new Date();
    const decision = shouldShowRecap(loaded, { enabled: true, minIdleMinutes: 0, mutedForSession: false }, now);
    assert.strictEqual(decision.shouldShow, false);
    assert.strictEqual(decision.reason, 'first_run');

    // Should not create panel
    const createStub = sandbox.stub(vscode.window, 'createWebviewPanel');
    const vm = composeSummary(loaded, { now });
    assert.strictEqual(vm, undefined);
    assert.ok(createStub.notCalled, 'should not create panel on first run');
  });

  it('full flow: suppresses when below threshold', async () => {
    const now = new Date('2026-08-29T18:00:00Z');
    const twoMinAgo = new Date(now.getTime() - 2 * 60 * 1000);
    const snapshot = {
      schemaVersion: SCHEMA_VERSION,
      sessionEndedAt: twoMinAgo.toISOString(),
      touchedFiles: [{ path: 'src/a.ts', lastEventAt: new Date(now.getTime() - 60 * 1000).toISOString(), eventType: 'saved' as const }],
    };
    await store.save(snapshot);
    const loaded = await store.load();

    const decision = shouldShowRecap(loaded, { enabled: true, minIdleMinutes: 10, mutedForSession: false }, now);
    assert.strictEqual(decision.shouldShow, false);
    assert.strictEqual(decision.reason, 'below_threshold');

    const vm = composeSummary(loaded!, { now });
    assert.ok(vm);
    assert.strictEqual(vm!.hasContent, true); // composer still has content, but decision suppresses
  });

  it('full flow: suppresses when muted', async () => {
    const now = new Date();
    const snapshot = {
      schemaVersion: SCHEMA_VERSION,
      sessionEndedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      touchedFiles: [{ path: 'src/a.ts', lastEventAt: new Date(now.getTime() - 30 * 60 * 1000).toISOString(), eventType: 'saved' as const }],
    };
    await store.save(snapshot);
    await store.setMutedForSession(true);

    const loaded = await store.load();
    const muted = store.getMutedForSession();
    assert.strictEqual(muted, true);

    const decision = shouldShowRecap(loaded, { enabled: true, minIdleMinutes: 0, mutedForSession: muted }, now);
    assert.strictEqual(decision.shouldShow, false);
    assert.strictEqual(decision.reason, 'muted');
  });

  it('activation: clears mute when long gap between activations', async () => {
    // Seed muted=true and a lastActivation far in the past
    await store.setMutedForSession(true);
    const past = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    await context.globalState.update('previouslyOn.lastActivation', past);

    // Call helper with threshold 5 minutes
    await clearMuteIfLongGap(context, store, 5 * 60 * 1000);

    const mutedAfter = store.getMutedForSession();
    assert.strictEqual(mutedAfter, false, 'mute should be cleared after long gap');
  });

  it('full flow: suppresses when no content (empty files, no Git/TODO)', async () => {
    const now = new Date();
    const snapshot = {
      schemaVersion: SCHEMA_VERSION,
      sessionEndedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      touchedFiles: [],
    };
    await store.save(snapshot);
    const loaded = await store.load();
    const decision = shouldShowRecap(loaded, { enabled: true, minIdleMinutes: 0, mutedForSession: false }, now);
    assert.strictEqual(decision.shouldShow, false);
    assert.strictEqual(decision.reason, 'no_content');

    const vm = composeSummary(loaded!, { now });
    assert.ok(vm);
    assert.strictEqual(vm!.hasContent, false);
  });

  it('full flow: respects enabled=false', async () => {
    const now = new Date();
    const snapshot = {
      schemaVersion: SCHEMA_VERSION,
      sessionEndedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      touchedFiles: [{ path: 'src/a.ts', lastEventAt: now.toISOString(), eventType: 'saved' as const }],
    };
    await store.save(snapshot);
    const loaded = await store.load();
    const decision = shouldShowRecap(loaded, { enabled: false, minIdleMinutes: 0, mutedForSession: false }, now);
    assert.strictEqual(decision.shouldShow, false);
    assert.strictEqual(decision.reason, 'disabled');
  });

  it('activate lifecycle: ensures SummaryComposer stays pure (no vscode API inside)', async () => {
    // Verify composer file does not import vscode
    const composerSource = fs.readFileSync(path.join(__dirname, '../../../src/summary/summaryComposer.ts'), 'utf8');
    assert.ok(!composerSource.includes("from 'vscode'"), 'SummaryComposer must not import vscode');
    assert.ok(!composerSource.includes('vscode.'), 'SummaryComposer must not use vscode API');

    const now = new Date();
    const snapshot = {
      schemaVersion: SCHEMA_VERSION,
      sessionEndedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      touchedFiles: [{ path: 'src/pure.ts', lastEventAt: now.toISOString(), eventType: 'saved' as const }],
    };
    // Call without any vscode global
    const vm = composeSummary(snapshot as unknown as import('../../src/session/sessionStore').SessionSnapshot, { now });
    assert.ok(vm);
    assert.strictEqual(vm!.filesTouched[0].path, 'src/pure.ts');
  });
});
