/**
 * Shared PLY header reader.
 *
 * PLY is a container, not a format: the same `.ply` extension carries the
 * uncompressed "INRIA flavor" 3DGS export (see `parse-splat-ply.ts`) and
 * SuperSplat/PlayCanvas's compressed flavor (`parse-compressed-ply.ts`).
 * Both need the same thing first - the element list, their property layouts,
 * and where each element's records start - so that lives here.
 */

/** Byte size of each scalar type PLY can declare. */
const PROPERTY_SIZES: Record<string, number> = {
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
  int: 4,
  int32: 4,
  uint: 4,
  uint32: 4,
  short: 2,
  int16: 2,
  ushort: 2,
  uint16: 2,
  char: 1,
  int8: 1,
  uchar: 1,
  uint8: 1,
};

/** One scalar property of an element. */
export interface PlyProperty {
  readonly type: string;
  /** Byte offset within one record of the element. */
  readonly offset: number;
}

/**
 * One list property (`property list <countType> <itemType> <name>`), such as a
 * mesh's `face` indices. Only the types are recorded - the data is variable-size
 * and must be walked record by record (see `parse-mesh-ply.ts`).
 */
export interface PlyListProperty {
  /** Type of the per-record item count, e.g. `uchar`. */
  readonly countType: string;
  /** Type of each item, e.g. `int`. */
  readonly itemType: string;
}

/** One PLY element (`element <name> <count>`) and its record layout. */
export interface PlyElement {
  readonly name: string;
  readonly count: number;
  readonly properties: ReadonlyMap<string, PlyProperty>;
  /** Property names in declaration order. */
  readonly propertyNames: readonly string[];
  /** List properties by name; empty unless {@link hasListProperty}. */
  readonly listProperties: ReadonlyMap<string, PlyListProperty>;
  /**
   * Bytes per record - meaningless when {@link hasListProperty}, since a list
   * makes each record's size depend on its contents.
   */
  readonly stride: number;
  /**
   * Byte offset of this element's first record within the file, or -1 when a
   * preceding element has a variable-size record and no arithmetic can find it.
   */
  readonly offset: number;
  /** A list property makes this element's records variable-size. */
  readonly hasListProperty: boolean;
}

/** A parsed PLY header. */
export interface PlyHeader {
  readonly elements: readonly PlyElement[];
  /** The element of that name, or undefined. */
  element(name: string): PlyElement | undefined;
}

/**
 * Reads a binary little-endian PLY header and resolves every element's byte
 * offset by walking the elements in declaration order.
 *
 * Whether the declared records actually fit in the buffer is deliberately not
 * checked here - call {@link assertPlyElementFits} once the caller has
 * validated the properties it needs, so a wrong property type is reported as
 * such rather than as the truncation it happens to imply.
 *
 * @throws {Error} if the file is not a binary little-endian PLY, or declares a
 * property type this reader cannot size.
 */
