const ansi = /\u001b\[[0-9;]*m/g;

/**
 * Short trailer for a failed preflight gate. Git UIs keep only the end of a
 * hook log, so the failing test names and error lines have to be restated
 * after the full transcript.
 *
 * @param {string} output
 */
export function failureSummary(output) {
  const lines = output.replace(ansi, '').split(/\r?\n/);
  const titles = [];
  const errors = [];
  const seenTitles = new Set();
  const seenErrors = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Playwright's closing list (`[project] › file › name`). Numbered `1)`
    // copies of the same title are the long error blocks above that list.
    if (/^\[[^\]]+\]\s+›\s+/.test(trimmed) && !/^\d+\)/.test(trimmed)) {
      if (!seenTitles.has(trimmed)) {
        seenTitles.add(trimmed);
        titles.push(trimmed);
      }
      continue;
    }
    if (
      /^(?:Error|AssertionError|RangeError|TypeError|TimeoutError):/.test(trimmed) ||
      /\berror TS\d+:/.test(trimmed) ||
      /^\d+:\d+\s+error\b/.test(trimmed) ||
      /^FAIL\s+/.test(trimmed)
    ) {
      if (!seenErrors.has(trimmed)) {
        seenErrors.add(trimmed);
        errors.push(trimmed);
      }
    }
  }

  const parts = [];
  if (titles.length > 0) {
    parts.push(titles.slice(0, 20).join('\n'));
    if (titles.length > 20) parts.push(`… ${titles.length - 20} more failed tests`);
  }
  if (errors.length > 0) {
    parts.push(errors.slice(0, 8).join('\n'));
    if (errors.length > 8) parts.push(`… ${errors.length - 8} more errors`);
  }
  if (parts.length > 0) return parts.join('\n\n');

  const tail = lines
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(-20);
  return tail.join('\n') || '(no output)';
}
