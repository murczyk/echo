/**
 * @vitest-environment happy-dom
 */
import { act, useCallback, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage, InboxMessageTag, SummaryTableFreqRow, User } from '../../../../Bindings';
import { minimalInboxMessage } from '../rer-duty-neo/inbox-message-mocks';
import { emptyQueryState } from './helpers';
import { useAnalysisDataMessageActions } from './use-analysis-data.message-actions';

const hoisted = vi.hoisted(() => ({
  bookmarkAdd: vi.fn(),
  bookmarkRemove: vi.fn(),
  commentSave: vi.fn(),
  deleteMessage: vi.fn(),
  editAnalysisFreqUnitName: vi.fn(),
  importantAdd: vi.fn(),
  importantRemove: vi.fn(),
  inboxMessageTagsAdd: vi.fn(),
  inboxMessageTagsModelError: vi.fn(),
  inboxMessageTagsRm: vi.fn(),
}));

vi.mock('../../services/api/analysis', () => ({
  bookmarkAdd: hoisted.bookmarkAdd,
  bookmarkRemove: hoisted.bookmarkRemove,
  commentSave: hoisted.commentSave,
  deleteMessage: hoisted.deleteMessage,
  editAnalysisFreqUnitName: hoisted.editAnalysisFreqUnitName,
  importantAdd: hoisted.importantAdd,
  importantRemove: hoisted.importantRemove,
  inboxMessageTagsAdd: hoisted.inboxMessageTagsAdd,
  inboxMessageTagsModelError: hoisted.inboxMessageTagsModelError,
  inboxMessageTagsRm: hoisted.inboxMessageTagsRm,
}));

type HarnessApi = ReturnType<typeof useAnalysisDataMessageActions> & {
  messages: Array<[number, InboxMessage]>;
  mapOpenMessages: Array<[number, InboxMessage]>;
  setMessages: Dispatch<SetStateAction<Array<[number, InboxMessage]>>>;
  setMapOpenMessages: Dispatch<SetStateAction<Array<[number, InboxMessage]>>>;
  onError: ReturnType<typeof vi.fn>;
};

function buildUser(): User {
  return {
    name: 'tester',
    roles: [],
    sigintZoneId: null,
    organismId: 1,
    deltaLogin: null,
    goiConfiguredForOrganism: false,
    goiFullAccessForOrganism: false,
    goiHost: null,
    goiIntegrations: [],
  };
}

function buildTag(tagId: number, overrides: Partial<InboxMessageTag> = {}): InboxMessageTag {
  return {
    id: tagId,
    tagId,
    confidence: 1,
    login: null,
    model: null,
    organismId: null,
    ...overrides,
  };
}

function buildMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return minimalInboxMessage({
    text: 'message',
    tags: [3, 4],
    inboxTags: [buildTag(3, { login: 'tester', organismId: 1 })],
    ...overrides,
  });
}

function patchItems(
  items: Array<[number, InboxMessage]>,
  updater: (messageId: number, message: InboxMessage) => InboxMessage,
): Array<[number, InboxMessage]> {
  return items.map(([messageId, message]) => [messageId, updater(messageId, message)] as [number, InboxMessage]);
}

function TestHarness(props: {
  apiRef: MutableRefObject<HarnessApi | null>;
  initialMessages?: Array<[number, InboxMessage]>;
  authUserName?: string | null;
  currentUser?: User | null;
  onError?: ReturnType<typeof vi.fn>;
}) {
  const [messages, setMessages] = useState<Array<[number, InboxMessage]>>(props.initialMessages ?? [[1, buildMessage()]]);
  const [mapOpenMessages, setMapOpenMessages] = useState<Array<[number, InboxMessage]>>(props.initialMessages ?? [[1, buildMessage()]]);
  const [onError] = useState(() => props.onError ?? vi.fn());
  const onUnauthorized = vi.fn(() => false);
  const currentUser = props.currentUser ?? buildUser();
  const patchMessages = useCallback(
    (updater: (messageId: number, message: InboxMessage) => InboxMessage) => {
      setMessages((current) => patchItems(current, updater));
      setMapOpenMessages((current) => patchItems(current, updater));
    },
    [],
  );
  const actions = useAnalysisDataMessageActions({
    authUserName: props.authUserName ?? currentUser?.name ?? null,
    currentUser,
    messages,
    mapOpenMessages,
    optionsFreqs: [],
    onError,
    onUnauthorized,
    patchMessages,
    queryState: emptyQueryState(),
    reload: vi.fn(() => Promise.resolve()),
    setMapOpenMessages,
    setMessages,
    setSummaryRows: vi.fn() as unknown as Dispatch<SetStateAction<SummaryTableFreqRow[]>>,
    toErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
  });

  props.apiRef.current = {
    ...actions,
    messages,
    mapOpenMessages,
    setMessages,
    setMapOpenMessages,
    onError,
  };

  return null;
}

