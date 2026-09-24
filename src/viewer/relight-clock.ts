/** Viewer-only civil clock and NOAA solar position for the relight demo. */
const presets = {
  Amsterdam: { latitude: 52.3676, longitude: 4.9041, zone: 'Europe/Amsterdam' },
  Athens: { latitude: 37.9838, longitude: 23.7275, zone: 'Europe/Athens' },
  London: { latitude: 51.5072, longitude: -0.1276, zone: 'Europe/London' },
  'New York': { latitude: 40.7128, longitude: -74.006, zone: 'America/New_York' },
  Tokyo: { latitude: 35.6762, longitude: 139.6503, zone: 'Asia/Tokyo' },
  Sydney: { latitude: -33.8688, longitude: 151.2093, zone: 'Australia/Sydney' },
};

type Civil = { year: number; month: number; day: number; hour: number; minute: number; second: number };
const formatter = (zone: string): Intl.DateTimeFormat => new Intl.DateTimeFormat('en-GB', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function civilAt(instant: number, format: Intl.DateTimeFormat): Civil {
  const parts = Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day,
    hour: parts.hour, minute: parts.minute, second: parts.second } as Civil;
}
const stamp = (c: Civil): number => Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);

/** First occurrence in a fold; first valid civil minute after a spring gap. */
function resolveCivil(date: string, minute: number, format: Intl.DateTimeFormat): number {
  const [year, month, day] = date.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day) + minute * 60000;
  const offsets = new Set<number>();
  for (let hour = -36; hour <= 36; hour += 6) {
    const instant = target + hour * 3600000;
    offsets.add(stamp(civilAt(instant, format)) - instant);
  }
  let first = Infinity;
  for (const offset of offsets) {
    const instant = target - offset;
    if (stamp(civilAt(instant, format)) === target) first = Math.min(first, instant);
  }
  if (Number.isFinite(first)) return first;
  for (let i = 1; i <= 180; i++) {
    for (const offset of offsets) {
      const instant = target + i * 60000 - offset;
      if (stamp(civilAt(instant, format)) === target + i * 60000) return instant;
    }
  }
  return target;
}

/** NOAA fractional-year approximation; azimuth is clockwise from geographic north. */
function solar(instant: number, latitude: number, longitude: number, format: Intl.DateTimeFormat) {
  const c = civilAt(instant, format);
  const day = Math.floor((Date.UTC(c.year, c.month - 1, c.day) - Date.UTC(c.year, 0, 1)) / 86400000) + 1;
  const days = new Date(Date.UTC(c.year, 1, 29)).getUTCMonth() === 1 ? 366 : 365;
  const gamma = 2 * Math.PI / days * (day - 1 + (c.hour + c.minute / 60 + c.second / 3600 - 12) / 24);
  const equation = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const offsetHours = (stamp(c) - instant) / 3600000;
  const solarMinutes = c.hour * 60 + c.minute + c.second / 60 + equation + 4 * longitude - 60 * offsetHours;
  const hourAngle = (solarMinutes / 4 - 180) * Math.PI / 180;
  const lat = latitude * Math.PI / 180;
  const east = -Math.cos(declination) * Math.sin(hourAngle);
  const north = Math.cos(lat) * Math.sin(declination) - Math.sin(lat) * Math.cos(declination) * Math.cos(hourAngle);
  const up = Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
  return { azimuth: Math.atan2(east, north), elevation: Math.asin(Math.max(-1, Math.min(1, up))) };
}

