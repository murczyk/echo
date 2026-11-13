/**
 * @vitest-environment happy-dom
 */
import { deflateSync, strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { parseKmzPreview } from '../kmz-preview-parser';
import {
  MAX_KMZ_PREVIEW_COORDINATES,
  MAX_KMZ_PREVIEW_ENTRIES,
  MAX_KMZ_PREVIEW_EXPANDED_BYTES,
  MAX_KMZ_PREVIEW_SOURCE_BYTES,
  MAX_MAP_PREVIEW_FEATURES,
} from '../kmz-preview-utils';

const encoder = new TextEncoder();
const buffer = (text: string) => encoder.encode(text).buffer as ArrayBuffer;
const kmz = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])))
    .buffer;
const kmlText = (size: number) => {
  const open = '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>';
  const close = '</Document></kml>';
  return `${open}${' '.repeat(size - open.length - close.length)}${close}`;
};
function localFileOffset(bytes: Uint8Array, name: string): number {
  const encodedName = encoder.encode(name);
  for (let offset = 0; offset + 30 <= bytes.length; offset += 1) {
    if (new DataView(bytes.buffer, bytes.byteOffset + offset).getUint32(0, true) !== 0x04034b50)
      continue;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const nameLength = view.getUint16(26, true);
    if (
      nameLength === encodedName.length &&
      bytes
        .subarray(offset + 30, offset + 30 + nameLength)
        .every((value, index) => value === encodedName[index])
    )
      return offset;
  }
  throw new Error(`Missing ZIP member ${name}`);
}
function setLocalOriginalSize(bytes: Uint8Array, name: string, size: number): void {
  new DataView(bytes.buffer, bytes.byteOffset + localFileOffset(bytes, name)).setUint32(
    22,
    size,
    true,
  );
}
function setLocalCompression(bytes: Uint8Array, name: string, compression: number): void {
  new DataView(bytes.buffer, bytes.byteOffset + localFileOffset(bytes, name)).setUint16(
    8,
    compression,
    true,
  );
}
function streamingKmz(name: string, text: string): ArrayBuffer {
  const encodedName = encoder.encode(name);
  const compressed = deflateSync(strToU8(text));
  const bytes = new Uint8Array(30 + encodedName.length + compressed.length + 16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0008, true);
  view.setUint16(8, 8, true);
  view.setUint16(26, encodedName.length, true);
  bytes.set(encodedName, 30);
  bytes.set(compressed, 30 + encodedName.length);
  const descriptor = 30 + encodedName.length + compressed.length;
  view.setUint32(descriptor, 0x08074b50, true);
  return bytes.buffer;
}

