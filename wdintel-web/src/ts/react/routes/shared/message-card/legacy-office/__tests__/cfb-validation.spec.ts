import { describe, expect, it } from 'vitest';

import { validateCfbContainer } from '../cfb-validation';
import { LegacyOfficePreviewError, LegacyOfficePreviewErrorCode } from '../legacy-office-errors';

const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const DIRECTORY_SECTOR = 0;
const FAT_SECTOR = 2;
const DATA_SECTOR = 3;

type Entry = {
  name: string;
  type: number;
  left?: number;
  right?: number;
  child?: number;
  size?: number;
};

function writeEntry(view: DataView, index: number, entry: Entry): void {
  const offset = 512 + DIRECTORY_SECTOR * 512 + index * 128;
  for (const [characterIndex, character] of [...entry.name].entries())
    view.setUint16(offset + characterIndex * 2, character.charCodeAt(0), true);
  view.setUint16(offset + entry.name.length * 2, 0, true);
  view.setUint16(offset + 64, entry.name.length * 2 + 2, true);
  view.setUint8(offset + 66, entry.type);
  view.setUint32(offset + 68, entry.left ?? FREESECT, true);
  view.setUint32(offset + 72, entry.right ?? FREESECT, true);
  view.setUint32(offset + 76, entry.child ?? FREESECT, true);
  view.setUint32(offset + 116, entry.size === 4096 ? DATA_SECTOR : ENDOFCHAIN, true);
  view.setUint32(offset + 120, entry.size ?? 0, true);
}

function cfb(entries: Entry[]): ArrayBuffer {
  const buffer = new ArrayBuffer(512 * 12);
  const view = new DataView(buffer);
  new Uint8Array(buffer).set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  view.setUint16(26, 3, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, 1, true);
  view.setUint32(48, DIRECTORY_SECTOR, true);
  view.setUint32(56, 4096, true);
  view.setUint32(60, ENDOFCHAIN, true);
  view.setUint32(64, 0, true);
  view.setUint32(68, ENDOFCHAIN, true);
  view.setUint32(72, 0, true);
  for (let index = 0; index < 109; index += 1) view.setUint32(76 + index * 4, FREESECT, true);
  view.setUint32(76, FAT_SECTOR, true);
  for (let index = 0; index < 128; index += 1)
    view.setUint32(512 + FAT_SECTOR * 512 + index * 4, FREESECT, true);
  view.setUint32(512 + FAT_SECTOR * 512, 1, true);
  view.setUint32(512 + FAT_SECTOR * 512 + 4, ENDOFCHAIN, true);
  view.setUint32(512 + FAT_SECTOR * 512 + FAT_SECTOR * 4, FATSECT, true);
  for (let sector = DATA_SECTOR; sector < DATA_SECTOR + 8; sector += 1)
    view.setUint32(
      512 + FAT_SECTOR * 512 + sector * 4,
      sector === DATA_SECTOR + 7 ? ENDOFCHAIN : sector + 1,
      true,
    );
  entries.forEach((entry, index) => writeEntry(view, index, entry));
  return buffer;
}

function nestedCfb(): ArrayBuffer {
  return cfb([
    { name: 'Root Entry', type: 5, child: 1 },
    { name: 'WordDocument', type: 2, left: 3, right: 2 },
    { name: '0Table', type: 2 },
    { name: 'ObjectPool', type: 1, child: 4 },
    { name: 'WordDocument', type: 2, right: 5, size: 4096 },
    { name: '0Table', type: 2, right: 6 },
    { name: '1Table', type: 2 },
  ]);
}

