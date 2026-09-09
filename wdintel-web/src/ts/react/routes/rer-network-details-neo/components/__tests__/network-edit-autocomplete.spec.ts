/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import {
  networkEditLookupFilterOptions,
  type NetworkEditLookupOption,
} from '.././network-edit-autocomplete';

function option(id: number, label: string): NetworkEditLookupOption {
  return { id, label };
}

// @test-scope parser: network-edit autocomplete ranking fixtures.
describe('network edit autocomplete helpers', () => {
  it('ranks exact and prefix label matches ahead of broader token matches', () => {
    const options = [
      option(1, '3 шр 1 мсб 126 мсп 71 мсд 14 АК'),
      option(2, '3 мсб 126 мсп 71 мсд 14 АК'),
      option(3, '7 мср 3 мсб 126 мсп 71 мсд 14 АК'),
    ];

    const result = networkEditLookupFilterOptions(options, { inputValue: '3 мсб 126 мсп' });

    expect(result.map((item) => item.id)).toEqual([2, 3, 1]);
  });

  it('does not split numeric tokens into arbitrary digit fragments', () => {
    const options = [option(1, '36 мсп 71 мсд 14 АК'), option(2, '3 мсб 126 мсп 71 мсд 14 АК')];

    const result = networkEditLookupFilterOptions(options, { inputValue: '36 мсп' });

    expect(result.map((item) => item.id)).toEqual([1]);
  });

  it('does not match on internal ids alone', () => {
    const options = [option(3, 'Альфа'), option(4, 'Браво')];

    const result = networkEditLookupFilterOptions(options, { inputValue: '3' });

    expect(result).toEqual([]);
  });

  it('limits the result set to twenty options', () => {
    const options = Array.from({ length: 24 }, (_unused, index) =>
      option(index + 1, `144 мсд ${index + 1}`),
    );

    const result = networkEditLookupFilterOptions(options, { inputValue: '144 мсд' });

    expect(result).toHaveLength(20);
  });
});
