import type { ComponentProps } from 'react';
import type { InboxMessage, MessageMediaInfo, Network, Tag } from '../../../Bindings';
import { emptyFilter } from '../../ts/react/routes/rer-duty-neo/utils';
import { MessageCard } from '../../ts/react/routes/shared/message-card/MessageCard';
import sampleSrc from '../fixtures/sample.wav';

export const SAMPLE_AUDIO_SRC = sampleSrc;
export const SAMPLE_AUDIO_SIZE_BYTES = 733_645;

export const STORY_TAGS_MAP = {
  3: { id: 3, label: 'переміщення', isPalitra: false },
  4: { id: 4, label: 'зв’язок', isPalitra: false },
  5: { id: 5, label: 'РЕБ', isPalitra: false },
} as Record<number, Tag>;

export const STORY_NETWORK_MAP = {
  7: { id: 7, name: 'Alpha', unitIds: [], location: null },
} as Record<number, Network>;

export function buildAudioAttachment(
  overrides: Partial<MessageMediaInfo> & Pick<MessageMediaInfo, 'id'> = { id: 'audio-full' },
): MessageMediaInfo {
  return {
    contentType: 'audio/wav',
    fileName: 'sample.wav',
    sizeBytes: SAMPLE_AUDIO_SIZE_BYTES,
    href: SAMPLE_AUDIO_SRC,
    transcription: null,
    ...overrides,
  };
}

export function buildMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    messageUid: 'story-message-1',
    text: 'Радіообмін на частоті, зразок картки з аудіо.',
    media: [],
    images: [],
    imageRecognized: [],
    date: '2026-03-23',
    time: '02:45',
    freq: '153.6250',
    coords: null,
    callsigns: ['ALPHA'],
    callsignsAlg2: ['ALPHA'],
    checked: false,
    important: false,
    bookmarked: false,
    timestamp: 1_709_999_940_000,
    groupMasterKey: 'group-1',
    sender: 'sender-1',
    extendedForm: null,
    messageComments: [],
    post: null,
    postId: null,
    unit: null,
    callsignTokens: null,
    signalTokens: null,
    pointTokens: [],
    noHeadersBody: null,
    keywordTokens: null,
    textMarked: [],
    datasourceId: null,
    location: 'ЛИМАН ПЕРШИЙ',
    tags: [3, 4],
    networkIds: [7],
    networkName: null,
    deviceName: null,
    inboxTags: [{ id: 1, tagId: 3, confidence: 1, login: 'tester', model: null, organismId: null }],
    metadata: [],
    ...overrides,
  } as InboxMessage;
}

export function buildMessageCardProps(
  overrides: Partial<ComponentProps<typeof MessageCard>> = {},
): ComponentProps<typeof MessageCard> {
  return {
    id: 42,
    msg: buildMessage(),
    feedCount: 1,
    displayMode: 'duty',
    referenceTimeMs: 1_710_000_000_000,
    authUserName: 'tester',
    groupName: "Куп'янськ пеленг",
    senderName: 'Dow_Jones_2',
    copiedFeedbackId: null,
    networkDisplayMap: { 7: 'р/м Alpha' },
    networkMap: STORY_NETWORK_MAP,
    tagsMap: STORY_TAGS_MAP,
    filterState: emptyFilter(),
    onBookmark: () => undefined,
    onImportant: () => undefined,
    onCopyText: () => undefined,
    onCopyFreq: () => undefined,
    onCopyEtalon: () => undefined,
    onCopyLocation: () => undefined,
    onAddFrequencyToFilter: () => undefined,
    onComment: () => undefined,
    onExcludeMessageEntity: () => undefined,
    onToggleTag: () => undefined,
    ...overrides,
  };
}
