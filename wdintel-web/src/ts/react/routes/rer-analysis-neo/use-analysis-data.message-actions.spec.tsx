/**
 * @vitest-environment happy-dom
 */
import { act, useCallback, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  InboxMessage,
  InboxMessageTag,
  SummaryTableFreqRow,
  User,
} from '../../../../Bindings';
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
  addPalitraHighlightBlacklistEntry: vi.fn(),
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
  fetchInboxMessages: hoisted.fetchInboxMessages,
}));

vi.mock('../../services/api/palitra', () => ({
  addPalitraHighlightBlacklistEntry: hoisted.addPalitraHighlightBlacklistEntry,
}));

type HarnessApi = ReturnType<typeof useAnalysisDataMessageActions> & {
  messages: Array<[number, InboxMessage]>;
  mapOpenMessages: Array<[number, InboxMessage]>;
  setMessages: Dispatch<SetStateAction<Array<[number, InboxMessage]>>>;
  setMapOpenMessages: Dispatch<SetStateAction<Array<[number, InboxMessage]>>>;
  onError: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  refreshTagFacet: ReturnType<typeof vi.fn>;
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
  return items.map(
    ([messageId, message]) => [messageId, updater(messageId, message)] as [number, InboxMessage],
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function TestHarness(props: {
  apiRef: MutableRefObject<HarnessApi | null>;
  initialMessages?: Array<[number, InboxMessage]>;
  authUserName?: string | null;
  currentUser?: User | null;
  onError?: ReturnType<typeof vi.fn>;
  reload?: ReturnType<typeof vi.fn>;
  refreshTagFacet?: ReturnType<typeof vi.fn>;
  completeLocalInboxChangeOrigin?: ReturnType<typeof vi.fn>;
  failLocalInboxChangeOrigin?: ReturnType<typeof vi.fn>;
  reconcileTagMutation?: ReturnType<typeof vi.fn>;
  registerLocalInboxChangeOrigin?: ReturnType<typeof vi.fn>;
  queryState?: ReturnType<typeof emptyQueryState>;
  unauthorizedRef?: MutableRefObject<ReturnType<typeof vi.fn> | null>;
}) {
  const [messages, setMessages] = useState<Array<[number, InboxMessage]>>(
    props.initialMessages ?? [[1, buildMessage()]],
  );
  const [mapOpenMessages, setMapOpenMessages] = useState<Array<[number, InboxMessage]>>(
    props.initialMessages ?? [[1, buildMessage()]],
  );
  const [onError] = useState(() => props.onError ?? vi.fn());
  const [refreshTagFacet] = useState(() => props.refreshTagFacet ?? vi.fn(() => Promise.resolve()));
  const onUnauthorized = props.unauthorizedRef?.current ?? vi.fn(() => false);
  const currentUser = props.currentUser ?? buildUser();
  const patchMessages = useCallback(
    (updater: (messageId: number, message: InboxMessage) => InboxMessage) => {
      setMessages((current) => patchItems(current, updater));
      setMapOpenMessages((current) => patchItems(current, updater));
    },
    [],
  );
  const [reload] = useState(() => props.reload ?? vi.fn(() => Promise.resolve()));
  const [completeLocalInboxChangeOrigin] = useState(
    () => props.completeLocalInboxChangeOrigin ?? vi.fn(),
  );
  const [failLocalInboxChangeOrigin] = useState(
    () => props.failLocalInboxChangeOrigin ?? vi.fn(() => false),
  );
  const [reconcileTagMutation] = useState(
    () => props.reconcileTagMutation ?? vi.fn(() => Promise.resolve()),
  );
  const [registerLocalInboxChangeOrigin] = useState(
    () => props.registerLocalInboxChangeOrigin ?? vi.fn(() => 'test-origin'),
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
    queryState: props.queryState ?? {
      ...emptyQueryState(),
      fromDateTimeStr: '2026-04-01T00:00',
      toDateTimeStr: '2026-04-02T00:00',
      tags: [3],
    },
    completeLocalInboxChangeOrigin,
    failLocalInboxChangeOrigin,
    reconcileTagMutation,
    registerLocalInboxChangeOrigin,
    refreshTagFacet,
    onUnauthorized,
    reload,
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
    reload,
    refreshTagFacet,
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
    options: {
      authUserName?: string | null;
      currentUser?: User | null;
      reload?: ReturnType<typeof vi.fn>;
      refreshTagFacet?: ReturnType<typeof vi.fn>;
      completeLocalInboxChangeOrigin?: ReturnType<typeof vi.fn>;
      failLocalInboxChangeOrigin?: ReturnType<typeof vi.fn>;
      reconcileTagMutation?: ReturnType<typeof vi.fn>;
      registerLocalInboxChangeOrigin?: ReturnType<typeof vi.fn>;
      queryState?: ReturnType<typeof emptyQueryState>;
      unauthorizedRef?: MutableRefObject<ReturnType<typeof vi.fn> | null>;
    } = {},
  ) {
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          initialMessages={initialMessages}
          authUserName={options.authUserName}
          currentUser={options.currentUser}
          reload={options.reload}
          refreshTagFacet={options.refreshTagFacet}
          completeLocalInboxChangeOrigin={options.completeLocalInboxChangeOrigin}
          failLocalInboxChangeOrigin={options.failLocalInboxChangeOrigin}
          reconcileTagMutation={options.reconcileTagMutation}
          registerLocalInboxChangeOrigin={options.registerLocalInboxChangeOrigin}
          queryState={options.queryState}
          unauthorizedRef={options.unauthorizedRef}
        />,
      );
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

    expect(hoisted.inboxMessageTagsRm).toHaveBeenCalledWith(
      { messageId: 1, tagId: 3 },
      { eventOrigin: 'test-origin' },
    );
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

    expect(hoisted.inboxMessageTagsRm).toHaveBeenCalledWith(
      { messageId: 1, tagId: 3 },
      { eventOrigin: 'test-origin' },
    );
    expect(apiRef.current!.messages[0]?.[1].inboxTags).toEqual([]);
    expect(apiRef.current!.messages[0]?.[1].tags).toEqual([4]);
  });

  it('confirms the bot error, clears the prompt, and removes bot rows locally', async () => {
    const registerLocalInboxChangeOrigin = vi.fn(() => 'model-error-origin');
    const completeLocalInboxChangeOrigin = vi.fn();
    const apiRef = await renderHarness(
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
      { completeLocalInboxChangeOrigin, registerLocalInboxChangeOrigin },
    );

    await act(async () => {
      await apiRef.current!.onToggleMessageTag(1, 3);
    });
    registerLocalInboxChangeOrigin.mockClear();
    completeLocalInboxChangeOrigin.mockClear();

    await act(async () => {
      await apiRef.current!.onMarkBotTagWrong(1, 3);
    });

    expect(registerLocalInboxChangeOrigin).toHaveBeenCalledOnce();
    expect(registerLocalInboxChangeOrigin.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.inboxMessageTagsModelError.mock.invocationCallOrder[0]!,
    );
    expect(hoisted.inboxMessageTagsModelError).toHaveBeenCalledWith(
      { messageId: 1, tagId: 3 },
      { eventOrigin: 'model-error-origin' },
    );
    expect(completeLocalInboxChangeOrigin).toHaveBeenCalledWith('model-error-origin');
    expect(apiRef.current!.botTagAction).toBeNull();
    expect(apiRef.current!.messages[0]?.[1].inboxTags).toEqual([]);
    expect(apiRef.current!.messages[0]?.[1].tags).toEqual([4]);
  });

  it('keeps the bot prompt and message unchanged when marking the bot tag wrong fails', async () => {
    const completeLocalInboxChangeOrigin = vi.fn();
    const failLocalInboxChangeOrigin = vi.fn(() => false);
    const reconcileTagMutation = vi.fn(() => Promise.resolve());
    const apiRef = await renderHarness(
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
      {
        completeLocalInboxChangeOrigin,
        failLocalInboxChangeOrigin,
        reconcileTagMutation,
      },
    );
    await act(async () => await apiRef.current!.onToggleMessageTag(1, 3));
    completeLocalInboxChangeOrigin.mockClear();
    hoisted.inboxMessageTagsModelError.mockRejectedValueOnce(new Error('response lost'));

    await act(async () => await apiRef.current!.onMarkBotTagWrong(1, 3));

    expect(failLocalInboxChangeOrigin).toHaveBeenCalledWith('test-origin');
    expect(completeLocalInboxChangeOrigin).not.toHaveBeenCalled();
    expect(apiRef.current!.onError).toHaveBeenCalledWith('response lost');
    expect(reconcileTagMutation).not.toHaveBeenCalled();
    expect(apiRef.current!.botTagAction).toEqual({ messageId: 1, tagId: 3 });
    expect(apiRef.current!.messages[0]?.[1].inboxTags).toEqual([
      expect.objectContaining({ tagId: 3, model: 'bot' }),
    ]);
  });

  it('reconciles once when the model-error event arrived before a lost response', async () => {
    const failLocalInboxChangeOrigin = vi.fn(() => true);
    const reconcileTagMutation = vi.fn(() => Promise.resolve());
    const apiRef = await renderHarness(
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
      { failLocalInboxChangeOrigin, reconcileTagMutation },
    );
    await act(async () => await apiRef.current!.onToggleMessageTag(1, 3));
    hoisted.inboxMessageTagsModelError.mockRejectedValueOnce(new Error('response lost'));

    await act(async () => await apiRef.current!.onMarkBotTagWrong(1, 3));

    expect(reconcileTagMutation).toHaveBeenCalledOnce();
    expect(reconcileTagMutation).toHaveBeenCalledWith(1);
  });

  it('adds the human contribution when only a bot row exists', async () => {
    const apiRef = await renderHarness([
      [1, buildMessage({ inboxTags: [buildTag(3, { model: 'bot', confidence: 0.92 })] })],
    ]);

    await act(async () => {
      await apiRef.current!.onToggleMessageTag(1, 3);
    });

    expect(hoisted.inboxMessageTagsAdd).toHaveBeenCalledWith(
      { messageId: 1, tagId: 3 },
      { eventOrigin: 'test-origin' },
    );
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

  it('does not reload or refresh the tag facet when the tag toggle fails', async () => {
    hoisted.inboxMessageTagsRm.mockRejectedValueOnce(new Error('boom'));
    const reload = vi.fn(() => Promise.resolve());
    const refreshTagFacet = vi.fn(() => Promise.resolve());
    const apiRef = await renderHarness(
      [[1, buildMessage({ inboxTags: [buildTag(3, { login: 'tester', organismId: 1 })] })]],
      { reload, refreshTagFacet },
    );

    await act(async () => {
      await apiRef.current!.onToggleMessageTag(1, 3);
    });

    expect(apiRef.current!.onError).toHaveBeenCalledWith('boom');
    expect(reload).not.toHaveBeenCalled();
    expect(refreshTagFacet).not.toHaveBeenCalled();
  });

  it('reconciles the message when its event arrived before the mutation failed', async () => {
    hoisted.inboxMessageTagsRm.mockRejectedValueOnce(new Error('response lost'));
    const failLocalInboxChangeOrigin = vi.fn(() => true);
    const reconcileTagMutation = vi.fn(() => Promise.resolve());
    const apiRef = await renderHarness(
      [[1, buildMessage({ inboxTags: [buildTag(3, { login: 'tester', organismId: 1 })] })]],
      { failLocalInboxChangeOrigin, reconcileTagMutation },
    );

    await act(async () => {
      await apiRef.current!.onToggleMessageTag(1, 3);
    });

    expect(failLocalInboxChangeOrigin).toHaveBeenCalledWith('test-origin');
    expect(reconcileTagMutation).toHaveBeenCalledWith(1);
  });

  it('refreshes the tags facet without reloading messages after a successful toggle', async () => {
    const reload = vi.fn(() => Promise.resolve());
    const refreshTagFacet = vi.fn(() => Promise.resolve());
    const apiRef = await renderHarness(
      [[1, buildMessage({ inboxTags: [buildTag(3, { login: 'tester', organismId: 1 })] })]],
      { reload, refreshTagFacet },
    );

    await act(async () => {
      await apiRef.current!.onToggleMessageTag(1, 3);
    });

    expect(refreshTagFacet).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
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

    expect(hoisted.inboxMessageTagsRm).toHaveBeenCalledWith(
      { messageId: 1, tagId: 3 },
      { eventOrigin: 'test-origin' },
    );
    expect(fallbackRef.current!.botTagAction).toEqual({ messageId: 1, tagId: 3 });
    expect(fallbackRef.current!.messages[0]?.[1].tags).toEqual([3, 4]);
  });

  it('deduplicates blacklist requests and patches both analysis collections', async () => {
    const deferredRequest = deferred<void>();
    hoisted.addPalitraHighlightBlacklistEntry.mockReturnValueOnce(deferredRequest.promise);
    const message = buildMessage({
      textMarked: [{ CNPointC: { etalon: '  Альфа ', text: 'A', palitraIds: [7, 12] } }],
      pointTokens: [{ etalon: 'АЛЬФА', text: 'A', palitraIds: [7, 12] }],
    });
    const secondMatching = buildMessage({
      textMarked: [{ CNPointC: { etalon: ' Альфа ', text: 'A', palitraIds: [7, 12] } }],
      pointTokens: [{ etalon: 'АЛЬФА', text: 'A', palitraIds: [7, 12] }],
    });
    const unrelated = buildMessage();
    const apiRef = await renderHarness([
      [42, message],
      [99, secondMatching],
      [100, unrelated],
    ]);
    const first = apiRef.current!.onAddPointHighlightBlacklist({
      messageId: 42,
      etalon: 'Альфа',
      palitraId: 7,
    });
    const second = apiRef.current!.onAddPointHighlightBlacklist({
      messageId: 42,
      etalon: ' альфа ',
      palitraId: 7,
    });
    expect(second).toBe(first);
    expect(hoisted.addPalitraHighlightBlacklistEntry).toHaveBeenCalledTimes(1);
    deferredRequest.resolve();
    await act(async () => {
      await first;
      await flushMicrotasks();
    });
    expect(apiRef.current!.messages[0]?.[1].pointTokens).toEqual([
      { etalon: 'АЛЬФА', text: 'A', palitraIds: [12] },
    ]);
    expect(apiRef.current!.mapOpenMessages[0]?.[1].pointTokens).toEqual([
      { etalon: 'АЛЬФА', text: 'A', palitraIds: [12] },
    ]);
    expect(apiRef.current!.messages[1]?.[1].pointTokens).toEqual([
      { etalon: 'АЛЬФА', text: 'A', palitraIds: [12] },
    ]);
    expect(apiRef.current!.mapOpenMessages[1]?.[1].pointTokens).toEqual([
      { etalon: 'АЛЬФА', text: 'A', palitraIds: [12] },
    ]);
    expect(apiRef.current!.messages[2]?.[1]).toBe(unrelated);
    expect(apiRef.current!.mapOpenMessages[2]?.[1]).toBe(unrelated);
  });

  it('reports blacklist failure and leaves both collections unchanged', async () => {
    const message = buildMessage({
      pointTokens: [{ etalon: 'АЛЬФА', text: 'A', palitraIds: [7] }],
    });
    const apiRef = await renderHarness([[42, message]]);
    // The harness owns its error callback; exercise the rejection contract and state identity.
    hoisted.addPalitraHighlightBlacklistEntry.mockRejectedValueOnce(new Error('boom'));
    const originalMessages = apiRef.current!.messages[0]?.[1];
    const originalMapMessages = apiRef.current!.mapOpenMessages[0]?.[1];
    await expect(
      apiRef.current!.onAddPointHighlightBlacklist({
        messageId: 42,
        etalon: ' альфа ',
        palitraId: 7,
      }),
    ).rejects.toThrow('boom');
    expect(apiRef.current!.messages[0]?.[1]).toBe(originalMessages);
    expect(apiRef.current!.mapOpenMessages[0]?.[1]).toBe(originalMapMessages);
    expect(apiRef.current!.onError).toHaveBeenCalledWith('boom');
  });

  it('routes blacklist 401 failures through unauthorized handling', async () => {
    const unauthorizedRef: MutableRefObject<ReturnType<typeof vi.fn> | null> = {
      current: vi.fn(() => true),
    };
    const apiRef = await renderHarness([[42, buildMessage()]], { unauthorizedRef });
    hoisted.addPalitraHighlightBlacklistEntry.mockRejectedValueOnce({ status: 401 });
    await expect(
      apiRef.current!.onAddPointHighlightBlacklist({
        messageId: 42,
        etalon: 'Альфа',
        palitraId: 7,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(unauthorizedRef.current).toHaveBeenCalledOnce();
    expect(apiRef.current!.onError).not.toHaveBeenCalled();
    expect(apiRef.current!.messages[0]?.[1]).toBe(apiRef.current!.mapOpenMessages[0]?.[1]);
  });
});
