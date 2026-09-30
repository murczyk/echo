import {
  LEGACY_OFFICE_MAX_CFB_DIRECTORY_ENTRIES,
  LEGACY_OFFICE_MAX_CFB_STREAMS,
  LEGACY_OFFICE_TYPED_BUFFER_BUDGET,
} from './legacy-office-limits';
import { LegacyOfficePreviewError, LegacyOfficePreviewErrorCode } from './legacy-office-errors';

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const HEADER_SIZE = 512;
const DIRECTORY_ENTRY_SIZE = 128;

type CfbDirectoryEntry = {
  index: number;
  parentIndex: number | null;
  name: string;
  type: number;
  startSector: number;
  size: number;
};
type CfbDirectoryReferences = { left: number; right: number; child: number };

export type ValidatedCfb = {
  directory: readonly CfbDirectoryEntry[];
  streams: ReadonlyMap<string, CfbDirectoryEntry>;
  readStream(name: string): Uint8Array;
};

function reject(code = LegacyOfficePreviewErrorCode.InvalidCfb): never {
  throw new LegacyOfficePreviewError(code);
}

function isSpecialSector(value: number): boolean {
  return value === FREESECT || value === ENDOFCHAIN || value === FATSECT || value === DIFSECT;
}

function checkedByteLength(count: number, itemSize: number): number {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > Math.floor(LEGACY_OFFICE_TYPED_BUFFER_BUDGET / itemSize)
  ) {
    reject(LegacyOfficePreviewErrorCode.ResourceLimit);
  }
  return count * itemSize;
}

