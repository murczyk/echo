/**
 * @vitest-environment happy-dom
 */
import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessengersAttachmentItem } from '../../../../../../Bindings';

const apiMock = vi.hoisted(() => ({
  listMessengersAttachments: vi.fn(),
  countMessengersAttachments: vi.fn(),
}));
vi.mock('../../../../services/api/analysis-messengers', () => apiMock);

const downloadMock = vi.hoisted(() => ({ downloadBlob: vi.fn() }));
vi.mock('../../../../utils/download-blob', () => downloadMock);

// Virtuoso measures a real layout, which happy-dom does not have: render every item, and report "ready" the way the real
// ones do once the items are laid out, unless a test holds that back.
const virtuosoState = vi.hoisted(() => ({
  ready: true,
  report: null as null | ((ready: boolean) => void),
}));
vi.mock('react-virtuoso', () => {
  const list = ({
    data,
    itemContent,
    readyStateChanged,
    totalListHeightChanged,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => ReactNode;
    readyStateChanged?: (ready: boolean) => void;
    totalListHeightChanged?: (height: number) => void;
  }) => {
    virtuosoState.report = (ready) => {
      readyStateChanged?.(ready);
      totalListHeightChanged?.(ready ? 100 : 0);
    };
    useEffect(() => {
      if (virtuosoState.ready) virtuosoState.report?.(true);
    }, [readyStateChanged, totalListHeightChanged]);
    return (
      <div>
        {data.map((item, index) => (
          <div key={index}>{itemContent(index, item)}</div>
        ))}
      </div>
    );
  };
  return { Virtuoso: list, VirtuosoGrid: list };
});

// Counts how often a tile renders: `formatSizeBytes` runs once per render of a tile.
const sizeSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../../shared/message-card/message-card-image-utils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../shared/message-card/message-card-image-utils')>();
  return {
    ...actual,
    formatSizeBytes: (size: number | null | undefined) => {
      sizeSpy.calls += 1;
      return actual.formatSizeBytes(size);
    },
  };
});

import {
  messengerGallerySource,
  type GalleryDataSource,
  type GalleryTab,
} from '../../messenger-gallery';
import { MessengerGallery } from '../MessengerGallery';

const item = (
  id: string,
  contentType: string,
  fileName = `${id}.bin`,
): MessengersAttachmentItem => ({
  chatId: 'c1',
  messageId: `m-${id}`,
  sentAt: Date.UTC(2026, 7, 28),
  senderChatMemberId: null,
  attachment: {
    media: {
      id,
      contentType,
      fileName,
      sizeBytes: 2048,
      href: `/api/messenger/media/${id}`,
      transcription: null,
      ocr: null,
      summary: null,
      coordinateStatus: null,
      kmzConversionStatus: null,
      positions: [],
    },
    externalId: id,
    createdAt: null,
    telegram: null,
  },
});

const audio = (id: string) => item(id, 'audio/ogg', `${id}.ogg`);

