import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { decodeZipEntryPath, extractZipEntry, parseZipListing } from '../zip-preview.worker';

const CP437_REFERENCE =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function unicodePathExtra(
  rawName: Uint8Array,
  unicodeName: string,
  nameCrc = crc32(rawName),
): Uint8Array {
  const name = strToU8(unicodeName);
  const extra = new Uint8Array(4 + 5 + name.byteLength);
  const view = new DataView(extra.buffer);
  view.setUint16(0, 0x7075, true);
  view.setUint16(2, 5 + name.byteLength, true);
  extra[4] = 1;
  view.setUint32(5, nameCrc, true);
  extra.set(name, 9);
  return extra;
}

function legacyCp437ZipFixture(): ArrayBuffer {
  const archive = zipSync({ a: strToU8('legacy ZIP member') });
  const replaceName = (signature: number, nameOffset: number) => {
    for (let index = 0; index <= archive.length - 4; index += 1) {
      if (new DataView(archive.buffer, index, 4).getUint32(0, true) === signature) {
        archive[index + nameOffset] = 0xe0;
        return;
      }
    }
    throw new Error('ZIP header not found');
  };
  replaceName(0x04034b50, 30);
  replaceName(0x02014b50, 46);
  return archive.buffer as ArrayBuffer;
}

