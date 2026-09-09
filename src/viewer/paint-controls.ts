import type { SelectionDepthMode, SelectionFootprintMode } from '../lib/selection';

/** Mutable paint settings read atomically when a stroke starts. */
export interface PaintBrushSettings {
  depth: SelectionDepthMode;
  footprint: SelectionFootprintMode;
  radiusPx: number;
}

/** Builds the compact controls shown beside the active paint tool. */
export function buildPaintControls(settings: PaintBrushSettings): HTMLElement {
  const controls = document.createElement('span');
  controls.className = 'paint-controls';

  const choice = <T extends string>(
    labelText: string,
    values: readonly T[],
    current: T,
    apply: (value: T) => void,
  ): HTMLLabelElement => {
    const label = document.createElement('label');
    label.className = 'label';
    label.append(`${labelText} `);
    const select = document.createElement('select');
    select.className = 'picker-select';
    select.setAttribute('aria-label', `Paint ${labelText}`);
    for (const value of values) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    }
    select.value = current;
    select.addEventListener('pointerdown', (event) => event.stopPropagation());
    select.addEventListener('change', () => apply(select.value as T));
    label.appendChild(select);
    return label;
  };

  controls.append(
    choice('depth', ['surface', 'through'] as const, settings.depth, (value) => {
      settings.depth = value;
    }),
    choice('target', ['center', 'footprint'] as const, settings.footprint, (value) => {
      settings.footprint = value;
    }),
  );

  const radius = document.createElement('label');
  radius.className = 'label';
  radius.append('size ');
  const range = document.createElement('input');
  range.type = 'range';
  range.min = '2';
  range.max = '80';
  range.step = '1';
  range.value = String(settings.radiusPx);
  range.setAttribute('aria-label', 'Paint brush radius in pixels');
  const output = document.createElement('output');
  output.textContent = `${settings.radiusPx}px`;
  range.addEventListener('pointerdown', (event) => event.stopPropagation());
  range.addEventListener('input', () => {
    settings.radiusPx = Number(range.value);
    output.textContent = `${settings.radiusPx}px`;
  });
  radius.append(range, output);
  controls.append(radius);
  return controls;
}
