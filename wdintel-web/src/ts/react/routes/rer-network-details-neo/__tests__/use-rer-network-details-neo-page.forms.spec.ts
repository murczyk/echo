import { describe, expect, it } from 'vitest';

import {
  getNetworkUpsertValidationError,
  shouldIncludeNetworkCreateFrequency,
  toCreateNetworkReq,
} from '../use-rer-network-details-neo-page.forms';
import { createDefaultNetworkUpsertForm } from '../use-rer-network-details-neo-page.forms';

// @test-scope safeguard: prevents network form state from resetting or retaining fields for the wrong selected network.
describe('use-rer-network-details-neo-page.forms', () => {
  it('passes modulation directly when creating a network', () => {
    const req = toCreateNetworkReq({
      ...createDefaultNetworkUpsertForm(),
      modulation: 'NFM',
      freq: '146.5000',
    });

    expect(req.freqs?.[0]?.modulation).toBe('NFM');
  });

  it('passes auto-archive protection when creating a network', () => {
    const req = toCreateNetworkReq({
      ...createDefaultNetworkUpsertForm(),
      doNotArchive: true,
    });

    expect(req.doNotArchive).toBe(true);
  });

  it('omits frequency when optional create frequency is blank', () => {
    const form = {
      ...createDefaultNetworkUpsertForm(),
      location: 'район',
      aorIds: [1],
    };
    const includeFrequency = shouldIncludeNetworkCreateFrequency(form, true);
    const req = toCreateNetworkReq(form, { includeFrequency });

    expect(includeFrequency).toBe(false);
    expect(req.freqs).toBeNull();
    expect(getNetworkUpsertValidationError(form, { includeFrequency })).toBeNull();
  });

  it('validates optional create frequency after it is entered', () => {
    const form = {
      ...createDefaultNetworkUpsertForm(),
      freq: '146.5000',
    };
    const includeFrequency = shouldIncludeNetworkCreateFrequency(form, true);

    expect(includeFrequency).toBe(true);
    expect(getNetworkUpsertValidationError(form, { includeFrequency })?.activeFrom).toBe(
      'Потрібно вказати дату початку',
    );
  });
});