function macosZipFixture(): ArrayBuffer {
  const archive = zipSync({
    '__MACOSX/': new Uint8Array(),
    '__MACOSX/._Звіт.txt': strToU8('metadata'),
    '._Звіт.txt': strToU8('metadata'),
    '.DS_Store': strToU8('metadata'),
    'Звіт.txt': strToU8('report'),
    'Папка/Дані.csv': strToU8('data'),
  });
  const view = new DataView(archive.buffer);
  let offset = view.getUint32(eocdOffset(archive) + 16, true);
  for (let index = 0; index < 6; index += 1) {
    const localOffset = view.getUint32(offset + 42, true);
    view.setUint16(localOffset + 6, view.getUint16(localOffset + 6, true) & ~(1 << 11), true);
    view.setUint16(offset + 8, view.getUint16(offset + 8, true) & ~(1 << 11), true);
    offset +=
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
  return archive.buffer as ArrayBuffer;
}

function eocdOffset(archive: Uint8Array): number {
  for (let index = archive.length - 22; index >= 0; index -= 1) {
    if (
      archive[index] === 0x50 &&
      archive[index + 1] === 0x4b &&
      archive[index + 2] === 0x05 &&
      archive[index + 3] === 0x06
    )
      return index;
  }
  throw new Error('EOCD not found');
}

function zipWithComment(comment: Uint8Array): ArrayBuffer {
  const archive = zipSync({ 'entry.txt': strToU8('comment fixture') });
  const end = eocdOffset(archive);
  const result = new Uint8Array(archive.byteLength + comment.byteLength);
  result.set(archive);
  new DataView(result.buffer).setUint16(end + 20, comment.byteLength, true);
  result.set(comment, archive.byteLength);
  return result.buffer;
}

function zipWithCraftedEocdTrailer(): ArrayBuffer {
  const archive = zipSync({ 'entry.txt': strToU8('comment fixture') });
  const realEocd = eocdOffset(archive);
  const centralDirectoryOffset = new DataView(archive.buffer).getUint32(realEocd + 16, true);
  const trailer = new Uint8Array(22);
  const trailerView = new DataView(trailer.buffer);
  trailerView.setUint32(0, 0x06054b50, true);
  trailerView.setUint16(8, 1, true);
  trailerView.setUint16(10, 1, true);
  trailerView.setUint32(12, archive.byteLength - centralDirectoryOffset, true);
  trailerView.setUint32(16, centralDirectoryOffset, true);
  trailerView.setUint16(20, 0, true);
  return zipWithComment(trailer);
}

function zipWithCentralDirectorySignature(
  data: Uint8Array,
  declaredLength = data.byteLength,
  includeInDirectorySize = false,
): ArrayBuffer {
  const archive = zipSync({ 'signed.txt': strToU8('signed member') });
  const end = eocdOffset(archive);
  const signature = new Uint8Array(6 + data.byteLength);
  const signatureView = new DataView(signature.buffer);
  signatureView.setUint32(0, 0x05054b50, true);
  signatureView.setUint16(4, declaredLength, true);
  signature.set(data, 6);
  const result = new Uint8Array(archive.byteLength + signature.byteLength);
  result.set(archive.subarray(0, end));
  result.set(signature, end);
  result.set(archive.subarray(end), end + signature.byteLength);
  if (includeInDirectorySize) {
    const view = new DataView(result.buffer);
    view.setUint32(
      end + signature.byteLength + 12,
      view.getUint32(end + signature.byteLength + 12, true) + signature.byteLength,
      true,
    );
  }
  return result.buffer;
}

describe('ZIP preview worker', () => {
  it('lists metadata without inflating members and extracts only the selected member', () => {
    const archive = zipSync({
      'nested/hello.txt': [strToU8('hello'), { level: 0 }],
      'second.txt': strToU8('second'),
    });
    const listing = parseZipListing(archive.buffer as ArrayBuffer);
    expect(listing.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(['nested/', 'nested/hello.txt', 'second.txt']),
    );
    const selected = listing.entries.find((entry) => entry.path === 'nested/hello.txt')!;
    expect(
      new TextDecoder().decode(extractZipEntry(archive.buffer.slice(0) as ArrayBuffer, selected)),
    ).toBe('hello');
  });

  it('rejects malformed input', () => {
    expect(() => parseZipListing(new Uint8Array([1, 2, 3]).buffer)).toThrow(
      /пошкоджений|обрізаний/i,
    );
  });

  it('uses the real EOCD after normal and EOCD-shaped comments', () => {
    const normal = zipWithComment(strToU8('normal archive comment'));
    expect(parseZipListing(normal).entries[0]?.path).toBe('entry.txt');

    const falseCandidate = new Uint8Array(22);
    const view = new DataView(falseCandidate.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(20, 0, true);
    const crafted = zipWithComment(falseCandidate);
    const entry = parseZipListing(crafted).entries[0]!;
    expect(entry.path).toBe('entry.txt');
    expect(new TextDecoder().decode(extractZipEntry(crafted, entry))).toBe('comment fixture');

    const craftedTrailer = zipWithCraftedEocdTrailer();
    const trailerEntry = parseZipListing(craftedTrailer).entries[0]!;
    expect(trailerEntry.path).toBe('entry.txt');
    expect(new TextDecoder().decode(extractZipEntry(craftedTrailer, trailerEntry))).toBe(
      'comment fixture',
    );
  });

  it('rejects a truncated archive comment', () => {
    const archive = new Uint8Array(zipWithComment(strToU8('short')));
    new DataView(archive.buffer).setUint16(eocdOffset(archive) + 20, 10, true);
    expect(() => parseZipListing(archive.buffer)).toThrow(/пошкоджений|обрізаний/i);
  });

  it('accepts one complete central-directory digital signature with either size convention', () => {
    const signatureData = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Uint8Array(18)]);
    for (const includeInDirectorySize of [false, true]) {
      const archive = zipWithCentralDirectorySignature(
        signatureData,
        signatureData.byteLength,
        includeInDirectorySize,
      );
      const entry = parseZipListing(archive).entries[0]!;
      expect(entry.path).toBe('signed.txt');
      expect(new TextDecoder().decode(extractZipEntry(archive, entry))).toBe('signed member');
    }
  });

  it('rejects truncated and wrong-length central-directory signature records', () => {
    expect(() => parseZipListing(zipWithCentralDirectorySignature(strToU8('xx'), 4))).toThrow(
      /пошкоджений|обрізаний/i,
    );
    expect(() => parseZipListing(zipWithCentralDirectorySignature(strToU8('xxx'), 2))).toThrow(
      /пошкоджений|обрізаний/i,
    );
  });

  it('decodes UTF-8, CP437, and validated Unicode Path entry names', () => {
    expect(decodeZipEntryPath(strToU8('київ.txt'), 1 << 11, new Uint8Array())).toBe('київ.txt');
    expect(decodeZipEntryPath(strToU8('київ.txt'), 0, new Uint8Array())).toBe('київ.txt');
    const cp437 = new Uint8Array([0x82, 0x2e, 0x74, 0x78, 0x74]);
    expect(decodeZipEntryPath(cp437, 0, new Uint8Array())).toBe('é.txt');
    expect(decodeZipEntryPath(cp437, 0, unicodePathExtra(cp437, 'київ.txt'))).toBe('київ.txt');
    expect(decodeZipEntryPath(cp437, 0, unicodePathExtra(cp437, 'київ.txt', 0))).toBe('é.txt');
  });

  it('matches an independent CP437 reference for every extended byte', () => {
    expect(
      decodeZipEntryPath(
        Uint8Array.from({ length: 128 }, (_, index) => index + 0x80),
        0,
        new Uint8Array(),
      ),
    ).toBe(CP437_REFERENCE);
  });

  it('lists and extracts an unflagged legacy α filename from a complete ZIP fixture', () => {
    const archive = legacyCp437ZipFixture();
    const entry = parseZipListing(archive).entries[0]!;
    expect(entry.path).toBe('α');
    expect(new TextDecoder().decode(extractZipEntry(archive, entry))).toBe('legacy ZIP member');
  });

  it('lists macOS UTF-8 names without Finder metadata and extracts the chosen file', () => {
    const archive = macosZipFixture();
    const listing = parseZipListing(archive);
    expect(listing.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(['Звіт.txt', 'Папка/', 'Папка/Дані.csv']),
    );
    expect(listing.entries).toHaveLength(3);
    expect(listing.totalUncompressedSize).toBe(10);
    const entry = listing.entries.find((candidate) => candidate.path === 'Звіт.txt')!;
    expect(new TextDecoder().decode(extractZipEntry(archive, entry))).toBe('report');
  });

  it('still applies the extraction-size limit to hidden Finder metadata', () => {
    const archive = zipSync({ '__MACOSX/._file.txt': strToU8('metadata') });
    const view = new DataView(archive.buffer);
    const directoryOffset = view.getUint32(eocdOffset(archive) + 16, true);
    view.setUint32(directoryOffset + 24, 200 * 1024 * 1024 + 1, true);
    expect(() => parseZipListing(archive.buffer as ArrayBuffer)).toThrow(
      'Розпакований розмір архіву перевищує ліміт',
    );
  });

  it('rejects malformed flagged UTF-8 names', () => {
    expect(() => decodeZipEntryPath(new Uint8Array([0xff]), 1 << 11, new Uint8Array())).toThrow(
      'некоректне UTF-8',
    );
  });

  it('keeps a bounded final listing when folders are inferred', () => {
    const nearLimit = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => [`file-${index}.txt`, strToU8('x')]),
    );
    expect(parseZipListing(zipSync(nearLimit).buffer as ArrayBuffer).entries).toHaveLength(1_000);

    const deepPaths = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, index) => [`folder-${index}/file.txt`, strToU8('x')]),
    );
    expect(() => parseZipListing(zipSync(deepPaths).buffer as ArrayBuffer)).toThrow(
      'Забагато папок',
    );
  });

  it('stops a forged small member while it exceeds the extraction limit', () => {
    const oversized = new Uint8Array(50 * 1024 * 1024 + 1);
    const archive = zipSync({ 'oversized.txt': oversized });
    const centralDirectoryOffset = (() => {
      for (let index = archive.length - 4; index >= 0; index -= 1) {
        if (
          archive[index] === 0x50 &&
          archive[index + 1] === 0x4b &&
          archive[index + 2] === 0x01 &&
          archive[index + 3] === 0x02
        )
          return index;
      }
      throw new Error('central directory not found');
    })();
    new DataView(archive.buffer).setUint32(centralDirectoryOffset + 24, 1, true);
    const entry = parseZipListing(archive.buffer as ArrayBuffer).entries[0]!;
    const processedChunks: number[] = [];
    expect(() =>
      extractZipEntry(archive.buffer as ArrayBuffer, entry, (processed) =>
        processedChunks.push(processed),
      ),
    ).toThrow('Файл перевищує ліміт розпакування.');
    expect(processedChunks.at(-1)! + 16 * 1024).toBeLessThan(entry.compressedSize);
  });
});
