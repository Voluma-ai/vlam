import { halfToFloat } from '../../core/half-float';
import { packShCoefficients } from '../../core/sh-pack';
import { writeCovariance, type SplatData } from '../../core/splat-data';

const HEADER_BYTES = 4096;
const SECTION_HEADER_BYTES = 1024;
const BUCKET_CENTER_BYTES = 12;
/** Default 8-bit SH dequant range half-width (GaussianSplats3D `Constants`). */
const DEFAULT_SH_RANGE_HALF = 1.5;

interface KsplatHeader {
  versionMajor: number;
  versionMinor: number;
  sectionCount: number;
  splatCount: number;
  compressionLevel: number;
  shCoeffMin: number;
  shCoeffMax: number;
}

interface KsplatSection {
  count: number;
  maxCount: number;
  bucketSize: number;
  bucketCount: number;
  bucketBlockSize: number;
  bucketStorageBytes: number;
  compressionRange: number;
  fullBucketCount: number;
  partialBucketCount: number;
  shDegree: number;
  bytesPerSplat: number;
  base: number;
  bucketsBase: number;
  dataBase: number;
}

/**
 * Parses a GaussianSplats3D `.ksplat` file, including compression levels 0–2.
 * Base color, opacity, position, scale, rotation and optional higher-order
 * spherical harmonics (degrees 1–2) are retained.
 *
 * @throws {Error} if the header, section layout or record data is invalid.
 */
export function parseKsplat(buffer: ArrayBuffer): SplatData {
  const view = new DataView(buffer);
  const header = parseHeader(view);
  const sections = parseSections(view, header);
  const totalSectionSplats = sections.reduce((sum, section) => sum + section.count, 0);
  if (totalSectionSplats !== header.splatCount) {
    throw new Error(
      `Invalid KSPLAT counts: header declares ${header.splatCount}, sections contain ${totalSectionSplats}.`,
    );
  }

  const positions = new Float32Array(header.splatCount * 3);
  const colors = new Uint8Array(header.splatCount * 4);
  const covariances = new Float32Array(header.splatCount * 6);
  const maxShDegree = sections.reduce((max, section) => Math.max(max, section.shDegree), 0);
  const shComponents = shComponentsForDegree(maxShDegree);
  const coefficients = shComponents > 0 ? new Float32Array(header.splatCount * shComponents) : null;
  let outputIndex = 0;

  for (const section of sections) {
    const partialLengths = readPartialBucketLengths(view, section);
    const sectionShComponents = shComponentsForDegree(section.shDegree);
    const shOffset = header.compressionLevel === 0 ? 44 : 24;
    for (let localIndex = 0; localIndex < section.count; localIndex++, outputIndex++) {
      const source = section.dataBase + localIndex * section.bytesPerSplat;
      const position = outputIndex * 3;
      const color = outputIndex * 4;
      const scaleOffset = header.compressionLevel === 0 ? 12 : 6;
      const rotationOffset = header.compressionLevel === 0 ? 24 : 12;
      const colorOffset = header.compressionLevel === 0 ? 40 : 20;

      if (header.compressionLevel === 0) {
        positions[position + 0] = view.getFloat32(source + 0, true);
        positions[position + 1] = view.getFloat32(source + 4, true);
        positions[position + 2] = view.getFloat32(source + 8, true);
      } else {
        const bucket = bucketIndexForSplat(localIndex, section, partialLengths);
        const bucketBase = section.bucketsBase + bucket * section.bucketStorageBytes;
        const factor = (section.bucketBlockSize * 0.5) / section.compressionRange;
        positions[position + 0] =
          (view.getUint16(source + 0, true) - section.compressionRange) * factor +
          view.getFloat32(bucketBase + 0, true);
        positions[position + 1] =
          (view.getUint16(source + 2, true) - section.compressionRange) * factor +
          view.getFloat32(bucketBase + 4, true);
        positions[position + 2] =
          (view.getUint16(source + 4, true) - section.compressionRange) * factor +
          view.getFloat32(bucketBase + 8, true);
      }

      colors[color + 0] = view.getUint8(source + colorOffset + 0);
      colors[color + 1] = view.getUint8(source + colorOffset + 1);
      colors[color + 2] = view.getUint8(source + colorOffset + 2);
      colors[color + 3] = view.getUint8(source + colorOffset + 3);

      const readScalar = (offset: number): number =>
        header.compressionLevel === 0
          ? view.getFloat32(source + offset, true)
          : halfToFloat(view.getUint16(source + offset, true));
      const scalarBytes = header.compressionLevel === 0 ? 4 : 2;
      writeCovariance(
        covariances,
        outputIndex,
        readScalar(scaleOffset + 0 * scalarBytes),
        readScalar(scaleOffset + 1 * scalarBytes),
        readScalar(scaleOffset + 2 * scalarBytes),
        readScalar(rotationOffset + 0 * scalarBytes),
        readScalar(rotationOffset + 1 * scalarBytes),
        readScalar(rotationOffset + 2 * scalarBytes),
        readScalar(rotationOffset + 3 * scalarBytes),
      );

      if (coefficients && sectionShComponents > 0) {
        const dest = outputIndex * shComponents;
        for (let c = 0; c < sectionShComponents; c++) {
          const byteOffset = shOffset + c * shScalarBytes(header.compressionLevel);
          coefficients[dest + c] = readShScalar(
            view,
            source + byteOffset,
            header.compressionLevel,
            header.shCoeffMin,
            header.shCoeffMax,
          );
        }
      }
    }
  }

  const shPacked =
    coefficients && maxShDegree > 0
      ? packShCoefficients(coefficients, header.splatCount, maxShDegree as 1 | 2)
      : undefined;

  return {
    count: header.splatCount,
    positions,
    colors,
    covariances,
    ...(shPacked ? { shPacked } : {}),
  };
}

