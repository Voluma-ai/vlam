/** STORE-method ZIP readable by the peek path (and by parseSog). */
export function buildZip(entries: Record<string, Uint8Array | string>): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const files = Object.entries(entries).map(([name, content]) => ({
    name: encoder.encode(name),
    data: typeof content === 'string' ? encoder.encode(content) : content,
  }));

  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const local = new Uint8Array(30 + file.name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(18, file.data.length, true);
    localView.setUint32(22, file.data.length, true);
    localView.setUint16(26, file.name.length, true);
    local.set(file.name, 30);
    chunks.push(local, file.data);

    const record = new Uint8Array(46 + file.name.length);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, 0x02014b50, true);
    recordView.setUint16(10, 0, true);
    recordView.setUint32(20, file.data.length, true);
    recordView.setUint32(24, file.data.length, true);
    recordView.setUint16(28, file.name.length, true);
    recordView.setUint32(42, offset, true);
    record.set(file.name, 46);
    central.push(record);
    offset += local.length + file.data.length;
  }

  const centralSize = central.reduce((sum, record) => sum + record.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  const parts = [...chunks, ...central, eocd];
  const archive = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  return archive;
}