describe('messengerGallerySource', () => {
  beforeEach(() => apiMock.listMessengersAttachments.mockReset());

  const ask = (tab: 'photo' | 'video' | 'audio' | 'document', cursor: string | null) =>
    messengerGallerySource.list(
      { accountId: 'a1', chatId: 'c1' },
      tab,
      cursor,
      new AbortController().signal,
    );

  it('asks for the Telegram types of the tab, a video note being a video and a voice message audio', async () => {
    apiMock.listMessengersAttachments.mockResolvedValue({ items: [], olderCursor: null });
    await ask('video', null);
    await ask('audio', null);
    const types = apiMock.listMessengersAttachments.mock.calls.map(
      ([req]) => req.telegramMediaTypes,
    );
    expect(types).toEqual([
      ['video', 'video_note'],
      ['voice', 'audio'],
    ]);
  });

  it('adds up the Telegram types of each tab, and counts 0 for a tab with none', async () => {
    apiMock.countMessengersAttachments.mockResolvedValue({
      items: [
        { telegramMediaType: 'photo', count: 12 },
        { telegramMediaType: 'video', count: 3 },
        { telegramMediaType: 'video_note', count: 4 },
        { telegramMediaType: 'voice', count: 5 },
        { telegramMediaType: 'audio', count: 1 },
        { telegramMediaType: null, count: 9 },
      ],
    });
    const counts = await messengerGallerySource.counts!(
      { accountId: 'a1', chatId: null },
      new AbortController().signal,
    );
    expect(counts).toEqual({ photo: 12, video: 7, audio: 6, document: 0 });
    expect(apiMock.countMessengersAttachments).toHaveBeenCalledWith(
      { accountId: 'a1', chatId: null },
      expect.anything(),
    );
  });

  it('asks for a small first page and the full page after it, and returns the page as it is', async () => {
    apiMock.listMessengersAttachments.mockResolvedValue({
      items: [audio('2')],
      olderCursor: 'older',
      newerCursor: 'newer',
    });
    const first = await ask('audio', null);
    await ask('audio', 'cursor-0');
    expect(apiMock.listMessengersAttachments).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ accountId: 'a1', chatId: 'c1', cursor: null, limit: 40 }),
      expect.anything(),
    );
    expect(apiMock.listMessengersAttachments).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: 'cursor-0', limit: 100 }),
      expect.anything(),
    );
    expect(first.items.map((entry) => entry.attachment.media.id)).toEqual(['2']);
    expect(first.olderCursor).toBe('older');
  });
});

