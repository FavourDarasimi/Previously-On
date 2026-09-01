import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { GitStatusProvider } from '../../src/providers/gitStatusProvider';

describe('GitStatusProvider', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('reads workingTreeChanges and indexChanges from the vscode.git API', async () => {
    const repo = {
      state: {
        workingTreeChanges: [
          { uri: vscode.Uri.file('/workspace/src/a.ts'), status: 'MODIFY' },
          { uri: vscode.Uri.file('/workspace/src/b.ts'), status: 'UNTRACKED' },
        ],
        indexChanges: [
          { uri: vscode.Uri.file('/workspace/src/c.ts'), status: 'ADD' },
          { uri: vscode.Uri.file('/workspace/src/a.ts'), status: 'MODIFY' },
        ],
      },
    };

    sandbox.stub(vscode.extensions, 'getExtension').withArgs('vscode.git').returns({
      isActive: true,
      exports: {
        getAPI: () => ({ repositories: [repo] }),
      },
    } as unknown as vscode.Extension<unknown>);

    const result = await new GitStatusProvider().getStatus();

    assert.strictEqual(result.hasRepository, true);
    assert.strictEqual(result.changes.length, 3);
    assert.deepStrictEqual(
      result.changes.map((change) => change.path).sort(),
      ['/workspace/src/a.ts', '/workspace/src/b.ts', '/workspace/src/c.ts']
    );
    assert.strictEqual(result.changes.find((change) => change.path === '/workspace/src/a.ts')?.status, 'modified');
    assert.strictEqual(result.changes.find((change) => change.path === '/workspace/src/b.ts')?.status, 'untracked');
    assert.strictEqual(result.changes.find((change) => change.path === '/workspace/src/c.ts')?.status, 'added');
  });

  it('activates the vscode.git extension before reading status', async () => {
    const repo = {
      state: {
        workingTreeChanges: [{ uri: vscode.Uri.file('/workspace/src/dirty.ts'), status: 'MODIFY' }],
        indexChanges: [],
      },
    };

    const activateStub = sandbox.stub().resolves();
    sandbox.stub(vscode.extensions, 'getExtension').withArgs('vscode.git').returns({
      isActive: false,
      activate: activateStub,
      exports: {
        getAPI: () => ({ repositories: [repo] }),
      },
    } as unknown as vscode.Extension<unknown>);

    const result = await new GitStatusProvider().getStatus();

    assert.strictEqual(activateStub.calledOnce, true);
    assert.strictEqual(result.hasRepository, true);
    assert.strictEqual(result.changes.length, 1);
    assert.strictEqual(result.changes[0].path, '/workspace/src/dirty.ts');
  });

  it('handles numeric Status enum values and resourceUri', async () => {
    const repo = {
      state: {
        workingTreeChanges: [
          { resourceUri: vscode.Uri.file('/workspace/src/num.ts'), status: 5 },
          { resourceUri: vscode.Uri.file('/workspace/src/untracked.ts'), status: 7 },
        ],
        indexChanges: [{ resourceUri: vscode.Uri.file('/workspace/src/added.ts'), status: 1 }],
      },
    };

    sandbox.stub(vscode.extensions, 'getExtension').withArgs('vscode.git').returns({
      isActive: true,
      exports: {
        getAPI: () => ({ repositories: [repo] }),
      },
    } as unknown as vscode.Extension<unknown>);

    const result = await new GitStatusProvider().getStatus();

    assert.strictEqual(result.changes.length, 3);
    assert.strictEqual(result.changes.find((c) => c.path === '/workspace/src/num.ts')?.status, 'modified');
    assert.strictEqual(result.changes.find((c) => c.path === '/workspace/src/untracked.ts')?.status, 'untracked');
    assert.strictEqual(result.changes.find((c) => c.path === '/workspace/src/added.ts')?.status, 'added');
  });

  it('returns empty output when vscode.git is unavailable or disabled', async () => {
    sandbox.stub(vscode.extensions, 'getExtension').withArgs('vscode.git').returns(undefined);

    const result = await new GitStatusProvider().getStatus();
    assert.strictEqual(result.hasRepository, false);
    assert.deepStrictEqual(result.changes, []);
  });
});