describe('parseKmzPreview', () => {
  it('#3930 renders GPX waypoints, routes and separate track segments without conversion', () => {
    const preview = parseKmzPreview(
      buffer(`<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1">
      <wpt lat="50" lon="30"><name>Точка</name></wpt>
      <rte><name>Маршрут</name><rtept lat="50" lon="30"/><rtept lat="51" lon="31"/></rte>
      <trk><name>Трек</name><trkseg><trkpt lat="50" lon="30"/><trkpt lat="51" lon="31"/></trkseg>
      <trkseg><trkpt lat="52" lon="32"/><trkpt lat="53" lon="33"/></trkseg></trk>
    </gpx>`),
      'gpx',
    );
    expect(preview.points).toMatchObject([{ label: 'Точка', coords: { lat: 50, lng: 30 } }]);
    expect(preview.lineStrings).toHaveLength(3);
    expect(preview.lineStrings.map((line) => line.label)).toEqual(['Трек', 'Трек', 'Маршрут']);
    expect(preview.lineStrings[1].coords).toEqual([
      { lat: 52, lng: 32 },
      { lat: 53, lng: 33 },
    ]);
  });

  it('#3930 renders GeoJSON collections, multipoints and polygon holes with labels and styles', () => {
    const preview = parseKmzPreview(
      buffer(
        JSON.stringify({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { name: 'Геометрії', stroke: '#123456', fill: '#654321' },
              geometry: {
                type: 'GeometryCollection',
                geometries: [
                  {
                    type: 'MultiPoint',
                    coordinates: [
                      [30, 50],
                      [31, 51],
                    ],
                  },
                  {
                    type: 'LineString',
                    coordinates: [
                      [30, 50],
                      [31, 51],
                    ],
                  },
                  {
                    type: 'Polygon',
                    coordinates: [
                      [
                        [30, 50],
                        [32, 50],
                        [32, 52],
                        [30, 50],
                      ],
                      [
                        [30.2, 50.2],
                        [31, 50.2],
                        [31, 51],
                        [30.2, 50.2],
                      ],
                    ],
                  },
                ],
              },
            },
          ],
        }),
      ),
      'geojson',
    );
    expect(preview.points).toHaveLength(2);
    expect(preview.lineStrings).toMatchObject([{ label: 'Геометрії', color: '#123456' }]);
    expect(preview.polygons).toMatchObject([
      { label: 'Геометрії', strokeColor: '#123456', fillColor: '#654321' },
    ]);
    expect(preview.polygons[0].rings).toHaveLength(2);
    expect(
      parseKmzPreview(buffer('{"type":"Point","coordinates":[30,50]}'), 'geojson').points,
    ).toHaveLength(1);
  });

  it.each([
    ['gpx', '<html/>'],
    ['gpx', '<gpx><wpt></gpx>'],
    ['gpx', '<!DOCTYPE gpx [<!ENTITY x "text">]><gpx/>'],
    ['geojson', '{broken'],
    ['geojson', '{"type":"FeatureCollection","features":[{"type":"Point","coordinates":[30,50]}]}'],
    ['geojson', '{"type":"Point","coordinates":["30",50]}'],
    ['geojson', '{"type":"Point","coordinates":[1e400,50]}'],
    ['geojson', '{"type":"Point","coordinates":[181,50]}'],
    ['geojson', '{"type":"LineString","coordinates":null}'],
    [
      'geojson',
      '{"type":"Feature","geometry":{"type":"Point","coordinates":[30,50]},"properties":[]}',
    ],
  ] as const)('#3930 rejects malformed or unsafe %s input %s', (format, text) => {
    expect(() => parseKmzPreview(buffer(text), format)).toThrow('MAP_MALFORMED');
  });

  it('#3930 bounds native GeoJSON coordinates and collection nesting', () => {
    const coordinates = Array.from({ length: MAX_KMZ_PREVIEW_COORDINATES + 1 }, () => [30, 50]);
    expect(() =>
      parseKmzPreview(buffer(JSON.stringify({ type: 'MultiPoint', coordinates })), 'geojson'),
    ).toThrow('KMZ_TOO_MANY_COORDINATES');
    let geometry: unknown = { type: 'Point', coordinates: [30, 50] };
    for (let i = 0; i < 40; i++) geometry = { type: 'GeometryCollection', geometries: [geometry] };
    expect(() => parseKmzPreview(buffer(JSON.stringify(geometry)), 'geojson')).toThrow(
      'MAP_MALFORMED',
    );
    expect(() =>
      parseKmzPreview(buffer('{"type":"Point","coordinates":[30,50]}'), 'geojson', 10),
    ).toThrow('KMZ_SOURCE_TOO_LARGE');
    const geometries = Array.from({ length: MAX_MAP_PREVIEW_FEATURES + 1 }, () => ({
      type: 'GeometryCollection',
      geometries: [],
    }));
    expect(() =>
      parseKmzPreview(
        buffer(JSON.stringify({ type: 'GeometryCollection', geometries })),
        'geojson',
      ),
    ).toThrow('MAP_TOO_MANY_FEATURES');
  });

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

  it('uses point names before descriptions and ignores blank labels', () => {
    const preview = parseKmzPreview(
      buffer(`<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
        <Placemark><name>Named point</name><description>Description</description><Point><coordinates>30,50</coordinates></Point></Placemark>
        <Placemark><name>   </name><description>Description-only point</description><Point><coordinates>31,51</coordinates></Point></Placemark>
        <Placemark><name> </name><description> </description><Point><coordinates>32,52</coordinates></Point></Placemark>
      </Document></kml>`),
      'kml',
    );

    expect(preview.points.map((point) => point.label)).toEqual([
      'Named point',
      'Description-only point',
      null,
    ]);
  });

  it('builds separate approximate areas for point-only folders', () => {
    const folderPoints = (longitude: number) =>
      Array.from({ length: 30 }, (_, index) => {
        const coordinates = [`${longitude},50`, `${longitude + 1},50`, `${longitude},51`][
          index % 3
        ];
        return `<Placemark><styleUrl>#red</styleUrl><Point><coordinates>${coordinates}</coordinates></Point></Placemark>`;
      }).join('');
    const preview = parseKmzPreview(
      buffer(`<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
        <Style id="red"><IconStyle><color>ff0000ff</color></IconStyle></Style>
        <Folder><name>First</name>${folderPoints(30)}</Folder>
        <Folder><name>Second</name>${folderPoints(40)}</Folder>
      </Document></kml>`),
      'kml',
    );

    expect(preview.points).toHaveLength(60);
    expect(preview.polygons).toHaveLength(2);
    expect(preview.polygons.every((polygon) => polygon.inferredFromPoints === true)).toBe(true);
    expect(preview.polygons.map((polygon) => polygon.rings[0]?.map((point) => point.lng))).toEqual([
      [30, 31, 30],
      [40, 41, 40],
    ]);
  });

  it('does not invent an area around a few distant points', () => {
    const preview = parseKmzPreview(
      kmz({
        'doc.kml': `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
          <Style id="yellow"><IconStyle><color>ff00ffff</color></IconStyle></Style>
          ${Array.from(
            { length: 7 },
            (_, index) =>
              `<Placemark><styleUrl>#yellow</styleUrl><Point><coordinates>${37.6 + index * 0.001},${index === 6 ? 49.77 : 49.71 + index * 0.002}</coordinates></Point></Placemark>`,
          ).join('')}
        </Document></kml>`,
      }),
      'kmz',
    );

    expect(preview.points).toHaveLength(7);
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

  it('stops streaming KMZ inflation at the actual expansion limit', () => {
    const oversized = new Uint8Array(
      zipSync({ 'doc.kml': strToU8(kmlText(MAX_KMZ_PREVIEW_EXPANDED_BYTES + 1)) }),
    );
    expect(oversized.byteLength).toBeLessThan(MAX_KMZ_PREVIEW_SOURCE_BYTES);
    expect(() => parseKmzPreview(oversized.buffer, 'kmz')).toThrow('KMZ_EXPANDED_TOO_LARGE');
  });

  it('enforces actual output for missing or incorrect ZIP sizes', () => {
    const oversized = new Uint8Array(
      zipSync({ 'doc.kml': strToU8(kmlText(MAX_KMZ_PREVIEW_EXPANDED_BYTES + 1)) }),
    );
    setLocalOriginalSize(oversized, 'doc.kml', 0);

    expect(() => parseKmzPreview(oversized.buffer, 'kmz')).toThrow('KMZ_EXPANDED_TOO_LARGE');
    expect(() =>
      parseKmzPreview(streamingKmz('doc.kml', kmlText(MAX_KMZ_PREVIEW_EXPANDED_BYTES + 1)), 'kmz'),
    ).toThrow('KMZ_EXPANDED_TOO_LARGE');
  });

  it('counts actual output across KML members and permits the exact boundary', () => {
    const firstSize = Math.floor(MAX_KMZ_PREVIEW_EXPANDED_BYTES / 2);
    const combined = new Uint8Array(
      zipSync({
        'first.kml': strToU8(kmlText(firstSize)),
        'second.kml': strToU8(kmlText(MAX_KMZ_PREVIEW_EXPANDED_BYTES - firstSize + 1)),
      }),
    );
    setLocalOriginalSize(combined, 'first.kml', 0);
    setLocalOriginalSize(combined, 'second.kml', 0);
    expect(() => parseKmzPreview(combined.buffer, 'kmz')).toThrow('KMZ_EXPANDED_TOO_LARGE');

    const exact = new Uint8Array(
      zipSync({ 'doc.kml': strToU8(kmlText(MAX_KMZ_PREVIEW_EXPANDED_BYTES)) }),
    );
    expect(parseKmzPreview(exact.buffer, 'kmz')).toEqual({
      points: [],
      lineStrings: [],
      polygons: [],
    });
  });

  it('does not feed a later invalid member after actual output exceeds the limit', () => {
    const archive = new Uint8Array(
      zipSync({
        'oversized.kml': strToU8(kmlText(MAX_KMZ_PREVIEW_EXPANDED_BYTES + 1)),
        'later.kml': strToU8('<kml/>'),
      }),
    );
    setLocalOriginalSize(archive, 'oversized.kml', 0);
    setLocalCompression(archive, 'later.kml', 99);

    expect(() => parseKmzPreview(archive.buffer, 'kmz')).toThrow('KMZ_EXPANDED_TOO_LARGE');
  });
});
