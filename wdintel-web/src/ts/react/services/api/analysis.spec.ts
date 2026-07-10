/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';

import type { InboxMessage, InboxMessagesReq } from '../../../../Bindings';
import { postJson, postVoid } from './client';
import { fetchMessagesByIds, submitAnalysisInboxMessages } from './analysis';

vi.mock('./client', () => ({
  postJson: vi.fn(),
  postVoid: vi.fn(),
}));

const postVoidMock = vi.mocked(postVoid);
const postJsonMock = vi.mocked(postJson);

describe('analysis API', () => {
  it('sends highlight context when fetching messages by id', async () => {
    postJsonMock.mockResolvedValueOnce({ messages: [] });

    await fetchMessagesByIds([7], {
      highlightCallsigns: true,
      highlightKeywords: true,
      highlightPoints: true,
      highlightSearchres: true,
      search: 'needle',
    } as Partial<InboxMessagesReq>);

    expect(postJsonMock).toHaveBeenCalledWith('/api/rer-importer/messages-by-id', {
      message_ids: [7],
      inbox_req: {
        highlight_callsigns: true,
        highlight_keywords: true,
        highlight_points: true,
        highlight_searchres: true,
        search: 'needle',
      },
    });
  });

  it('preserves ContentNode variants when submitting inbox messages', async () => {
    const message = {
      text: 'hello',
      callsigns: ['ALPHA'],
      textMarked: [{ CNTextC: { text: 'hello' } }],
    } as InboxMessage;

    await submitAnalysisInboxMessages({
      messages: [[7, message]],
    });

    expect(postVoidMock).toHaveBeenCalledWith(
      '/api/rer-importer/inbox/submit',
      expect.objectContaining({
        messages: [[7, expect.objectContaining({ text_marked: [{ CNTextC: { text: 'hello' } }] })]],
      }),
    );
  });
});
