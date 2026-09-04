import { expect, type Page, type Route } from '@playwright/test';

import type { InboxMessagesRspRaw } from '../../src/ts/react/services/api/inbox-messages';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

export type MessageCardMediaPreviewHost = 'analysis' | 'duty';

export const MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES = {
  image1: 'e2e-image-1.png',
  image2: 'e2e-image-2.png',
  video1: 'e2e-video-1.mp4',
  video2: 'e2e-video-2.mp4',
  audio: 'e2e-audio.wav',
  text: 'e2e-preview.txt',
  markdown: 'e2e-preview.md',
  download: 'e2e-download.bin',
} as const;

const MESSAGE_CARD_MEDIA_PREVIEW_ASSET_PREFIX = '/test-assets/message-card-media-preview';
const MESSAGE_CARD_POLISH_NETWORKS = [
  { id: 301, name: 'E2E Альфа', unit_ids: [1], location: null },
  { id: 302, name: 'E2E Браво', unit_ids: [], location: null },
];

const TRANSPARENT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP7bq8W2QAAAABJRU5ErkJggg==';

function buildValidWavAudioFixture(): Buffer {
  const sampleRate = 8_000;
  const sampleCount = sampleRate / 10;
  const sampleBytes = 2;
  const audio = Buffer.alloc(44 + sampleCount * sampleBytes);

  audio.write('RIFF', 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(sampleRate, 24);
  audio.writeUInt32LE(sampleRate * sampleBytes, 28);
  audio.writeUInt16LE(sampleBytes, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(sampleCount * sampleBytes, 40);

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin((index / sampleRate) * Math.PI * 2 * 440) * 3_000);
    audio.writeInt16LE(sample, 44 + index * sampleBytes);
  }

  return audio;
}

const TXT_PREVIEW_TEXT = ['E2E TXT preview line 1', 'E2E TXT preview line 2'].join('\n');
const MARKDOWN_PREVIEW_TEXT = [
  '# E2E Markdown preview',
  '',
  'This is *safe* markdown.',
  '',
  '- first item',
  '- second item',
  '',
  '[Safe link](https://example.test/safe-link)',
].join('\n');

