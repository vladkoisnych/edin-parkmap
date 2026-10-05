import { distanceM, type LngLat } from '../lib/geo';
import { formatDistance, walkMinutes, type Ranked } from '../lib/rank';
import { formatSchedule, isControlledAt, nextChangeLabel } from '../lib/schedule';
import type { Tariff } from '../lib/tariff';
import type { BayKind, Segment } from '../lib/types';
import { copyLabel } from './clipboard';
import { appleMapsUrl, googleMapsUrl } from './links';
import { h } from './sheet';

const KIND_LABEL: Record<BayKind, string> = {
  pd: 'Pay and display',
  shared: 'Shared use (residents or pay)',
  area: 'Pay and display (long stay)',
};

/** "About 110 m of parking (~18 cars)", using 6 m per car. */
export function kerbText(seg: Segment): string {
  const cars = Math.max(1, Math.floor(seg.kerbM / 6));
  return `About ${Math.max(5, Math.round(seg.kerbM / 5) * 5)} m of parking (~${cars} ${cars === 1 ? 'car' : 'cars'})`;
}

export function statusText(t: Tariff, now: Date): { text: string; free: boolean } {
  const controlled = isControlledAt(t.schedule, now);
  const next = nextChangeLabel(t.schedule, now);
  return controlled
    ? { text: `Charging now${next ? ` ${next}` : ''}`, free: false }
    : { text: `Free now${next ? ` ${next}` : ''}`, free: true };
}

function mapsButtons(point: LngLat, street: string, onCopy: () => void): HTMLElement {
  return h(
    'div',
    { class: 'actions' },
    h('a', { class: 'btn primary', href: googleMapsUrl(point), target: '_blank', rel: 'noopener' }, 'Open in Google Maps'),
    h('a', { class: 'btn primary', href: appleMapsUrl(point, copyLabel(street)), target: '_blank', rel: 'noopener' }, 'Open in Apple Maps'),
    h('button', { class: 'btn wide', type: 'button', onclick: onCopy }, `Copy “${copyLabel(street)}”`),
  );
}

export interface DetailContext {
  me: LngLat | null;
  now: Date;
  onCopy(street: string): void;
  onBack?: () => void;
}

/** Point of a segment nearest to `from`, else its label point. */
export function handoffPoint(seg: Segment, from: LngLat | null): LngLat {
  if (!from) return seg.label;
  return seg.pts.reduce((best, p) => (distanceM(from, p) < distanceM(from, best) ? p : best), seg.label);
}

function distanceFact(point: LngLat, me: LngLat | null): (HTMLElement | string)[] {
  if (!me) return [];
  const d = distanceM(me, point);
  return [h('dt', {}, 'From you'), h('dd', {}, `${formatDistance(d)} (${walkMinutes(d)} min walk)`)];
}

function backButton(onBack?: () => void) {
  return onBack ? h('button', { class: 'btn wide', type: 'button', onclick: onBack }, '← Back to results') : null;
}

export function segmentView(seg: Segment, t: Tariff, ctx: DetailContext & { point: LngLat }): HTMLElement {
  const status = statusText(t, ctx.now);
  const zone = seg.zone ? `Zone ${seg.zone} · ` : '';
  return h(
    'div',
    { class: 'detail', 'data-segment': seg.id },
    h('h2', { id: 'sheet-title' }, seg.street),
    h('p', { class: 'sub' }, `${zone}${kerbText(seg)}`),
    h(
      'div',
      {},
      h('span', { class: `price-big${t.cheap ? ' cheap' : ''}` }, t.cost),
      h('span', { class: `status${status.free ? ' free' : ''}` }, status.text),
    ),
    h(
      'dl',
      { class: 'facts' },
      h('dt', {}, 'Charged'),
      h('dd', {}, formatSchedule(t.schedule)),
      t.maxStayHours ? h('dt', {}, 'Max stay') : null,
      t.maxStayHours ? h('dd', {}, `${t.maxStayHours} hours`) : null,
      t.remarks ? h('dt', {}, 'Tariff') : null,
      t.remarks ? h('dd', {}, t.remarks) : null,
      h('dt', {}, 'Type'),
      h('dd', {}, seg.kinds.map((k) => KIND_LABEL[k]).join(', ')),
      ...distanceFact(ctx.point, ctx.me),
    ),
    mapsButtons(ctx.point, seg.street, () => ctx.onCopy(seg.street)),
    backButton(ctx.onBack),
  );
}

export function freePointView(street: string, point: LngLat, ctx: DetailContext): HTMLElement {
  return h(
    'div',
    { class: 'detail' },
    h('h2', { id: 'sheet-title' }, street),
    h('p', { class: 'sub' }, 'Free parking: just outside the controlled zone'),
    h(
      'dl',
      { class: 'facts' },
      h('dt', {}, 'Price'),
      h('dd', {}, 'Free, no time limit unless signed'),
      ...distanceFact(point, ctx.me),
    ),
    h('p', { class: 'sub' }, 'Uncontrolled streets can still have yellow lines, driveways and private sections.'),
    mapsButtons(point, street, () => ctx.onCopy(street)),
    backButton(ctx.onBack),
  );
}

export type ResultsTab = 'cheap' | 'free';

export interface ResultRow {
  key: string;
  street: string;
  meta: string;
  ranked: Ranked<any>;
  open(): void;
}

export interface ResultsModel {
  destLabel: string;
  tab: ResultsTab;
  limit: 5 | 10;
  cheap: ResultRow[];
  free: ResultRow[];
  onTab(tab: ResultsTab): void;
  onLimit(limit: 5 | 10): void;
}

export function resultsView(m: ResultsModel): HTMLElement {
  const rows = (m.tab === 'cheap' ? m.cheap : m.free).slice(0, m.limit);
  const tab = (id: ResultsTab, label: string, n: number) =>
    h(
      'button',
      { class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(m.tab === id), onclick: () => m.onTab(id) },
      `${label} (${Math.min(n, m.limit)})`,
    );
  return h(
    'div',
    { class: 'results-view' },
    h('h2', { id: 'sheet-title' }, `Near ${m.destLabel}`),
    h(
      'div',
      { class: 'tabs', role: 'tablist' },
      tab('cheap', '£1/hr', m.cheap.length),
      tab('free', 'Free', m.free.length),
      h('span', { class: 'spacer' }),
      h(
        'button',
        { class: 'limit', type: 'button', onclick: () => m.onLimit(m.limit === 10 ? 5 : 10) },
        m.limit === 10 ? 'Top 5' : 'Top 10',
      ),
    ),
    rows.length
      ? h(
          'ol',
          { class: 'results' },
          ...rows.map((r) =>
            h(
              'li',
              {},
              h(
                'button',
                { class: 'result', type: 'button', onclick: r.open, 'data-key': r.key },
                h('strong', {}, r.street),
                h('span', { class: 'meta' }, r.meta),
                h(
                  'span',
                  { class: 'dist' },
                  formatDistance(r.ranked.distanceM),
                  h('small', {}, `${walkMinutes(r.ranked.distanceM)} min walk`),
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'empty' }, m.tab === 'cheap' ? 'No £1/hr bays found.' : 'No free parking found nearby.'),
  );
}
