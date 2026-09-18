/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsMessageCard } from '../SettingsMessageCard';

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];

function renderCard() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <SettingsMessageCard
        tagsLayout="full"
        onTagsLayoutChange={vi.fn()}
        messageTextPreviewLines={20}
        onMessageTextPreviewLinesChange={vi.fn()}
        messageSortBy="interception"
        onMessageSortByChange={vi.fn()}
        mediaSummaryEnabled
        onMediaSummaryEnabledChange={vi.fn()}
        collapseMediaPreviews
        onCollapseMediaPreviewsChange={vi.fn()}
        loadInProgress={false}
      />,
    );
  });

  mounted.push({ container, root });
  return container;
}

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('SettingsMessageCard', () => {
  // @test-scope regression: https://github.com/echoua/echo/issues/3455
  it('places message sorting immediately after the long-message setting', () => {
    const container = renderCard();
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
  });
});
