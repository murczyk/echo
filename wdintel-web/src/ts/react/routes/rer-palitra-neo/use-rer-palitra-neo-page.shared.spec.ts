/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';

import type { Palitra } from '../../../../Bindings';
import {
  filterPalitrasByArchiveView,
  readInitialArchiveViewFromUrl,
  updateArchiveViewInUrl,
} from './use-rer-palitra-neo-page.shared';

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

describe('palitra URL state', () => {
  it('removes legacy tab values while preserving view mode', () => {
    window.history.replaceState({}, '', '/rer-palitra-neo?tab=anything&viewMode=archived');

    expect(readInitialArchiveViewFromUrl()).toBe('archived');
    expect(window.location.href).toContain('/rer-palitra-neo?viewMode=archived');
  });

  it('removes tab and preserves unrelated parameters and hash', () => {
    window.history.replaceState({}, '', '/rer-palitra-neo?tab=callsign&other=value#section');

    readInitialArchiveViewFromUrl();
    expect(window.location.href).toContain('/rer-palitra-neo?other=value#section');
  });

  it('removes tab on later view mode updates', () => {
    window.history.replaceState({}, '', '/rer-palitra-neo?tab=malformed');

    updateArchiveViewInUrl('active');
    expect(window.location.search).toBe('');
  });
});
