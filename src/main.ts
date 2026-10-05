import './style.css';
import type { LngLat } from './lib/geo';
import { rankByDistance, type Candidate } from './lib/rank';
import { isControlledAt, nextChangeLabel } from './lib/schedule';
import type { Feature, FreePointProps, PointGeom, Segment } from './lib/types';
import { copyLabel, copyText } from './app/clipboard';
import { loadData, type AppData } from './app/data';
import { geocode } from './app/geocode';
import { EDINBURGH_BOUNDS, ParkMap, toLatLng } from './app/map';
import { closeSheet, initSheet, openSheet } from './app/sheet';
import { toast } from './app/toast';
import { freePointView, handoffPoint, resultsView, segmentView, type ResultRow, type ResultsTab } from './app/views';

interface SearchState {
  dest: LngLat;
  label: string;
  tab: ResultsTab;
  limit: 5 | 10;
}

const MAX_RESULTS = 10;

let data: AppData;
let pmap: ParkMap;
let me: LngLat | null = null;
let search: SearchState | null = null;
let freeNow = false;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function copyStreet(street: string) {
  const text = copyLabel(street);
  const ok = await copyText(text);
  toast(ok ? `Copied: ${text}` : `Couldn't copy. Long-press the street name to copy it.`);
}

// ---------- Selection ----------

function showSegment(seg: Segment, opts: { fromResults?: boolean } = {}) {
  const t = data.meta.tariffs[seg.t];
  if (!t) return;
  // Copy first, while we are still inside the tap's user gesture.
  void copyStreet(seg.street);
  const point = handoffPoint(seg, search?.dest ?? me);
  pmap.select(seg.id);
  openSheet(
    segmentView(seg, t, {
      me,
      now: new Date(),
      point,
      onCopy: copyStreet,
      onBack: opts.fromResults ? renderResults : undefined,
    }),
    () => pmap.select(null),
  );
  if (opts.fromResults) pmap.flyTo(point);
}

function showFreePoint(f: Feature<PointGeom, FreePointProps>, opts: { fromResults?: boolean } = {}) {
  void copyStreet(f.properties.street);
  pmap.select(null);
  openSheet(
    freePointView(f.properties.street, f.geometry.coordinates, {
      me,
      now: new Date(),
      onCopy: copyStreet,
      onBack: opts.fromResults ? renderResults : undefined,
    }),
  );
  if (opts.fromResults) pmap.flyTo(f.geometry.coordinates);
}

// ---------- Search ----------

function cheapRows(dest: LngLat): ResultRow[] {
  const segs = data.segments.filter((s) => data.meta.tariffs[s.t]?.cheap);
  const now = new Date();
  return rankByDistance(dest, segs, MAX_RESULTS).map((r) => {
    const t = data.meta.tariffs[r.item.t];
    const free = !isControlledAt(t.schedule, now);
    return {
      key: r.item.id,
      street: r.item.street,
      meta: `${t.cost}${free ? ` · free now ${nextChangeLabel(t.schedule, now) ?? ''}` : ''} · ~${Math.max(1, Math.floor(r.item.kerbM / 6))} car spaces`,
      ranked: r,
      open: () => showSegment(r.item, { fromResults: true }),
    };
  });
}

function freeRows(dest: LngLat): ResultRow[] {
  type C = Candidate & { open(): void; meta: string };
  const now = new Date();
  const items: C[] = data.freePoints.features.map((f) => ({
    id: f.properties.id,
    street: f.properties.street,
    pts: [f.geometry.coordinates],
    meta: 'Free · outside controlled zone',
    open: () => showFreePoint(f, { fromResults: true }),
  }));
  if (freeNow) {
    for (const seg of data.segments) {
      const t = data.meta.tariffs[seg.t];
      if (!t || isControlledAt(t.schedule, now)) continue;
      items.push({
        id: seg.id,
        street: seg.street,
        pts: seg.pts,
        meta: `Free now ${nextChangeLabel(t.schedule, now) ?? ''}, then ${t.cost}`,
        open: () => showSegment(seg, { fromResults: true }),
      });
    }
  }
  return rankByDistance(dest, items, MAX_RESULTS).map((r) => ({
    key: r.item.id,
    street: r.item.street,
    meta: r.item.meta,
    ranked: r,
    open: r.item.open,
  }));
}

