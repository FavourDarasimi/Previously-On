import { SessionSnapshot } from '../session/sessionStore';
import { SummaryViewModel, DecisionConfig, DecisionResult, FileTouchedViewModel } from './viewModel';
import { Strings } from '../strings';

// Pure helpers — no VSCode API

export function formatRelativeTime(iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  const nowMs = now.getTime();
  const diffMs = nowMs - then;
  if (diffMs < 0) {
    return 'just now';
  }
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) {
    return 'just now';
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return diffMin === 1 ? '1 min ago' : `${diffMin} min ago`;
  }
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) {
    return diffHr === 1 ? '1 hr ago' : `${diffHr} hrs ago`;
  }
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) {
    return diffDays === 1 ? '1 day ago' : `${diffDays} days ago`;
  }
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) {
    return diffMonths === 1 ? '1 month ago' : `${diffMonths} months ago`;
  }
  const diffYears = Math.floor(diffMonths / 12);
  return diffYears === 1 ? '1 year ago' : `${diffYears} years ago`;
}

export function formatSubtitle(sessionEndedAt: string, now: Date): string {
  const relative = formatRelativeTime(sessionEndedAt, now);
  const diffMs = now.getTime() - new Date(sessionEndedAt).getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  if (diffMs >= thirtyDaysMs) {
    return `It's been a while — last session ended ${relative}`;
  }
  return Strings.lastSessionLabel(relative);
}

export interface ComposeOptions {
  now?: Date;
  maxFilesShown?: number;
}

/**
 * Pure function: snapshot + options -> ViewModel
 * No side effects, no VSCode API calls.
 * Must remain pure for unit testability per AGENTS.md §6.
 */
export function composeSummary(
  snapshot: SessionSnapshot | undefined,
  options?: ComposeOptions
): SummaryViewModel | undefined {
  if (!snapshot) {
    return undefined;
  }
  const now = options?.now ?? new Date();
  // M1: only files touched section
  // Determine maxFilesShown with long-gap aggressive capping
  const diffMs = now.getTime() - new Date(snapshot.sessionEndedAt).getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const isLongGap = diffMs >= thirtyDaysMs;
  const defaultMax = isLongGap ? 5 : 10;
  const maxFilesShown = options?.maxFilesShown ?? defaultMax;

  const touchedFiles = snapshot.touchedFiles ?? [];
  // Sort most recent first
  const sorted = [...touchedFiles].sort((a, b) => {
    return new Date(b.lastEventAt).getTime() - new Date(a.lastEventAt).getTime();
  });

  const totalFiles = sorted.length;
  const truncated = totalFiles > maxFilesShown;
  const sliced = truncated ? sorted.slice(0, maxFilesShown) : sorted;

  const filesTouched: FileTouchedViewModel[] = sliced.map((f) => ({
    path: f.path,
    lastEventAt: f.lastEventAt,
    relativeTime: formatRelativeTime(f.lastEventAt, now),
    eventType: f.eventType,
  }));

  const subtitle = formatSubtitle(snapshot.sessionEndedAt, now);

  const hasContent = filesTouched.length > 0;
  // Per FINAL_FLOW §4: No activity to report -> suppressed (hasContent false)
  // Composer still returns model but caller should suppress if !hasContent

  return {
    title: Strings.panelTitle,
    subtitle,
    filesTouched,
    totalFiles,
    truncated,
    hasContent,
    sessionEndedAt: snapshot.sessionEndedAt,
  };
}

/**
 * Decision tree from FINAL_FLOW.md §3 (pure function)
 * ```
 * Is first run? -> don't show
 * Is enabled == false? -> don't show
 * Is muted-for-session? -> don't show
 * Is (now - sessionEndedAt) < minIdleMinutes? -> don't show
 * Otherwise -> show (but still suppressed if no content)
 * ```
 */
export function shouldShowRecap(
  snapshot: SessionSnapshot | undefined,
  config: DecisionConfig,
  now: Date
): DecisionResult {
  // First run: no snapshot
  if (!snapshot) {
    return { shouldShow: false, reason: 'first_run' };
  }

  if (!config.enabled) {
    return { shouldShow: false, reason: 'disabled' };
  }

  if (config.mutedForSession) {
    return { shouldShow: false, reason: 'muted' };
  }

  const gapMs = now.getTime() - new Date(snapshot.sessionEndedAt).getTime();
  const minIdleMs = config.minIdleMinutes * 60 * 1000;
  if (gapMs < minIdleMs) {
    return { shouldShow: false, reason: 'below_threshold' };
  }

  // Check for empty content suppression (FINAL_FLOW §4 No activity to report)
  const hasFiles = snapshot.touchedFiles && snapshot.touchedFiles.length > 0;
  // M1 only has files; future will also check Git/TODO
  if (!hasFiles) {
    return { shouldShow: false, reason: 'no_content' };
  }

  return { shouldShow: true, reason: 'show' };
}
