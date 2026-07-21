import { describe, expect, it } from 'vitest';

import type { Palitra } from '../../../../Bindings';
import { filterPalitrasByArchiveView } from './use-rer-palitra-neo-page.shared';

function makePalitra(id: number, conversionStatus: string, isArchived = false): Palitra {
  return { id, conversionStatus, isArchived } as Palitra;
}

describe('filterPalitrasByArchiveView', () => {
  const ready = makePalitra(1, 'ready');
  const processing = makePalitra(2, 'processing');
  const failed = makePalitra(3, 'error');
  const archivedFailed = makePalitra(4, 'error', true);
  const palitras = [ready, processing, failed, archivedFailed];

  it('omits failed conversions from active palettes', () => {
    expect(filterPalitrasByArchiveView(palitras, 'active')).toEqual([ready, processing]);
  });

  it('keeps failed conversions in all and archived views', () => {
    expect(filterPalitrasByArchiveView(palitras, 'all')).toEqual(palitras);
    expect(filterPalitrasByArchiveView(palitras, 'archived')).toEqual([archivedFailed]);
  });
});
