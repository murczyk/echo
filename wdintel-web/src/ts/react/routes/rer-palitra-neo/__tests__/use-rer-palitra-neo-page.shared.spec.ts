/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';

import {
  readInitialArchiveViewFromUrl,
  updateArchiveViewInUrl,
} from '../use-rer-palitra-neo-page.shared';
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
