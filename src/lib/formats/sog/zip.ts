/** Internal ZIP primitives shared by whole-file SOG decode and bounded metadata peeks. */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_UINT16 = 0xffff;
const ZIP64_UINT32 = 0xffffffff;

export interface ZipEndOfCentralDirectory {
  readonly entryCount: number;
  readonly centralDirectoryOffset: number;
  readonly centralDirectorySize: number;
}

export interface ZipCentralDirectoryEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly localOffset: number;
}

export interface ZipLocalFileHeader {
  readonly dataOffset: number;
}

/** Validates the fixed local-header prefix and returns its full byte length. */
export function zipLocalHeaderSize(
  bytes: Uint8Array,
  entry: ZipCentralDirectoryEntry,
  offset = 0,
): number | null {
  if (
    offset < 0 ||
    offset + 30 > bytes.byteLength ||
    readUint32(bytes, offset) !== LOCAL_SIGNATURE
  ) {
    return null;
  }
  if (readUint16(bytes, offset + 8) !== entry.method) return null;
  return 30 + readUint16(bytes, offset + 26) + readUint16(bytes, offset + 28);
}

/** Finds a non-ZIP64 end-of-central-directory record in the supplied tail bytes. */
export function findZipEndOfCentralDirectory(bytes: Uint8Array): ZipEndOfCentralDirectory | null {
  // A ZIP footer is 22 bytes plus at most a uint16-sized archive comment.
  // Whole-file callers must not scan gigabytes of malformed payload data.
  const scanEnd = Math.max(0, bytes.byteLength - 22 - 0xffff);
  for (let offset = bytes.byteLength - 22; offset >= scanEnd; offset--) {
    if (readUint32(bytes, offset) !== EOCD_SIGNATURE) continue;
    const disk = readUint16(bytes, offset + 4);
    const directoryDisk = readUint16(bytes, offset + 6);
    const entriesOnDisk = readUint16(bytes, offset + 8);
    const entryCount = readUint16(bytes, offset + 10);
    const centralDirectorySize = readUint32(bytes, offset + 12);
    const centralDirectoryOffset = readUint32(bytes, offset + 16);
    const commentLength = readUint16(bytes, offset + 20);
    if (offset + 22 + commentLength !== bytes.byteLength) continue;
    if (
      disk !== 0 ||
      directoryDisk !== 0 ||
      entriesOnDisk !== entryCount ||
      entryCount === ZIP64_UINT16 ||
      centralDirectorySize === ZIP64_UINT32 ||
      centralDirectoryOffset === ZIP64_UINT32
    ) {
      return null;
    }
    return { entryCount, centralDirectoryOffset, centralDirectorySize };
  }
  return null;
}

/** Parses every central-directory entry from exactly its declared byte range. */
export function parseZipCentralDirectory(
  bytes: Uint8Array,
  entryCount: number,
): ZipCentralDirectoryEntry[] | null {
  const entries: ZipCentralDirectoryEntry[] = [];
  let cursor = 0;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > bytes.byteLength || readUint32(bytes, cursor) !== CENTRAL_SIGNATURE)
      return null;
    const method = readUint16(bytes, cursor + 10);
    const compressedSize = readUint32(bytes, cursor + 20);
    const nameLength = readUint16(bytes, cursor + 28);
    const extraLength = readUint16(bytes, cursor + 30);
    const commentLength = readUint16(bytes, cursor + 32);
    const localOffset = readUint32(bytes, cursor + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (
      cursor + recordLength > bytes.byteLength ||
      compressedSize === ZIP64_UINT32 ||
      localOffset === ZIP64_UINT32
    ) {
      return null;
    }
    entries.push({
      name: new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)),
      method,
      compressedSize,
      localOffset,
    });
    cursor += recordLength;
  }
  return cursor === bytes.byteLength ? entries : null;
}

/** Validates a local header against its central-directory entry. */
export function validateZipLocalFileHeader(
  bytes: Uint8Array,
  entry: ZipCentralDirectoryEntry,
  offset = 0,
): ZipLocalFileHeader | null {
  const headerLength = zipLocalHeaderSize(bytes, entry, offset);
  if (headerLength === null) return null;
  const nameLength = readUint16(bytes, offset + 26);
  if (offset + headerLength > bytes.byteLength) return null;
  const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
  if (name !== entry.name) return null;
  return { dataOffset: offset + headerLength };
}

/** Decodes the two ZIP methods supported by SOG bundles. */
export async function decodeZipPayload(
  compressed: Uint8Array,
  method: number,
  entryName: string,
): Promise<Uint8Array> {
  if (method === 0) return compressed;
  if (method === 8) {
    const stream = new Blob([compressed as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error(`Unsupported ZIP compression method ${method} for "${entryName}".`);
}

/** Returns a readable entry map for a complete non-ZIP64 archive. */
export function readZipEntries(buffer: ArrayBuffer): Map<string, () => Promise<Uint8Array>> {
  const bytes = new Uint8Array(buffer);
  const eocd = findZipEndOfCentralDirectory(bytes);
  if (eocd === null) throw new Error('Unsupported or corrupt ZIP archive end-of-directory record.');
  if (eocd.centralDirectoryOffset + eocd.centralDirectorySize > bytes.byteLength) {
    throw new Error('Corrupt ZIP central directory.');
  }
  const directory = bytes.subarray(
    eocd.centralDirectoryOffset,
    eocd.centralDirectoryOffset + eocd.centralDirectorySize,
  );
  const entries = parseZipCentralDirectory(directory, eocd.entryCount);
  if (entries === null) throw new Error('Corrupt or unsupported ZIP central directory.');

  return new Map(
    entries.map((entry) => [
      entry.name,
      async () => {
        const header = validateZipLocalFileHeader(bytes, entry, entry.localOffset);
        if (header === null)
          throw new Error(`Corrupt ZIP entry "${entry.name}": local header mismatch.`);
        if (header.dataOffset + entry.compressedSize > bytes.byteLength) {
          throw new Error(`Corrupt ZIP entry "${entry.name}": data extends past the archive.`);
        }
        return decodeZipPayload(
          bytes.subarray(header.dataOffset, header.dataOffset + entry.compressedSize),
          entry.method,
          entry.name,
        );
      },
    ]),
  );
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}
