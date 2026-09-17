import { describe, expect, it, vi } from 'vitest';

import { editDirectSubmit, submitDirect } from '../direct-submit';

const apiMocks = vi.hoisted(() => ({
  postJson: vi.fn(),
}));

vi.mock('../client', async () => ({
  ...(await vi.importActual<typeof import('../client')>('../client')),
  postJson: apiMocks.postJson,
}));

const request = { signal_group_master_key: 'group-1' };

const rawMessage = {
  id: 101,
  text: 'created',
  group_master_key: 'group-1',
  network_ids: [2, 3],
  message_comments: [{ login: 'operator', text: 'comment' }],
  no_headers_body: { body: 'body', start: 0, end: 4 },
  extended_form: 'note',
  inbox_tags: [{ id: 1, tag_id: 9, confidence: 1, organism_id: 4 }],
  text_marked: [{ CNHighlightC: { text: 'marked' } }],
  point_tokens: [{ text: 'point', etalon: 'etalon-1' }],
  datasource_id: 4,
  post_id: 5,
  media: [{ content_type: 'image/jpeg', file_name: 'photo.jpg', size_bytes: 123 }],
};

// @test-scope parser: normalizes supported snake-case and optional inline direct-submit responses.
describe('direct-submit response normalization', () => {
  it('normalizes an inline snake_case create message', async () => {
    apiMocks.postJson.mockResolvedValueOnce({ signal_message_id: 101, message: rawMessage });

    const result = await submitDirect(request);

    expect(result).toMatchObject({
      signal_message_id: 101,
      message: {
        groupMasterKey: 'group-1',
        networkIds: [2, 3],
        messageComments: [{ login: 'operator', text: 'comment' }],
        noHeadersBody: { body: 'body', start: 0, end: 4 },
        extendedForm: 'note',
        inboxTags: [{ id: 1, tagId: 9, organismId: 4 }],
        textMarked: [{ CNHighlightC: { text: 'marked' } }],
        pointTokens: [{ text: 'point', etalon: 'etalon-1' }],
        datasourceId: 4,
        postId: 5,
        media: [{ contentType: 'image/jpeg', fileName: 'photo.jpg', sizeBytes: 123 }],
      },
    });
    expect(result.message).not.toHaveProperty('group_master_key');
    expect(result.message).not.toHaveProperty('network_ids');
    expect(apiMocks.postJson).toHaveBeenCalledWith('/api/1.1/submit-direct', request, undefined);
  });

  it.each([{ signal_message_id: 102 }, { signal_message_id: 102, message: null }])(
    'preserves a response without an inline message',
    async (raw) => {
      apiMocks.postJson.mockResolvedValueOnce(raw);

      await expect(submitDirect(request)).resolves.toEqual({ signal_message_id: 102 });
    },
  );

  it('accepts an already camelCase inline message', async () => {
    apiMocks.postJson.mockResolvedValueOnce({
      signal_message_id: 103,
      message: {
        ...rawMessage,
        group_master_key: undefined,
        network_ids: undefined,
        groupMasterKey: 'group-1',
        networkIds: [2, 3],
      },
    });

    await expect(submitDirect(request)).resolves.toMatchObject({
      signal_message_id: 103,
      message: { groupMasterKey: 'group-1', networkIds: [2, 3] },
    });
  });

  it('normalizes an inline edit message and preserves request options', async () => {
    const options = { signal: new AbortController().signal };
    apiMocks.postJson.mockResolvedValueOnce({ signal_message_id: 104, message: rawMessage });

    const result = await editDirectSubmit(42, request, options);

    expect(result.message?.groupMasterKey).toBe('group-1');
    expect(apiMocks.postJson).toHaveBeenCalledWith('/api/1.1/message/42/edit', request, options);
  });

  it.each([{ signal_message_id: 105 }, { signal_message_id: 106, message: null }])(
    'normalizes an edit response without an inline message',
    async (raw) => {
      apiMocks.postJson.mockResolvedValueOnce(raw);

      await expect(editDirectSubmit(42, request)).resolves.toEqual({
        signal_message_id: raw.signal_message_id,
      });
    },
  );
});
