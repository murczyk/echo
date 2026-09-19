/**
 * @vitest-environment happy-dom
 */
import type { ComponentProps } from 'react';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage, MessageMediaInfo, Network, Tag } from '../../../../../../Bindings.ts';
import { emptyFilter } from '../../../rer-duty-neo/utils.ts';
import { formatMessageCardTooltipTime, MessageCard } from '../MessageCard.tsx';
import { MessageCardHeader, MessageCardMetadata } from '../MessageCardHeader.tsx';
import {
  canDownloadAllMessageAttachments,
  isAudioMediaAttachment,
  isVideoMediaAttachment,
  RER_MESSAGE_ATTACHMENTS_ZIP_MAX_FILES,
  RER_MESSAGE_ATTACHMENTS_ZIP_MAX_TOTAL_BYTES,
  MESSAGE_CARD_DOWNLOAD_START_COOLDOWN_MS,
} from '../MessageCardMedia.tsx';
import { MessageDeviceAccessProvider } from '../MessageDeviceAccess.tsx';
import { resolveMessageCardEtalonDisplayModel } from '../message-card.utils.ts';

const observedPopoverAnchors: Array<HTMLElement | null> = [];

vi.mock('@mui/material', async () => {
  const material = await vi.importActual<typeof import('@mui/material')>('@mui/material');
  return {
    ...material,
    Popover: (props: React.ComponentProps<typeof material.Popover>) => {
      observedPopoverAnchors.push(props.anchorEl as HTMLElement | null);
      return <material.Popover {...props} />;
    },
  };
});

type Rendered = {
  container: HTMLDivElement;
  root: Root;
  props: ComponentProps<typeof MessageCard>;
};
const rendered: Rendered[] = [];

function buildMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    text: 'Повідомлення',
    freq: '153.6250',
    bookmarked: false,
    important: false,
    sender: 'sender-1',
    groupMasterKey: 'group-1',
    networkIds: [7],
    tags: [3],
    inboxTags: [{ id: 1, tagId: 3, confidence: 1, login: 'tester', model: null, organismId: null }],
    timestamp: 1_709_999_940_000,
    time: '02:45',
    date: '2026-03-23',
    callsigns: [],
    callsignsAlg2: [],
    location: null,
    pointTokens: [],
    textMarked: [],
    metadata: [],
    ...overrides,
  } as InboxMessage;
}

async function renderCard(overrides: Partial<ComponentProps<typeof MessageCard>> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const props = {
    id: 42,
    msg: buildMessage(),
    feedCount: 1,
    referenceTimeMs: 1_710_000_000_000,
    authUserName: 'tester',
    groupName: 'Group',
    senderName: 'Sender',
    copiedFeedbackId: null,
    networkDisplayMap: { 7: 'р/м Alpha' },
    networkMap: { 7: { id: 7, name: 'Alpha', unitIds: [], location: null } as Network },
    tagsMap: { 3: { id: 3, label: 'переміщення', isPalitra: false } as Tag },
    filterState: emptyFilter(),
    collapseMediaPreviews: false,
    onBookmark: vi.fn(),
    onImportant: vi.fn(),
    onCopyText: vi.fn(),
    onCopyFreq: vi.fn(),
    onCopyEtalon: vi.fn(),
    onCopyLocation: vi.fn(),
    onAddFrequencyToFilter: vi.fn(),
    onCreateReport: vi.fn(),
    onExcludeMessageEntity: vi.fn(),
    onToggleTag: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  } as ComponentProps<typeof MessageCard>;
  await act(async () => root.render(<MessageCard {...props} />));
  const view = { container, root, props };
  rendered.push(view);
  return view;
}