function nestedStreamCountCfb(streamCount: number): ArrayBuffer {
  const directorySectorCount = Math.ceil((streamCount + 2) / 4);
  const fatSectorCount = Math.ceil(directorySectorCount / 127);
  const fatStart = directorySectorCount;
  const sectorCount = directorySectorCount + fatSectorCount;
  const buffer = new ArrayBuffer(512 * (sectorCount + 1));
  const view = new DataView(buffer);
  new Uint8Array(buffer).set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  view.setUint16(26, 3, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, fatSectorCount, true);
  view.setUint32(48, DIRECTORY_SECTOR, true);
  view.setUint32(56, 4096, true);
  view.setUint32(60, ENDOFCHAIN, true);
  view.setUint32(68, ENDOFCHAIN, true);
  for (let index = 0; index < 109; index += 1) view.setUint32(76 + index * 4, FREESECT, true);
  for (let index = 0; index < fatSectorCount; index += 1)
    view.setUint32(76 + index * 4, fatStart + index, true);
  for (let sector = 0; sector < fatSectorCount; sector += 1)
    for (let index = 0; index < 128; index += 1)
      view.setUint32(512 + (fatStart + sector) * 512 + index * 4, FREESECT, true);
  for (let sector = 0; sector < directorySectorCount; sector += 1)
    view.setUint32(
      512 + fatStart * 512 + sector * 4,
      sector + 1 === directorySectorCount ? ENDOFCHAIN : sector + 1,
      true,
    );
  for (let sector = 0; sector < fatSectorCount; sector += 1)
    view.setUint32(512 + fatStart * 512 + (fatStart + sector) * 4, FATSECT, true);
  writeEntry(view, 0, { name: 'Root Entry', type: 5, child: 1 });
  writeEntry(view, 1, { name: 'ObjectPool', type: 1, child: 2 });
  for (let index = 0; index < streamCount; index += 1)
    writeEntry(view, index + 2, {
      name: `stream-${index}`,
      type: 2,
      right: index + 1 === streamCount ? FREESECT : index + 3,
    });
  return buffer;
}

describe('CFB directory hierarchy', () => {
  it('accepts duplicate stream names under different storages and exposes root streams only', () => {
    const result = validateCfbContainer(nestedCfb());

    expect(result.streams.has('WordDocument')).toBe(true);
    expect(result.streams.has('0Table')).toBe(true);
    expect(result.streams.has('1Table')).toBe(false);
    expect(result.streams.size).toBe(2);
    expect(result.directory.find((entry) => entry.index === 4)?.parentIndex).toBe(3);
  });

  it('rejects duplicate names in one storage', () => {
    expect(() =>
      validateCfbContainer(
        cfb([
          { name: 'Root Entry', type: 5, child: 1 },
          { name: 'ObjectPool', type: 1, child: 2 },
          { name: '\x01CompObj', type: 2, right: 3 },
          { name: '\x01compobj', type: 2 },
        ]),
      ),
    ).toThrow(LegacyOfficePreviewError);
  });

  it('counts nested streams toward the total stream limit without exposing them', () => {
    expect(validateCfbContainer(nestedStreamCountCfb(1_000)).streams.size).toBe(0);
    try {
      validateCfbContainer(nestedStreamCountCfb(1_001));
    } catch (error) {
      expect((error as LegacyOfficePreviewError).code).toBe(
        LegacyOfficePreviewErrorCode.ResourceLimit,
      );
      return;
    }
    throw new Error('Expected the 1,001st nested stream to be rejected');
  });

  it('rejects nested-chain ownership reuse, cycles, multiple parents, and unreachable entries', () => {
    const cases: Array<(view: DataView) => void> = [
      (view) => {
        view.setUint32(512 + DIRECTORY_SECTOR * 512 + 2 * 128 + 116, DATA_SECTOR, true);
        view.setUint32(512 + DIRECTORY_SECTOR * 512 + 2 * 128 + 120, 4096, true);
      },
      (view) => view.setUint32(512 + DIRECTORY_SECTOR * 512 + 4 * 128 + 72, 4, true),
      (view) => view.setUint32(512 + DIRECTORY_SECTOR * 512 + 2 * 128 + 68, 4, true),
      (view) => writeEntry(view, 5, { name: 'Unreachable', type: 2 }),
    ];
    for (const mutate of cases) {
      const buffer = nestedCfb();
      mutate(new DataView(buffer));
      expect(() => validateCfbContainer(buffer)).toThrow(LegacyOfficePreviewError);
    }
  });

  it('classifies hierarchy corruption as an invalid CFB', () => {
    const buffer = nestedCfb();
    new DataView(buffer).setUint32(512 + DIRECTORY_SECTOR * 512 + 4 * 128 + 72, 4, true);
    try {
      validateCfbContainer(buffer);
    } catch (error) {
      expect((error as LegacyOfficePreviewError).code).toBe(
        LegacyOfficePreviewErrorCode.InvalidCfb,
      );
    }
  });
});
