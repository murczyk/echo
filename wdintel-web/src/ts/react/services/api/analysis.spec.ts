/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '../../../../Bindings';
import { postVoid } from './client';
import { submitAnalysisInboxMessages } from './analysis';

vi.mock('./client', () => ({
  postJson: vi.fn(),
  postVoid: vi.fn(),
}));

const postVoidMock = vi.mocked(postVoid);

describe('analysis API submit', () => {
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
