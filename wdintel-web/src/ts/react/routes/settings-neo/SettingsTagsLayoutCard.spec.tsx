/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsTagsLayoutCard } from './SettingsTagsLayoutCard';

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];

function renderCard(messageTextPreviewLines: 20 | 40 | null) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onTagsLayoutChange = vi.fn();
  const onMessageTextPreviewLinesChange = vi.fn();

  act(() => {
    root.render(
      <SettingsTagsLayoutCard
        title="Картка повідомлення"
        tagsLayout="full"
        onTagsLayoutChange={onTagsLayoutChange}
        messageTextPreviewLines={messageTextPreviewLines}
        onMessageTextPreviewLinesChange={onMessageTextPreviewLinesChange}
        loadInProgress={false}
        note="Спільні налаштування для Оперативного та Аналізу."
      />,
    );
  });

  mounted.push({ container, root });
  return { container, onMessageTextPreviewLinesChange };
}

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('SettingsTagsLayoutCard', () => {
  it('renders the shared card controls and explanations', () => {
    const { container } = renderCard(20);

    for (const text of [
      'Повний',
      'Щільний',
      'Без тегів',
      '20 рядків',
      '40 рядків',
      'Без скорочення',
      'Згортати перегляд довгих повідомлень:',
      'Визначає, коли з’являється кнопка «Показати більше».',
      'Спільні налаштування для Оперативного та Аналізу.',
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
});
