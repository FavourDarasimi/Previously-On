// Centralized user-visible strings for future localization
export const Strings = {
  extensionDisplayName: 'Previously On',
  panelTitle: 'Previously On',
  firstRunStatus: 'Previously On is now tracking this workspace',
  lastSessionLabel: (relative: string) => `Last session ended ${relative}`,
  filesTouched: {
    title: 'Files touched',
    emptyHint: 'No files touched last session',
    noLongerExists: 'no longer exists',
  },
  gitStatus: {
    title: 'Uncommitted changes',
    noRepository: 'No Git repository',
  },
  todos: {
    title: 'TODOs left',
  },
  actions: {
    dismiss: 'Dismiss',
    muteForSession: 'Mute for this session',
    openFile: 'Open file',
    openSourceControl: 'Open Source Control',
    showRecap: 'Show Last Session Recap',
  },
  errors: {
    snapshotCorrupt: 'Snapshot file corrupt — treating as first run',
  },
} as const;