function shScalarBytes(compressionLevel: number): number {
  return compressionLevel === 0 ? 4 : compressionLevel === 1 ? 2 : 1;
}

function readShScalar(
  view: DataView,
  offset: number,
  compressionLevel: number,
  rangeMin: number,
  rangeMax: number,
): number {
  if (compressionLevel === 0) return view.getFloat32(offset, true);
  if (compressionLevel === 1) return halfToFloat(view.getUint16(offset, true));
  const encoded = view.getUint8(offset);
  return (encoded / 255) * (rangeMax - rangeMin) + rangeMin;
}

function shComponentsForDegree(shDegree: number): number {
  if (shDegree === 0) return 0;
  if (shDegree === 1) return 9;
  if (shDegree === 2) return 24;
  throw new Error(`Unsupported KSPLAT SH degree ${shDegree}.`);
}

function parseHeader(view: DataView): KsplatHeader {
  if (view.byteLength < HEADER_BYTES) throw new Error('Truncated KSPLAT header.');
  const versionMajor = view.getUint8(0);
  const versionMinor = view.getUint8(1);
  const maxSectionCount = view.getUint32(4, true);
  const sectionCount = view.getUint32(8, true);
  const maxSplatCount = view.getUint32(12, true);
  const splatCount = view.getUint32(16, true);
  const compressionLevel = view.getUint16(20, true);
  const shCoeffMin = view.getFloat32(36, true) || -DEFAULT_SH_RANGE_HALF;
  const shCoeffMax = view.getFloat32(40, true) || DEFAULT_SH_RANGE_HALF;

  if (versionMajor !== 0 || versionMinor < 1) {
    throw new Error(
      `Unsupported KSPLAT version ${versionMajor}.${versionMinor}; expected 0.1 or newer.`,
    );
  }
  if (compressionLevel < 0 || compressionLevel > 2) {
    throw new Error(`Unsupported KSPLAT compression level ${compressionLevel}.`);
  }
  if (
    !Number.isSafeInteger(maxSectionCount) ||
    sectionCount > maxSectionCount ||
    sectionCount === 0
  ) {
    throw new Error(`Invalid KSPLAT section count ${sectionCount}/${maxSectionCount}.`);
  }
  if (splatCount > maxSplatCount) {
    throw new Error(`Invalid KSPLAT splat count ${splatCount}/${maxSplatCount}.`);
  }
  const headersEnd = HEADER_BYTES + maxSectionCount * SECTION_HEADER_BYTES;
  if (!Number.isSafeInteger(headersEnd) || headersEnd > view.byteLength) {
    throw new Error('Truncated KSPLAT section headers.');
  }

  return {
    versionMajor,
    versionMinor,
    sectionCount,
    splatCount,
    compressionLevel,
    shCoeffMin,
    shCoeffMax,
  };
}

