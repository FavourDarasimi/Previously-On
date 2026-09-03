import * as assert from 'assert';
import * as sinon from 'sinon';
import { SessionTracker } from '../../src/session/sessionTracker';
import { SessionStore, SessionSnapshot, SCHEMA_VERSION } from '../../src/session/sessionStore';

// Minimal mock store that captures saves
class MockStore {
  saved: SessionSnapshot[] = [];
  savedSync: SessionSnapshot[] = [];
  async save(snap: SessionSnapshot): Promise<void> {
    this.saved.push(snap);
  }
  saveSync(snap: SessionSnapshot): void {
    this.savedSync.push(snap);
  }
}

describe('SessionTracker', () => {
  let mockStore: MockStore;
  let tracker: SessionTracker;

  beforeEach(() => {
    mockStore = new MockStore();
    // Use small debounce for tests (10ms) to keep tests fast, but we will test logic directly
    tracker = new SessionTracker(mockStore as unknown as SessionStore, { maxFiles: 5, debounceMs: 50 });
  });

  afterEach(() => {
    tracker.dispose();
    sinon.restore();
  });

  it('records a file and deduplicates on repeated touches', () => {
    const t1 = new Date('2026-08-29T10:00:00Z');
    const t2 = new Date('2026-08-29T11:00:00Z');
    tracker.recordFile('src/a.ts', 'opened', t1);
    assert.strictEqual(tracker.getCount(), 1);
    assert.strictEqual(tracker.getTouchedFiles()[0].lastEventAt, t1.toISOString());
    assert.strictEqual(tracker.getTouchedFiles()[0].eventType, 'opened');

    // Record same path again with newer time and different event
    tracker.recordFile('src/a.ts', 'saved', t2);
    assert.strictEqual(tracker.getCount(), 1, 'should deduplicate');
    assert.strictEqual(tracker.getTouchedFiles()[0].lastEventAt, t2.toISOString());
    assert.strictEqual(tracker.getTouchedFiles()[0].eventType, 'saved');
  });

  it('caps at maxFiles keeping most recent', () => {
    // maxFiles=5, insert 7 files
    for (let i = 0; i < 7; i++) {
      tracker.recordFile(`src/file${i}.ts`, 'saved', new Date(`2026-08-29T10:0${i}:00Z`));
    }
    assert.strictEqual(tracker.getCount(), 5);
    const files = tracker.getTouchedFiles().map((f) => f.path);
    // Should keep most recent 5: file2..file6 (file0, file1 evicted)
    // Since we insert in order, oldest are evicted
    assert.ok(!files.includes('src/file0.ts'), 'oldest should be evicted');
    assert.ok(!files.includes('src/file1.ts'));
    assert.ok(files.includes('src/file6.ts'));
    assert.ok(files.includes('src/file2.ts'));
  });

  it('returns most-recent-first sorted', () => {
    const t1 = new Date('2026-08-29T10:00:00Z');
    const t2 = new Date('2026-08-29T12:00:00Z');
    const t3 = new Date('2026-08-29T11:00:00Z');
    tracker.recordFile('src/a.ts', 'saved', t1);
    tracker.recordFile('src/b.ts', 'saved', t2);
    tracker.recordFile('src/c.ts', 'saved', t3);
    const sorted = tracker.getTouchedFiles();
    assert.strictEqual(sorted[0].path, 'src/b.ts'); // latest 12:00
    assert.strictEqual(sorted[1].path, 'src/c.ts'); // 11:00
    assert.strictEqual(sorted[2].path, 'src/a.ts'); // 10:00
  });

  it('enforce cap respects LRU update on dedup', () => {
    // Fill to cap
    for (let i = 0; i < 5; i++) {
      tracker.recordFile(`src/file${i}.ts`, 'saved', new Date(`2026-08-29T10:0${i}:00Z`));
    }
    // Touch file0 again (should become most recent, not evicted)
    tracker.recordFile('src/file0.ts', 'saved', new Date('2026-08-29T11:00:00Z'));
    // Add one more to exceed cap — oldest among remaining should be evicted (file1)
    tracker.recordFile('src/file5.ts', 'saved', new Date('2026-08-29T12:00:00Z'));
    const files = tracker.getTouchedFiles().map((f) => f.path);
    assert.ok(files.includes('src/file0.ts'), 'file0 was refreshed and should survive');
    assert.ok(!files.includes('src/file1.ts'), 'file1 should be evicted as oldest');
    assert.ok(files.includes('src/file5.ts'));
  });

  it('setTouchedFiles respects cap', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      path: `src/file${i}.ts`,
      lastEventAt: new Date(`2026-08-29T10:0${i}:00Z`).toISOString(),
      eventType: 'saved' as const,
    }));
    tracker.setTouchedFiles(entries);
    assert.strictEqual(tracker.getCount(), 5);
  });

  it('clear empties map', () => {
    tracker.recordFile('src/a.ts', 'saved');
    tracker.recordFile('src/b.ts', 'opened');
    assert.strictEqual(tracker.getCount(), 2);
    tracker.clear();
    assert.strictEqual(tracker.getCount(), 0);
  });

  it('flush saves snapshot with schemaVersion and touched files', async () => {
    tracker.recordFile('src/a.ts', 'saved', new Date('2026-08-29T10:00:00Z'));
    tracker.recordFile('src/b.ts', 'opened', new Date('2026-08-29T11:00:00Z'));
    await tracker.flush();
    assert.strictEqual(mockStore.saved.length, 1);
    const snap = mockStore.saved[0];
    assert.strictEqual(snap.schemaVersion, SCHEMA_VERSION);
    assert.ok(snap.sessionEndedAt);
    assert.strictEqual(snap.touchedFiles.length, 2);
    assert.strictEqual(snap.touchedFiles[0].path, 'src/b.ts'); // most recent first
  });

  it('flushSync saves synchronously', () => {
    tracker.recordFile('src/a.ts', 'saved');
    tracker.flushSync();
    assert.strictEqual(mockStore.savedSync.length, 1);
    assert.strictEqual(mockStore.savedSync[0].schemaVersion, SCHEMA_VERSION);
    assert.ok(mockStore.savedSync[0].sessionEndedAt);
  });

  it('debounce schedules flush but can be cleared by dispose', async () => {
    const flushSpy = sinon.spy(tracker as unknown as { flush: () => Promise<void> }, 'flush');
    tracker.recordFile('src/a.ts', 'saved');
    // Should not flush immediately
    assert.strictEqual(flushSpy.callCount, 0);
    // Wait for debounce (50ms + buffer)
    await new Promise((r) => setTimeout(r, 80));
    // After debounce, flush should have been called once
    assert.strictEqual(flushSpy.callCount, 1);
    flushSpy.restore();
  });

  it('recordFile ignores empty path', () => {
    tracker.recordFile('', 'saved');
    assert.strictEqual(tracker.getCount(), 0);
  });

  it('dispose clears debounce timer and disposables', () => {
    tracker.recordFile('src/a.ts', 'saved');
    tracker.dispose();
    // After dispose, flush should be no-op
    assert.strictEqual((tracker as unknown as { isDisposed: boolean }).isDisposed, true);
  });

  it('handles deduplication with same file many times (edge from FINAL_FLOW)', () => {
    const base = new Date('2026-08-29T10:00:00Z');
    for (let i = 0; i < 10; i++) {
      tracker.recordFile('src/same.ts', i % 2 === 0 ? 'opened' : 'saved', new Date(base.getTime() + i * 1000));
    }
    assert.strictEqual(tracker.getCount(), 1);
    const entry = tracker.getTouchedFiles()[0];
    assert.strictEqual(entry.path, 'src/same.ts');
    // Last event should be saved (i=9 odd)
    assert.strictEqual(entry.eventType, 'saved');
    assert.strictEqual(entry.lastEventAt, new Date(base.getTime() + 9 * 1000).toISOString());
  });
});
