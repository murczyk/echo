import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage, MessageComment, User } from '../../../../Bindings';

const fetchMessageComments = vi.hoisted(() => vi.fn());
const fetchUserInfo = vi.hoisted(() => vi.fn());

vi.mock('../../services/api/analysis', () => ({
  fetchMessageComments,
}));

vi.mock('../../services/api/user', () => ({
  fetchUserInfo,
}));

import { loadMissingMessageCommentsForMessages } from './use-analysis-data.comments';

afterEach(() => {
  vi.clearAllMocks();
});

function buildUser(overrides: Partial<User>): User {
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
    ...overrides,
  };
}

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
  it('caches failed user lookups as null so repeated loads do not retry the same login', async () => {
    fetchMessageComments.mockResolvedValue({
      data: [{ messageId: 42, comments: [buildComment({ login: 'missing-login' })] }],
    });
    fetchUserInfo.mockRejectedValue(new Error('missing'));

    const setUsers = vi.fn();
    const setMessageComments = vi.fn();

    await loadMissingMessageCommentsForMessages([[42, buildMessage()]], {
      authUserName: 'tester',
      currentUser: buildUser({ name: 'tester', organismId: 1 }),
      messageComments: {},
      messageCommentsLoadVersionRef: { current: 1 },
      onError: vi.fn(),
      onUnauthorized: vi.fn().mockReturnValue(false),
      setMessageComments,
      setUsers,
      users: {},
    });

    expect(setUsers).toHaveBeenCalledTimes(1);
    const updater = setUsers.mock.calls[0]?.[0];
    expect(updater).toEqual(expect.any(Function));
    expect(updater({})).toEqual({ 'missing-login': null });

    await loadMissingMessageCommentsForMessages([[42, buildMessage()]], {
      authUserName: 'tester',
      currentUser: buildUser({ name: 'tester', organismId: 1 }),
      messageComments: { 42: [] },
      messageCommentsLoadVersionRef: { current: 2 },
      onError: vi.fn(),
      onUnauthorized: vi.fn().mockReturnValue(false),
      setMessageComments,
      setUsers,
      users: { 'missing-login': null },
    });

    expect(fetchUserInfo).toHaveBeenCalledTimes(1);
  });

  it('does not surface stale per-login lookup failures after the request version changes', async () => {
    fetchMessageComments.mockResolvedValue({
      data: [{ messageId: 42, comments: [buildComment({ login: 'stale-login' })] }],
    });
    fetchUserInfo.mockRejectedValue(new Error('stale'));

    const setUsers = vi.fn();
    const setMessageComments = vi.fn();
    const onError = vi.fn();
    const versionRef = { current: 1 };

    const promise = loadMissingMessageCommentsForMessages([[42, buildMessage()]], {
      authUserName: 'tester',
      currentUser: buildUser({ name: 'tester', organismId: 1 }),
      messageComments: {},
      messageCommentsLoadVersionRef: versionRef,
      onError,
      onUnauthorized: vi.fn().mockReturnValue(false),
      setMessageComments,
      setUsers,
      users: {},
    });

    versionRef.current = 2;
    await promise;

    expect(onError).not.toHaveBeenCalled();
    expect(setUsers).not.toHaveBeenCalled();
  });

  it('does not load user info for post-authored comments', async () => {
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

    await loadMissingMessageCommentsForMessages([[42, buildMessage()]], {
      authUserName: 'tester',
      currentUser: buildUser({ name: 'tester', organismId: 1 }),
      messageComments: {},
      messageCommentsLoadVersionRef: { current: 1 },
      onError: vi.fn(),
      onUnauthorized: vi.fn().mockReturnValue(false),
      setMessageComments: vi.fn(),
      setUsers: vi.fn(),
      users: {},
    });

    expect(fetchUserInfo).not.toHaveBeenCalled();
  });
});
