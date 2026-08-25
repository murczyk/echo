/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsMessageCard } from './SettingsMessageCard';

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];

function renderCard(messageTextPreviewLines: 20 | 40 | null, mediaSummaryEnabled = true) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onTagsLayoutChange = vi.fn();
  const onMessageTextPreviewLinesChange = vi.fn();
  const onMediaSummaryEnabledChange = vi.fn();

  act(() => {
    root.render(
      <SettingsMessageCard
        tagsLayout="full"
        onTagsLayoutChange={onTagsLayoutChange}
        messageTextPreviewLines={messageTextPreviewLines}
        onMessageTextPreviewLinesChange={onMessageTextPreviewLinesChange}
        mediaSummaryEnabled={mediaSummaryEnabled}
        onMediaSummaryEnabledChange={onMediaSummaryEnabledChange}
        loadInProgress={false}
      />,
    );
  });

  mounted.push({ container, root });
  return {
    container,
    onTagsLayoutChange,
    onMessageTextPreviewLinesChange,
    onMediaSummaryEnabledChange,
  };
}

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('SettingsMessageCard', () => {
  it('renders the shared card controls and explanations', () => {
    const { container } = renderCard(20);

    for (const text of [
      'Картка повідомлення',
      'Відображення тегів:',
      'повний',
      'щільний',
      'без тегів',
      '20 рядків',
      '40 рядків',
      'Без скорочення',
      'Згортати перегляд довгих повідомлень:',
      'Визначає, коли з’являється кнопка «Показати більше».',
      'Стислий опис файлів у картках',
      'Відображати блок стислого опису для зображень та документів у картках повідомлень стрічки.',
    ]) {
      expect(container.textContent).toContain(text);
    }
  });

  it.each([
    [20, '20 рядків'],
    [40, '40 рядків'],
    [null, 'Без скорочення'],
  ] as const)('ignores clicking the active %s preview option', (value, label) => {
    const { container, onMessageTextPreviewLinesChange } = renderCard(value);

    const option = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === label,
    );
    expect(option).toBeDefined();

    act(() => option?.click());

    expect(onMessageTextPreviewLinesChange).not.toHaveBeenCalled();
  });

  it.each([
    [20, '40 рядків', 40],
    [40, '20 рядків', 20],
    [20, 'Без скорочення', null],
  ] as const)('passes the app value when selecting %s', (currentValue, label, expectedValue) => {
    const { container, onMessageTextPreviewLinesChange } = renderCard(currentValue);

    const option = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === label,
    );
    expect(option).toBeDefined();

    act(() => option?.click());

    expect(onMessageTextPreviewLinesChange).toHaveBeenCalledOnce();
    expect(onMessageTextPreviewLinesChange).toHaveBeenCalledWith(expectedValue);
  });

  it('triggers media summary toggle change', () => {
    const { container, onMediaSummaryEnabledChange } = renderCard(20, true);

    const checkbox = container.querySelector('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();

    act(() => {
      checkbox?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onMediaSummaryEnabledChange).toHaveBeenCalledWith(false);
  });
});
