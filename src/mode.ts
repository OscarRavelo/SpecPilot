import fs from 'fs';
import path from 'path';

export const MODES = ['standard', 'max'] as const;

export type Mode = (typeof MODES)[number];

export const DEFAULT_MODELS: Record<Mode, string> = { standard: 'sonnet', max: 'opus' };

export interface ModeConfig {
  mode: Mode;
  modes: Record<Mode, string>;
}

const CONFIG_FILE = path.join('.specpilot', 'config.json');
const AGENTS_DIR = path.join('.claude', 'agents');

function isMode(mode: unknown): mode is Mode {
  return (MODES as readonly unknown[]).includes(mode);
}

function unknownMode(mode: string): Error {
  return new Error(`Unknown mode: ${mode} (valid modes: ${MODES.join(', ')})`);
}

function readConfigFile(projectRoot: string): Record<string, unknown> {
  const file = path.join(projectRoot, CONFIG_FILE);
  if (!fs.existsSync(file)) return {};
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (config && typeof config === 'object' && !Array.isArray(config)) return config;
  } catch {
    // reported below
  }
  throw new Error(`Corrupt ${file}`);
}

// .specpilot/config.json overrides the default mode (standard) and the model of each mode.
export function readModeConfig(projectRoot: string): ModeConfig {
  const config = readConfigFile(projectRoot);
  const mode = config.mode ?? 'standard';
  if (!isMode(mode)) throw unknownMode(String(mode));
  return { mode, modes: { ...DEFAULT_MODELS, ...(config.modes as Partial<Record<Mode, string>>) } };
}

// Sets the model: line of the frontmatter, adding it before the closing --- if missing. The body is never touched.
export function setModelLine(text: string, model: string): string {
  const lines = text.split('\n');
  const isFence = (line: string) => line.replace(/\r$/, '') === '---';
  const close = lines.findIndex((line, i) => i > 0 && isFence(line));
  if (!isFence(lines[0]) || close === -1) {
    throw new Error('No frontmatter (expected a --- block at the top)');
  }
  const eol = lines[0].endsWith('\r') ? '\r' : '';
  const modelLine = `model: ${model}${eol}`;
  const index = lines.slice(1, close).findIndex((line) => /^model:/.test(line));
  if (index === -1) lines.splice(close, 0, modelLine);
  else lines[index + 1] = modelLine;
  return lines.join('\n');
}

// Returns the files it changed.
export function setMode(projectRoot: string, mode: string): string[] {
  if (!isMode(mode)) throw unknownMode(mode);
  const model = readModeConfig(projectRoot).modes[mode];
  const agentsDir = path.join(projectRoot, AGENTS_DIR);
  if (!fs.existsSync(agentsDir)) throw new Error(`No agents folder: ${agentsDir}`);

  // Every file is checked before any is written, so a broken one changes nothing.
  const updates = fs
    .readdirSync(agentsDir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const file = path.join(agentsDir, name);
      const text = fs.readFileSync(file, 'utf8');
      try {
        return { file, text, next: setModelLine(text, model) };
      } catch (err) {
        throw new Error(`${file}: ${(err as Error).message}`);
      }
    })
    .filter(({ text, next }) => next !== text);
  for (const { file, next } of updates) fs.writeFileSync(file, next);
  const changed = updates.map(({ file }) => file);

  const config = readConfigFile(projectRoot);
  if (config.mode !== mode) {
    const file = path.join(projectRoot, CONFIG_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ ...config, mode }, null, 2)}\n`);
    changed.push(file);
  }
  return changed;
}
