import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { extractZipEntry, parseZipListing } from '../zip-preview.worker';

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
