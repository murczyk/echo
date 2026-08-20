import { describe, expect, it } from 'vitest';

import { isManageMessageSubmitEligible } from './manage-message-submit-eligibility';

const baseInput = {
  busy: false,
  parsing: false,
  schemaValid: true,
  isEditMode: false,
  groupsLoading: false,
  selectedGroupKey: 'g-1',
  accessibleGroupKeys: ['g-1'],
  text: 'message',
  fullBody: '',
  newAttachmentCount: 0,
  existingAttachmentIds: [],
  deletedAttachmentIds: [],
  maxAttachmentCount: 20,
};

describe('isManageMessageSubmitEligible', () => {
  it.each([
    ['empty create form', { text: '', selectedGroupKey: '' }, false],
    ['valid group without content', { text: '' }, false],
    ['content without group', { selectedGroupKey: '' }, false],
    ['whitespace-only text and full body', { text: '  ', fullBody: '\n\t' }, false],
    ['valid group plus text', {}, true],
    ['valid group plus full body', { text: '', fullBody: 'body' }, true],
    ['valid group plus a new attachment', { text: '', newAttachmentCount: 1 }, true],
    ['busy', { busy: true }, false],
    ['parsing', { parsing: true }, false],
    ['invalid schema', { schemaValid: false }, false],
    ['report without text', { reportTextRequired: true, text: '', newAttachmentCount: 1 }, false],
    ['report with text', { reportTextRequired: true, text: '', fullBody: 'report' }, true],
    ['create groups loading', { groupsLoading: true }, false],
    ['remembered group is inaccessible', { selectedGroupKey: 'stale' }, false],
    ['attachments at maximum', { text: '', newAttachmentCount: 20 }, true],
    ['attachments above maximum', { newAttachmentCount: 21 }, false],
    [
      'edit with retained attachment',
      { isEditMode: true, text: '', existingAttachmentIds: ['media-1'] },
      true,
    ],
    [
      'edit after deleting every retained attachment',
      {
        isEditMode: true,
        text: '',
        existingAttachmentIds: ['media-1', 'media-2'],
        deletedAttachmentIds: ['media-1', 'media-2'],
      },
      false,
    ],
    [
      'edit ignores create accessible groups',
      { isEditMode: true, accessibleGroupKeys: [], existingAttachmentIds: ['media-1'] },
      true,
    ],
  ])('%s', (_name, overrides, expected) => {
    expect(isManageMessageSubmitEligible({ ...baseInput, ...overrides })).toBe(expected);
  });
});