function parseSections(view: DataView, header: KsplatHeader): KsplatSection[] {
  const maxSectionCount = view.getUint32(4, true);
  let sectionBase = HEADER_BYTES + maxSectionCount * SECTION_HEADER_BYTES;
  const sections: KsplatSection[] = [];

  for (let index = 0; index < maxSectionCount; index++) {
    const offset = HEADER_BYTES + index * SECTION_HEADER_BYTES;
    const count = view.getUint32(offset + 0, true);
    const maxCount = view.getUint32(offset + 4, true);
    const bucketSize = view.getUint32(offset + 8, true);
    const bucketCount = view.getUint32(offset + 12, true);
    const bucketBlockSize = view.getFloat32(offset + 16, true);
    const bucketStorageBytes = view.getUint16(offset + 20, true);
    const compressionRange = view.getUint32(offset + 24, true) || 32767;
    const fullBucketCount = view.getUint32(offset + 32, true);
    const partialBucketCount = view.getUint32(offset + 36, true);
    const shDegree = view.getUint16(offset + 40, true);
    const bytesPerSplat = bytesPerKsplat(header.compressionLevel, shDegree);
    const bucketMetadataBytes = partialBucketCount * 4;
    const bucketBytes = bucketCount * bucketStorageBytes;
    const storageBytes = bucketMetadataBytes + bucketBytes + maxCount * bytesPerSplat;

    if (index < header.sectionCount) {
      if (count > maxCount)
        throw new Error(`Invalid KSPLAT section ${index} count ${count}/${maxCount}.`);
      if (header.compressionLevel > 0) {
        if (bucketSize === 0 || bucketCount === 0 || bucketStorageBytes < BUCKET_CENTER_BYTES) {
          throw new Error(`Invalid KSPLAT bucket layout in section ${index}.`);
        }
        if (!Number.isFinite(bucketBlockSize) || bucketBlockSize <= 0 || compressionRange === 0) {
          throw new Error(`Invalid KSPLAT compression parameters in section ${index}.`);
        }
        if (fullBucketCount + partialBucketCount > bucketCount) {
          throw new Error(
            `Invalid KSPLAT section ${index}: ${fullBucketCount} full + ` +
              `${partialBucketCount} partial buckets exceed the ${bucketCount} declared.`,
          );
        }
      }
      if (sectionBase + storageBytes > view.byteLength) {
        throw new Error(`Truncated KSPLAT data in section ${index}.`);
      }
      sections.push({
        count,
        maxCount,
        bucketSize,
        bucketCount,
        bucketBlockSize,
        bucketStorageBytes,
        compressionRange,
        fullBucketCount,
        partialBucketCount,
        shDegree,
        bytesPerSplat,
        base: sectionBase,
        bucketsBase: sectionBase + bucketMetadataBytes,
        dataBase: sectionBase + bucketMetadataBytes + bucketBytes,
      });
    }
    sectionBase += storageBytes;
  }
  return sections;
}

function bytesPerKsplat(compressionLevel: number, shDegree: number): number {
  if (shDegree < 0 || shDegree > 2) throw new Error(`Unsupported KSPLAT SH degree ${shDegree}.`);
  const shComponents = shComponentsForDegree(shDegree);
  if (compressionLevel === 0) return 44 + shComponents * 4;
  return 24 + shComponents * shScalarBytes(compressionLevel);
}

function readPartialBucketLengths(view: DataView, section: KsplatSection): Uint32Array {
  const lengths = new Uint32Array(section.partialBucketCount);
  for (let i = 0; i < lengths.length; i++) lengths[i] = view.getUint32(section.base + i * 4, true);
  return lengths;
}

function bucketIndexForSplat(
  localIndex: number,
  section: KsplatSection,
  partialLengths: Uint32Array,
): number {
  const fullSplats = section.fullBucketCount * section.bucketSize;
  const checked = (bucket: number): number => {
    // Belt-and-braces: a bucket index at or past bucketCount would read
    // bucket centers out of the section's storage (OOB DataView reads or
    // garbage positions from a hostile file).
    if (bucket >= section.bucketCount) {
      throw new Error(`KSPLAT splat ${localIndex} maps to out-of-range bucket ${bucket}.`);
    }
    return bucket;
  };
  if (localIndex < fullSplats) return checked(Math.floor(localIndex / section.bucketSize));
  let first = fullSplats;
  for (let i = 0; i < partialLengths.length; i++) {
    const length = partialLengths[i] as number;
    if (localIndex < first + length) return checked(section.fullBucketCount + i);
    first += length;
  }
  throw new Error(`KSPLAT splat ${localIndex} does not belong to a bucket.`);
}
