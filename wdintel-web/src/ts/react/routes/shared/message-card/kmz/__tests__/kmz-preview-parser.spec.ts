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
