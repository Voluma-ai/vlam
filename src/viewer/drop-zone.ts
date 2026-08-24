/**
 * Full-window drag-and-drop target for local splat scenes (M8.x demo).
 *
 * The whole viewport is the drop area, and nothing is ever uploaded: a single
 * file decodes through `loadSceneFile`, and a **folder** streams in place via
 * `StreamedSplatMesh.loadLocal` - its files are read through `blob:` URLs,
 * which serve range requests just as an HTTP origin does, so a multi-hundred-
 * megabyte `.lcc` `data.bin` is never read whole. The overlay only appears
 * while a drag actually carries files, so it never blocks orbiting.
 */

import { SINGLE_FILE_LIST as SUPPORTED_LIST, isSupportedSplatFile } from './scene-url';

export interface DropZoneOptions {
  /** A single self-contained splat file was dropped. */
  onFile: (file: File) => void;
  /** A folder was dropped; `files` is keyed by path relative to its root. */
  onDirectory: (files: Map<string, File>, name: string) => void;
  /** The drop carried nothing loadable; `message` explains why. */
  onReject: (message: string) => void;
}

/** A directory entry, in the shape browsers actually expose it. */
interface DirectoryEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file(onSuccess: (file: File) => void, onError: (error: Error) => void): void;
  createReader(): {
    readEntries(
      onSuccess: (entries: DirectoryEntry[]) => void,
      onError: (error: Error) => void,
    ): void;
  };
}

/**
 * Walks a dropped directory into a `path → File` map.
 *
 * `readEntries` returns at most 100 entries per call and signals the end with
 * an empty batch, so each directory is drained in a loop - a capture folder
 * with hundreds of tiles would otherwise silently load only its first 100.
 */
async function readDirectory(entry: DirectoryEntry, prefix = ''): Promise<Map<string, File>> {
  const files = new Map<string, File>();
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise<DirectoryEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) break;
    for (const child of batch) {
      const path = prefix + child.name;
      if (child.isFile) {
        files.set(path, await new Promise<File>((resolve, reject) => child.file(resolve, reject)));
      } else if (child.isDirectory) {
        for (const [nested, file] of await readDirectory(child, `${path}/`))
          files.set(nested, file);
      }
    }
  }
  return files;
}

/**
 * Converts a `webkitdirectory` file input's picks into the shape a drop
 * produces, so a picked folder and a dropped one load through the same call.
 *
 * The two APIs disagree about the root: {@link readDirectory} yields paths
 * *relative to* the chosen folder, while `webkitRelativePath` *includes* it
 * (`myscene/data.bin`). `StreamedSplatMesh.loadLocal` expects the former, so
 * the leading segment is stripped here and returned as the scene name.
 *
 * Returns null when the pick was empty (Cancel, or an empty folder).
 */
export function filesFromDirectoryInput(
  list: ArrayLike<File>,
): { files: Map<string, File>; name: string } | null {
  const picked = Array.from(list);
  if (picked.length === 0) return null;

  const files = new Map<string, File>();
  let name = '';
  for (const file of picked) {
    // Empty on a browser that reports no relative path; such a file has no
    // place in the tree, so it keeps its bare name at the root.
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
    const segments = relative.split('/').filter(Boolean);
    if (segments.length > 1) {
      if (name === '') name = segments[0] as string;
      files.set(segments.slice(1).join('/'), file);
    } else {
      files.set(segments[0] ?? file.name, file);
    }
  }
  return { files, name: name === '' ? 'Selected folder' : name };
}

/**
 * Classifies a drop. `webkitGetAsEntry` must be called synchronously while the
 * handler runs - the `DataTransfer` is neutered the moment it returns - so the
 * entries are captured here and read asynchronously afterwards.
 */
function classify(
  transfer: DataTransfer,
): { file: File } | { directory: DirectoryEntry } | { error: string } {
  const entries = Array.from(transfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry() as DirectoryEntry | null);
  const directories = entries.filter(
    (entry): entry is DirectoryEntry => entry?.isDirectory === true,
  );

  // A single self-contained file wins: dropping goose.ply should not be read
  // as a one-file folder.
  const supported = Array.from(transfer.files).find((file) => isSupportedSplatFile(file.name));
  if (supported && directories.length === 0) return { file: supported };

  if (directories.length === 1) return { directory: directories[0] as DirectoryEntry };
  if (directories.length > 1) return { error: 'Drop one scene folder at a time.' };

  const files = Array.from(transfer.files);
  if (files.length === 0) return { error: 'That drop contained no files.' };
  return {
    error:
      `"${files[0]?.name}" is not a splat file this viewer can read. Drop a ${SUPPORTED_LIST} file, ` +
      'or a folder holding a .lcc, .lcc2, .rad or lod-meta.json scene.',
  };
}

/** Builds the drop overlay: hidden until a drag carrying files enters. */
function buildOverlay(): HTMLElement {
  const zone = document.createElement('div');
  zone.id = 'dropzone';
  const card = document.createElement('div');
  card.className = 'dropzone-card';
  const title = document.createElement('strong');
  title.textContent = 'Drop a splat file or scene folder to view it';
  const hint = document.createElement('span');
  hint.textContent = `${SUPPORTED_LIST}, or a .lcc / .lcc2 / .rad / sog folder · stays on your device`;
  card.append(title, hint);
  zone.appendChild(card);
  document.body.appendChild(zone);
  return zone;
}

/** Makes the whole window a drop target for splat files and scene folders. */
export function createDropZone({ onFile, onDirectory, onReject }: DropZoneOptions): void {
  const zone = buildOverlay();

  // dragenter/dragleave fire in pairs as the pointer crosses *every* element
  // under it, so a plain "leave hides it" flickers. Count the nesting instead.
  let depth = 0;
  const hide = (): void => {
    depth = 0;
    zone.classList.remove('visible');
  };

  /** Whether a drag carries files, as opposed to selected text or a link. */
  const carriesFiles = (event: DragEvent): boolean =>
    event.dataTransfer?.types.includes('Files') === true;

  window.addEventListener('dragenter', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth++;
    zone.classList.add('visible');
  });

  window.addEventListener('dragover', (event) => {
    if (!carriesFiles(event)) return;
    // Without preventDefault the browser navigates to the file on drop.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (event) => {
    if (!carriesFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) zone.classList.remove('visible');
  });

  window.addEventListener('drop', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    hide();
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const chosen = classify(transfer);
    if ('error' in chosen) {
      onReject(chosen.error);
    } else if ('file' in chosen) {
      onFile(chosen.file);
    } else {
      // Reading the folder is async, but its entry was captured above while
      // the DataTransfer was still alive.
      readDirectory(chosen.directory)
        .then((files) => {
          if (files.size === 0) onReject(`"${chosen.directory.name}" is empty.`);
          else onDirectory(files, chosen.directory.name);
        })
        .catch((error: unknown) => {
          onReject(`Could not read "${chosen.directory.name}": ${(error as Error).message}`);
        });
    }
  });

  // A drag that ends outside the window (or is cancelled with Escape) never
  // fires `drop`, and Chrome can swallow the final `dragleave`.
  window.addEventListener('dragend', hide);
  window.addEventListener('blur', hide);
}
