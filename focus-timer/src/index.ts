import type { AwarenessPlugin, GatherContext, GatherResult, PluginConfig, Trigger } from 'agent-awareness';

/**
 * Focus timer (Pomodoro) plugin.
 *
 * The agent can start/stop/extend focus sessions and adapts its behavior:
 * - During focus: dense responses, no tangents, no "should we wrap up?"
 * - During break: suggests stepping away, lighter interaction
 * - Between sessions: normal behavior
 *
 * State is managed externally — gather() handles auto-transitions
 * (focus expired -> break, break expired -> idle) and status display.
 */

interface TimerState {
  status: 'idle' | 'focus' | 'break';
  startedAt: string | null;
  endsAt: string | null;
  focusMinutes: number;
  breakMinutes: number;
  sessionsCompleted: number;
  label: string | null;
}

const DEFAULT_STATE: TimerState = {
  status: 'idle',
  startedAt: null,
  endsAt: null,
  focusMinutes: 25,
  breakMinutes: 5,
  sessionsCompleted: 0,
  label: null,
};

function getTimer(prevState: Record<string, unknown> | null): TimerState {
  if (!prevState?.status) return { ...DEFAULT_STATE };
  return prevState as unknown as TimerState;
}

function remaining(endsAt: string): number {
  return Math.max(0, Math.ceil((new Date(endsAt).getTime() - Date.now()) / 60_000));
}

function isExpired(endsAt: string | null): boolean {
  if (!endsAt) return false;
  return Date.now() >= new Date(endsAt).getTime();
}

function formatTimer(timer: TimerState): string {
  if (timer.status === 'idle') return '';

  if (timer.status === 'focus') {
    if (isExpired(timer.endsAt)) {
      return `Focus: ${timer.focusMinutes}min complete -- time for a break`;
    }
    const left = remaining(timer.endsAt!);
    const total = timer.focusMinutes;
    const label = timer.label ? ` [${timer.label}]` : '';
    return `Focus: ${total - left}/${total}min${label} -- deep work, stay dense and focused`;
  }

  if (timer.status === 'break') {
    if (isExpired(timer.endsAt)) {
      return `Break over -- ready for next focus session (#${timer.sessionsCompleted + 1})`;
    }
    const left = remaining(timer.endsAt!);
    return `Break: ${left}min left -- suggest stepping away`;
  }

  return '';
}

function startBreak(timer: TimerState, minutes: number): TimerState {
  const now = new Date();
  return {
    ...timer,
    status: 'break',
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
    breakMinutes: minutes,
    sessionsCompleted: timer.sessionsCompleted + 1,
    label: null,
  };
}

function stopTimer(timer: TimerState): TimerState {
  const completed = timer.status === 'focus' && isExpired(timer.endsAt)
    ? timer.sessionsCompleted + 1
    : timer.sessionsCompleted;
  return { ...DEFAULT_STATE, sessionsCompleted: completed };
}

export default {
  name: 'focus-timer',
  description: 'Pomodoro focus timer — agent adapts behavior during focus/break sessions',

  triggers: ['session-start', 'prompt'],

  defaults: {
    focusMinutes: 25,
    breakMinutes: 5,
    longBreakMinutes: 15,
    longBreakAfter: 4,
    autoBreak: true,
    triggers: {
      'session-start': true,
      'prompt': true,
    },
  },

  gather(trigger: Trigger, config: PluginConfig, prevState, _context: GatherContext): GatherResult | null {
    const timer = getTimer(prevState);

    // Auto-transition: focus expired → start break
    if (timer.status === 'focus' && isExpired(timer.endsAt) && config.autoBreak !== false) {
      const isLongBreak = (config.longBreakAfter as number) > 0
        && (timer.sessionsCompleted + 1) % (config.longBreakAfter as number) === 0;
      const breakMins = isLongBreak
        ? (config.longBreakMinutes as number) ?? 15
        : (config.breakMinutes as number) ?? 5;
      const breakTimer = startBreak(timer, breakMins);
      const breakType = isLongBreak ? 'Long break' : 'Break';
      return {
        text: `${breakType}: ${breakMins}min -- session #${breakTimer.sessionsCompleted} complete, step away`,
        state: breakTimer as unknown as Record<string, unknown>,
      };
    }

    // Auto-transition: break expired → back to idle
    if (timer.status === 'break' && isExpired(timer.endsAt)) {
      return {
        text: `Break over -- ready for focus session #${timer.sessionsCompleted + 1}`,
        state: stopTimer(timer) as unknown as Record<string, unknown>,
      };
    }

    const text = formatTimer(timer);
    if (!text) return null; // idle — no injection

    return {
      text,
      state: timer as unknown as Record<string, unknown>,
    };
  },
} satisfies AwarenessPlugin;
