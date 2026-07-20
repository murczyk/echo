import { describe, expect, it } from 'vitest';
import { EMPTY_FORM_VALUES, makeMessageSchema } from './manage-message-drawer.schema';

describe('makeMessageSchema', () => {
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
});
