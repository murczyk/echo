import { describe, expect, it } from 'vitest';

import { toCreateNetworkReq } from './use-rer-network-details-neo-page.forms';
import { createDefaultNetworkUpsertForm } from './use-rer-network-details-neo-page.forms';

describe('use-rer-network-details-neo-page.forms', () => {
  it('maps NFM to VHF when creating a network', () => {
    const req = toCreateNetworkReq({
      ...createDefaultNetworkUpsertForm(),
      kind: 'NFM',
      freq: '146.5000',
    });

    expect(req.freqs?.[0]?.kind).toBe('VHF');
  });
});