/** One clock instance persists through scene and effect changes. */
export function createRelightClock() {
  const params = new URLSearchParams(location.search);
  const requestedCity = params.get('sunCity');
  const defaultCity = requestedCity && requestedCity in presets
    ? requestedCity as keyof typeof presets
    : 'Amsterdam';
  const initial = presets[defaultCity];
  let latitude = initial.latitude;
  let longitude = initial.longitude;
  let zone = initial.zone;
  let format = formatter(zone);
  let north = 0;
  let instant = Date.now();
  let playing = true;
  let lastTick = performance.now();
  let nightEnd = 0;
  let nightSpeed = 0;
  const panel = document.createElement('div');
  panel.id = 'relight-clock';
  panel.hidden = true;
  const play = document.createElement('button');
  play.type = 'button';
  const readout = document.createElement('output');
  const scrub = document.createElement('input');
  scrub.type = 'range'; scrub.min = '0'; scrub.max = '1439'; scrub.step = '1';
  scrub.setAttribute('aria-label', 'Local time');
  const date = document.createElement('input'); date.type = 'date'; date.setAttribute('aria-label', 'Date');
  const city = document.createElement('select'); city.setAttribute('aria-label', 'City');
  for (const name of [...Object.keys(presets), 'Custom']) city.add(new Option(name, name));
  city.value = defaultCity;
  const lat = document.createElement('input'); lat.type = 'number'; lat.min = '-90'; lat.max = '90'; lat.step = 'any'; lat.setAttribute('aria-label', 'Latitude');
  const lon = document.createElement('input'); lon.type = 'number'; lon.min = '-180'; lon.max = '180'; lon.step = 'any'; lon.setAttribute('aria-label', 'Longitude');
  const tz = document.createElement('input'); tz.type = 'text'; tz.setAttribute('aria-label', 'IANA time zone');
  const zoneSuggestions = document.createElement('datalist'); zoneSuggestions.id = 'relight-time-zones';
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  for (const value of new Set(['UTC', ...Object.values(presets).map((preset) => preset.zone), ...zones])) {
    zoneSuggestions.append(new Option(value));
  }
  tz.setAttribute('list', zoneSuggestions.id);
  const heading = document.createElement('input'); heading.type = 'number'; heading.min = '-180'; heading.max = '180'; heading.step = 'any'; heading.value = '0'; heading.setAttribute('aria-label', 'North heading in degrees');
  const field = (label: string, input: HTMLElement): HTMLLabelElement => { const el = document.createElement('label'); el.textContent = label; el.append(input); return el; };
  const latField = field('Lat', lat);
  const lonField = field('Lon', lon);
  const tzField = field('Time zone', tz);
  const syncCustomFields = (): void => {
    const visible = city.value === 'Custom';
    latField.hidden = !visible;
    lonField.hidden = !visible;
    tzField.hidden = !visible;
  };
  syncCustomFields();
  panel.addEventListener('pointerdown', (event) => event.stopPropagation());
  panel.append(play, readout, scrub, field('Date', date), field('City', city),
    latField, lonField, tzField, field('North °', heading), zoneSuggestions);
  document.querySelector('#bottom-chrome')?.append(panel);
  const dateString = (c: Civil): string => `${c.year}-${String(c.month).padStart(2, '0')}-${String(c.day).padStart(2, '0')}`;
  const sync = (): void => {
    const c = civilAt(instant, format);
    const day = dateString(c);
    if (document.activeElement !== date) date.value = day;
    scrub.value = String(c.hour * 60 + c.minute);
    readout.textContent = `${day} ${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`;
    play.innerHTML = playing
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>';
    play.setAttribute('aria-label', playing ? 'Pause sun clock' : 'Play sun clock');
    if (document.activeElement !== lat) lat.value = String(latitude);
    if (document.activeElement !== lon) lon.value = String(longitude);
    if (document.activeElement !== tz) tz.value = zone;
  };
  const invalidate = (): void => { nightEnd = 0; lastTick = performance.now(); sync(); };
  play.onclick = () => { playing = !playing; invalidate(); };
  const setCivil = (day: string, minute: number): void => { if (!day) return; instant = resolveCivil(day, minute, format); invalidate(); };
  scrub.oninput = () => setCivil(date.value, Number(scrub.value));
  date.onchange = () => setCivil(date.value, Number(scrub.value));
  city.onchange = () => {
    if (city.value !== 'Custom') {
      const preset = presets[city.value as keyof typeof presets];
      latitude = preset.latitude; longitude = preset.longitude; zone = preset.zone; format = formatter(zone);
    }
    syncCustomFields();
    invalidate();
  };
  lat.onchange = () => { const v = Number(lat.value); if (Number.isFinite(v)) latitude = Math.max(-90, Math.min(90, v)); city.value = 'Custom'; invalidate(); };
  lon.onchange = () => { const v = Number(lon.value); if (Number.isFinite(v)) longitude = Math.max(-180, Math.min(180, v)); city.value = 'Custom'; invalidate(); };
  tz.onchange = () => { try { const next = formatter(tz.value); next.format(instant); zone = tz.value; format = next; invalidate(); tz.setCustomValidity(''); } catch { tz.setCustomValidity('Enter a valid IANA time zone'); tz.reportValidity(); } };
  heading.oninput = () => { north = Number(heading.value) || 0; invalidate(); };
  sync();
  return {
    setVisible(visible: boolean) { panel.hidden = !visible; if (visible) invalidate(); },
    tick() {
      const now = performance.now();
      const dt = Math.min(0.1, Math.max(0, (now - lastTick) / 1000));
      lastTick = now;
      if (playing && !panel.hidden) {
        const elevation = solar(instant, latitude, longitude, format).elevation;
        if (elevation < 0 && nightEnd <= instant) {
          // Find the next horizon crossing once; the whole remaining night takes about 10 seconds.
          let next = instant + 300000;
          while (next < instant + 172800000 && solar(next, latitude, longitude, format).elevation < 0) next += 300000;
          nightEnd = next;
          nightSpeed = (nightEnd - instant) / 10;
        }
        instant = Math.min(nightEnd > instant ? nightEnd : Infinity, instant + dt * (elevation < 0 ? nightSpeed : 360000));
        sync();
      }
      const position = solar(instant, latitude, longitude, format);
      return { ...position, heading: north * Math.PI / 180 };
    },
  };
}