export function validateCfbContainer(buffer: ArrayBuffer): ValidatedCfb {
  if (buffer.byteLength < HEADER_SIZE) reject();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (!signature.every((value, index) => bytes[index] === value)) reject();
  if (view.getUint16(28, true) !== 0xfffe || view.getUint16(32, true) !== 6) reject();
  const majorVersion = view.getUint16(26, true);
  const sectorShift = view.getUint16(30, true);
  if (!((majorVersion === 3 && sectorShift === 9) || (majorVersion === 4 && sectorShift === 12)))
    reject();
  const sectorSize = 1 << sectorShift;
  if ((buffer.byteLength - HEADER_SIZE) % sectorSize !== 0) reject();
  const sectorCount = (buffer.byteLength - HEADER_SIZE) / sectorSize;
  if (sectorCount <= 0) reject();
  let allocatedBytes = 0;
  const reserve = (size: number) => {
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      allocatedBytes > LEGACY_OFFICE_TYPED_BUFFER_BUDGET - size
    )
      reject(LegacyOfficePreviewErrorCode.ResourceLimit);
    allocatedBytes += size;
  };
  const entriesPerSector = sectorSize / 4;
  const sectorOffset = (sector: number) => {
    if (!Number.isInteger(sector) || sector < 0 || sector >= sectorCount) reject();
    return HEADER_SIZE + sector * sectorSize;
  };
  const readSector = (sector: number) => new DataView(buffer, sectorOffset(sector), sectorSize);
  const firstDirectorySector = view.getUint32(48, true);
  const fatSectorCount = view.getUint32(44, true);
  const firstMiniFatSector = view.getUint32(60, true);
  const miniFatSectorCount = view.getUint32(64, true);
  const firstDifatSector = view.getUint32(68, true);
  const difatSectorCount = view.getUint32(72, true);
  if (majorVersion === 3 && view.getUint32(40, true) !== 0) reject();
  if (
    difatSectorCount > sectorCount ||
    fatSectorCount > sectorCount ||
    miniFatSectorCount > sectorCount
  )
    reject();

  const roles = new Map<number, string>();
  const claim = (sector: number, role: string) => {
    if (isSpecialSector(sector)) reject();
    sectorOffset(sector);
    if (roles.has(sector)) reject();
    roles.set(sector, role);
  };
  const fatSectors: number[] = [];
  const seenFat = new Set<number>();
  const addFat = (sector: number) => {
    if (sector === FREESECT || sector === ENDOFCHAIN) return;
    if (seenFat.has(sector)) reject();
    seenFat.add(sector);
    claim(sector, 'fat');
    fatSectors.push(sector);
  };
  for (let index = 0; index < 109; index += 1) {
    const sector = view.getUint32(76 + index * 4, true);
    if (index < Math.min(fatSectorCount, 109)) {
      if (sector === FREESECT || sector === ENDOFCHAIN) reject();
      addFat(sector);
    } else if (sector !== FREESECT) reject();
  }
  const expectedDifatEntries = difatSectorCount * (entriesPerSector - 1);
  checkedByteLength(expectedDifatEntries, 4);
  let difat = firstDifatSector;
  const seenDifat = new Set<number>();
  for (let index = 0; index < difatSectorCount; index += 1) {
    if (difat === ENDOFCHAIN || difat === FREESECT || seenDifat.has(difat)) reject();
    seenDifat.add(difat);
    claim(difat, 'difat');
    const sector = readSector(difat);
    for (let entry = 0; entry < entriesPerSector - 1; entry += 1) {
      const fatSector = sector.getUint32(entry * 4, true);
      if (fatSectors.length < fatSectorCount) {
        if (fatSector === FREESECT || fatSector === ENDOFCHAIN) reject();
        addFat(fatSector);
      } else if (fatSector !== FREESECT) reject();
    }
    difat = sector.getUint32(sectorSize - 4, true);
  }
  if (difat !== ENDOFCHAIN || fatSectors.length !== fatSectorCount) reject();
  const fatByteLength = checkedByteLength(fatSectors.length * entriesPerSector, 4);
  reserve(fatByteLength);
  const fat = new Uint32Array(fatSectors.length * entriesPerSector);
  fatSectors.forEach((sector, sectorIndex) => {
    const data = readSector(sector);
    for (let entry = 0; entry < entriesPerSector; entry += 1)
      fat[sectorIndex * entriesPerSector + entry] = data.getUint32(entry * 4, true);
  });
  for (const sector of fatSectors) if (fat[sector] !== FATSECT) reject();
  for (const sector of seenDifat) if (fat[sector] !== DIFSECT) reject();

  const walkFat = (start: number, role: string, expectedBytes?: number): number[] => {
    if (expectedBytes === 0) {
      if (start !== ENDOFCHAIN && start !== FREESECT) reject();
      return [];
    }
    const chain: number[] = [];
    const seen = new Set<number>();
    let current = start;
    const requiredSectors = expectedBytes == null ? null : Math.ceil(expectedBytes / sectorSize);
    for (let steps = 0; steps < sectorCount; steps += 1) {
      if (current === ENDOFCHAIN) {
        if (requiredSectors != null && chain.length !== requiredSectors) reject();
        return chain;
      }
      if (
        current === FREESECT ||
        isSpecialSector(current) ||
        current >= sectorCount ||
        current >= fat.length ||
        seen.has(current)
      )
        reject();
      seen.add(current);
      if (roles.has(current)) reject();
      roles.set(current, role);
      chain.push(current);
      if (requiredSectors != null && chain.length > requiredSectors) reject();
      current = fat[current]!;
    }
    reject();
  };

  const directoryChain = walkFat(firstDirectorySector, 'directory');
  if (directoryChain.length === 0) reject();
  const directoryBytes = directoryChain.length * sectorSize;
  const directory: CfbDirectoryEntry[] = [];
  let declaredStreamBytes = 0;
  const directoryNodes: Array<CfbDirectoryEntry | null> = [];
  const directoryReferences: CfbDirectoryReferences[] = [];
  for (const sectorId of directoryChain) {
    const sector = readSector(sectorId);
    for (let offset = 0; offset < sectorSize; offset += DIRECTORY_ENTRY_SIZE) {
      reserve(DIRECTORY_ENTRY_SIZE);
      const nameLength = sector.getUint16(offset + 64, true);
      const type = sector.getUint8(offset + 66);
      const references = {
        left: sector.getUint32(offset + 68, true),
        right: sector.getUint32(offset + 72, true),
        child: sector.getUint32(offset + 76, true),
      };
      directoryReferences.push(references);
      if (directoryNodes.length >= LEGACY_OFFICE_MAX_CFB_DIRECTORY_ENTRIES)
        reject(LegacyOfficePreviewErrorCode.ResourceLimit);
      if (type === 0) {
        directoryNodes.push(null);
        continue;
      }
      if (![1, 2, 5].includes(type) || nameLength < 2 || nameLength > 64 || nameLength % 2 !== 0)
        reject();
      let name = '';
      for (let charOffset = 0; charOffset < nameLength - 2; charOffset += 2)
        name += String.fromCharCode(sector.getUint16(offset + charOffset, true));
      if (sector.getUint16(offset + nameLength - 2, true) !== 0) reject();
      const sizeLow = sector.getUint32(offset + 120, true);
      const sizeHigh = sector.getUint32(offset + 124, true);
      if (sizeHigh !== 0 || sizeLow > buffer.byteLength) reject();
      const entry = {
        index: directoryNodes.length,
        parentIndex: null,
        name,
        type,
        startSector: sector.getUint32(offset + 116, true),
        size: sizeLow,
      };
      if (type === 2) {
        declaredStreamBytes += entry.size;
        if (
          !Number.isSafeInteger(declaredStreamBytes) ||
          declaredStreamBytes > LEGACY_OFFICE_TYPED_BUFFER_BUDGET
        )
          reject(LegacyOfficePreviewErrorCode.ResourceLimit);
      }
      directory.push(entry);
      directoryNodes.push(entry);
    }
  }
  if (directoryBytes / DIRECTORY_ENTRY_SIZE !== directoryNodes.length) reject();
  const root = directory.find((entry) => entry.type === 5);
  if (root == null || directory.filter((entry) => entry.type === 5).length !== 1) reject();
  const rootIndex = root.index;
  const rootReferences = directoryReferences[rootIndex];
  if (
    rootReferences == null ||
    rootReferences.left !== FREESECT ||
    rootReferences.right !== FREESECT
  )
    reject();
  const isDirectoryReference = (reference: number) =>
    reference === FREESECT ||
    (Number.isInteger(reference) &&
      reference >= 0 &&
      reference < directoryNodes.length &&
      directoryNodes[reference] != null);
  for (let index = 0; index < directoryNodes.length; index += 1) {
    const entry = directoryNodes[index];
    if (entry == null) continue;
    const references = directoryReferences[index]!;
    if (![references.left, references.right, references.child].every(isDirectoryReference))
      reject();
    if (entry.type === 2 && references.child !== FREESECT) reject();
  }
  const visitedDirectoryEntries = new Set<number>([rootIndex]);
  const pendingDirectoryEntries =
    rootReferences.child === FREESECT
      ? []
      : [{ index: rootReferences.child, parentIndex: rootIndex }];
  while (pendingDirectoryEntries.length > 0) {
    const pending = pendingDirectoryEntries.pop();
    if (pending == null || visitedDirectoryEntries.has(pending.index)) reject();
    const { index, parentIndex } = pending;
    visitedDirectoryEntries.add(index);
    const entry = directoryNodes[index];
    if (entry == null) reject();
    entry.parentIndex = parentIndex;
    const references = directoryReferences[index]!;
    for (const reference of [references.left, references.right])
      if (reference !== FREESECT) pendingDirectoryEntries.push({ index: reference, parentIndex });
    if (references.child !== FREESECT)
      pendingDirectoryEntries.push({ index: references.child, parentIndex: index });
  }
  if (visitedDirectoryEntries.size !== directory.length) reject();
  const namesByParent = new Map<number, Set<string>>();
  for (const entry of directory) {
    if (entry.index === rootIndex || entry.parentIndex == null) continue;
    const names = namesByParent.get(entry.parentIndex) ?? new Set<string>();
    const normalizedName = entry.name.toLowerCase();
    if (names.has(normalizedName)) reject();
    names.add(normalizedName);
    namesByParent.set(entry.parentIndex, names);
  }
  const miniFatChain = walkFat(firstMiniFatSector, 'mini-fat', miniFatSectorCount * sectorSize);
  if (miniFatChain.length !== miniFatSectorCount) reject();
  const rootMiniStream =
    root.size === 0
      ? walkFat(root.startSector, 'root-mini-stream', 0)
      : walkFat(root.startSector, 'root-mini-stream', root.size);
  const miniFatEntries = miniFatChain.length * entriesPerSector;
  const miniFatByteLength = checkedByteLength(miniFatEntries, 4);
  reserve(miniFatByteLength);
  const miniFat = new Uint32Array(miniFatEntries);
  miniFatChain.forEach((sectorId, sectorIndex) => {
    const sector = readSector(sectorId);
    for (let entry = 0; entry < entriesPerSector; entry += 1)
      miniFat[sectorIndex * entriesPerSector + entry] = sector.getUint32(entry * 4, true);
  });
  const rootMiniCapacity = rootMiniStream.length * sectorSize;
  const miniSectorSize = 64;
  const walkMini = (start: number, size: number): number[] => {
    if (size === 0) return [];
    const needed = Math.ceil(size / miniSectorSize);
    const seen = new Set<number>();
    const claimed = miniSectors;
    const chain: number[] = [];
    let current = start;
    for (let count = 0; count < needed; count += 1) {
      if (
        current === ENDOFCHAIN ||
        current === FREESECT ||
        current >= miniFat.length ||
        seen.has(current) ||
        claimed.has(current) ||
        (current + 1) * miniSectorSize > rootMiniCapacity
      )
        reject();
      seen.add(current);
      claimed.add(current);
      chain.push(current);
      current = miniFat[current]!;
    }
    if (current !== ENDOFCHAIN) reject();
    return chain;
  };
  const miniSectors = new Set<number>();
  const regularChains = new Map<number, number[]>();
  const miniChains = new Map<number, number[]>();
  for (const entry of directory) {
    if (entry.type !== 2) continue;
    if (entry.size === 0) {
      if (entry.startSector !== ENDOFCHAIN && entry.startSector !== FREESECT) reject();
      miniChains.set(entry.index, []);
    } else if (entry.size < 4096)
      miniChains.set(entry.index, walkMini(entry.startSector, entry.size));
    else
      regularChains.set(
        entry.index,
        walkFat(entry.startSector, `stream:${entry.index}`, entry.size),
      );
  }
  const streams = new Map<string, CfbDirectoryEntry>();
  let streamCount = 0;
  for (const entry of directory)
    if (entry.type === 2) {
      streamCount += 1;
      if (streamCount > LEGACY_OFFICE_MAX_CFB_STREAMS)
        reject(LegacyOfficePreviewErrorCode.ResourceLimit);
      if (entry.parentIndex === rootIndex) streams.set(entry.name, entry);
    }
  const copyRegularChain = (chain: readonly number[], size: number): Uint8Array => {
    checkedByteLength(size, 1);
    reserve(size);
    const output = new Uint8Array(size);
    let outputOffset = 0;
    for (const sectorId of chain) {
      const input = new Uint8Array(buffer, sectorOffset(sectorId), sectorSize);
      const length = Math.min(size - outputOffset, sectorSize);
      if (length <= 0) break;
      output.set(input.subarray(0, length), outputOffset);
      outputOffset += length;
    }
    if (outputOffset !== size) reject();
    return output;
  };
  const rootMiniBytes =
    root.size === 0 ? new Uint8Array() : copyRegularChain(rootMiniStream, root.size);
  const readStream = (name: string): Uint8Array => {
    const entry = streams.get(name);
    if (entry == null) reject(LegacyOfficePreviewErrorCode.UnsupportedStructure);
    const regularChain = regularChains.get(entry.index);
    if (regularChain != null) return copyRegularChain(regularChain, entry.size);
    const miniChain = miniChains.get(entry.index);
    if (miniChain == null) reject();
    checkedByteLength(entry.size, 1);
    reserve(entry.size);
    const output = new Uint8Array(entry.size);
    let outputOffset = 0;
    for (const miniSectorId of miniChain) {
      const miniOffset = miniSectorId * miniSectorSize;
      const length = Math.min(entry.size - outputOffset, miniSectorSize);
      if (length <= 0 || miniOffset + length > rootMiniBytes.length) reject();
      output.set(rootMiniBytes.subarray(miniOffset, miniOffset + length), outputOffset);
      outputOffset += length;
    }
    if (outputOffset !== entry.size) reject();
    return output;
  };
  return { directory, streams, readStream };
}
