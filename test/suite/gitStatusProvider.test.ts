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

  it('returns empty output when vscode.git is unavailable or disabled', async () => {
    sandbox.stub(vscode.extensions, 'getExtension').withArgs('vscode.git').returns(undefined);

    const result = await new GitStatusProvider().getStatus();
    assert.strictEqual(result.hasRepository, false);
    assert.deepStrictEqual(result.changes, []);
  });
});