function buildMessageCardMediaPreviewMessage({
  withPolishContent = false,
  withPartialCoordinateError = false,
  withCompleteCoordinateError = false,
}: {
  withPolishContent?: boolean;
  withPartialCoordinateError?: boolean;
  withCompleteCoordinateError?: boolean;
} = {}): Record<string, unknown> {
  const image1 = `${MESSAGE_CARD_MEDIA_PREVIEW_ASSET_PREFIX}/${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.image1}`;
  const image2 = `${MESSAGE_CARD_MEDIA_PREVIEW_ASSET_PREFIX}/${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.image2}`;
  const video1 = `${MESSAGE_CARD_MEDIA_PREVIEW_ASSET_PREFIX}/${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.video1}`;
  const video2 = `${MESSAGE_CARD_MEDIA_PREVIEW_ASSET_PREFIX}/${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.video2}`;
  const audio = `${MESSAGE_CARD_MEDIA_PREVIEW_ASSET_PREFIX}/${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.audio}`;
  const text = `${MESSAGE_CARD_MEDIA_PREVIEW_ASSET_PREFIX}/${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.text}`;
  const markdown = `${MESSAGE_CARD_MEDIA_PREVIEW_ASSET_PREFIX}/${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.markdown}`;
  const download = `${MESSAGE_CARD_MEDIA_PREVIEW_ASSET_PREFIX}/${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.download}`;

  return {
    messageUid: 'e2e-message-card-preview',
    text: 'E2E message-card media preview fixture',
    media: [
      {
        id: 'e2e-video-1',
        content_type: 'video/mp4',
        file_name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.video1,
        size_bytes: 1_024,
        href: video1,
      },
      {
        id: 'e2e-video-2',
        content_type: 'video/mp4',
        file_name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.video2,
        size_bytes: 1_536,
        href: video2,
      },
      {
        id: 'e2e-text',
        content_type: 'text/plain',
        file_name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.text,
        size_bytes: 128,
        href: text,
      },
      {
        id: 'e2e-markdown',
        content_type: 'text/markdown',
        file_name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.markdown,
        size_bytes: 192,
        href: markdown,
      },
      {
        id: 'e2e-audio',
        content_type: 'audio/wav',
        file_name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.audio,
        size_bytes: 512,
        href: audio,
      },
      {
        id: 'e2e-download',
        content_type: 'application/octet-stream',
        file_name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.download,
        size_bytes: 256,
        href: download,
      },
      ...(withPartialCoordinateError || withCompleteCoordinateError
        ? [
            {
              id: 'e2e-coordinate-error',
              content_type: 'application/octet-stream',
              file_name: 'e2e-coordinate-error.bin',
              size_bytes: 64,
              href: download,
              summary: { state: 'completed', has_coordinates: true },
            },
          ]
        : []),
    ],
    images: [image1, image2],
    imageRecognized: [],
    date: '13.07.2026',
    time: '12:34',
    freq: '123.4',
    coords: withCompleteCoordinateError ? null : '50.45044, 30.52355',
    callsigns: withPolishContent ? ['E2E-ALPHA'] : [],
    callsignsAlg2: [],
    checked: false,
    important: false,
    bookmarked: false,
    timestamp: 1_720_000_000_000,
    groupMasterKey: 'e2e-group',
    sender: 'E2E Sender',
    extendedForm: null,
    messageComments: [],
    post: null,
    postId: null,
    unit: 'E2E Unit',
    callsignTokens: null,
    signalTokens: null,
    pointTokens: null,
    noHeadersBody: null,
    keywordTokens: null,
    textMarked: null,
    datasourceId: null,
    location: null,
    tags: null,
    networkIds: withPolishContent ? [301, 302] : null,
    inboxTags: null,
    metadata: [],
    intelligenceReports: withPolishContent
      ? [
          {
            id: 202,
            isAccessible: true,
            isDeleted: false,
            text: 'E2E intelligence report',
            attachmentsCount: 0,
            timestamp: 1_720_000_001_000,
            date: '13.07.2026',
            time: '12:35',
            groupName: null,
            groupMasterKey: 'e2e-group',
          },
        ]
      : [],
  };
}

export function buildMessageCardMediaPreviewInboxResponse({
  withPolishContent = false,
  withPartialCoordinateError = false,
  withCompleteCoordinateError = false,
}: {
  withPolishContent?: boolean;
  withPartialCoordinateError?: boolean;
  withCompleteCoordinateError?: boolean;
} = {}): InboxMessagesRspRaw {
  return {
    inbox_items: [
      [
        101,
        buildMessageCardMediaPreviewMessage({
          withPolishContent,
          withPartialCoordinateError,
          withCompleteCoordinateError,
        }) as never,
      ],
    ],
    callsigns: [],
    signal_profiles: {},
    signal_groups: [],
    freq_pelengs_summary: null,
    page_limit: 20,
  };
}

async function fulfillAsset(route: Route, body: BodyInit, contentType: string): Promise<void> {
  await route.fulfill({
    contentType,
    body,
  });
}

