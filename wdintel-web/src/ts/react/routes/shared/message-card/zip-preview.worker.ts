import { Inflate } from 'fflate';
import type { ZipEntry, ZipListing } from './zip-preview.types';

const MAX_ENTRIES = 1000;
const MAX_LISTING_ROWS = 1000;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_MEMBER_BYTES = 50 * 1024 * 1024;
const MAX_PATH_LENGTH = 1024;
const MAX_PATH_DEPTH = 32;
export const ZIP_INFLATE_INPUT_CHUNK_BYTES = 16 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const CP437_EXTENDED =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function fail(message: string): never {
  throw new Error(message);
}
function u16(bytes: Uint8Array, offset: number) {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}
function u32(bytes: Uint8Array, offset: number) {
  return (u16(bytes, offset) | (u16(bytes, offset + 2) << 16)) >>> 0;
}
function has(bytes: Uint8Array, offset: number, size: number) {
  return offset >= 0 && size >= 0 && offset + size <= bytes.length;
}
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function decodeUtf8(bytes: Uint8Array): string | null {
  let path: string;
  try {
    path = decoder.decode(bytes);
  } catch {
    return null;
  }
  return path;
}

function decodeCp437(bytes: Uint8Array): string {
  let path = '';
  for (const byte of bytes)
    path += byte < 0x80 ? String.fromCharCode(byte) : CP437_EXTENDED[byte - 0x80]!;
  return path;
}

function unicodePathFromExtra(rawName: Uint8Array, extra: Uint8Array): string | null {
  for (let offset = 0; offset < extra.byteLength;) {
    if (!has(extra, offset, 4)) return null;
    const id = u16(extra, offset);
    const size = u16(extra, offset + 2);
    const dataOffset = offset + 4;
    if (!has(extra, dataOffset, size)) return null;
    if (id === 0x7075 && size >= 5) {
      const data = extra.subarray(dataOffset, dataOffset + size);
      if (data[0] === 1 && u32(data, 1) === crc32(rawName)) return decodeUtf8(data.subarray(5));
    }
    offset = dataOffset + size;
  }
  return null;
}

export function decodeZipEntryPath(rawName: Uint8Array, flags: number, extra: Uint8Array): string {
  const path =
    flags & (1 << 11)
      ? (decodeUtf8(rawName) ?? fail('Архів містить некоректне UTF-8 ім’я файлу.'))
      : (unicodePathFromExtra(rawName, extra) ?? decodeUtf8(rawName) ?? decodeCp437(rawName));
  if (
    !path ||
    path.length > MAX_PATH_LENGTH ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[a-z]:/i.test(path) ||
    path.split('/').some((part) => part === '..') ||
    path.split('/').length > MAX_PATH_DEPTH
  )
    fail('Архів містить небезпечний або надто вкладений шлях.');
  return path;
}

function isMacMetadataPath(path: string): boolean {
  const segments = path.split('/').filter(Boolean);
  const basename = segments.at(-1);
  return (
    segments[0]?.toLowerCase() === '__macosx' ||
    basename?.startsWith('._') === true ||
    basename === '.DS_Store'
  );
}
function hasCentralDirectoryChain(
  bytes: Uint8Array,
  directoryOffset: number,
  directorySize: number,
  entriesCount: number,
  eocdOffset: number,
): boolean {
  if (entriesCount > MAX_ENTRIES || directoryOffset > eocdOffset) return false;
  let offset = directoryOffset;
  for (let index = 0; index < entriesCount; index += 1) {
    if (!has(bytes, offset, 46) || u32(bytes, offset) !== 0x02014b50) return false;
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const recordSize = 46 + nameLength + extraLength + commentLength;
    if (!has(bytes, offset, recordSize) || offset + recordSize > eocdOffset) return false;
    offset += recordSize;
  }
  const headersSize = offset - directoryOffset;
  if (offset === eocdOffset) return directorySize === headersSize;
  if (!has(bytes, offset, 6) || u32(bytes, offset) !== 0x05054b50) return false;
  const signatureSize = 6 + u16(bytes, offset + 4);
  if (offset + signatureSize !== eocdOffset) return false;
  return directorySize === headersSize || directorySize === headersSize + signatureSize;
}

