import { SessionSnapshot } from '../session/sessionStore';
import { TodoItem } from '../providers/todoScanner';
import { GitStatusResult } from '../providers/gitStatusProvider';

export interface ActivitySignals {
  visitCounts?: Record<string, number>;
  symbolEdits?: Array<{ path: string; symbol: string; at: string }>;
  terminalCommands?: Array<{ command: string; at: string }>;
  testRuns?: Array<{ command: string; at: string }>;
  gitBranch?: string;
  lastActiveFile?: { path: string; line: number; at: string };
  cursorPositions?: Array<{ path: string; line: number; character: number; at: string }>;
}

export interface InferredActivity {
  primaryArea?: string;
  primaryAreaDisplay?: string;
  flow: string[];
  focusFile?: { path: string; line?: number };
  intent: string;
  details?: string;
  reason: string;
  signals: {
    fileCount: number;
    mostVisited?: string;
    branch?: string;
    lastSymbol?: string;
    hadTests: boolean;
    hadTerminal: boolean;
  };
}

const STOP_WORDS = new Set(['src', 'app', 'lib', 'test', 'tests', '__tests__', 'spec', 'specs']);
const AREA_ALIASES: Record<string, string> = {
  auth: 'authentication',
  payments: 'payment webhook',
  payment: 'payment webhook',
  webhooks: 'payment webhook',
  webhook: 'payment webhook',
  api: 'API',
};

function humanizeArea(area: string): string {
  if (!area) return area;
  const low = area.toLowerCase();
  if (AREA_ALIASES[low]) return AREA_ALIASES[low];
  // Capitalize first letter
  return area.charAt(0).toUpperCase() + area.slice(1);
}

function getAreaForPath(p: string): string | undefined {
  if (!p) return undefined;
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return undefined;
  // If single file like "README.md", use name without ext
  if (parts.length === 1) {
    const base = parts[0].replace(/\.[^.]+$/, '');
    return base.toLowerCase();
  }
  // If starts with src/app/lib, skip them
  let idx = 0;
  if (STOP_WORDS.has(parts[0].toLowerCase())) {
    idx = 1;
    // Also skip second if it's still stop word (e.g., src/tests)
    if (parts.length > 2 && STOP_WORDS.has(parts[1].toLowerCase())) idx = 2;
  }
  const area = parts[idx] ?? parts[0];
  return area.toLowerCase();
}

function mostFrequent<T>(items: T[], key: (x: T) => string): { value: string; count: number } | undefined {
  const freq = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    if (!k) continue;
    freq.set(k, (freq.get(k) ?? 0) + 1);
  }
  let best: { value: string; count: number } | undefined;
  for (const [v, c] of freq.entries()) {
    if (!best || c > best.count) best = { value: v, count: c };
  }
  return best;
}

/**
 * Pure deterministic inference — no VS Code API, no network, no AI.
 * Given snapshot + optional live signals, returns a lightweight summary or undefined if not enough data.
 */
