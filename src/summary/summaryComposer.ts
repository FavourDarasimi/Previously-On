import { SessionSnapshot } from '../session/sessionStore';
import { GitStatusResult } from '../providers/gitStatusProvider';
import { TodoItem } from '../providers/todoScanner';
import {
  SummaryViewModel,
  DecisionConfig,
  DecisionResult,
  FileTouchedViewModel,
  GitStatusChangeViewModel,
  GitStatusViewModel,
  TodoViewModel,
} from './viewModel';
import { Strings } from '../strings';
import { inferActivity } from '../activity/activityDetector';

export interface ComposeOptions {
  now?: Date;
  maxFilesShown?: number;
}

function isGitStatusResult(value: unknown): value is GitStatusResult {
  return !!value && typeof value === 'object' && 'hasRepository' in value && 'changes' in value;
}

function gitStatusLabel(status: GitStatusChangeViewModel['status']): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'modified':
      return 'M';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'untracked':
      return '??';
    default:
      return '?';
  }
}

function toGitStatusViewModel(gitStatus?: GitStatusResult): GitStatusViewModel | undefined {
  if (!gitStatus || !gitStatus.hasRepository || gitStatus.changes.length === 0) {
    return undefined;
  }

  return {
    hasRepository: true,
    count: gitStatus.changes.length,
    changes: gitStatus.changes.map((change) => ({
      path: change.path,
      status: change.status,
      label: gitStatusLabel(change.status),
    })),
  };
}

function toTodoViewModel(todos?: TodoItem[]): TodoViewModel[] | undefined {
  if (!todos || todos.length === 0) {
    return undefined;
  }

  return [...todos].sort((a, b) => {
    if (a.path !== b.path) {
      return a.path.localeCompare(b.path);
    }
    return a.line - b.line;
  });
}

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

/**
 * Pure function: snapshot + options -> ViewModel
 * No side effects, no VSCode API calls.
 * Must remain pure for unit testability per AGENTS.md §6.
 */
export function composeSummary(
  snapshot: SessionSnapshot | undefined,
  optionsOrGitStatus?: ComposeOptions | GitStatusResult,
  todos?: TodoItem[],
  options?: ComposeOptions
): SummaryViewModel | undefined {
  if (!snapshot) {
    return undefined;
  }

  const resolvedOptions = isGitStatusResult(optionsOrGitStatus)
    ? options ?? {}
    : (optionsOrGitStatus ?? options ?? {});
  const resolvedGitStatus = isGitStatusResult(optionsOrGitStatus) ? optionsOrGitStatus : undefined;
  const now = resolvedOptions.now ?? new Date();
  const diffMs = now.getTime() - new Date(snapshot.sessionEndedAt).getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const isLongGap = diffMs >= thirtyDaysMs;
  const defaultMax = isLongGap ? 5 : 10;
  const maxFilesShown = resolvedOptions.maxFilesShown ?? defaultMax;

  const touchedFiles = snapshot.touchedFiles ?? [];
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
  const gitStatus = toGitStatusViewModel(resolvedGitStatus);
  const todoItems = toTodoViewModel(todos);
  const hasContent =
    filesTouched.length > 0 ||
    (gitStatus !== undefined && gitStatus.count > 0) ||
    (todoItems !== undefined && todoItems.length > 0);

  // "What was I doing?" — deterministic lightweight inference, pure
  const activityRaw = inferActivity(snapshot, {
    gitBranch: (snapshot as unknown as { gitBranch?: string }).gitBranch,
    todos: todoItems as unknown as TodoItem[],
    gitStatus: resolvedGitStatus,
  });
  const activity = activityRaw
    ? {
        intent: activityRaw.intent,
        details: activityRaw.details,
        flow: activityRaw.flow,
        primaryArea: activityRaw.primaryArea,
        primaryAreaDisplay: activityRaw.primaryAreaDisplay,
        focusFile: activityRaw.focusFile,
        reason: activityRaw.reason,
      }
    : undefined;

  return {
    title: Strings.panelTitle,
    subtitle,
    filesTouched,
    totalFiles,
    truncated,
    hasContent,
    sessionEndedAt: snapshot.sessionEndedAt,
    gitStatus,
    todos: todoItems,
    activity,
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
  now: Date,
  gitStatus?: GitStatusResult,
  todos?: TodoItem[]
): DecisionResult {
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

  const hasFiles = (snapshot.touchedFiles?.length ?? 0) > 0;
  const hasGitStatus = !!gitStatus && gitStatus.hasRepository && gitStatus.changes.length > 0;
  const hasTodos = !!todos && todos.length > 0;

  if (!hasFiles && !hasGitStatus && !hasTodos) {
    return { shouldShow: false, reason: 'no_content' };
  }

  return { shouldShow: true, reason: 'show' };
}