describe('MessengerGallery', () => {
  let container: HTMLDivElement;
  let root: Root;
  const text = () => container.textContent ?? '';
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLElement>('button')].find((candidate) =>
      candidate.textContent?.includes(label),
    );
  const click = (element: Element | undefined | null) =>
    act(async () => (element as HTMLElement | undefined)?.click());
  const sourceOf = (
    pages: Partial<Record<GalleryTab, MessengersAttachmentItem[]>>,
    extra: Partial<GalleryDataSource> = {},
  ): GalleryDataSource => ({
    list: vi.fn(async (_scope, tab) => ({ items: pages[tab] ?? [], olderCursor: null })),
    ...extra,
  });
  const mount = (source: GalleryDataSource, onOpenMessage = vi.fn()) =>
    act(async () =>
      root.render(
        <MessengerGallery
          accountId="a1"
          chatId="c1"
          source={source}
          onOpenMessage={onOpenMessage}
        />,
      ),
    );

  beforeEach(() => {
    virtuosoState.ready = true;
    downloadMock.downloadBlob.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows the tabs without numbers and a disabled ZIP while the backend has no counts or archive', async () => {
    await mount(sourceOf({}));
    expect(text()).toContain('Фото');
    expect(text()).toContain('Документи');
    expect(text()).not.toMatch(/Фото \(/);
    expect(button('ZIP (0)')?.hasAttribute('disabled')).toBe(true);
    expect(text()).toContain('У цьому чаті немає медіа цього типу.');
  });

  it('puts the counts into the tab labels', async () => {
    const counts = vi.fn(async () => ({ photo: 12, video: 0, audio: 3, document: 1 }));
    await mount(sourceOf({}, { counts }));
    expect(text()).toContain('Фото (12)');
    expect(text()).toContain('Відео (0)');
    expect(text()).toContain('Аудіо (3)');
  });

  it('lists a tab on its own and switches tabs', async () => {
    const source = sourceOf({ audio: [audio('a1'), audio('a2')] });
    await mount(source);
    await click(button('Аудіо'));
    expect(source.list).toHaveBeenCalledWith(
      { accountId: 'a1', chatId: 'c1' },
      'audio',
      null,
      expect.anything(),
    );
    expect(container.querySelectorAll('[data-gallery-tile]')).toHaveLength(2);
    expect(text()).toContain('a1.ogg');
    expect(text()).toContain('28.08.26');
  });

  it('pages on until the cursor ends and keeps each item once', async () => {
    const list = vi.fn(async (_scope, tab: GalleryTab, cursor: string | null) =>
      tab !== 'audio'
        ? { items: [], olderCursor: null }
        : cursor == null
          ? { items: [audio('a1')], olderCursor: 'next' }
          : { items: [audio('a1'), audio('a2')], olderCursor: null },
    );
    await mount({ list });
    await click(button('Аудіо'));
    expect(list).toHaveBeenLastCalledWith(
      { accountId: 'a1', chatId: 'c1' },
      'audio',
      'next',
      expect.anything(),
    );
    expect(container.querySelectorAll('[data-gallery-tile]')).toHaveLength(2);
  });

  describe('tab cache', () => {
    const audioCalls = (source: GalleryDataSource) =>
      vi.mocked(source.list).mock.calls.filter(([, tab]) => tab === 'audio').length;
    const render = (source: GalleryDataSource, refreshToken = 0) =>
      act(async () =>
        root.render(
          <MessengerGallery
            accountId="a1"
            chatId="c1"
            source={source}
            refreshToken={refreshToken}
          />,
        ),
      );

    afterEach(() => vi.restoreAllMocks());

    it('shows a tab that was left again without asking, while it is fresh', async () => {
      const source = sourceOf({ audio: [audio('a1')] });
      await render(source);
      await click(button('Аудіо'));
      await click(button('Відео'));
      await click(button('Аудіо'));
      expect(audioCalls(source)).toBe(1);
      expect(container.querySelectorAll('[data-gallery-tile]')).toHaveLength(1);
    });

    it('shows the old items at once and asks for the first page again once it is stale', async () => {
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const pages = [[audio('a1')], [audio('b1'), audio('b2')]];
      const source: GalleryDataSource = {
        list: vi.fn(async (_scope, tab) => ({
          items: tab === 'audio' ? (pages.shift() ?? []) : [],
          olderCursor: null,
        })),
      };
      await render(source);
      await click(button('Аудіо'));
      await click(button('Відео'));
      now += 31_000;
      await click(button('Аудіо'));
      expect(audioCalls(source)).toBe(2);
      expect(container.querySelectorAll('[data-gallery-tile]')).toHaveLength(2);
      expect(text()).toContain('b1.ogg');
    });

    it('forgets the other tabs on a refresh and loads the open one again', async () => {
      const source = sourceOf({ audio: [audio('a1')] });
      await render(source);
      await click(button('Аудіо'));
      await click(button('Відео'));
      await render(source, 1);
      expect(vi.mocked(source.list).mock.calls.filter(([, tab]) => tab === 'video')).toHaveLength(
        2,
      );
      await click(button('Аудіо'));
      expect(audioCalls(source)).toBe(2);
    });
  });

  it('re-renders only the tile that changed when one is selected', async () => {
    await mount(sourceOf({ audio: [audio('a1'), audio('a2'), audio('a3')] }));
    await click(button('Аудіо'));
    expect(container.querySelectorAll('[data-gallery-tile]')).toHaveLength(3);
    sizeSpy.calls = 0;
    await click(container.querySelector('[data-gallery-tile="a2"] input[type="checkbox"]'));
    expect(
      (container.querySelector('[data-gallery-tile="a2"] input') as HTMLInputElement).checked,
    ).toBe(true);
    expect(sizeSpy.calls).toBe(1);
  });

  it('keeps the player of an audio row out of the page until the row is pressed, then plays', async () => {
    await mount(sourceOf({ audio: [audio('a1'), audio('a2')] }));
    await click(button('Аудіо'));
    expect(container.querySelector('[data-audio-player-host]')).toBeNull();
    expect(container.querySelector('[aria-label="Відтворити a1.ogg"]')).not.toBeNull();
    await click(container.querySelector('[aria-label="Відтворити a1.ogg"]'));
    expect(
      container.querySelectorAll('[data-gallery-tile="a1"] [data-audio-player-host]'),
    ).toHaveLength(1);
    expect(container.querySelector('[data-gallery-tile="a2"] [data-audio-player-host]')).toBeNull();
  });

  describe('a preview near the end of the loaded items', () => {
    const photos = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) =>
        item(`p${from + i}`, 'image/jpeg', `p${from + i}.jpg`),
      );
    const openPhoto = async (position: number) => {
      // Not laid out, so the scroll position alone asks for nothing: only the preview can.
      virtuosoState.ready = false;
      const list = vi.fn(async (_scope, tab: GalleryTab, cursor: string | null) =>
        tab !== 'photo'
          ? { items: [], olderCursor: null }
          : cursor == null
            ? { items: photos(0, 15), olderCursor: 'next' }
            : { items: photos(15, 30), olderCursor: null },
      );
      await mount({ list });
      expect(list).toHaveBeenCalledTimes(1);
      await click(container.querySelectorAll('[aria-label="Відкрити зображення"]')[position]);
      return list;
    };

    it('asks for the next page when it is opened close to the end', async () => {
      const list = await openPhoto(10);
      expect(list).toHaveBeenCalledTimes(2);
      expect(list).toHaveBeenLastCalledWith(
        { accountId: 'a1', chatId: 'c1' },
        'photo',
        'next',
        expect.anything(),
      );
    });

    it('asks for nothing while it is far from the end', async () => {
      const list = await openPhoto(0);
      expect(list).toHaveBeenCalledTimes(1);
    });
  });

  it('waits for the grid to be laid out before it asks for a second page', async () => {
    virtuosoState.ready = false;
    const list = vi.fn(async (_scope, tab: GalleryTab, cursor: string | null) =>
      tab !== 'audio'
        ? { items: [], olderCursor: null }
        : cursor == null
          ? { items: [audio('a1')], olderCursor: 'next' }
          : { items: [audio('a2')], olderCursor: null },
    );
    await mount({ list });
    await click(button('Аудіо'));
    expect(list.mock.calls.filter(([, , cursor]) => cursor === 'next')).toHaveLength(0);
    await act(async () => virtuosoState.report?.(true));
    expect(list.mock.calls.filter(([, , cursor]) => cursor === 'next')).toHaveLength(1);
  });

  it('selects the loaded items and takes them off again', async () => {
    await mount(sourceOf({ audio: [audio('a1'), audio('a2')] }));
    await click(button('Аудіо'));
    await click(button('Вибрати всі'));
    expect(text()).toContain('ZIP (2)');
    await click(button('Вибрати всі'));
    expect(text()).toContain('ZIP (0)');
  });

  it('selects every id of the tab when the backend lists them, and downloads the archive', async () => {
    const blob = new Blob(['zip']);
    const ids = vi.fn(async () => ['a1', 'a2', 'a3']);
    const zip = vi.fn(async () => blob);
    await mount(sourceOf({ audio: [audio('a1')] }, { ids, zip }));
    await click(button('Аудіо'));
    await click(button('Вибрати всі'));
    expect(ids).toHaveBeenCalledWith({ accountId: 'a1', chatId: 'c1' }, 'audio', expect.anything());
    expect(text()).toContain('ZIP (3)');
    await click(button('ZIP (3)'));
    expect(zip).toHaveBeenCalledWith(
      { accountId: 'a1', chatId: 'c1' },
      ['a1', 'a2', 'a3'],
      expect.anything(),
    );
    expect(downloadMock.downloadBlob).toHaveBeenCalledWith(blob, 'media_chat_c1.zip');
  });

  it('opens the message of an item', async () => {
    const onOpenMessage = vi.fn();
    await mount(sourceOf({ audio: [audio('a1')] }), onOpenMessage);
    await click(button('Аудіо'));
    await click(container.querySelector('[aria-label="Перейти до повідомлення"]'));
    expect(onOpenMessage).toHaveBeenCalledWith('c1', 'm-a1');
  });

  it('is the gallery of the account when no chat is given', async () => {
    const source = sourceOf({});
    await act(async () =>
      root.render(<MessengerGallery accountId="a1" chatId={null} source={source} />),
    );
    expect(source.list).toHaveBeenCalledWith(
      { accountId: 'a1', chatId: null },
      'photo',
      null,
      expect.anything(),
    );
    expect(container.querySelector('[aria-label="Медіа акаунта"]')).not.toBeNull();
    expect(text()).toContain('В акаунті немає медіа цього типу.');
  });

  it('says so when a page fails and tries again', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ items: [], olderCursor: null });
    await mount({ list });
    expect(text()).toContain('Повторити завантаження');
    await click(button('Повторити завантаження'));
    expect(list).toHaveBeenCalledTimes(2);
    expect(text()).not.toContain('Повторити завантаження');
  });
});
