import { describe, expect, it } from 'vitest';

import { toCreateNetworkReq } from './use-rer-network-details-neo-page.forms';
import { createDefaultNetworkUpsertForm } from './use-rer-network-details-neo-page.forms';

describe('use-rer-network-details-neo-page.forms', () => {
  it('passes modulation directly when creating a network', () => {
    const req = toCreateNetworkReq({
      ...createDefaultNetworkUpsertForm(),
      modulation: 'NFM',
      freq: '146.5000',
    });

    expect(req.freqs?.[0]?.modulation).toBe('NFM');
  });
});
