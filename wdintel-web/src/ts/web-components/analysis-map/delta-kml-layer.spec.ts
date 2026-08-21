/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadDeltaKmlLayer } from './delta-kml-layer';

afterEach(() => vi.unstubAllGlobals());

describe('Delta KML layer', () => {
  it('loads the latest Delta KML independently', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => `
        <kml xmlns="http://www.opengis.net/kml/2.2">
          <Placemark>
            <name>Delta object</name>
            <LineString><coordinates>35,49 36,50</coordinates></LineString>
          </Placemark>
        </kml>
      `,
    });
    vi.stubGlobal('fetch', fetchMock);

    const layer = await loadDeltaKmlLayer();

    expect(fetchMock).toHaveBeenCalledWith('/api/delta/kml/latest');
    expect(layer?.getLayers()).toHaveLength(1);
  });

  it('skips the optional layer when Delta has no upload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    await expect(loadDeltaKmlLayer()).resolves.toBeNull();
  });
});
