/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as L from 'leaflet';

import { HttpRequestError } from '../../react/services/api/client';
import { loadDeltaKmlLayer, updateDeltaKmlLayerZoom } from './delta-kml-layer';

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

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/delta/kml/latest',
      expect.objectContaining({ credentials: 'include', method: 'GET' }),
    );
    expect(layer?.getLayers()).toHaveLength(1);
    const line = layer?.getLayers()[0] as L.Polyline;
    expect(line.options).toMatchObject({
      color: '#3388ff',
      opacity: 0.3,
      weight: 3,
    });
    let zoom = 8;
    const map = {
      getSize: () => ({ x: 1200 }),
      getZoom: () => zoom,
    } as unknown as L.Map;
    updateDeltaKmlLayerZoom(layer!, map);
    expect(line.getTooltip()?.options.opacity).toBe(0);
    zoom = 11;
    updateDeltaKmlLayerZoom(layer!, map);
    expect(line.getTooltip()?.options.opacity).toBe(0.9);
  });

  it('skips the optional layer when Delta has no upload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));

    await expect(loadDeltaKmlLayer()).resolves.toBeNull();
  });

  it('preserves unauthorized responses for the shared logout flow', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 })),
    );

    await expect(loadDeltaKmlLayer()).rejects.toMatchObject<Partial<HttpRequestError>>({
      name: 'HttpRequestError',
      status: 401,
    });
  });

  it('updates markers and tooltips nested in grouped layers', () => {
    const marker = L.marker([49, 35], { opacity: 0 }).bindTooltip('Delta object', {
      permanent: true,
      opacity: 0,
    });
    const layer = L.geoJSON().addLayer(L.featureGroup([L.featureGroup([marker])]));
    let zoom = 8;
    const map = {
      getSize: () => ({ x: 1200 }),
      getZoom: () => zoom,
    } as unknown as L.Map;

    updateDeltaKmlLayerZoom(layer, map);
    expect(marker.options.opacity).toBe(0);
    expect(marker.getTooltip()?.options.opacity).toBe(0);

    zoom = 11;
    updateDeltaKmlLayerZoom(layer, map);
    expect(marker.options.opacity).toBe(1);
    expect(marker.getTooltip()?.options.opacity).toBe(0.9);
  });
});