async function renderHeader(allowed: boolean | undefined) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const msg = buildMessage({ deviceName: 'Радіостанція' });
  const etalonDisplayModel = resolveMessageCardEtalonDisplayModel(msg, {
    featureStrictNetworks: false,
    networkDisplayMap: { 7: 'р/м Alpha' },
    networkMap: { 7: { id: 7, name: 'Alpha', unitIds: [], location: null } as Network },
    networks: undefined,
  });
  const props = {
    compact: true,
    displayMode: 'duty',
    excludeMenuOptions: [],
    id: 42,
    msg,
    copiedFeedbackId: null,
    groupName: 'Group',
    senderName: 'Sender',
    etalonDisplayModel,
    mapHref: undefined,
    analysisHref: undefined,
    rightInsetPx: 0,
    topRight: <div />,
    onBookmark: vi.fn(),
    onImportant: vi.fn(),
    onCreateReport: vi.fn(),
    onCopyText: vi.fn(),
    onCopyFreq: vi.fn(),
    onCopyEtalon: vi.fn(),
    onCopyLocation: vi.fn(),
    onAddFrequencyToFilter: vi.fn(),
    onDelete: vi.fn(),
    onEditDetails: vi.fn(),
    onExcludeMessageEntity: vi.fn(),
  } as ComponentProps<typeof MessageCardHeader>;
  const content = (
    <>
      <MessageCardHeader {...props} />
      <MessageCardMetadata
        msg={msg}
        groupName="Group"
        senderName="Sender"
        etalonDisplayModel={etalonDisplayModel}
      />
    </>
  );
  await act(async () => {
    root.render(
      allowed === undefined ? (
        content
      ) : (
        <MessageDeviceAccessProvider allowed={allowed}>{content}</MessageDeviceAccessProvider>
      ),
    );
  });
  const view = { container, root, props: {} as ComponentProps<typeof MessageCard> };
  rendered.push(view);
  return view;
}

function button(container: HTMLElement, label: string) {
  const result = [...container.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(label),
  );
  if (!(result instanceof HTMLButtonElement)) throw new Error(`missing ${label}`);
  return result;
}

async function click(element: HTMLElement) {
  await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

async function downloadClick(element: HTMLElement) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  await act(async () => element.dispatchEvent(event));
  return event;
}

async function openOverflowMenu(container: HTMLElement) {
  const overflow = container.querySelector('button[aria-label="Більше дій"]');
  if (!(overflow instanceof HTMLElement)) throw new Error('missing overflow menu');
  await click(overflow);
}

afterEach(() => {
  for (const view of rendered.splice(0)) {
    act(() => view.root.unmount());
    view.container.remove();
  }
  observedPopoverAnchors.splice(0);
  vi.restoreAllMocks();
});