export function parsePlyHeader(buffer: ArrayBuffer): PlyHeader {
  const headerBytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 64 * 1024));
  const headerText = new TextDecoder('ascii').decode(headerBytes);
  const endMatch = /end_header\r?\n/.exec(headerText);
  if (!/^ply\r?\n/.test(headerText)) {
    throw new Error('Not a PLY file (missing "ply" magic).');
  }
  if (!endMatch) {
    throw new Error(
      'Unsupported PLY file: no "end_header" within the first 64 KiB - the header exceeds the ' +
        'supported window, or the file is truncated.',
    );
  }
  if (!headerText.includes('format binary_little_endian 1.0')) {
    throw new Error('Unsupported PLY format; expected binary_little_endian 1.0.');
  }

  interface Building {
    name: string;
    count: number;
    properties: Map<string, PlyProperty>;
    propertyNames: string[];
    listProperties: Map<string, PlyListProperty>;
    stride: number;
    hasListProperty: boolean;
  }
  const building: Building[] = [];

  for (const line of headerText.slice(0, endMatch.index).split('\n')) {
    const tokens = line.trim().split(/\s+/);
    if (tokens[0] === 'element') {
      const name = tokens[1];
      const count = Number(tokens[2]);
      if (name === undefined) throw new Error(`Malformed PLY element: "${line.trim()}"`);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(`Invalid PLY ${name} count: ${tokens[2]}.`);
      }
      building.push({
        name,
        count,
        properties: new Map(),
        propertyNames: [],
        listProperties: new Map(),
        stride: 0,
        hasListProperty: false,
      });
    } else if (tokens[0] === 'property') {
      const element = building[building.length - 1];
      if (!element) throw new Error(`PLY property declared before any element: "${line.trim()}"`);
      if (tokens[1] === 'list') {
        // A list makes this element's records variable-size. That is fine for
        // the element itself (a trailing `face` list is common) - it only
        // costs later elements their computable offset. The types are recorded
        // so a reader that does want the data can walk it record by record.
        const countType = tokens[2] ?? '';
        const itemType = tokens[3] ?? '';
        const listName = tokens[4];
        if (
          PROPERTY_SIZES[countType] === undefined ||
          PROPERTY_SIZES[itemType] === undefined ||
          listName === undefined
        ) {
          throw new Error(`Unsupported PLY property: "${line.trim()}"`);
        }
        if (element.properties.has(listName) || element.listProperties.has(listName)) {
          throw new Error(`Duplicate PLY property "${listName}" in element "${element.name}".`);
        }
        element.listProperties.set(listName, { countType, itemType });
        element.hasListProperty = true;
        continue;
      }
      const type = tokens[1] ?? '';
      const size = PROPERTY_SIZES[type];
      const name = tokens[2];
      if (size === undefined || name === undefined) {
        throw new Error(`Unsupported PLY property: "${line.trim()}"`);
      }
      if (element.properties.has(name) || element.listProperties.has(name)) {
        // A duplicate name would let the later offset overwrite the earlier
        // one while the stride counts both - every read after it lands on
        // the wrong bytes.
        throw new Error(`Duplicate PLY property "${name}" in element "${element.name}".`);
      }
      element.properties.set(name, { type, offset: element.stride });
      element.propertyNames.push(name);
      element.stride += size;
    }
  }

  // Records are laid out back to back in element order, starting right after
  // the header - so each element begins where the previous one ended, until a
  // variable-size element makes the rest unreachable by arithmetic.
  let offset = endMatch.index + endMatch[0].length;
  let resolved = true;
  const elements: PlyElement[] = [];
  for (const element of building) {
    elements.push({
      name: element.name,
      count: element.count,
      properties: element.properties,
      propertyNames: element.propertyNames,
      listProperties: element.listProperties,
      stride: element.stride,
      offset: resolved ? offset : -1,
      hasListProperty: element.hasListProperty,
    });
    if (element.hasListProperty) resolved = false;
    else offset += element.count * element.stride;
  }

  return {
    elements,
    element: (name: string) => elements.find((candidate) => candidate.name === name),
  };
}

/**
 * Asserts an element's records are actually present in a file of `totalBytes`.
 *
 * Takes a size rather than a buffer so it works for a streamed parse, which
 * only ever holds a window of the file.
 *
 * @throws {Error} if the element sits behind a variable-size one, or its
 * records run past the end of the file.
 */
export function assertPlyElementFits(element: PlyElement, totalBytes: number): void {
  if (element.offset < 0) {
    throw new Error(
      `Unsupported PLY layout: element "${element.name}" follows a list property, so its ` +
        'position cannot be determined.',
    );
  }
  const end = element.offset + element.count * element.stride;
  if (end > totalBytes) {
    throw new Error(
      `Truncated PLY file: element "${element.name}" needs ${end} bytes but the file is ` +
        `${totalBytes}.`,
    );
  }
}

/**
 * Byte size of a PLY scalar type.
 *
 * @throws {Error} if the type is not one PLY can declare.
 */
export function plyTypeSize(type: string): number {
  const size = PROPERTY_SIZES[type];
  if (size === undefined) throw new Error(`Unsupported PLY property type: "${type}".`);
  return size;
}

/** The byte offset of `property` within `element`'s record. */
export function plyPropertyOffset(element: PlyElement, property: string): number {
  const found = element.properties.get(property);
  if (!found) {
    throw new Error(`PLY element "${element.name}" is missing property "${property}".`);
  }
  return found.offset;
}

/** Asserts every named property exists on `element` with the given type. */
export function assertPlyPropertyTypes(
  element: PlyElement,
  properties: readonly string[],
  types: readonly string[],
  what: string,
): void {
  for (const name of properties) {
    const property = element.properties.get(name);
    if (!property) {
      throw new Error(`${what}: missing property "${name}".`);
    }
    if (!types.includes(property.type)) {
      throw new Error(
        `Unsupported PLY property type for "${name}": expected ${types.join(' or ')}, ` +
          `got ${property.type}.`,
      );
    }
  }
}
