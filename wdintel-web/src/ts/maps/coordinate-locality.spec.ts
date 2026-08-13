import { describe, expect, it } from 'vitest';

import { formatCoordinateLocality } from './coordinate-locality';

describe('formatCoordinateLocality', () => {
  it('renders a concise Ukrainian distance and direction', () => {
    expect(
      formatCoordinateLocality({
        settlementName: 'Степногірськ',
        direction: 'SW',
        region: null,
        country: null,
        distanceM: 5400,
        isRf: false,
      }),
    ).toBe('5,4 км на пд-зх від Степногірськ');
  });

  it('renders only the settlement for a point inside it', () => {
    expect(
      formatCoordinateLocality({
        settlementName: 'Степногірськ',
        direction: 'N',
        region: null,
        country: null,
        distanceM: 50,
        isRf: false,
      }),
    ).toBe('Степногірськ');
  });
});