function eocdOffset(bytes: Uint8Array) {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 0x10016); offset -= 1) {
    if (u32(bytes, offset) !== 0x06054b50 || !has(bytes, offset, 22)) continue;
    const commentLength = u16(bytes, offset + 20);
    if (offset + 22 + commentLength !== bytes.length) continue;
    const directorySize = u32(bytes, offset + 12);
    const directoryOffset = u32(bytes, offset + 16);
    const entriesCount = u16(bytes, offset + 10);
    if (directorySize === 0xffffffff || directoryOffset === 0xffffffff) continue;
    if (!hasCentralDirectoryChain(bytes, directoryOffset, directorySize, entriesCount, offset))
      continue;
    return offset;
  }
  fail('Архів пошкоджений або обрізаний: не знайдено центральний каталог.');
}
export function parseZipListing(buffer: ArrayBuffer): ZipListing {
  const bytes = new Uint8Array(buffer);
  const end = eocdOffset(bytes);
  if (!has(bytes, end, 22)) fail('Архів обрізаний.');
  const entriesCount = u16(bytes, end + 10);
  const directorySize = u32(bytes, end + 12);
  const directoryOffset = u32(bytes, end + 16);
  let offset = directoryOffset;
  if (entriesCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff)
    fail('ZIP64 ще не підтримується.');
  if (entriesCount > MAX_ENTRIES || !has(bytes, offset, directorySize))
    fail(
      entriesCount > MAX_ENTRIES
        ? 'В архіві забагато файлів для попереднього перегляду.'
        : 'Архів пошкоджений або обрізаний.',
    );
  const entries: ZipEntry[] = [];
  let totalArchiveUncompressedSize = 0;
  let totalUncompressedSize = 0;
  for (let index = 0; index < entriesCount; index += 1) {
    if (!has(bytes, offset, 46) || u32(bytes, offset) !== 0x02014b50)
      fail('Архів має некоректний центральний каталог.');
    const flags = u16(bytes, offset + 8);
    const compressionMethod = u16(bytes, offset + 10);
    const crc = u32(bytes, offset + 16);
    const compressedSize = u32(bytes, offset + 20);
    const uncompressedSize = u32(bytes, offset + 24);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const localHeaderOffset = u32(bytes, offset + 42);
    const recordSize = 46 + nameLength + extraLength + commentLength;
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    )
      fail('ZIP64 ще не підтримується.');
    if (!has(bytes, offset, recordSize)) fail('Архів обрізаний.');
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const extra = bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    const path = decodeZipEntryPath(rawName, flags, extra);
    const directory = path.endsWith('/');
    totalArchiveUncompressedSize += uncompressedSize;
    if (totalArchiveUncompressedSize > MAX_TOTAL_BYTES)
      fail('Розпакований розмір архіву перевищує ліміт попереднього перегляду.');
    if (isMacMetadataPath(path)) {
      offset += recordSize;
      continue;
    }
    totalUncompressedSize += uncompressedSize;
    entries.push({
      index,
      path,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      localHeaderOffset,
      crc32: crc,
      directory,
      unavailableReason:
        !directory &&
        (flags & 1
          ? 'Зашифрований файл недоступний.'
          : compressionMethod !== 0 && compressionMethod !== 8
            ? 'Цей метод стиснення не підтримується.'
            : uncompressedSize > MAX_MEMBER_BYTES
              ? 'Файл перевищує ліміт розпакування.'
              : undefined),
    });
    offset += recordSize;
  }
  if (!hasCentralDirectoryChain(bytes, directoryOffset, directorySize, entriesCount, end))
    fail('Архів має некоректний центральний каталог.');
  const knownPaths = new Set(entries.map((entry) => entry.path));
  const folders: ZipEntry[] = [];
  for (const entry of entries) {
    const segments = entry.path.split('/').filter(Boolean);
    for (let depth = 1; depth < segments.length; depth += 1) {
      const path = `${segments.slice(0, depth).join('/')}/`;
      if (!knownPaths.has(path)) {
        if (entries.length + folders.length >= MAX_LISTING_ROWS)
          fail('Забагато папок для попереднього перегляду ZIP.');
        knownPaths.add(path);
        folders.push({
          index: -(folders.length + 1),
          path,
          compressedSize: 0,
          uncompressedSize: 0,
          compressionMethod: 0,
          localHeaderOffset: 0,
          crc32: 0,
          directory: true,
        });
      }
    }
  }
  entries.push(...folders);
  entries.sort((left, right) => left.path.localeCompare(right.path) || left.index - right.index);
  return { entries, totalUncompressedSize };
}
export function extractZipEntry(
  buffer: ArrayBuffer,
  entry: ZipEntry,
  onInflateInputChunk?: (processedBytes: number) => void,
): ArrayBuffer {
  if (entry.directory) fail('Папку неможливо завантажити.');
  if (entry.unavailableReason) fail(entry.unavailableReason);
  const bytes = new Uint8Array(buffer);
  const offset = entry.localHeaderOffset;
  if (!has(bytes, offset, 30) || u32(bytes, offset) !== 0x04034b50)
    fail('Архів має некоректне зміщення файлу.');
  const flags = u16(bytes, offset + 6);
  const method = u16(bytes, offset + 8);
  const nameLength = u16(bytes, offset + 26);
  const extraLength = u16(bytes, offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  if (
    flags & 1 ||
    method !== entry.compressionMethod ||
    !has(bytes, dataOffset, entry.compressedSize)
  )
    fail('Архів пошкоджений або файл недоступний.');
  const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
  if (entry.uncompressedSize > MAX_MEMBER_BYTES) fail('Файл перевищує ліміт розпакування.');
  const output =
    method === 0
      ? copyStoredBounded(compressed, entry.uncompressedSize)
      : inflateBounded(compressed, entry.uncompressedSize, onInflateInputChunk);
  if (
    output.byteLength !== entry.uncompressedSize ||
    output.byteLength > MAX_MEMBER_BYTES ||
    crc32(output) !== entry.crc32
  )
    fail('Перевірка цілісності файлу не пройшла.');
  return output.buffer;
}

function copyStoredBounded(compressed: Uint8Array, expectedSize: number): Uint8Array {
  if (compressed.byteLength > expectedSize || compressed.byteLength > MAX_MEMBER_BYTES)
    fail('Файл перевищує ліміт розпакування.');
  return compressed.slice();
}

function inflateBounded(
  compressed: Uint8Array,
  expectedSize: number,
  onInflateInputChunk?: (processedBytes: number) => void,
): Uint8Array {
  const output = new Uint8Array(expectedSize);
  let outputSize = 0;
  const inflater = new Inflate((chunk) => {
    const nextSize = outputSize + chunk.byteLength;
    if (nextSize > expectedSize || nextSize > MAX_MEMBER_BYTES)
      fail('Файл перевищує ліміт розпакування.');
    output.set(chunk, outputSize);
    outputSize = nextSize;
  });
  for (let offset = 0; offset < compressed.byteLength; offset += ZIP_INFLATE_INPUT_CHUNK_BYTES) {
    onInflateInputChunk?.(offset);
    inflater.push(
      compressed.subarray(
        offset,
        Math.min(offset + ZIP_INFLATE_INPUT_CHUNK_BYTES, compressed.byteLength),
      ),
      offset + ZIP_INFLATE_INPUT_CHUNK_BYTES >= compressed.byteLength,
    );
  }
  return output.subarray(0, outputSize);
}
if (typeof self !== 'undefined')
  self.onmessage = (
    event: MessageEvent<{
      requestId: string;
      request:
        | { type: 'list'; buffer: ArrayBuffer }
        | { type: 'extract'; buffer: ArrayBuffer; entry: ZipEntry };
    }>,
  ) => {
    try {
      const { requestId, request } = event.data;
      const value =
        request.type === 'list'
          ? parseZipListing(request.buffer)
          : extractZipEntry(request.buffer, request.entry);
      self.postMessage({ requestId, ok: true, value }, request.type === 'extract' ? [value] : []);
    } catch (error) {
      self.postMessage({
        requestId: event.data.requestId,
        ok: false,
        error: error instanceof Error ? error.message : 'Не вдалося прочитати ZIP.',
      });
    }
  };
