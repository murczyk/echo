import { describe, expect, it } from 'vitest';

import { NO_DATA_LABEL } from '../../utils/misc';
import { derivePelengEnabledFreqs } from './use-rer-network-details-neo-page.load';

describe('use-rer-network-details-neo-page.load', () => {
  it('keeps blank frequencies enabled after load', () => {
    expect(
      derivePelengEnabledFreqs([], [
        { freq: '   ' },
        { freq: '146.5000' },
        { freq: '146.5000' },
      ]),
    ).toEqual(['146.5000', NO_DATA_LABEL]);
  });

  it('falls back to all loaded peleng frequencies when nothing stays enabled', () => {
    expect(derivePelengEnabledFreqs(['149.0000'], [{ freq: '   ' }, { freq: '146.5000' }])).toEqual([
      '146.5000',
      NO_DATA_LABEL,
    ]);
  });
});
