/**
 * @vitest-environment happy-dom
 */
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Skeleton } from '@mui/material';

import type { InboxMessage, Tag } from '../../../../../../../Bindings';
import { MessageCardContent } from '../../MessageCardContent';

const previewDialogProps: Array<{ types: string[]; currentIndex: number }> = [];

vi.mock('../../MessageCardCoordinateAttachment', () => ({
  MessageCardCoordinateAttachment: ({
    onPointsChange,
    onOpen,
  }: {
    onPointsChange?: (points: Array<Record<string, unknown>>) => void;
    onOpen?: (index: number) => void;
  }) => (
    <>
      <Skeleton variant="rounded" height={150} />
      <button
        type="button"
        data-coordinate-ready
        onClick={() =>
          onPointsChange?.([
            { source: 'direct', lat: 50.45, lng: 30.52, label: 'point' },
            { source: 'direct', lat: 50.46, lng: 30.53, label: 'point 2' },
          ])
        }
      />
      <button type="button" data-coordinate-open onClick={() => onOpen?.(0)} />
    </>
  ),
}));

vi.mock('../../attachment-preview/MessageCardAttachmentPreviewProvider', () => ({
  MessageCardAttachmentPreviewProvider: ({
    attachments,
    initialIndex,
  }: {
    attachments: Array<{ type: string }>;
    initialIndex: number;
  }) => {
    previewDialogProps.push({
      types: attachments.map((attachment) => attachment.type),
      currentIndex: initialIndex,
    });
    return <div role="dialog" />;
  },
}));

function createMessage(overrides: Partial<InboxMessage>): InboxMessage {
  return {
    messageUid: null,
    text: '',
    media: [],
    images: [],
    imageRecognized: [],
    date: null,
    time: null,
    freq: null,
    coords: null,
    callsigns: [],
    callsignsAlg2: [],
    checked: false,
    important: false,
    bookmarked: false,
    timestamp: null,
    groupMasterKey: null,
    sender: null,
    extendedForm: null,
    messageComments: [],
    post: null,
    inboxTags: [],
    pointTokens: [],
    textMarked: [],
    ...overrides,
  } as InboxMessage;
}

describe('MessageCardContent coordinate preview guard', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    previewDialogProps.splice(0);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    document.body.innerHTML = '';
  });

  it('does not render the preview skeleton for ordinary text', () => {
    const msg = createMessage({
      text: 'Routine message with no coordinates',
    });

    act(() => {
      root.render(<MessageCardContent msg={msg} tagsMap={{}} onToggleTag={vi.fn()} />);
    });

    expect(container.querySelector('.MuiSkeleton-root')).toBeNull();
  });

  it.each([
    ['50.45044, 30.52355', { text: '50.45044, 30.52355' }],
    ['X=5012345\\nY=5034567', { text: 'X=5012345\nY=5034567' }],
    ['33T 292332 4642055', { text: '33T 292332 4642055' }],
  ])('renders the preview path for %s without Palitra tags', (_label, overrides) => {
    const msg = createMessage(overrides as Partial<InboxMessage>);

    act(() => {
      root.render(<MessageCardContent msg={msg} tagsMap={{}} onToggleTag={vi.fn()} />);
    });

    expect(container.querySelector('.MuiSkeleton-root')).not.toBeNull();
  });

  it('does not render a coordinate preview for untagged point tokens', () => {
    const msg = createMessage({
      text: 'routine',
      pointTokens: [{ etalon: 'BRAVO' }],
    });

    act(() => {
      root.render(<MessageCardContent msg={msg} tagsMap={{}} onToggleTag={vi.fn()} />);
    });

    expect(container.querySelector('.MuiSkeleton-root')).toBeNull();
  });

  it('renders a coordinate preview for Palitra-tagged point tokens', () => {
    const tagsMap = {
      7: { isPalitra: true } as Tag,
    };
    const msg = createMessage({
      text: 'routine',
      inboxTags: [{ tagId: 7 }],
      pointTokens: [{ etalon: 'BRAVO' }],
    });

    act(() => {
      root.render(<MessageCardContent msg={msg} tagsMap={tagsMap} onToggleTag={vi.fn()} />);
    });

    expect(container.querySelector('.MuiSkeleton-root')).not.toBeNull();
  });

  it('adds resolved coordinates to the same attachment carousel', () => {
    const msg = createMessage({
      text: '50.45044, 30.52355',
      images: ['https://example.test/image.png'],
    });

    act(() => {
      root.render(<MessageCardContent msg={msg} tagsMap={{}} onToggleTag={vi.fn()} />);
    });
    act(() => {
      container
        .querySelector('[data-coordinate-ready]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    act(() => {
      container
        .querySelector('[data-coordinate-open]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(previewDialogProps.at(-1)).toEqual({
      types: ['image', 'coordinate'],
      currentIndex: 1,
    });
  });
});
