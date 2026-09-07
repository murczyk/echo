import { describe, expect, it } from 'vitest';

import { normalizeAiAgentEvent, type AiAgentEvent } from '../../services/api/ai-agent';
import {
  AI_AGENT_CHAT_CARD_HEIGHT,
  applyAiAgentEvent,
  historyPaneMotionStyles,
  providerOptionDisabled,
  type LiveRequest,
} from '.';

describe('AI_AGENT_CHAT_CARD_HEIGHT', () => {
  it('fills the height assigned by the application shell', () => {
    expect(AI_AGENT_CHAT_CARD_HEIGHT).toBe('100%');
  });
});

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
        id: 'echo_api',
        name: 'Завантаження даних',
        status: 'running',
        summary: 'Запит до /api/user',
        method: null,
        path: null,
        httpStatus: null,
      },
    ]);
    expect(tool.assistantText).toBe('');
  });

  it('deduplicates progress and repeated tools while retaining the latest state', () => {
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
    expect(repeated.tools).toHaveLength(1);
    expect(repeated.tools[0]).toMatchObject({
      name: 'Аналіз щоденної активності',
      status: 'failed',
    });
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

  // @test-scope parser: persisted AI-agent event payload fixture that excludes non-displayable reasoning fields.
  it('normalizes persisted event payloads without exposing reasoning fields', () => {
    const normalized = normalizeAiAgentEvent({
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

  // @test-scope parser: structured AI-agent tool result payload fixture.
  it('normalizes structured API route and result fields', () => {
    const normalized = normalizeAiAgentEvent({
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

describe('historyPaneMotionStyles', () => {
  it('uses a 200 ms desktop width transition and a mobile overlay translation', () => {
    const closed = historyPaneMotionStyles(false);
    const open = historyPaneMotionStyles(true);

    expect(closed.width).toEqual({ xs: 'min(82%, 300px)', sm: 0 });
    expect(closed.position).toEqual({ xs: 'absolute', sm: 'relative' });
    expect(closed.transform.xs).toBe('translateX(-100%)');
    expect(open.width.sm).toBe(300);
    expect(open.opacity).toBe(1);
    expect(open.transition).toContain('width 200ms');
    expect(open.transition).toContain('transform 200ms');
    expect(open.transition).toContain('opacity 200ms');
    expect(open['@media (prefers-reduced-motion: reduce)'].transition).toBe('none');
  });
});

describe('providerOptionDisabled', () => {
  it('keeps the standard selector enabled while locking incompatible options', () => {
    expect(providerOptionDisabled(true, 'conversation-1', 'provider-1', 'provider-1')).toBe(false);
    expect(providerOptionDisabled(true, 'conversation-1', 'provider-1', 'provider-2')).toBe(true);
    expect(providerOptionDisabled(false, null, 'provider-1', 'provider-2')).toBe(true);
  });
});
