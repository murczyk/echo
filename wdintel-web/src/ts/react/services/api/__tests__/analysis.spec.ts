/**
 * @vitest-environment happy-dom
 */
// @test-scope parser: analysis request and message-response compatibility fixtures
import { describe, expect, it, vi } from 'vitest';

import type { AnalysisStatsReq, InboxMessage, InboxMessagesReq } from '../../../../../Bindings';
import { postJson, postVoid } from '../client';
import {
  fetchAnalysisCallsignFrequencyMatches,
  fetchAnalysisCallsignInfos,
  fetchMessagesByIds,
  inboxMessageTagsModelError,
  inboxMessageTagsRm,
  submitAnalysisInboxMessages,
} from '../analysis';

vi.mock('../client', () => ({
  postJson: vi.fn(),
  postVoid: vi.fn(),
}));

const postVoidMock = vi.mocked(postVoid);
const postJsonMock = vi.mocked(postJson);

describe('analysis API', () => {
  it('sends callsign frequency search criteria with the normalized analysis request', async () => {
    postJsonMock.mockResolvedValueOnce({ frequencies: [] });

    await fetchAnalysisCallsignFrequencyMatches({
      req: {
        sinceDateInclusiveMs: 1,
        tillDateNoninclusiveMs: 2,
        selectedGroups: [],
        selectedCallsigns: ['НУГУШ'],
      } as AnalysisStatsReq,
      callsigns: ['ALPHA', 'BRAVO'],
      minMatches: 2,
    });

    expect(postJsonMock).toHaveBeenCalledWith(
      '/api/rer/analysis/callsign-frequency-matches',
      expect.objectContaining({
        callsigns: ['alpha', 'bravo'],
        min_matches: 2,
        req: expect.objectContaining({
          since_date_inclusive_ms: 1,
          till_date_noninclusive_ms: 2,
          selected_groups: null,
          selected_callsigns: ['нугуш'],
        }),
      }),
      undefined,
    );
  });

  it('normalizes callsign info lookups', async () => {
    postJsonMock.mockResolvedValueOnce([]);

    await fetchAnalysisCallsignInfos([' НУГУШ ', 'нугуш']);

    expect(postJsonMock).toHaveBeenCalledWith(
      '/api/rer/callsign-info-batch',
      { callsigns: ['нугуш'] },
      undefined,
    );
  });

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

  it('sends a tag mutation origin without changing the request body', async () => {
    await inboxMessageTagsRm({ messageId: 7, tagId: 3 }, { eventOrigin: 'local-mutation' });

    expect(postVoidMock).toHaveBeenCalledWith(
      '/api/tags/tags-rm',
      { message_id: 7, tag_id: 3 },
      { headers: { 'X-Echo-Event-Origin': 'local-mutation' } },
    );
  });

  it('sends a model-error origin without changing the request body', async () => {
    await inboxMessageTagsModelError({ messageId: 7, tagId: 3 }, { eventOrigin: 'local-mutation' });

    expect(postVoidMock).toHaveBeenCalledWith(
      '/api/tags/tag-model-error',
      { message_id: 7, tag_id: 3 },
      { headers: { 'X-Echo-Event-Origin': 'local-mutation' } },
    );
  });

  it('keeps the model-error request compatible when no origin is provided', async () => {
    await inboxMessageTagsModelError({ messageId: 7, tagId: 3 });

    expect(postVoidMock).toHaveBeenCalledWith(
      '/api/tags/tag-model-error',
      { message_id: 7, tag_id: 3 },
      undefined,
    );
  });
});