describe('MessageCard', () => {
  // Regression: https://github.com/echoua/echo/issues/3461
  it('ECHO-3461 hides device metadata without device access', async () => {
    const view = await renderHeader(false);
    expect(view.container.querySelector('[title="Пристрій"]')).toBeNull();
    expect(view.container.textContent).not.toContain('Радіостанція');
  });

  // Regression: https://github.com/echoua/echo/issues/3461
  it('ECHO-3461 hides device metadata without a provider', async () => {
    const view = await renderHeader(undefined);
    expect(view.container.querySelector('[title="Пристрій"]')).toBeNull();
    expect(view.container.textContent).not.toContain('Радіостанція');
  });

  // Regression: https://github.com/echoua/echo/issues/3461
  it('ECHO-3461 shows device metadata with an allowed provider', async () => {
    const view = await renderHeader(true);
    expect(view.container.querySelector('[title="Пристрій"]')).not.toBeNull();
    expect(view.container.textContent).toContain('Радіостанція');
  });

  // Regression: https://github.com/echoua/echo/issues/3515
  it.each(['interception', 'creation'] as const)(
    '#3515 hides all generated times for a date-only message (%s)',
    async (messageTimeBasis) => {
      const view = await renderCard({
        messageTimeBasis,
        msg: buildMessage({
          text: 'Повідомлення без часу',
          textMarked: [],
          timestamp: Date.UTC(2026, 6, 15, 9),
          createdAt: Date.UTC(2026, 6, 15, 10),
          date: '15.07.2026',
          time: '12:00:00',
          isTimeNull: true,
          hasDateInHeader: false,
        }),
      });
      expect(view.container.textContent).toContain('15.07');
      expect(view.container.textContent).not.toContain('12:00');
      expect(view.container.querySelector('.message-card-relative-time')).toBeNull();
      expect(
        view.container.querySelectorAll('[data-message-card-timestamp-item="true"]'),
      ).toHaveLength(messageTimeBasis === 'creation' ? 2 : 1);
      expect(
        formatMessageCardTooltipTime({
          time: '12:00',
          timestamp: Date.UTC(2026, 6, 15, 9),
          isTimeNull: true,
        }),
      ).not.toContain('12:00');
    },
  );

  // Regression: https://github.com/echoua/echo/issues/3515
  it.each(['interception', 'creation'] as const)(
    '#3515 shows creation and event dates independently in analysis (%s)',
    async (messageTimeBasis) => {
      for (const isTimeNull of [true, false, null]) {
        const view = await renderCard({
          displayMode: 'analysis',
          messageTimeBasis,
          msg: buildMessage({
            text: 'Повідомлення',
            textMarked: [],
            createdAt: Date.UTC(2026, 6, 16, 21, 30),
            timestamp: Date.UTC(2026, 6, 15, 9),
            date: '14.07.2026',
            time: '08:45:00',
            isTimeNull,
          }),
        });
        const timestamps = view.container.querySelectorAll(
          '[data-message-card-timestamp-item="true"]',
        );
        if (messageTimeBasis === 'creation') {
          expect(timestamps).toHaveLength(2);
          expect(timestamps[0]?.textContent).toContain('17.07, 00:30');
          expect(timestamps[0]?.getAttribute('title')).toBe('Дата і час створення повідомлення');
          expect(timestamps[1]?.getAttribute('title')).toBe('Дата і час перехоплення');
          expect(timestamps[1]?.textContent).toContain(isTimeNull ? '14.07' : '14.07, 08:45');
          if (isTimeNull) expect(timestamps[1]?.textContent).not.toContain(':');
          expect(timestamps[0]?.querySelector('svg')).toBeNull();
          expect(timestamps[1]?.querySelector('[data-testid="TodayOutlinedIcon"]')).not.toBeNull();
          expect(timestamps[1]?.querySelector('.message-card-header-icon')).not.toBeNull();
          expect(timestamps[1]?.querySelector('.message-card-timestamp-icon')).toBeNull();
        } else {
          expect(timestamps).toHaveLength(1);
          expect(timestamps[0]?.getAttribute('title')).toBe('Дата і час перехоплення');
          expect(timestamps[0]?.textContent).toContain(isTimeNull ? '14.07' : '14.07, 08:45');
          if (isTimeNull) expect(timestamps[0]?.textContent).not.toContain(':');
          expect(timestamps[0]?.querySelector('[data-testid="TodayOutlinedIcon"]')).not.toBeNull();
          expect(timestamps[0]?.querySelector('.message-card-header-icon')).not.toBeNull();
          expect(timestamps[0]?.querySelector('.message-card-timestamp-icon')).toBeNull();
        }
      }
    },
  );

  // Regression: https://github.com/echoua/echo/issues/3515
  it.each([
    { date: '2026-07-14', time: '08:45:00', isTimeNull: false, expected: '14.07, 08:45' },
    { date: null, time: null, isTimeNull: false, expected: '15.07, 12:00' },
    { date: null, time: null, isTimeNull: true, expected: '15.07' },
  ])(
    '#3515 formats analysis event dates with timestamp fallback ($expected)',
    async ({ expected, ...fields }) => {
      const view = await renderCard({
        displayMode: 'analysis',
        msg: buildMessage({ ...fields, timestamp: Date.UTC(2026, 6, 15, 9) }),
      });
      expect(
        view.container.querySelector('[title="Дата і час перехоплення"]')?.textContent,
      ).toContain(expected);
      if (fields.isTimeNull) {
        expect(
          view.container.querySelector('[title="Дата і час перехоплення"]')?.textContent,
        ).not.toContain(':');
      }
    },
  );

  // Regression: https://github.com/echoua/echo/issues/3324
  it('ECHO-3324 cancels the matching mixed-provenance bot-tag action', async () => {
    const onCancelBotTagAction = vi.fn();
    const view = await renderCard({
      msg: buildMessage({
        inboxTags: [
          { id: 1, tagId: 3, confidence: 1, login: 'tester', model: null, organismId: 1 },
          { id: 2, tagId: 3, confidence: 0.92, login: null, model: 'bot', organismId: null },
        ],
      }),
      botTagAction: { messageId: 42, tagId: 3 },
      onCancelBotTagAction,
      onMarkBotTagWrong: vi.fn(),
    });
    await click(button(document.body, 'СКАСУВАТИ'));
    expect(onCancelBotTagAction).toHaveBeenCalledOnce();
  });

  // Regression: https://github.com/echoua/echo/issues/3324
  it('ECHO-3324 confirms the matching bot-tag action exactly once', async () => {
    const onMarkBotTagWrong = vi.fn();
    await renderCard({
      msg: buildMessage({
        inboxTags: [
          { id: 1, tagId: 3, confidence: 1, login: 'tester', model: null, organismId: 1 },
          { id: 2, tagId: 3, confidence: 0.92, login: null, model: 'bot', organismId: null },
        ],
      }),
      botTagAction: { messageId: 42, tagId: 3 },
      onMarkBotTagWrong,
      onCancelBotTagAction: vi.fn(),
    });
    await click(button(document.body, 'БОТ ПОМИЛИВСЯ'));
    expect(onMarkBotTagWrong).toHaveBeenCalledOnce();
    expect(onMarkBotTagWrong).toHaveBeenCalledWith(42, 3);
  });

  // Regression: https://github.com/echoua/echo/issues/3324
  it('ECHO-3324 retains the matching bot-tag anchor through unrelated card rerenders', async () => {
    const onCancelBotTagAction = vi.fn();
    const onMarkBotTagWrong = vi.fn();
    const view = await renderCard({
      msg: buildMessage({
        inboxTags: [
          { id: 1, tagId: 3, confidence: 1, login: 'tester', model: null, organismId: 1 },
          { id: 2, tagId: 3, confidence: 0.92, login: null, model: 'bot', organismId: null },
        ],
      }),
      botTagAction: { messageId: 42, tagId: 3 },
      onCancelBotTagAction,
      onMarkBotTagWrong,
    });
    const anchor = observedPopoverAnchors.at(-1);
    expect(anchor).toBeInstanceOf(HTMLElement);

    await act(async () => {
      view.root.render(<MessageCard {...view.props} messageTextPreviewLines={40} />);
    });

    expect(observedPopoverAnchors.at(-1)).toBe(anchor);
    expect(onCancelBotTagAction).not.toHaveBeenCalled();
    expect(onMarkBotTagWrong).not.toHaveBeenCalled();
  });

  // Regression: https://github.com/echoua/echo/issues/3324
  it.each([
    ['read-only card', { readOnly: true }],
    ['disabled bot tags', { hideBotTags: true }],
    ['different message', { botTagAction: { messageId: 43, tagId: 3 } }],
    ['missing tag', { botTagAction: { messageId: 42, tagId: 99 } }],
  ] as const)('ECHO-3324 does not open a bot-action Popover for a %s', async (_, overrides) => {
    await renderCard({
      botTagAction: { messageId: 42, tagId: 3 },
      onCancelBotTagAction: vi.fn(),
      onMarkBotTagWrong: vi.fn(),
      ...overrides,
    });
    expect(observedPopoverAnchors).toHaveLength(0);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
  it('classifies ambiguous video and snake-case audio metadata', () => {
    const video = {
      id: 'mpeg',
      href: '/media/mpeg',
      contentType: 'video/mp2t',
      fileName: 'clip.ts',
      sizeBytes: 1,
    } as MessageMediaInfo;
    const audio = {
      id: 'audio',
      href: '/media/audio',
      content_type: 'audio/mpeg',
      file_name: 'voice.mp3',
      size_bytes: 1,
    } as MessageMediaInfo;
    expect(isVideoMediaAttachment(video)).toBe(true);
    expect(isAudioMediaAttachment(video)).toBe(false);
    expect(isAudioMediaAttachment(audio)).toBe(true);
  });
  it('keeps download cooldowns independent by attachment identity', async () => {
    vi.useFakeTimers();
    try {
      const view = await renderCard({
        msg: buildMessage({
          media: [
            {
              id: 'first',
              href: 'javascript:void(1)',
              contentType: 'audio/mpeg',
              fileName: 'first.mp3',
            },
            {
              id: 'second',
              href: 'javascript:void(0)',
              contentType: 'audio/mpeg',
              fileName: 'second.mp3',
            },
          ] as InboxMessage['media'],
        }),
      });
      const first = view.container.querySelector(
        'a[aria-label="Завантажити аудіо: first.mp3"]',
      ) as HTMLElement;
      const second = view.container.querySelector(
        'a[aria-label="Завантажити аудіо: second.mp3"]',
      ) as HTMLElement;
      expect((await downloadClick(first)).defaultPrevented).toBe(false);
      expect((await downloadClick(first)).defaultPrevented).toBe(true);
      expect((await downloadClick(second)).defaultPrevented).toBe(false);
      await act(async () => vi.advanceTimersByTime(MESSAGE_CARD_DOWNLOAD_START_COOLDOWN_MS));
      expect(first.getAttribute('aria-label')).toBe('Завантажити аудіо: first.mp3');
      expect(second.getAttribute('aria-label')).toBe('Завантажити аудіо: second.mp3');
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not request derived images for oversized snake-case audio metadata', async () => {
    const view = await renderCard({
      msg: buildMessage({
        media: [
          {
            id: 'large-audio',
            href: '/api/messenger/media/large-audio',
            content_type: 'audio/mpeg',
            file_name: 'large.mp3',
            size_bytes: 100 * 1024 * 1024 + 1,
          },
        ] as InboxMessage['media'],
      }),
    });
    const player = view.container.querySelector('custom-audio-player');
    expect(player?.getAttribute('src')).toBe('/api/messenger/media/large-audio');
    expect(player?.hasAttribute('wave-src')).toBe(false);
    expect(player?.hasAttribute('spectrum-src')).toBe(false);
  });
  it('keeps legacy image order while merging metadata by attachment identity', async () => {
    const first = 'https://example.test/files/first.png';
    const shared = 'https://example.test/files/shared.png';
    const view = await renderCard({
      msg: buildMessage({
        images: [first, shared],
        media: [
          {
            id: 'shared-media',
            href: shared,
            contentType: 'image/png',
            fileName: 'shared.png',
            sizeBytes: 1,
          },
        ] as InboxMessage['media'],
      }),
    });
    const thumbnails = Array.from(
      view.container.querySelectorAll('button[aria-label="Відкрити зображення"]'),
    );
    expect(
      thumbnails.map((thumbnail) => thumbnail.querySelector('img')?.getAttribute('src')),
    ).toEqual([first, shared]);
    await click(thumbnails[1] as HTMLElement);
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('shared.png');
  });
  it('rejects archive count and size limits while keeping individual downloads', async () => {
    const attachment = (id: string, sizeBytes: number) =>
      ({
        id,
        href: `/api/messenger/media/${id}`,
        contentType: 'text/plain',
        fileName: `${id}.txt`,
        sizeBytes,
      }) as MessageMediaInfo;
    const rejectedCollections = [
      Array.from({ length: RER_MESSAGE_ATTACHMENTS_ZIP_MAX_FILES + 1 }, (_, index) =>
        attachment(`count-${index}`, 1),
      ),
      [
        attachment('large', RER_MESSAGE_ATTACHMENTS_ZIP_MAX_TOTAL_BYTES + 1),
        attachment('small', 1),
      ],
    ];

    for (const media of rejectedCollections) {
      expect(canDownloadAllMessageAttachments(media)).toBe(false);
      const view = await renderCard({ msg: buildMessage({ media }) });
      expect(view.container.querySelectorAll('a[download]')).toHaveLength(media.length);
      if (view.container.querySelector('button[aria-label="Більше дій"]'))
        await openOverflowMenu(view.container);
      expect(
        document.body.querySelector('a[href="/api/rer-importer/messages/42/attachments.zip"]'),
      ).toBeNull();
    }

    const validMedia = [attachment('valid-first', 1), attachment('valid-second', 1)];
    expect(canDownloadAllMessageAttachments(validMedia)).toBe(true);

    const convertedKmz = {
      ...attachment('route', 128),
      contentType: 'application/geo+json',
      fileName: 'route.geojson',
    } as MessageMediaInfo;
    expect(
      canDownloadAllMessageAttachments([{ ...convertedKmz, kmzConversionStatus: 'done' }]),
    ).toBe(true);
    for (const kmzConversionStatus of [null, 'pending', 'processing', 'error']) {
      expect(canDownloadAllMessageAttachments([{ ...convertedKmz, kmzConversionStatus }])).toBe(
        false,
      );
    }
    expect(
      canDownloadAllMessageAttachments([
        { ...convertedKmz, fileName: 'route.KMZ', kmzConversionStatus: 'done' },
      ]),
    ).toBe(false);

    const validView = await renderCard({ msg: buildMessage({ media: validMedia }) });
    await openOverflowMenu(validView.container);
    expect(
      document.body.querySelector('a[href="/api/rer-importer/messages/42/attachments.zip"]'),
    ).not.toBeNull();
  });
});
