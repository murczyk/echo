/**
 * @vitest-environment happy-dom
 */
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Skeleton } from '@mui/material';

import type { InboxMessage } from '../../../../../Bindings';
import { MessageCardContent } from './MessageCardContent';

vi.mock('./MessageCardCoordinatePreview', () => ({
  MessageCardCoordinatePreview: () => <Skeleton variant="rounded" height={150} />,
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
  ])('renders the preview path for %s', (_label, overrides) => {
    const msg = createMessage(overrides as Partial<InboxMessage>);

    act(() => {
      root.render(<MessageCardContent msg={msg} tagsMap={{}} onToggleTag={vi.fn()} />);
    });

    expect(container.querySelector('.MuiSkeleton-root')).not.toBeNull();
  });
});
