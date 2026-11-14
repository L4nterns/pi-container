export const DEFAULT_TIMEOUT_SECONDS = 120;
export const WARN_TIMEOUT_SECONDS = 600;
export const HARD_MAX_TIMEOUT_SECONDS = 3600;

export interface TimeoutDecision {
  timeout: number;
  notice?: string;
}

/**
 * A shell command without an explicit bound is the one case where a silent
 * process can stall an entire agent turn. Keep the default short enough to
 * kill a hung lazy fetch, while allowing an explicit longer build/deploy
 * command up to a hard ceiling.
 */
export function decideTimeout(requested: unknown): TimeoutDecision {
  if (requested === undefined || requested === null || requested === '') {
    return { timeout: DEFAULT_TIMEOUT_SECONDS };
  }
  const value = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(value) || value <= 0) {
    return { timeout: DEFAULT_TIMEOUT_SECONDS, notice: `无效的命令超时 ${String(requested)}；已使用 ${DEFAULT_TIMEOUT_SECONDS}s` };
  }
  if (value > HARD_MAX_TIMEOUT_SECONDS) {
    return { timeout: HARD_MAX_TIMEOUT_SECONDS, notice: `命令超时 ${Math.floor(value)}s 超过上限；已限制为 ${HARD_MAX_TIMEOUT_SECONDS}s` };
  }
  if (value < 1) {
    return { timeout: 1, notice: `命令超时 ${String(requested)}s 低于最小值；已使用 1s` };
  }
  const timeout = Math.floor(value);
  return timeout > WARN_TIMEOUT_SECONDS
    ? { timeout, notice: `长任务：命令超时为 ${timeout}s；可按 Esc 中止` }
    : { timeout };
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}
