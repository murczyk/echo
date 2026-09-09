/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MessageCardPreviewNavigation } from '../message-card-preview.types.ts';
import {
  MessageCardAttachmentPreviewProvider,
  type MessageCardPreviewAttachment,
} from '../MessageCardAttachmentPreviewProvider.tsx';

function PreviewStub({
  type,
  navigation,
}: {
  type: string;
  navigation?: MessageCardPreviewNavigation;
}) {
  return (
    <div data-preview-type={type}>
      <span>{`${(navigation?.index ?? 0) + 1} / ${navigation?.count ?? 1}`}</span>
      <button type="button" aria-label="Попереднє" onClick={navigation?.onPrevious} />
      <button type="button" aria-label="Наступне" onClick={navigation?.onNext} />
    </div>
  );
}

vi.mock('../MessageCardAttachmentPreviewDialog.tsx', () => ({
  MessageCardAttachmentPreviewDialog: ({
    item,
    navigation,
  }: {
    item: MessageCardPreviewAttachment;
    navigation: MessageCardPreviewNavigation;
  }) => (
    <div role="dialog" aria-label="Перегляд вкладення">
      <PreviewStub type={item.type} navigation={navigation} />
    </div>
  ),
}));

const attachments: MessageCardPreviewAttachment[] = [
  { type: 'image', value: { id: 'image-1', href: '/image.png' } },
  {
    type: 'video',
    value: { id: 'video-1', name: 'video.mp4', source: '/video.mp4' },
  },
  {
    type: 'document',
    value: { id: 'document-1', href: '/document.pdf', kind: 'pdf' },
  },
];

// @test-scope safeguard: prevents mixed attachment types from losing their shared carousel identity during preview navigation
describe('MessageCardAttachmentPreviewProvider', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it('uses one carousel to switch between attachment preview types', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () =>
      root?.render(
        <MessageCardAttachmentPreviewProvider
          attachments={attachments}
          initialIndex={0}
          onClose={() => {}}
          isDownloadStarting={() => false}
          onDownloadStart={() => true}
        />,
      ),
    );

    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-label')).toBe('Перегляд вкладення');
    expect(container.querySelector('[data-preview-type]')?.getAttribute('data-preview-type')).toBe(
      'image',
    );
    expect(container.textContent).toContain('1 / 3');

    await act(async () => {
      container
        ?.querySelector('button[aria-label="Наступне"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(container.querySelector('[role="dialog"]')).toBe(dialog);
    expect(container.querySelector('[data-preview-type]')?.getAttribute('data-preview-type')).toBe(
      'video',
    );
    expect(container.textContent).toContain('2 / 3');

    await act(async () => {
      container
        ?.querySelector('button[aria-label="Наступне"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(container.querySelector('[role="dialog"]')).toBe(dialog);
    expect(container.querySelector('[data-preview-type]')?.getAttribute('data-preview-type')).toBe(
      'document',
    );
    expect(container.textContent).toContain('3 / 3');

    await act(async () => {
      container
        ?.querySelector('button[aria-label="Наступне"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBe(dialog);
    expect(container.querySelector('[data-preview-type]')?.getAttribute('data-preview-type')).toBe(
      'image',
    );
    expect(container.textContent).toContain('1 / 3');
  });
});
