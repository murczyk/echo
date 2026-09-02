import { describe, expect, it } from 'vitest';

import { preserveAiManagedLoginIds } from '../login-options';

describe('login options', () => {
  // @test-scope safeguard: prevents keyboard removal or clearing from deleting AI-managed login access
  it('keeps AI-managed login IDs after keyboard removal or clear actions', () => {
    expect(
      preserveAiManagedLoginIds(
        ['human-id', 'ai-id', 'other-id'],
        ['other-id'],
        [
          { loginId: 'human-id', isAiManaged: false },
          { loginId: 'ai-id', isAiManaged: true },
        ],
      ),
    ).toEqual(['ai-id', 'other-id']);

    expect(
      preserveAiManagedLoginIds(['ai-id'], [], [{ loginId: 'ai-id', isAiManaged: true }]),
    ).toEqual(['ai-id']);
  });
});
