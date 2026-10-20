export const MODES = ['standard', 'max'] as const;

export type Mode = (typeof MODES)[number];

export const DEFAULT_MODELS: Record<Mode, string> = { standard: '', max: '' };

export interface ModeConfig {
  mode: Mode;
  modes: Record<Mode, string>;
}

export function readModeConfig(projectRoot: string): ModeConfig {
  void projectRoot;
  return { mode: 'standard', modes: DEFAULT_MODELS };
}

export function setModelLine(text: string, model: string): string {
  void model;
  return text;
}

// Returns the files it changed.
export function setMode(projectRoot: string, mode: string): string[] {
  void projectRoot;
  void mode;
  return [];
}
