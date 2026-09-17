import { describe, expect, it } from 'vitest';
import { EMPTY_FORM_VALUES, makeMessageSchema, parseCoords } from '../manage-message-drawer.schema';

describe('makeMessageSchema', () => {
  // @test-scope parser: rejects malformed coordinate input before message submission.
  it('returns a coords field error for invalid coordinates in edit mode', () => {
    const result = makeMessageSchema(true).safeParse({
      ...EMPTY_FORM_VALUES,
      signalGroupMasterKey: 'group-1',
      coords: 'somewhere near the ridge',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ['coords'] }));
  });

  // @test-scope parser: accepts supported coordinate formats for message submission.
  it('accepts and returns multiple coordinate formats', () => {
    const value = '49.12345, 37.12345\n37U DR 05997 22279';
    const result = makeMessageSchema(false).safeParse({
      ...EMPTY_FORM_VALUES,
      signalGroupMasterKey: 'group-1',
      coords: value,
    });

    expect(result.success).toBe(true);
    expect(parseCoords(value)).toHaveLength(2);
  });
});
