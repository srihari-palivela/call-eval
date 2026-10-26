import { config } from '../config';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const min = LEVELS[(config.logLevel as Level)] ?? LEVELS.info;

function emit(level: Level, msg: string, extra?: Record<string, unknown>) {
  if (LEVELS[level] < min) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (m: string, e?: Record<string, unknown>) => emit('debug', m, e),
  info: (m: string, e?: Record<string, unknown>) => emit('info', m, e),
  warn: (m: string, e?: Record<string, unknown>) => emit('warn', m, e),
  error: (m: string, e?: Record<string, unknown>) => emit('error', m, e),
};

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
