export type ZipEntry = {
  index: number;
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
  crc32: number;
  directory: boolean;
  unavailableReason?: string;
};

export type ZipListing = { entries: ZipEntry[]; totalUncompressedSize: number };
