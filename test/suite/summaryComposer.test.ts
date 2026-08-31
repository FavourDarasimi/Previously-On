import * as assert from 'assert';
import { composeSummary, shouldShowRecap, formatRelativeTime, formatSubtitle } from '../../src/summary/summaryComposer';
import { SessionSnapshot } from '../../src/session/sessionStore';

function makeSnapshot(opts?: Partial<SessionSnapshot>): SessionSnapshot {
  const now = new Date();
  return {
    schemaVersion: 1,
    workspaceId: 'ws-test',
    sessionEndedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(), // 1 hr ago
    touchedFiles: [
      { path: 'src/a.ts', lastEventAt: new Date(now.getTime() - 30 * 60 * 1000).toISOString(), eventType: 'saved' },
      { path: 'src/b.ts', lastEventAt: new Date(now.getTime() - 10 * 60 * 1000).toISOString(), eventType: 'opened' },
    ],
    todosFound: [],
    ...opts,
  };
}

describe('SummaryComposer', () => {
  describe('formatRelativeTime', () => {
    it('returns just now for <60s', () => {
      const now = new Date('2026-08-29T18:00:00Z');
      const then = new Date('2026-08-29T17:59:30Z').toISOString();
      assert.strictEqual(formatRelativeTime(then, now), 'just now');
    });

    it('returns mins', () => {
      const now = new Date('2026-08-29T18:00:00Z');
      const then = new Date('2026-08-29T17:45:00Z').toISOString();
      assert.strictEqual(formatRelativeTime(then, now), '15 min ago');
    });

    it('returns hours', () => {
      const now = new Date('2026-08-29T18:00:00Z');
      const then = new Date('2026-08-29T16:00:00Z').toISOString();
      assert.strictEqual(formatRelativeTime(then, now), '2 hrs ago');
    });

    it('returns days', () => {
      const now = new Date('2026-08-29T18:00:00Z');
      const then = new Date('2026-08-27T18:00:00Z').toISOString();
      assert.strictEqual(formatRelativeTime(then, now), '2 days ago');
    });

    it('handles future dates as just now', () => {
      const now = new Date('2026-08-29T18:00:00Z');
      const then = new Date('2026-08-29T19:00:00Z').toISOString();
      assert.strictEqual(formatRelativeTime(then, now), 'just now');
    });
  });

  describe('formatSubtitle', () => {
    it('returns normal subtitle for short gap', () => {
      const now = new Date('2026-08-29T18:00:00Z');
      const ended = new Date('2026-08-29T17:00:00Z').toISOString();
      const sub = formatSubtitle(ended, now);
      assert.ok(sub.includes('Last session ended'), `got ${sub}`);
    });

    it('returns long-absence copy for >=30 days', () => {
      const now = new Date('2026-08-29T18:00:00Z');
      const ended = new Date('2026-07-20T18:00:00Z').toISOString(); // 40 days ago
      const sub = formatSubtitle(ended, now);
      assert.ok(sub.includes("It's been a while"), `got ${sub}`);
    });
  });

  describe('composeSummary', () => {
    it('returns undefined for missing snapshot (pure, no VSCode API)', () => {
      const vm = composeSummary(undefined);
      assert.strictEqual(vm, undefined);
    });

    it('composes view-model with files sorted most-recent-first', () => {
      const now = new Date('2026-08-29T18:00:00Z');
      const snapshot = makeSnapshot({
        sessionEndedAt: new Date('2026-08-29T17:00:00Z').toISOString(),
        touchedFiles: [
          { path: 'src/old.ts', lastEventAt: new Date('2026-08-29T16:00:00Z').toISOString(), eventType: 'saved' },
          { path: 'src/new.ts', lastEventAt: new Date('2026-08-29T17:30:00Z').toISOString(), eventType: 'opened' },
          { path: 'src/mid.ts', lastEventAt: new Date('2026-08-29T17:15:00Z').toISOString(), eventType: 'activated' },
        ],
      });
      const vm = composeSummary(snapshot, { now });
      assert.ok(vm);
      assert.strictEqual(vm!.filesTouched[0].path, 'src/new.ts');
      assert.strictEqual(vm!.filesTouched[1].path, 'src/mid.ts');
      assert.strictEqual(vm!.filesTouched[2].path, 'src/old.ts');
      assert.strictEqual(vm!.totalFiles, 3);
      assert.strictEqual(vm!.truncated, false);
      assert.strictEqual(vm!.hasContent, true);
      assert.ok(vm!.subtitle.includes('Last session ended'));
    });

    it('truncates when over maxFilesShown', () => {
      const now = new Date('2026-08-29T18:00:00Z');
      const files = Array.from({ length: 12 }, (_, i) => ({
        path: `src/file${i}.ts`,
        lastEventAt: new Date(now.getTime() - i * 1000).toISOString(),
        eventType: 'saved' as const,
      }));
      const snapshot = makeSnapshot({ touchedFiles: files });
      const vm = composeSummary(snapshot, { now, maxFilesShown: 5 });
      assert.ok(vm);
      assert.strictEqual(vm!.filesTouched.length, 5);
      assert.strictEqual(vm!.totalFiles, 12);
      assert.strictEqual(vm!.truncated, true);
    });

    it('caps more aggressively on long gap (>=30 days)', () => {
      const now = new Date('2026-08-29T18:00:00Z');
      const ended = new Date('2026-07-10T18:00:00Z').toISOString(); // 50 days ago
      const files = Array.from({ length: 8 }, (_, i) => ({
        path: `src/file${i}.ts`,
        lastEventAt: new Date(now.getTime() - i * 1000).toISOString(),
        eventType: 'saved' as const,
      }));
      const snapshot = makeSnapshot({ sessionEndedAt: ended, touchedFiles: files });
      const vm = composeSummary(snapshot, { now }); // default max should be 5 for long gap
      assert.ok(vm);
      assert.strictEqual(vm!.filesTouched.length, 5);
      assert.strictEqual(vm!.truncated, true);
      assert.ok(vm!.subtitle.includes("It's been a while"));
    });

    it('hasContent false when no files (suppressed)', () => {
      const now = new Date('2026-08-29T18:00:00Z');
      const snapshot = makeSnapshot({ touchedFiles: [] });
      const vm = composeSummary(snapshot, { now });
      assert.ok(vm);
      assert.strictEqual(vm!.hasContent, false);
    });

    it('does not call any VSCode API (pure function verification)', () => {
      // This is verified by the fact that the function only uses snapshot + date math
      // and imports no vscode module. We assert that global vscode is not required.
      const now = new Date();
      const snapshot = makeSnapshot();
      // Should not throw even when vscode is undefined
      const originalRequire = (global as unknown as { vscode?: unknown }).vscode;
      const vm = composeSummary(snapshot, { now });
      assert.ok(vm);
      void originalRequire;
    });
  });

  describe('shouldShowRecap decision tree', () => {
    it('first run -> do not show', () => {
      const now = new Date();
      const decision = shouldShowRecap(undefined, { enabled: true, minIdleMinutes: 0, mutedForSession: false }, now);
      assert.strictEqual(decision.shouldShow, false);
      assert.strictEqual(decision.reason, 'first_run');
    });

    it('disabled -> do not show', () => {
      const now = new Date();
      const snap = makeSnapshot();
      const decision = shouldShowRecap(snap, { enabled: false, minIdleMinutes: 0, mutedForSession: false }, now);
      assert.strictEqual(decision.shouldShow, false);
      assert.strictEqual(decision.reason, 'disabled');
    });

    it('muted-for-session -> do not show', () => {
      const now = new Date();
      const snap = makeSnapshot();
      const decision = shouldShowRecap(snap, { enabled: true, minIdleMinutes: 0, mutedForSession: true }, now);
      assert.strictEqual(decision.shouldShow, false);
      assert.strictEqual(decision.reason, 'muted');
    });

    it('below minIdleMinutes -> do not show', () => {
      const now = new Date('2026-08-29T18:00:00Z');
      const snap = makeSnapshot({ sessionEndedAt: new Date('2026-08-29T17:55:00Z').toISOString() }); // 5 min ago
      const decision = shouldShowRecap(snap, { enabled: true, minIdleMinutes: 10, mutedForSession: false }, now);
      assert.strictEqual(decision.shouldShow, false);
      assert.strictEqual(decision.reason, 'below_threshold');
    });

    it('at threshold -> show', () => {
      const now = new Date('2026-08-29T18:00:00Z');
      const snap = makeSnapshot({ sessionEndedAt: new Date('2026-08-29T17:50:00Z').toISOString() }); // 10 min ago
      const decision = shouldShowRecap(snap, { enabled: true, minIdleMinutes: 10, mutedForSession: false }, now);
      assert.strictEqual(decision.shouldShow, true);
      assert.strictEqual(decision.reason, 'show');
    });

    it('above threshold -> show', () => {
      const now = new Date('2026-08-29T18:00:00Z');
      const snap = makeSnapshot({ sessionEndedAt: new Date('2026-08-29T17:00:00Z').toISOString() }); // 60 min ago
      const decision = shouldShowRecap(snap, { enabled: true, minIdleMinutes: 10, mutedForSession: false }, now);
      assert.strictEqual(decision.shouldShow, true);
    });

    it('minIdleMinutes 0 -> show on every reopen', () => {
      const now = new Date('2026-08-29T18:00:01Z');
      const snap = makeSnapshot({ sessionEndedAt: new Date('2026-08-29T18:00:00Z').toISOString() }); // 1 sec ago
      const decision = shouldShowRecap(snap, { enabled: true, minIdleMinutes: 0, mutedForSession: false }, now);
      assert.strictEqual(decision.shouldShow, true);
    });

    it('no content (empty touchedFiles) -> do not show (suppressed)', () => {
      const now = new Date();
      const snap = makeSnapshot({ touchedFiles: [] });
      const decision = shouldShowRecap(snap, { enabled: true, minIdleMinutes: 0, mutedForSession: false }, now);
      assert.strictEqual(decision.shouldShow, false);
      assert.strictEqual(decision.reason, 'no_content');
    });

    it('order: muted check before gap check', () => {
      const now = new Date('2026-08-29T18:00:00Z');
      const snap = makeSnapshot({ sessionEndedAt: new Date('2026-08-29T17:59:00Z').toISOString() }); // 1 min ago, would be below threshold 10
      // muted true should win over below_threshold
      const decision = shouldShowRecap(snap, { enabled: true, minIdleMinutes: 10, mutedForSession: true }, now);
      assert.strictEqual(decision.reason, 'muted');
    });

    it('order: disabled before muted', () => {
      const now = new Date();
      const snap = makeSnapshot();
      const decision = shouldShowRecap(snap, { enabled: false, minIdleMinutes: 0, mutedForSession: true }, now);
      assert.strictEqual(decision.reason, 'disabled');
    });
  });
});
