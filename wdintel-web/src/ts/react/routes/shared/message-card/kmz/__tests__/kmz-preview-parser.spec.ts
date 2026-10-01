/**
 * @vitest-environment happy-dom
 */
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { parseKmzPreview } from '../kmz-preview-parser';
import {
  MAX_KMZ_PREVIEW_COORDINATES,
  MAX_KMZ_PREVIEW_ENTRIES,
  MAX_KMZ_PREVIEW_EXPANDED_BYTES,
  MAX_KMZ_PREVIEW_SOURCE_BYTES,
} from '../kmz-preview-utils';

const encoder = new TextEncoder();
const buffer = (text: string) => encoder.encode(text).buffer as ArrayBuffer;
const kmz = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])))
    .buffer;

describe('parseKmzPreview', () => {
  it('keeps independently styled points, lines, polygons, and polygon holes', () => {
    const preview = parseKmzPreview(
      buffer(`<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
        <Style id="point"><IconStyle><color>7f332211</color></IconStyle></Style>
        <Style id="line"><LineStyle><color>ff665544</color></LineStyle></Style>
        <Style id="polygon"><LineStyle><color>ff998877</color></LineStyle><PolyStyle><color>80443322</color></PolyStyle></Style>
        <Placemark><name>Point</name><styleUrl>#point</styleUrl><Point><coordinates>30,50</coordinates></Point></Placemark>
        <Placemark><name>Line</name><styleUrl>#line</styleUrl><LineString><coordinates>30,50 31,51</coordinates></LineString></Placemark>
        <Placemark><name>Polygon</name><styleUrl>#polygon</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>30,50 31,50 31,51 30,50</coordinates></LinearRing></outerBoundaryIs><innerBoundaryIs><LinearRing><coordinates>30.2,50.2 30.4,50.2 30.2,50.4 30.2,50.2</coordinates></LinearRing></innerBoundaryIs></Polygon></Placemark>
      </Document></kml>`),
      'kml',
    );

    expect(preview.points[0]).toMatchObject({ label: 'Point', color: '#112233' });
    expect(preview.points[0]?.opacity).toBeCloseTo(0.5);
    expect(preview.lineStrings).toMatchObject([{ label: 'Line', color: '#445566', opacity: 1 }]);
    expect(preview.polygons).toMatchObject([
      {
        label: 'Polygon',
        strokeColor: '#778899',
        strokeOpacity: 1,
        fillColor: '#223344',
        fillOpacity: expect.closeTo(0.5),
      },
    ]);
    expect(preview.polygons[0]?.rings).toHaveLength(2);
  });

  it('skips malformed polygon rings without discarding valid geometry', () => {
    const preview = parseKmzPreview(
      buffer(`<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
        <Placemark><Point><coordinates>30,50</coordinates></Point></Placemark>
        <Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>30,50 31,50</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
      </Document></kml>`),
      'kml',
    );

    expect(preview.points).toHaveLength(1);
    expect(preview.polygons).toHaveLength(0);
  });

  it('reports malformed KML and KMZ input', () => {
    expect(() => parseKmzPreview(buffer('<kml><Placemark>'), 'kml')).toThrow('KML_MALFORMED');
    expect(() => parseKmzPreview(buffer('not a zip'), 'kmz')).toThrow('KMZ_MALFORMED');
  });

  it('enforces source, archive entry, expanded-byte, and coordinate limits', () => {
    expect(() => parseKmzPreview(new ArrayBuffer(MAX_KMZ_PREVIEW_SOURCE_BYTES + 1), 'kml')).toThrow(
      'KMZ_SOURCE_TOO_LARGE',
    );
    expect(() =>
      parseKmzPreview(
        kmz(
          Object.fromEntries(
            Array.from({ length: MAX_KMZ_PREVIEW_ENTRIES + 1 }, (_, index) => [`${index}.txt`, '']),
          ),
        ),
        'kmz',
      ),
    ).toThrow('KMZ_TOO_MANY_ENTRIES');
    expect(() =>
      parseKmzPreview(kmz({ 'doc.kml': 'x'.repeat(MAX_KMZ_PREVIEW_EXPANDED_BYTES + 1) }), 'kmz'),
    ).toThrow('KMZ_EXPANDED_TOO_LARGE');
    const coordinateText = Array.from(
      { length: MAX_KMZ_PREVIEW_COORDINATES + 1 },
      () => '30,50',
    ).join(' ');
    expect(() =>
      parseKmzPreview(
        buffer(
          `<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><LineString><coordinates>${coordinateText}</coordinates></LineString></Placemark></kml>`,
        ),
        'kml',
      ),
    ).toThrow('KMZ_TOO_MANY_COORDINATES');
  });

  it('retains a line at the permitted coordinate boundary', () => {
    const coordinateText = Array.from({ length: MAX_KMZ_PREVIEW_COORDINATES }, () => '30,50').join(
      ' ',
    );
    const preview = parseKmzPreview(
      buffer(
        `<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><LineString><coordinates>${coordinateText}</coordinates></LineString></Placemark></kml>`,
      ),
      'kml',
    );

    expect(preview.lineStrings[0]?.coords).toHaveLength(MAX_KMZ_PREVIEW_COORDINATES);
  });
});