function renderResults() {
  if (!search) return;
  const s = search;
  const cheap = cheapRows(s.dest);
  const free = freeRows(s.dest);
  pmap.select(null);
  openSheet(
    resultsView({
      destLabel: s.label,
      tab: s.tab,
      limit: s.limit,
      cheap,
      free,
      onTab: (tab) => {
        s.tab = tab;
        renderResults();
      },
      onLimit: (limit) => {
        s.limit = limit;
        renderResults();
      },
    }),
  );
}

async function runSearch(q: string) {
  const input = $<HTMLInputElement>('search-input');
  input.blur(); // drop the keyboard so results are visible
  let hit;
  try {
    hit = await geocode(q);
  } catch (e) {
    toast((e as Error).message || 'Search failed. Check your connection.');
    return;
  }
  if (!hit) {
    toast(`No match for “${q}” in Edinburgh`);
    return;
  }
  search = { dest: hit.point, label: hit.label, tab: search?.tab ?? 'cheap', limit: search?.limit ?? 10 };
  pmap.showDestination(hit.point, hit.label);
  renderResults();
  const nearest = [...cheapRows(hit.point).slice(0, 3), ...freeRows(hit.point).slice(0, 2)].map((r) => r.ranked.nearest);
  pmap.fitPoints([hit.point, ...nearest]);
}

// ---------- Location ----------

function locate(opts: { fly: boolean; quiet: boolean }) {
  if (!('geolocation' in navigator)) {
    if (!opts.quiet) toast('Location is not available on this device');
    return;
  }
  const btn = $('locate');
  btn.classList.add('active');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      me = [pos.coords.longitude, pos.coords.latitude];
      pmap.showMe(me);
      if (!EDINBURGH_BOUNDS.contains(toLatLng(me))) {
        if (!opts.quiet) toast('You appear to be outside Edinburgh');
        return;
      }
      if (opts.fly) pmap.flyTo(me, 16);
    },
    (err) => {
      btn.classList.remove('active');
      if (!opts.quiet) toast(err.code === err.PERMISSION_DENIED ? 'Location permission denied' : 'Could not get your location');
    },
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
  );
}

async function locateIfAlreadyAllowed() {
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    if (status?.state === 'granted') locate({ fly: true, quiet: true });
  } catch {
    /* Permissions API unsupported: wait for the button */
  }
}

// ---------- Boot ----------

function initChrome() {
  initSheet();
  const chip = $('legend-chip');
  const legend = $('legend');
  chip.addEventListener('click', () => {
    legend.hidden = !legend.hidden;
    chip.setAttribute('aria-expanded', String(!legend.hidden));
  });
  $('locate').addEventListener('click', () => locate({ fly: true, quiet: false }));
  $('search').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $<HTMLInputElement>('search-input').value;
    if (q.trim()) void runSearch(q);
  });
  $<HTMLInputElement>('toggle-paid').addEventListener('change', (e) => pmap?.setShowPaid((e.target as HTMLInputElement).checked));
  $<HTMLInputElement>('toggle-freenow').addEventListener('change', (e) => {
    freeNow = (e.target as HTMLInputElement).checked;
    pmap?.setFreeNow(freeNow);
    if (search && !$('sheet').hidden && document.querySelector('.results-view')) renderResults();
  });
  // Keep the bottom bar height in sync for Leaflet's control offsets.
  const bar = document.querySelector<HTMLElement>('.bottom')!;
  new ResizeObserver(() => document.documentElement.style.setProperty('--bar-h', `${bar.offsetHeight}px`)).observe(bar);
}

async function boot() {
  initChrome();
  try {
    data = await loadData();
  } catch (e) {
    $('data-date').textContent = 'Parking data failed to load.';
    toast('Could not load parking data. Check your connection and reload.', 6000);
    console.error(e);
    return;
  }
  const date = new Date(data.meta.fetchedAt);
  if (data.meta.attribution) $('data-attribution').textContent = data.meta.attribution.replace(/database right\b/g, `database right ${new Date(data.meta.fetchedAt).getFullYear()}`);
  $('data-date').textContent = `Data as of ${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.`;

  pmap = new ParkMap($('map'), data, {
    onSegmentTap: (seg) => showSegment(seg),
    onFreePointTap: (f) => showFreePoint(f),
  });
  pmap.map.on('click', () => closeSheet());
  // Handle for E2E tests and debugging from the console.
  (window as any).__parkmap = { map: pmap.map, data };
  setInterval(() => pmap.tick(), 60_000);
  void locateIfAlreadyAllowed();
}

void boot();
