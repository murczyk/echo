import type { InboxMessage, MessageMediaInfo } from '../../../../Bindings';

/** Tiny inline SVG — works in `img src` without network (tests & local preview). */
export const MOCK_IMAGE_DATA_URL =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">' +
      '<rect fill="#2d6cdf" width="320" height="240"/>' +
      '<text x="24" y="130" fill="#fff" font-family="system-ui,sans-serif" font-size="22">ECHO mock image</text>' +
      '</svg>',
  );

/** Second placeholder (e.g. `media[]` image attachment with a different URL than `images[]`). */
export const MOCK_IMAGE_DATA_URL_ALT =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="200" viewBox="0 0 280 200">' +
      '<rect fill="#c94a4a" width="280" height="200"/>' +
      '<text x="16" y="110" fill="#fff" font-family="system-ui,sans-serif" font-size="18">mock via media</text>' +
      '</svg>',
  );

const MOCK_IMAGE_MEDIA_ID = 'mock-media-image-1';

export function mockImageMediaEntry(overrides: Partial<MessageMediaInfo> = {}): MessageMediaInfo {
  return {
    id: MOCK_IMAGE_MEDIA_ID,
    contentType: 'image/png',
    fileName: 'mock-screenshot.png',
    sizeBytes: 1024,
    href: MOCK_IMAGE_DATA_URL,
    transcription: null,
    ocr: null,
    summary: null,
    ...overrides,
  };
}

export function minimalInboxMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
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
    timestamp: 1,
    groupMasterKey: null,
    sender: null,
    extendedForm: null,
    post: null,
    postId: null,
    unit: null,
    callsignTokens: null,
    signalTokens: null,
    pointTokens: null,
    noHeadersBody: null,
    keywordTokens: null,
    textMarked: null,
    datasourceId: null,
    location: null,
    tags: null,
    networkIds: null,
    inboxTags: null,
    metadata: [],
    parentMessages: [],
    intelligenceReports: [],
    ...overrides,
  };
}

/** Message with both `images` URLs and an image entry in `media` (typical API shapes). */
export function inboxMessageWithMockImages(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return minimalInboxMessage({
    text: 'Текст з вкладеннями-зображеннями (mock).',
    images: [MOCK_IMAGE_DATA_URL],
    media: [
      mockImageMediaEntry({
        id: 'mock-via-media',
        href: MOCK_IMAGE_DATA_URL_ALT,
        contentType: 'image/jpeg',
        fileName: 'attachment.jpg',
      }),
    ],
    timestamp: 1_710_000_000_000,
    ...overrides,
  });
}
