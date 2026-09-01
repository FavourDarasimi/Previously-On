import { GitFileChange } from '../providers/gitStatusProvider';
import { TodoItem } from '../providers/todoScanner';

export interface FileTouchedViewModel {
  path: string;
  lastEventAt: string;
  relativeTime: string;
  eventType: string;
}

export interface GitStatusChangeViewModel {
  path: string;
  status: GitFileChange['status'];
  label: string;
}

export interface GitStatusViewModel {
  hasRepository: boolean;
  count: number;
  changes: GitStatusChangeViewModel[];
}

export interface TodoViewModel extends TodoItem {}

export interface SummaryViewModel {
  title: string;
  subtitle: string;
  filesTouched: FileTouchedViewModel[];
  totalFiles: number;
  truncated: boolean;
  hasContent: boolean;
  sessionEndedAt: string;
  gitStatus?: GitStatusViewModel;
  todos?: TodoViewModel[];
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
