/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage, MessageComment } from '../../../../../Bindings';

const fetchMessageComments = vi.hoisted(() => vi.fn());

vi.mock('../../../services/api/analysis', () => ({
  fetchMessageComments,
}));

import { loadMissingMessageCommentsForMessages } from '../use-analysis-data.comments';

afterEach(() => {
  vi.clearAllMocks();
});

function buildComment(overrides: Partial<MessageComment>): MessageComment {
  return {
    id: 1,
    messageId: 42,
    login: 'peer-login',
    comment: 'peer comment',
    sigintPostName: null,
    ...overrides,
  };
}

function buildMessage(): InboxMessage {
  return {
    text: '',
    freq: null,
    bookmarked: false,
    important: false,
    extendedForm: null,
    sender: null,
    groupMasterKey: null,
    networkIds: [],
    tags: [],
    inboxTags: [],
    timestamp: null,
    time: null,
    date: null,
    callsigns: [],
    callsignsAlg2: [],
    location: null,
    pointTokens: [],
    textMarked: [],
    media: [],
    images: [],
  } as InboxMessage;
}
describe('loadMissingMessageCommentsForMessages', () => {
  it('loads comments without filtering out self-authored entries', async () => {
    fetchMessageComments.mockResolvedValue({
      data: [
        {
          messageId: 42,
          comments: [
            buildComment({ login: 'peer-login', comment: 'peer comment' }),
            buildComment({ login: 'tester', comment: 'self comment' }),
          ],
        },
      ],
    });

    const setMessageComments = vi.fn();

    await loadMissingMessageCommentsForMessages([[42, buildMessage()]], {
      messageComments: {},
      messageCommentsLoadVersionRef: { current: 1 },
      onError: vi.fn(),
      onUnauthorized: vi.fn().mockReturnValue(false),
      setMessageComments,
    });

    expect(fetchMessageComments).toHaveBeenCalledTimes(1);
    expect(setMessageComments).toHaveBeenCalledTimes(1);
    const updater = setMessageComments.mock.calls[0]?.[0];
    expect(updater).toEqual(expect.any(Function));
    expect(updater({})).toEqual({
      42: [
        buildComment({ login: 'peer-login', comment: 'peer comment' }),
        buildComment({ login: 'tester', comment: 'self comment' }),
      ],
    });
  });
  it('does not surface stale loads after the request version changes', async () => {
    fetchMessageComments.mockResolvedValue({
      data: [{ messageId: 42, comments: [buildComment({ login: 'stale-login' })] }],
    });

    const setMessageComments = vi.fn();
    const onError = vi.fn();
    const versionRef = { current: 1 };

    const promise = loadMissingMessageCommentsForMessages([[42, buildMessage()]], {
      messageComments: {},
      messageCommentsLoadVersionRef: versionRef,
      onError,
      onUnauthorized: vi.fn().mockReturnValue(false),
      setMessageComments,
    });

    versionRef.current = 2;
    await promise;

    expect(onError).not.toHaveBeenCalled();
    expect(setMessageComments).not.toHaveBeenCalled();
  });

  it('preserves post-authored comments', async () => {
    fetchMessageComments.mockResolvedValue({
      data: [
        {
          messageId: 42,
          comments: [
            buildComment({
              login: 'system',
              sigintPostName: 'Пост Альфа',
              comment: 'auto comment',
            }),
          ],
        },
      ],
    });

    const setMessageComments = vi.fn();

    await loadMissingMessageCommentsForMessages([[42, buildMessage()]], {
      messageComments: {},
      messageCommentsLoadVersionRef: { current: 1 },
      onError: vi.fn(),
      onUnauthorized: vi.fn().mockReturnValue(false),
      setMessageComments,
    });

    const updater = setMessageComments.mock.calls[0]?.[0];
    expect(updater({})).toEqual({
      42: [
        buildComment({
          login: 'system',
          sigintPostName: 'Пост Альфа',
          comment: 'auto comment',
        }),
      ],
    });
  });
});