export function inferActivity(
  snapshot: SessionSnapshot | undefined,
  opts?: {
    gitBranch?: string;
    todos?: TodoItem[];
    gitStatus?: GitStatusResult;
    now?: Date;
  }
): InferredActivity | undefined {
  if (!snapshot || !snapshot.touchedFiles || snapshot.touchedFiles.length === 0) {
    return undefined;
  }

  const touched = snapshot.touchedFiles;
  // Use visitCounts if present, else fallback to touched order
  const visitCounts = (snapshot as unknown as { visitCounts?: Record<string, number> }).visitCounts ?? {};
  const symbolEdits = (snapshot as unknown as { symbolEdits?: Array<{ path: string; symbol: string }> }).symbolEdits ?? [];
  const terminalCommands = (snapshot as unknown as { terminalCommands?: Array<{ command: string }> }).terminalCommands ?? [];
  const testRuns = (snapshot as unknown as { testRuns?: Array<{ command: string }> }).testRuns ?? [];
  const lastActiveFile = (snapshot as unknown as { lastActiveFile?: { path: string; line: number } }).lastActiveFile;
  const gitBranch = opts?.gitBranch ?? (snapshot as unknown as { gitBranch?: string }).gitBranch;
  const todos = opts?.todos ?? [];

  // Primary area by directory frequency
  const areas = touched.map((f) => getAreaForPath(f.path)).filter((a): a is string => Boolean(a));
  const primary = mostFrequent(areas, (a) => a);
  const primaryArea = primary?.value;
  const primaryAreaDisplay = primaryArea ? humanizeArea(primaryArea) : undefined;

  // Flow: chronological order (oldest to newest) deduped, mapped to display paths
  const sortedByTime = [...touched].sort((a, b) => new Date(a.lastEventAt).getTime() - new Date(b.lastEventAt).getTime());
  const seen = new Set<string>();
  const flow: string[] = [];
  for (const f of sortedByTime) {
    if (!seen.has(f.path)) {
      seen.add(f.path);
      flow.push(f.path);
    }
  }
  // Cap flow to 3-4 for brevity like example "auth/views.py → auth/serializers.py → tests/test_auth.py"
  const flowTrimmed = flow.length > 4 ? flow.slice(-4) : flow;

  // Focus file
  let focusFile: { path: string; line?: number } | undefined;
  if (lastActiveFile?.path) {
    focusFile = { path: lastActiveFile.path, line: lastActiveFile.line };
  } else {
    const last = sortedByTime[sortedByTime.length - 1];
    if (last) focusFile = { path: last.path };
  }
  // If focusFile has cursor, prefer that line; else try to find symbol edit for that file
  if (focusFile && focusFile.line === undefined) {
    const symForFocus = [...symbolEdits].reverse().find((s) => s.path === focusFile!.path);
    if (symForFocus) {
      // Try to parse line from symbol? SymbolEdits don't have line, so keep undefined
    }
  }

  // Most visited file
  let mostVisited: string | undefined;
  let maxVisits = 0;
  for (const [p, c] of Object.entries(visitCounts)) {
    if (c > maxVisits) {
      maxVisits = c;
      mostVisited = p;
    }
  }

  // Detect signals
  const hadTests =
    testRuns.length > 0 ||
    terminalCommands.some((t) => /test|jest|pytest|vitest|mocha|playwright|cypress/i.test(t.command)) ||
    touched.some((f) => /test|spec/i.test(f.path)) ||
    (gitBranch ? /test/i.test(gitBranch) : false);

  const hadTerminal = terminalCommands.length > 0;

  const lastSymbol = symbolEdits.length > 0 ? symbolEdits[symbolEdits.length - 1].symbol : undefined;

  // Infer intent — deterministic priority
  let intent = '';
  let reason = '';
  let details: string | undefined;

  const branchLow = gitBranch?.toLowerCase() ?? '';
  const todoText = todos.map((t) => t.text.toLowerCase()).join(' ');

  // 1) Branch gives strong signal
  if (branchLow.includes('auth')) {
    intent = `You were working on authentication`;
    reason = 'branch';
    details = gitBranch ? `On branch ${gitBranch}` : undefined;
  } else if (branchLow.includes('payment') || branchLow.includes('webhook') || branchLow.includes('pay')) {
    intent = `You were debugging the payment webhook`;
    reason = 'branch';
    details = gitBranch ? `On branch ${gitBranch}` : undefined;
  } else if (hadTests && primaryArea && /test/i.test(primaryArea)) {
    intent = `You were testing ${primaryAreaDisplay ?? primaryArea}`;
    reason = 'tests';
  } else if (hadTests) {
    // Generic testing
    intent = primaryAreaDisplay ? `You were testing ${primaryAreaDisplay}` : `You were running tests`;
    reason = 'tests';
    if (testRuns[0]) details = `Last run: ${testRuns[testRuns.length - 1].command}`;
  } else if (todoText.includes('webhook') || todoText.includes('payment')) {
    intent = `You were debugging the payment webhook`;
    reason = 'todo';
  } else if (lastSymbol && /webhook|payment/i.test(lastSymbol)) {
    intent = `You were debugging the payment webhook`;
    reason = 'symbol';
    details = focusFile ? `Last touched ${focusFile.path}${focusFile.line !== undefined ? `:${focusFile.line + 1}` : ''}` : undefined;
  } else if (mostVisited && maxVisits >= 3) {
    // Repeatedly visited same file => debugging that file
    const areaForMost = getAreaForPath(mostVisited);
    intent = areaForMost ? `You were debugging ${humanizeArea(areaForMost)}` : `You were focused on ${mostVisited}`;
    reason = 'visits';
    details = `Visited ${mostVisited} ${maxVisits} times`;
    focusFile = { path: mostVisited, line: focusFile?.line };
  } else if (lastSymbol) {
    // If we have a symbol, use it
    intent = `You were working on ${lastSymbol}`;
    reason = 'symbol';
    if (primaryAreaDisplay) intent += ` in ${primaryAreaDisplay}`;
    details = focusFile ? `Last touched ${focusFile.path}${focusFile.line !== undefined ? `:${focusFile.line + 1}` : ''}` : undefined;
  } else if (primaryAreaDisplay) {
    intent = `You were working on ${primaryAreaDisplay}`;
    reason = 'area';
  } else if (primaryArea) {
    intent = `You were working on ${primaryArea}`;
    reason = 'area';
  } else {
    // Fallback to file name
    const base = focusFile ? focusFile.path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? focusFile.path : 'your workspace';
    intent = `You were working on ${base}`;
    reason = 'fallback';
  }

  // If we have a clear flow with 2+ files in same area, use flow as details
  if (!details && flowTrimmed.length >= 2) {
    // Only show flow if it adds value (multiple files)
    details = flowTrimmed.join(' → ');
  } else if (!details && focusFile) {
    details = `Last touched ${focusFile.path}${focusFile.line !== undefined ? `:${focusFile.line + 1}` : ''}`;
  }

  // Ensure we always have at least flow or focus
  if (!details && flowTrimmed.length > 0) {
    details = flowTrimmed.join(' → ');
  }

  return {
    primaryArea,
    primaryAreaDisplay,
    flow: flowTrimmed,
    focusFile,
    intent,
    details,
    reason,
    signals: {
      fileCount: touched.length,
      mostVisited,
      branch: gitBranch,
      lastSymbol,
      hadTests,
      hadTerminal,
    },
  };
}
