import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
import { decideTimeout, formatElapsed } from './policy.ts';

const STATUS_KEY = 'tool-policy';
const HEARTBEAT_MS = 1000;
const QUIET_NOTICE_MS = 30_000;

interface ActiveShell {
  startedAt: number;
  lastOutputAt: number;
  timeout: number;
}

export default function toolPolicyExtension(pi: ExtensionAPI) {
  const active = new Map<string, ActiveShell>();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lastRenderedAt = 0;

  const render = (ctx: ExtensionContext, force = false) => {
    const now = Date.now();
    if (!force && now - lastRenderedAt < 250) return;
    lastRenderedAt = now;
    const entries = [...active.values()];
    if (!entries.length) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const elapsed = Math.max(...entries.map(entry => now - entry.startedAt));
    const quiet = Math.max(...entries.map(entry => now - entry.lastOutputAt));
    const parts = [`${entries.length} shell`, `已运行 ${formatElapsed(elapsed)}`];
    if (quiet >= QUIET_NOTICE_MS) parts.push(`无输出 ${formatElapsed(quiet)}`);
    if (elapsed >= QUIET_NOTICE_MS) parts.push('Esc 可中止');
    const text = parts.join(' · ');
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme?.fg ? ctx.ui.theme.fg('dim', text) : text);
  };

  const ensureHeartbeat = (ctx: ExtensionContext) => {
    if (heartbeat) return;
    heartbeat = setInterval(() => render(ctx), HEARTBEAT_MS);
    heartbeat.unref?.();
  };

  const stopHeartbeatIfIdle = () => {
    if (active.size || !heartbeat) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
  };

  pi.on('tool_call', (event, ctx) => {
    if (!isToolCallEventType('bash', event) && !isToolCallEventType('powershell', event)) return;
    const decision = decideTimeout(event.input.timeout);
    event.input.timeout = decision.timeout;
    if (decision.notice) ctx.ui.notify(decision.notice, 'warning');
  });

  pi.on('tool_execution_start', (event, ctx) => {
    if (event.toolName !== 'bash' && event.toolName !== 'powershell') return;
    const now = Date.now();
    active.set(event.toolCallId, { startedAt: now, lastOutputAt: now, timeout: Number(event.args?.timeout) || 0 });
    ensureHeartbeat(ctx);
    render(ctx, true);
  });

  pi.on('tool_execution_update', (event, ctx) => {
    const entry = active.get(event.toolCallId);
    if (!entry) return;
    entry.lastOutputAt = Date.now();
    render(ctx);
  });

  pi.on('tool_execution_end', (event, ctx) => {
    if (!active.delete(event.toolCallId)) return;
    render(ctx, true);
    stopHeartbeatIfIdle();
  });

  pi.on('session_shutdown', () => {
    active.clear();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  });
}
