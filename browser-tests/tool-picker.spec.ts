import { expect, test } from '@playwright/test';

interface BrowserToolPicker {
  setToolVisible(
    tool: 'none' | 'paint' | 'annotate' | 'measure' | 'select',
    visible: boolean,
  ): void;
}

interface ToolPickerWindow extends Window {
  buildTestToolPicker: (
    active: 'none' | 'paint' | 'annotate' | 'measure' | 'select',
    onChange: (tool: string) => void,
  ) => BrowserToolPicker;
}

test('hides unavailable tools and resets an active tool', async ({ page }) => {
  await page.goto('/src/viewer/backend-probe.html');
  await page.setContent('<div id="bottom-chrome"><div id="effects"></div></div>');
  await page.addScriptTag({
    type: 'module',
    content: `
      import { buildToolPicker } from '/src/viewer/tool-picker.ts';
      window.buildTestToolPicker = buildToolPicker;
    `,
  });
  await page.waitForFunction(() => 'buildTestToolPicker' in window);

  const state = await page.evaluate(() => {
    const changes: string[] = [];
    const picker = (window as unknown as ToolPickerWindow).buildTestToolPicker('paint', (tool) =>
      changes.push(tool),
    );
    picker.setToolVisible('paint', false);
    picker.setToolVisible('select', false);

    const select = document.querySelector<HTMLSelectElement>('select[aria-label="tool"]');
    const option = (tool: string): HTMLOptionElement | undefined =>
      [...(select?.options ?? [])].find((candidate) => candidate.value === tool);
    return {
      value: select?.value,
      changes,
      paint: { hidden: option('paint')?.hidden, disabled: option('paint')?.disabled },
      select: { hidden: option('select')?.hidden, disabled: option('select')?.disabled },
      annotate: { hidden: option('annotate')?.hidden, disabled: option('annotate')?.disabled },
      measure: { hidden: option('measure')?.hidden, disabled: option('measure')?.disabled },
    };
  });

  expect(state).toEqual({
    value: 'none',
    changes: ['none'],
    paint: { hidden: true, disabled: true },
    select: { hidden: true, disabled: true },
    annotate: { hidden: false, disabled: false },
    measure: { hidden: false, disabled: false },
  });
});