export async function installMessageCardMediaPreviewAssetRoutes(page: Page): Promise<void> {
  await page.route(`**${MESSAGE_CARD_MEDIA_PREVIEW_ASSET_PREFIX}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const fileName = pathname.split('/').pop() ?? '';

    if (fileName === MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.image1) {
      await fulfillAsset(route, Buffer.from(TRANSPARENT_PNG_BASE64, 'base64'), 'image/png');
      return;
    }

    if (fileName === MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.image2) {
      await fulfillAsset(route, Buffer.from(TRANSPARENT_PNG_BASE64, 'base64'), 'image/png');
      return;
    }

    if (fileName === MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.video1) {
      await fulfillAsset(route, Buffer.from('e2e-video-1'), 'video/mp4');
      return;
    }

    if (fileName === MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.video2) {
      await fulfillAsset(route, Buffer.from('e2e-video-2'), 'video/mp4');
      return;
    }

    if (fileName === MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.audio) {
      await fulfillAsset(route, buildValidWavAudioFixture(), 'audio/wav');
      return;
    }

    if (fileName === MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.text) {
      await fulfillAsset(route, TXT_PREVIEW_TEXT, 'text/plain; charset=utf-8');
      return;
    }

    if (fileName === MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.markdown) {
      await fulfillAsset(route, MARKDOWN_PREVIEW_TEXT, 'text/markdown; charset=utf-8');
      return;
    }

    if (fileName === MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.download) {
      await fulfillAsset(route, Buffer.from('e2e-download'), 'application/octet-stream');
      return;
    }

    await route.fulfill({ status: 404, body: 'Not found' });
  });
}

async function installMessageCardMediaPreviewHostFixture(
  page: Page,
  host: MessageCardMediaPreviewHost,
  withPolishContent: boolean,
  withPartialCoordinateError: boolean,
  withCompleteCoordinateError: boolean,
): Promise<void> {
  const inboxResponse = buildMessageCardMediaPreviewInboxResponse({
    withPolishContent,
    withPartialCoordinateError,
    withCompleteCoordinateError,
  });

  const networkInfoResponse = withPolishContent ? MESSAGE_CARD_POLISH_NETWORKS : undefined;

  if (host === 'analysis') {
    await installAnalysisNeoApiMocks(page, { inboxResponse, networkInfoResponse });
  } else {
    await installRerDutyShortStateMocks(page, { inboxResponse, networkInfoResponse });
  }

  if (withPartialCoordinateError || withCompleteCoordinateError) {
    let requestCount = 0;
    await page.route(
      '**/api/messenger/media/e2e-coordinate-error/summary/coordinates',
      async (route) => {
        requestCount += 1;
        if (withPartialCoordinateError || requestCount === 1) {
          await route.fulfill({ status: 500, body: 'coordinate lookup failed' });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            coordinates: [
              {
                title: 'E2E coordinate',
                description: 'Recovered coordinate',
                plannedMeans: null,
                coordinateSystem: 'wgs84',
                value: '50.45044, 30.52355',
              },
            ],
          }),
        });
      },
    );
  }
}

export async function openMessageCardPreviewHost(
  page: Page,
  host: MessageCardMediaPreviewHost,
  {
    revealAudio = false,
    revealCoordinates = false,
    withPolishContent = false,
    withPartialCoordinateError = false,
    withCompleteCoordinateError = false,
  }: {
    revealAudio?: boolean;
    revealCoordinates?: boolean;
    withPolishContent?: boolean;
    withPartialCoordinateError?: boolean;
    withCompleteCoordinateError?: boolean;
  } = {},
): Promise<void> {
  await installMessageCardMediaPreviewAssetRoutes(page);
  await installMessageCardMediaPreviewHostFixture(
    page,
    host,
    withPolishContent,
    withPartialCoordinateError,
    withCompleteCoordinateError,
  );
  await page.goto(host === 'analysis' ? '/rer-analysis-neo' : '/rer-duty-neo');

  const ensureAttachmentExpanded = async (name: RegExp) => {
    const control = page.getByRole('button', { name });
    await expect(control).toBeVisible();
    if ((await control.getAttribute('aria-expanded')) !== 'true') {
      await control.click();
      await expect(control).toHaveAttribute('aria-expanded', 'true');
    }
  };

  await ensureAttachmentExpanded(/^Розгорнути медіа:|^Згорнути медіа:/);
  if (revealAudio) {
    await ensureAttachmentExpanded(/^Розгорнути аудіо:|^Згорнути аудіо:/);
  }
  if (revealCoordinates) {
    await ensureAttachmentExpanded(/^Розгорнути координати:|^Згорнути координати:/);
  }

  if (!revealAudio && !revealCoordinates) {
    await expect(page.getByRole('button', { name: 'Відкрити зображення' })).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Відкрити відео' })).toHaveCount(2);
  }
}
