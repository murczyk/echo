/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import type { InboxMessage, SignalGroupEntry } from '../../../../../Bindings';
import { buildMessageCardDisplayLabels } from './message-card-labels';

function buildMessage(
  overrides: Partial<InboxMessage> = {},
): Pick<InboxMessage, 'text' | 'freq' | 'groupMasterKey' | 'sender'> {
  return {
    text: 'hello',
    freq: '100.000',
    groupMasterKey: 'group-1',
    sender: 'sender-1',
    ...overrides,
  } as Pick<InboxMessage, 'text' | 'freq' | 'groupMasterKey' | 'sender'>;
}

describe('buildMessageCardDisplayLabels', () => {
  it('uses friendly group and sender labels when available', () => {
    const labels = buildMessageCardDisplayLabels(buildMessage(), {
      groupInfos: {
        'group-1': { masterKey: 'group-1', name: 'Група 1' } as SignalGroupEntry,
      },
      profiles: {
        'sender-1': { givenName: 'BBC', familyName: 'SPORT' },
      },
    });

    expect(labels).toEqual({
      groupName: 'Група 1',
      senderName: 'BBC SPORT',
      commentPreview: {
        text: 'hello',
        freq: '100.000',
        groupMasterKey: 'group-1',
        groupName: 'Група 1',
        sender: 'sender-1',
        senderName: 'BBC SPORT',
      },
    });
  });

  it('falls back to raw group and sender identifiers when friendly labels are missing', () => {
    const labels = buildMessageCardDisplayLabels(
      buildMessage({ groupMasterKey: 'group-9', sender: 'sender-9' }),
      {
        groupInfos: {},
        profiles: {},
      },
    );

    expect(labels.groupName).toBe('group-9');
    expect(labels.senderName).toBe('sender-9');
    expect(labels.commentPreview.groupName).toBe('group-9');
    expect(labels.commentPreview.senderName).toBe('sender-9');
  });
});
