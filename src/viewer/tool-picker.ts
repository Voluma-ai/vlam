/**
 * Pointer-mode switcher, the twin of the effect picker beside it: an **effect**
 * changes how the scene looks, a **tool** changes what clicking does.
 *
 * Tools are mutually exclusive by nature - a click cannot both paint and drop a
 * label - so one `<select>` holds all of them and stays a single row however
 * many are added. That is the whole point: the demo showcases a growing set of
 * examples, and a button per mode does not survive that.
 *
 * The picker owns no behaviour. It sets `document.body.dataset.tool`, which CSS
 * uses to reveal each tool's own controls (the separation panel, the measure
 * readout), and reports the change so the host can arm the matching handlers.
 */
export type ViewerTool = 'none' | 'paint' | 'annotate' | 'measure' | 'select';

const VIEWER_TOOLS = new Set<ViewerTool>(['none', 'paint', 'annotate', 'measure', 'select']);

/** Parses `?tool=` from a share link; unknown values are ignored. */
export function parseViewerTool(value: string | null | undefined): ViewerTool | null {
  if (value == null || !VIEWER_TOOLS.has(value as ViewerTool)) return null;
  return value as ViewerTool;
}

const TOOLS: { value: ViewerTool; label: string; title: string }[] = [
  { value: 'none', label: 'tool', title: 'Click and drag move the camera' },
  {
    value: 'paint',
    label: 'paint',
    title: 'LMB on a splat paints it; LMB elsewhere orbits; C clears',
  },
  { value: 'annotate', label: 'annotate', title: 'Click to pin a label to a point on the capture' },
  {
    value: 'measure',
    label: 'measure',
    title: 'Click two points to measure the distance between them',
  },
  {
    value: 'select',
    label: 'select & cut',
    title: 'Place a volume with the gizmo, then separate it',
  },
];

export interface ToolPicker {
  readonly element: HTMLElement;
  /** Reflects a tool change the picker did not originate (a URL param, a reset). */
  setValue(tool: ViewerTool): void;
  /** The slot each tool hangs its own controls in, to the right of the select. */
  readonly slot: HTMLElement;
}

/** Builds the picker and mounts it in the bottom chrome, before the effects nav. */
export function buildToolPicker(
  active: ViewerTool,
  onChange: (tool: ViewerTool) => void,
): ToolPicker {
  const picker = document.createElement('nav');
  picker.id = 'tools';

  const label = document.createElement('label');
  label.className = 'label';

  const select = document.createElement('select');
  select.className = 'picker-select';
  select.setAttribute('aria-label', 'tool');
  for (const { value, label: text, title } of TOOLS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    option.title = title;
    select.appendChild(option);
  }
  label.appendChild(select);
  picker.appendChild(label);

  const slot = document.createElement('span');
  slot.className = 'tool-slot';
  picker.appendChild(slot);

  const apply = (tool: ViewerTool): void => {
    select.value = tool;
    // CSS reveals the tool's controls from this attribute, so a tool can own
    // chrome that the picker itself knows nothing about.
    document.body.dataset.tool = tool;
    select.title = TOOLS.find((t) => t.value === tool)?.title ?? '';
  };

  select.addEventListener('change', () => {
    const tool = select.value as ViewerTool;
    apply(tool);
    onChange(tool);
  });
  // The native dropdown takes focus; without this the keyboard flight controls
  // stop responding until the canvas is clicked again.
  select.addEventListener('pointerdown', (e) => e.stopPropagation());

  apply(active);

  const chrome = document.querySelector('#bottom-chrome');
  const effects = document.querySelector('#effects');
  if (chrome && effects) chrome.insertBefore(picker, effects);
  else (chrome ?? document.body).appendChild(picker);

  return {
    element: picker,
    slot,
    setValue: apply,
  };
}
