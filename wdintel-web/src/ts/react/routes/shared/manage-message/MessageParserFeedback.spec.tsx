// @vitest-environment happy-dom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageParserFeedbackProvider, ParserFieldFeedback } from './MessageParserFeedback';
import type { ParserFeedback } from './message-parser-ownership';

describe('MessageParserFeedback', () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderFeedback = async (
    feedback: ParserFeedback | null,
    onAccept = vi.fn(),
    children: ReactNode = <input aria-label="Частота" />,
  ) => {
    await act(async () => {
      root.render(
        <MessageParserFeedbackProvider feedback={feedback} onAccept={onAccept}>
          <ParserFieldFeedback field="freq" label="частоту">
            {children}
          </ParserFieldFeedback>
        </MessageParserFeedbackProvider>,
      );
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('shows an updated field without rendering a summary', async () => {
    await renderFeedback({
      sequence: 1,
      changedFields: ['freq', 'coords'],
      conflictFields: [],
    });

    expect(
      container.querySelector('[data-testid="parser-feedback-freq"]')?.getAttribute('data-state'),
    ).toBe('updated');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('offers the current parsed candidate for a conflict', async () => {
    const onAccept = vi.fn();
    await renderFeedback({ sequence: 1, changedFields: [], conflictFields: ['freq'] }, onAccept);

    const button = container.querySelector(
      'button[aria-label="Взяти частоту із тексту"]',
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    await act(async () => button.click());
    expect(onAccept).toHaveBeenCalledWith('freq');
  });

  it('keeps a conflict visible until the user resolves it', async () => {
    vi.useFakeTimers();
    const onAccept = vi.fn();
    await renderFeedback({ sequence: 1, changedFields: [], conflictFields: ['freq'] }, onAccept);

    await act(async () => vi.advanceTimersByTime(30_000));

    expect(
      container.querySelector('[data-testid="parser-feedback-freq"]')?.getAttribute('data-state'),
    ).toBe('conflict');
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('hides a successful update highlight after 3000 ms', async () => {
    vi.useFakeTimers();
    await renderFeedback({ sequence: 1, changedFields: ['freq'], conflictFields: [] });

    await act(async () => vi.advanceTimersByTime(3000));

    expect(
      container.querySelector('[data-testid="parser-feedback-freq"]')?.getAttribute('data-state'),
    ).toBe('idle');
  });

  it('restarts the expiry timer for a newer feedback sequence', async () => {
    vi.useFakeTimers();
    await renderFeedback({ sequence: 1, changedFields: ['freq'], conflictFields: [] });
    await act(async () => vi.advanceTimersByTime(2500));

    await renderFeedback({ sequence: 2, changedFields: [], conflictFields: ['freq'] });
    await act(async () => vi.advanceTimersByTime(2500));
    expect(
      container.querySelector('[data-testid="parser-feedback-freq"]')?.getAttribute('data-state'),
    ).toBe('conflict');

    await act(async () => vi.advanceTimersByTime(30_000));
    expect(
      container.querySelector('[data-testid="parser-feedback-freq"]')?.getAttribute('data-state'),
    ).toBe('conflict');
  });

  it('labels acceptance as removal when the latest parse has no value', async () => {
    const feedback: ParserFeedback = {
      sequence: 1,
      changedFields: [],
      conflictFields: ['freq'],
      emptyCandidateFields: ['freq'],
    };

    await renderFeedback(feedback);

    expect(
      container.querySelector('button[aria-label="Прибрати частоту: у тексті значення немає"]')
        ?.textContent,
    ).toBe('Прибрати значення');
  });
});
