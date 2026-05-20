/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import { networkEditLookupFilterOptions, type NetworkEditLookupOption } from './network-edit-autocomplete';

function option(id: number, label: string): NetworkEditLookupOption {
  return { id, label };
}

describe('network edit autocomplete helpers', () => {
  it('matches on the visible label and not internal ids', () => {
    const options = [option(144, '144 мсд'), option(1, '1 мсб'), option(2, '2 мсд')];

    const result = networkEditLookupFilterOptions(options, { inputValue: '144 мсд' });

    expect(result.map((item) => item.label)).toEqual(['144 мсд']);
  });

  it('limits the result set to ten options', () => {
    const options = Array.from({ length: 12 }, (_unused, index) => option(index + 1, `144 мсд ${index + 1}`));

    const result = networkEditLookupFilterOptions(options, { inputValue: '144 мсд' });

    expect(result).toHaveLength(10);
  });
});
