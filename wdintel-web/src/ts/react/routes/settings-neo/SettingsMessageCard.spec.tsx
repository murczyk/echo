/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsMessageCard } from './SettingsMessageCard';

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];

function renderCard(
  messageTextPreviewLines: 20 | 40 | null,
  mediaSummaryEnabled = true,
  collapseMediaPreviews = true,
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onTagsLayoutChange = vi.fn();
  const onMessageTextPreviewLinesChange = vi.fn();
  const onMediaSummaryEnabledChange = vi.fn();
  const onCollapseMediaPreviewsChange = vi.fn();

  act(() => {
    root.render(
      <SettingsMessageCard
        tagsLayout="full"
        onTagsLayoutChange={onTagsLayoutChange}
        messageTextPreviewLines={messageTextPreviewLines}
        onMessageTextPreviewLinesChange={onMessageTextPreviewLinesChange}
        messageSortBy="interception"
        onMessageSortByChange={vi.fn()}
        mediaSummaryEnabled={mediaSummaryEnabled}
        onMediaSummaryEnabledChange={onMediaSummaryEnabledChange}
        collapseMediaPreviews={collapseMediaPreviews}
        onCollapseMediaPreviewsChange={onCollapseMediaPreviewsChange}
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
    onCollapseMediaPreviewsChange,
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
      'Повний',
      'Щільний',
      'Без тегів',
      '20 рядків',
      '40 рядків',
      'Без скорочення',
      'Згортати перегляд довгих повідомлень:',
      'Визначає, коли з’являється кнопка «Показати більше».',
      'Стислий опис файлів',
      'Відображати блок стислого опису для зображень та документів у картках повідомлень стрічки.',
      'Спільні налаштування для Оперативного та Аналізу.',
    ]) {
      expect(container.textContent).toContain(text);
    }
  });

  it('keeps the shared message-card settings in their semantic order', () => {
    const { container } = renderCard(20);
    const preview = container.querySelector('[data-message-card-mock="true"]');
    expect(preview).not.toBeNull();
    const orderedItems = [
      'Відображення тегів:',
      'Стислий опис файлів',
      'Згортати вкладення',
      'Згортати перегляд довгих повідомлень:',
      'Спільні налаштування для Оперативного та Аналізу.',
    ].map((text) =>
      Array.from(container.querySelectorAll('*')).find((item) => item.textContent === text),
    );
    const nodes = [
      orderedItems[0],
      orderedItems[1],
      orderedItems[2],
      preview,
      orderedItems[3],
      orderedItems[4],
    ];

    for (let index = 0; index < nodes.length - 1; index += 1) {
      expect(nodes[index]).toBeDefined();
      expect(
        Boolean(
          nodes[index]?.compareDocumentPosition(nodes[index + 1] ?? document.body) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).toBe(true);
    }
  });

  // https://github.com/echoua/echo/issues/3455
  it('places message sorting immediately after the long-message setting', () => {
    const { container } = renderCard(20, true, true);
    const previewToggle = Array.from(container.querySelectorAll('*')).find(
      (item) => item.textContent === 'Згортати перегляд довгих повідомлень:',
    );
    const sorting = Array.from(container.querySelectorAll('*')).find(
      (item) => item.textContent === 'Сортування:',
    );

    expect(previewToggle).toBeDefined();
    expect(sorting).toBeDefined();
    expect(
      Boolean(
        previewToggle?.compareDocumentPosition(sorting ?? document.body) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(container.textContent).toContain('За датою перехоплення');
    expect(container.textContent).toContain('За датою створення');
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

  it.each([true, false])('reflects the collapsed-attachment preference %s', (value) => {
    const { container } = renderCard(20, true, value);
    const label = Array.from(container.querySelectorAll('label')).find((item) =>
      item.textContent?.includes('Згортати вкладення'),
    );
    expect(label?.querySelector('input[type="checkbox"]')).toHaveProperty('checked', value);
  });

  it('changes the collapsed-attachment preference', () => {
    const { container, onCollapseMediaPreviewsChange } = renderCard(20, true, true);
    const label = Array.from(container.querySelectorAll('label')).find((item) =>
      item.textContent?.includes('Згортати вкладення'),
    );
    const input = label?.querySelector('input[type="checkbox"]');
    act(() => input?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onCollapseMediaPreviewsChange).toHaveBeenCalledWith(false);
  });
});
