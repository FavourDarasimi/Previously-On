export interface FileTouchedViewModel {
  path: string;
  lastEventAt: string;
  relativeTime: string;
  eventType: string;
}

export interface SummaryViewModel {
  title: string;
  subtitle: string;
  filesTouched: FileTouchedViewModel[];
  totalFiles: number;
  truncated: boolean;
  hasContent: boolean;
  sessionEndedAt: string;
  // Future M2+ sections
  // gitStatus?: GitStatusViewModel | null
  // todos?: TodoViewModel[]
}

export interface DecisionConfig {
  enabled: boolean;
  minIdleMinutes: number;
  mutedForSession: boolean;
}

export type DecisionReason =
  | 'first_run'
  | 'disabled'
  | 'muted'
  | 'below_threshold'
  | 'no_content'
  | 'show';

export interface DecisionResult {
  shouldShow: boolean;
  reason: DecisionReason;
}
