import { describe, expect, it } from 'vitest';

import { normalizeAiAgentEvent, type AiAgentEvent } from '../../../services/api/ai-agent';
import { applyAiAgentEvent, providerOptionDisabled, type LiveRequest } from '../.';

function request(): LiveRequest {
  return {
    id: 'request-1',
    conversationId: 'conversation-1',
    prompt: 'Запит',
    createdAt: 1_700_000_000_000,
    state: 'queued',
    assistantText: '',
    progress: [],
    tools: [],
    sources: [],
    lastSequence: 0,
    streamError: null,
  };
}

function event(sequence: number, type: AiAgentEvent['type'], text: string | null): AiAgentEvent {
  return {
    sequence,
    requestId: 'request-1',
    type,
    createdAt: 1_700_000_000_000,
    text,
    toolCallId: null,
    toolName: null,
    sourceTitle: null,
    sourceUrl: null,
    method: null,
    path: null,
    status: null,
    isError: null,
  };
}
describe('applyAiAgentEvent', () => {
  it('applies deltas in sequence and ignores replays', () => {
    const first = applyAiAgentEvent(request(), event(1, 'assistant_delta', 'Від'));
    const second = applyAiAgentEvent(first, event(2, 'assistant_delta', 'повідь'));
    const replayed = applyAiAgentEvent(second, event(1, 'assistant_delta', 'дубль'));

    expect(replayed.assistantText).toBe('Відповідь');
    expect(replayed.lastSequence).toBe(2);
  });

  it('replaces streamed text with an assistant snapshot', () => {
    const streamed = applyAiAgentEvent(request(), event(1, 'assistant_delta', 'Чернетка'));
    const replaced = applyAiAgentEvent(
      streamed,
      event(2, 'assistant_snapshot', 'Готово [джерело](/rer-analysis-neo?m=1)'),
    );

    expect(replaced.assistantText).toBe('Готово [джерело](/rer-analysis-neo?m=1)');
    expect(replaced.lastSequence).toBe(2);
  });

  it('keeps progress and tool activity separate from assistant text', () => {
    const progress = applyAiAgentEvent(request(), event(1, 'progress', 'Шукаю дані'));
    const tool = applyAiAgentEvent(progress, {
      ...event(2, 'tool_start', 'Запит до /api/user'),
      toolCallId: 'tool-1',
      toolName: 'echo_api',
      toolLabel: 'Завантаження даних',
    });

    expect(tool.progress).toEqual(['Шукаю дані']);
    expect(tool.tools).toEqual([
      {
        id: 'tool-1',
        name: 'Завантаження даних',
        status: 'running',
        summary: 'Запит до /api/user',
        method: null,
        path: null,
        httpStatus: null,
        presentation: null,
      },
    ]);
    expect(tool.assistantText).toBe('');
  });

  it('keeps repeated tool calls independent while deduplicating consecutive progress', () => {
    const progress = applyAiAgentEvent(request(), event(1, 'progress', 'Шукаю дані'));
    const duplicateProgress = applyAiAgentEvent(progress, event(2, 'progress', 'Шукаю дані'));
    const started = applyAiAgentEvent(duplicateProgress, {
      ...event(3, 'tool_start', null),
      toolCallId: 'tool-1',
      toolName: 'echo_daily_activity',
      toolLabel: 'Аналіз щоденної активності',
    });
    const completed = applyAiAgentEvent(started, {
      ...event(4, 'tool_end', null),
      toolCallId: 'tool-1',
      toolName: 'echo_daily_activity',
      toolLabel: 'Аналіз щоденної активності',
      isError: false,
    });
    const repeated = applyAiAgentEvent(completed, {
      ...event(5, 'tool_end', null),
      toolCallId: 'tool-2',
      toolName: 'echo_daily_activity',
      toolLabel: 'Аналіз щоденної активності',
      isError: true,
    });

    expect(repeated.progress).toEqual(['Шукаю дані']);
    expect(repeated.tools).toHaveLength(2);
    expect(repeated.tools[0]).toMatchObject({
      id: 'tool-1',
      status: 'completed',
    });
    expect(repeated.tools[1]).toMatchObject({
      id: 'tool-2',
      name: 'Аналіз щоденної активності',
      status: 'failed',
    });
  });

  it('#3064 keeps late generated titles out of newer steps, history and terminal requests', () => {
    const firstPresentation = { key: 1, title: 'Шукаю події', detail: 'За 23–29 вересня' };
    const started = applyAiAgentEvent(
      applyAiAgentEvent(request(), event(1, 'request_start', null)),
      {
        ...event(2, 'tool_start', null),
        toolCallId: 'first-search',
        toolLabel: 'Шукаю перехоплення',
        activityPresentation: firstPresentation,
      },
    );
    const titled = applyAiAgentEvent(started, {
      ...event(3, 'progress', null),
      activityOnly: true,
      activityPresentation: { ...firstPresentation, title: 'Шукаю події за підрозділами' },
    });
    expect(titled.tools[0].presentation?.title).toBe('Шукаю події за підрозділами');
    expect(titled.tools[0].status).toBe('running');
    expect(titled.activity).toEqual(started.activity);
    expect(titled.progress).toEqual(started.progress);
    expect(titled.assistantText).toBe('');

    const second = applyAiAgentEvent(titled, {
      ...event(4, 'tool_start', null),
      toolCallId: 'second-search',
      activityPresentation: { key: 2, title: 'Уточнюю джерела', detail: null },
    });
    const stale = applyAiAgentEvent(second, {
      ...event(5, 'progress', null),
      activityOnly: true,
      activityPresentation: { ...firstPresentation, title: 'Застарілий заголовок' },
    });
    expect(stale.tools).toEqual(second.tools);
    expect(stale.currentActivityPresentation).toEqual(second.currentActivityPresentation);
    expect(stale.activity).toEqual(second.activity);

    const firstEnded = applyAiAgentEvent(stale, {
      ...event(6, 'tool_end', null),
      toolCallId: 'first-search',
      activityPresentation: { key: 3, title: 'Переглядаю добірку', detail: '20 повідомлень' },
    });
    const secondEnded = applyAiAgentEvent(firstEnded, {
      ...event(7, 'tool_end', null),
      toolCallId: 'second-search',
      activityPresentation: { key: 4, title: 'Переглядаю добірку', detail: '40 повідомлень' },
    });
    const reviewed = applyAiAgentEvent(secondEnded, {
      ...event(8, 'progress', null),
      activityOnly: true,
      activityPresentation: {
        key: 4,
        title: 'Зіставляю події за підрозділами',
        detail: '40 повідомлень',
      },
    });
    expect(reviewed.tools[1].status).toBe('completed');
    expect(reviewed.currentActivityPresentation?.title).toBe('Зіставляю події за підрозділами');
    expect(reviewed.activity).toEqual(secondEnded.activity);

    const completed = applyAiAgentEvent(reviewed, event(9, 'completion', null));
    const terminalTitle = applyAiAgentEvent(completed, {
      ...event(10, 'progress', null),
      activityOnly: true,
      activityPresentation: { key: 4, title: 'Запізнілий заголовок', detail: 'Не показувати' },
    });
    expect(terminalTitle.currentActivityPresentation).toEqual(
      completed.currentActivityPresentation,
    );
    expect(terminalTitle.finishedAt).toBe(completed.finishedAt);
    expect(terminalTitle.tools.every((tool) => tool.status === 'completed')).toBe(true);
  });

  it('#3064 keeps cancelled requests and late replayed activity stopped', () => {
    const cancelled = applyAiAgentEvent(request(), event(1, 'cancellation', null));
    const replayedStart = applyAiAgentEvent(cancelled, event(2, 'request_start', null));
    const lateTool = applyAiAgentEvent(replayedStart, {
      ...event(3, 'tool_start', null),
      toolCallId: 'tool-1',
      toolName: 'echo_inbox_messages',
    });

    expect(lateTool.state).toBe('cancelled');
    expect(lateTool.tools[0].status).toBe('cancelled');
    expect(lateTool.finishedAt).toBe(cancelled.finishedAt);
  });

  it('uses a localized generic label for legacy tool events', () => {
    const legacy = applyAiAgentEvent(request(), {
      ...event(1, 'tool_start', null),
      toolCallId: 'tool-1',
      toolName: 'echo_internal_name',
    });

    expect(legacy.tools[0].name).toBe('Робота з даними');
  });

  it('keeps internal request failures out of progress', () => {
    const failed = applyAiAgentEvent(
      applyAiAgentEvent(request(), event(1, 'progress', 'Шукаю дані')),
      event(2, 'error', 'internal runner failure'),
    );

    expect(failed.state).toBe('failed');
    expect(failed.progress).toEqual(['Шукаю дані']);
    expect(JSON.stringify(failed)).not.toContain('internal runner failure');
  });

  it('ignores unsupported hidden event types', () => {
    const hidden = applyAiAgentEvent(request(), {
      ...event(1, 'reasoning' as AiAgentEvent['type'], 'секретні міркування'),
    });

    expect(hidden.assistantText).toBe('');
    expect(hidden.progress).toEqual([]);
  });
  it('normalizes persisted event payloads without exposing reasoning fields', () => {
    const normalized = normalizeAiAgentEvent({
      activityPresentation: null,
      activityOnly: false,
      sequence: 2,
      eventType: 'tool_start',
      payloadJson: JSON.stringify({
        tool: 'echo_api',
        content: 'GET /api/user',
        reasoning: 'не показувати',
      }),
      createdAt: 1_700_000_000_000,
    });

    expect(normalized.toolName).toBe('echo_api');
    expect(normalized.text).toBe('GET /api/user');
    expect(normalized.createdAt).toBe(1_700_000_000_000);
    expect(JSON.stringify(normalized)).not.toContain('не показувати');
  });
  it('normalizes structured API route and result fields', () => {
    const normalized = normalizeAiAgentEvent({
      activityPresentation: null,
      activityOnly: false,
      sequence: 3,
      eventType: 'tool_end',
      payloadJson: JSON.stringify({
        tool: 'echo_current_user',
        method: 'get',
        path: '/api/user',
        status: 200,
        is_error: false,
      }),
      createdAt: 1_700_000_000_000,
    });

    expect(normalized).toMatchObject({
      method: 'GET',
      path: '/api/user',
      status: 200,
      isError: false,
    });
  });

  it('uses a friendly tool error summary', () => {
    const normalized = normalizeAiAgentEvent({
      activityPresentation: null,
      activityOnly: false,
      sequence: 4,
      eventType: 'tool_end',
      payloadJson: JSON.stringify({
        tool: 'echo_interception_context',
        is_error: true,
        errorSummary: 'Не вдалося завантажити дані за вказаними параметрами.',
      }),
      createdAt: 1_700_000_000_000,
    });

    expect(normalized.text).toBe('Не вдалося завантажити дані за вказаними параметрами.');
  });
});

describe('providerOptionDisabled', () => {
  it('#4112 offers every enabled engine, also mid-conversation', () => {
    expect(providerOptionDisabled(true)).toBe(false);
    expect(providerOptionDisabled(false)).toBe(true);
  });
});
