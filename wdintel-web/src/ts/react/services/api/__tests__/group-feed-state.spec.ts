import { afterEach, describe, expect, it, vi } from 'vitest';

import { acknowledgeGroupFeedTail, fetchGroupFeedStates } from '../group-feed-state';

afterEach(() => vi.unstubAllGlobals());

describe('group feed state API', () => {
  it('maps snake-case state and optional unread references', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            groups: [
              {
                master_key: 'group-1',
                name: 'Група 1',
                ignore_operativny: false,
                unread_count: 2,
                oldest_unread_message_ref: '018f1234-1234-7000-8000-123456789abc',
                last_activity_at: 1_760_000_000_000,
                latest_cursor: {
                  created_at: 1_760_000_000_000,
                  message_id: 42,
                },
              },
              {
                master_key: 'group-2',
                name: 'Група 2',
                ignore_operativny: true,
                unread_count: 0,
                oldest_unread_message_ref: null,
                last_activity_at: null,
                latest_cursor: null,
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(fetchGroupFeedStates()).resolves.toEqual([
      expect.objectContaining({
        masterKey: 'group-1',
        unreadCount: 2,
        oldestUnreadMessageRef: '018f1234-1234-7000-8000-123456789abc',
        latestCursor: { createdAt: 1_760_000_000_000, messageId: 42 },
      }),
      expect.objectContaining({
        masterKey: 'group-2',
        oldestUnreadMessageRef: null,
        latestCursor: null,
      }),
    ]);
  });

  it('passes AbortSignal to list and acknowledge requests', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ groups: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            master_key: 'group-1',
            name: 'Група 1',
            ignore_operativny: false,
            unread_count: 0,
            oldest_unread_message_ref: null,
            last_activity_at: 1_760_000_000_000,
            latest_cursor: { created_at: 1_760_000_000_000, message_id: 42 },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await fetchGroupFeedStates(controller.signal);
    await acknowledgeGroupFeedTail(
      {
        masterKey: 'group-1',
        cursor: { createdAt: 1_760_000_000_000, messageId: 42 },
      },
      controller.signal,
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/rer-importer/group-feed-state',
      expect.objectContaining({ method: 'GET', signal: controller.signal }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/rer-importer/group-feed-state/acknowledge',
      expect.objectContaining({
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          master_key: 'group-1',
          cursor: { created_at: 1_760_000_000_000, message_id: 42 },
        }),
      }),
    );
  });
});
