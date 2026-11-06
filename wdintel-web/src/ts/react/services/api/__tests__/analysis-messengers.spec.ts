import { describe, expect, it, vi } from 'vitest';

import { postJson } from '../client';
import { listMessengersChatMembers, listMessengersMessages } from '../analysis-messengers';

vi.mock('../client', () => ({
  postJson: vi.fn(),
  postVoid: vi.fn(),
}));

const postJsonMock = vi.mocked(postJson);

describe('analysis messengers API', () => {
  it('lists chat members with snake_case request and camelCase response', async () => {
    postJsonMock.mockResolvedValueOnce({
      items: [{ id: 'm1', external_id: '7', first_name: 'Ivan', is_bot: false, deleted: true }],
    });

    const rsp = await listMessengersChatMembers({ accountId: 'a1', chatId: 'c1' });

    expect(postJsonMock).toHaveBeenCalledWith(
      '/api/messengers/chats/members/list',
      { account_id: 'a1', chat_id: 'c1' },
      undefined,
    );
    expect(rsp.items[0]).toMatchObject({ externalId: '7', firstName: 'Ivan', deleted: true });
  });

  it('lists messages with every paging field and keeps cursors and attachments intact', async () => {
    const signal = new AbortController().signal;
    postJsonMock.mockResolvedValueOnce({
      items: [
        {
          id: 'msg1',
          external_id: '5',
          sent_at: 1760431100000,
          text: 'hi',
          is_outgoing: null,
          has_media: true,
          sender_chat_member_id: null,
          attachments: [
            {
              media: {
                id: 'media1',
                content_type: 'image/jpeg',
                href: '/api/messenger/media/media1',
              },
              external_id: '5:0',
              created_at: null,
              telegram: { file_id: '9', media_type: 'photo' },
            },
          ],
          telegram: { message_id: '48211' },
        },
      ],
      older_cursor: '1760431100000000_3008815',
      newer_cursor: null,
    });

    const rsp = await listMessengersMessages(
      {
        accountId: 'a1',
        chatId: 'c1',
        cursor: 'abc',
        limit: 20,
        direction: 'Newer',
        aroundMessageId: null,
      },
      { signal },
    );

    expect(postJsonMock).toHaveBeenLastCalledWith(
      '/api/messengers/messages/list',
      {
        account_id: 'a1',
        chat_id: 'c1',
        cursor: 'abc',
        limit: 20,
        direction: 'Newer',
        around_message_id: null,
      },
      { signal },
    );
    expect(rsp.olderCursor).toBe('1760431100000000_3008815');
    expect(rsp.newerCursor).toBeNull();
    expect(rsp.items[0]).toMatchObject({
      sentAt: 1760431100000,
      hasMedia: true,
      senderChatMemberId: null,
      telegram: { messageId: '48211' },
    });
    expect(rsp.items[0].attachments[0].media).toMatchObject({
      contentType: 'image/jpeg',
      href: '/api/messenger/media/media1',
    });
  });
});