describe('useAnalysisDataMessageActions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.inboxMessageTagsAdd.mockResolvedValue(undefined);
    hoisted.inboxMessageTagsRm.mockResolvedValue(undefined);
    hoisted.inboxMessageTagsModelError.mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
      container.remove();
      document.body.innerHTML = '';
    });
  });

  async function renderHarness(
    initialMessages?: Array<[number, InboxMessage]>,
    options: { authUserName?: string | null; currentUser?: User | null } = {},
  ) {
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} initialMessages={initialMessages} authUserName={options.authUserName} currentUser={options.currentUser} />);
    });
    return apiRef;
  }

  it('removes only the human contribution, keeps bot rows, and opens the prompt', async () => {
    const apiRef = await renderHarness([
      [
        1,
        buildMessage({
          inboxTags: [
            buildTag(3, { login: 'tester', organismId: 1 }),
            buildTag(3, { model: 'bot', confidence: 0.92 }),
          ],
        }),
      ],
    ]);

    await act(async () => {
      await apiRef.current!.onToggleMessageTag(1, 3);
    });

    expect(hoisted.inboxMessageTagsRm).toHaveBeenCalledWith({ messageId: 1, tagId: 3 });
    expect(hoisted.inboxMessageTagsAdd).not.toHaveBeenCalled();
    expect(apiRef.current!.botTagAction).toEqual({ messageId: 1, tagId: 3 });
    expect(apiRef.current!.messages[0]?.[1].inboxTags).toEqual([
      expect.objectContaining({ tagId: 3, model: 'bot' }),
    ]);
    expect(apiRef.current!.messages[0]?.[1].tags).toEqual([3, 4]);
  });

  it('removes the fallback tag when the human tag is toggled off', async () => {
    const apiRef = await renderHarness([
      [
        1,
        buildMessage({
          inboxTags: [buildTag(3, { login: 'tester', organismId: 1 })],
        }),
      ],
    ]);

    await act(async () => {
      await apiRef.current!.onToggleMessageTag(1, 3);
    });

    expect(hoisted.inboxMessageTagsRm).toHaveBeenCalledWith({ messageId: 1, tagId: 3 });
    expect(apiRef.current!.messages[0]?.[1].inboxTags).toEqual([]);
    expect(apiRef.current!.messages[0]?.[1].tags).toEqual([4]);
  });

  it('confirms the bot error, clears the prompt, and removes bot rows locally', async () => {
    const apiRef = await renderHarness([
      [
        1,
        buildMessage({
          inboxTags: [
            buildTag(3, { login: 'tester', organismId: 1 }),
            buildTag(3, { model: 'bot', confidence: 0.92 }),
          ],
        }),
      ],
    ]);

    await act(async () => {
      await apiRef.current!.onToggleMessageTag(1, 3);
    });

    await act(async () => {
      await apiRef.current!.onMarkBotTagWrong(1, 3);
    });

    expect(hoisted.inboxMessageTagsModelError).toHaveBeenCalledWith({ messageId: 1, tagId: 3 });
    expect(apiRef.current!.botTagAction).toBeNull();
    expect(apiRef.current!.messages[0]?.[1].inboxTags).toEqual([]);
    expect(apiRef.current!.messages[0]?.[1].tags).toEqual([4]);
  });

  it('adds the human contribution when only a bot row exists', async () => {
    const apiRef = await renderHarness([
      [1, buildMessage({ inboxTags: [buildTag(3, { model: 'bot', confidence: 0.92 })] })],
    ]);

    await act(async () => {
      await apiRef.current!.onToggleMessageTag(1, 3);
    });

    expect(hoisted.inboxMessageTagsAdd).toHaveBeenCalledWith({ messageId: 1, tagId: 3 });
    expect(hoisted.inboxMessageTagsRm).not.toHaveBeenCalled();
    expect(apiRef.current!.botTagAction).toBeNull();
    expect(apiRef.current!.messages[0]?.[1].inboxTags).toEqual([
      expect.objectContaining({ tagId: 3, login: 'tester', model: null }),
      expect.objectContaining({ tagId: 3, model: 'bot' }),
    ]);
    expect(apiRef.current!.messages[0]?.[1].tags).toEqual([3, 4]);
  });

  it('rolls back the optimistic human tag change and keeps the prompt open on failure', async () => {
    hoisted.inboxMessageTagsRm.mockRejectedValueOnce(new Error('boom'));
    const apiRef = await renderHarness([
      [
        1,
        buildMessage({
          inboxTags: [
            buildTag(3, { login: 'tester', organismId: 1 }),
            buildTag(3, { model: 'bot', confidence: 0.92 }),
          ],
        }),
      ],
    ]);

    await act(async () => {
      await apiRef.current!.onToggleMessageTag(1, 3);
    });

    expect(apiRef.current!.onError).toHaveBeenCalledWith('boom');
    expect(apiRef.current!.botTagAction).toEqual({ messageId: 1, tagId: 3 });
    expect(apiRef.current!.messages[0]?.[1].inboxTags).toEqual([
      expect.objectContaining({ tagId: 3, login: 'tester', model: null }),
      expect.objectContaining({ tagId: 3, model: 'bot' }),
    ]);
    expect(apiRef.current!.messages[0]?.[1].tags).toEqual([3, 4]);
  });

  it('uses the auth user fallback when currentUser is unavailable', async () => {
    const fallbackRef = await renderHarness(
      [
        [
          1,
          buildMessage({
            inboxTags: [
              buildTag(3, { login: 'tester', organismId: 1 }),
              buildTag(3, { model: 'bot', confidence: 0.92 }),
            ],
          }),
        ],
      ],
      { currentUser: null, authUserName: 'tester' },
    );

    await act(async () => {
      await fallbackRef.current!.onToggleMessageTag(1, 3);
    });

    expect(hoisted.inboxMessageTagsRm).toHaveBeenCalledWith({ messageId: 1, tagId: 3 });
    expect(fallbackRef.current!.botTagAction).toEqual({ messageId: 1, tagId: 3 });
    expect(fallbackRef.current!.messages[0]?.[1].tags).toEqual([3, 4]);
  });
});
