import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { LngLat } from '../lib/geo';
import { isControlledAt } from '../lib/schedule';
import type { Tariff } from '../lib/tariff';
import type { AreaGeom, BayProps, Feature, FreePointProps, PointGeom, Segment } from '../lib/types';
import type { AppData } from './data';

export const CITY_CENTRE: LngLat = [-3.1883, 55.9533];
/** Loose Edinburgh bounds, for "is the user actually here?" and panning limits. */
export const EDINBURGH_BOUNDS = L.latLngBounds([55.82, -3.5], [56.02, -2.95]);

const LABEL_MIN_ZOOM = 16;
const PIN_MAX_ZOOM = 14;
const FREE_POINT_MIN_ZOOM = 13;

/** Price-band thresholds in pence/hr for the dimmed "other paid" bays. */
const BANDS = [420, 600, 680, Infinity];

export const toLatLng = ([lng, lat]: LngLat): L.LatLngTuple => [lat, lng];

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export interface MapHandlers {
  onSegmentTap(seg: Segment): void;
  onFreePointTap(p: Feature<PointGeom, FreePointProps>): void;
}

export class ParkMap {
  readonly map: L.Map;
  private tiles?: L.TileLayer;
  private renderer: L.Canvas;
  private cheapLayer: L.GeoJSON;
  private paidLayer: L.GeoJSON;
  private freeZoneLayer: L.GeoJSON;
  private freePointLayer = L.layerGroup();
  private pinLayer = L.layerGroup();
  private labelLayer = L.layerGroup();
  private bayLayersBySeg = new Map<string, L.Path[]>();
  private selectedSeg: string | null = null;
  private destMarker: L.Marker | null = null;
  private meMarker: L.Marker | null = null;
  private showPaid = true;
  private freeNow = false;
  private now = new Date();

  constructor(
    el: HTMLElement,
    private data: AppData,
    private handlers: MapHandlers,
  ) {
    this.map = L.map(el, {
      zoomControl: false,
      attributionControl: true,
      maxBounds: EDINBURGH_BOUNDS.pad(0.3),
      minZoom: 11,
      maxZoom: 19,
      tapTolerance: 15,
      // Bays are drawn on one canvas; tolerance widens every bay's hit area to ~20px.
      preferCanvas: true,
    }).setView(toLatLng(CITY_CENTRE), 14);
    this.map.attributionControl.setPrefix(false);

    this.renderer = L.canvas({ tolerance: 10, padding: 0.3 });
    this.map.createPane('freezone').style.zIndex = '350';
    const freeRenderer = L.canvas({ pane: 'freezone', padding: 0.3 });

    this.setTiles();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.restyle());

    // GeoJSON passes `renderer` through to each path; the typings just don't say so.
    this.freeZoneLayer = L.geoJSON(data.freeZone as any, {
      renderer: freeRenderer,
      interactive: false,
      style: () => this.freeZoneStyle(),
    } as L.GeoJSONOptions).addTo(this.map);

    const isCheap = (f: Feature<AreaGeom, BayProps>) => !!this.tariff(f.properties.t)?.cheap;
    const onEach = (f: Feature<AreaGeom, BayProps>, layer: L.Layer) => {
      const list = this.bayLayersBySeg.get(f.properties.seg) ?? [];
      list.push(layer as L.Path);
      this.bayLayersBySeg.set(f.properties.seg, list);
      layer.on('click', (e: L.LeafletMouseEvent) => {
        L.DomEvent.stop(e);
        const seg = this.data.segById.get(f.properties.seg);
        if (seg) this.handlers.onSegmentTap(seg);
      });
    };
    const bayStyle = (f?: any) => this.bayStyle(f as Feature<AreaGeom, BayProps>);

    this.paidLayer = L.geoJSON(
      { type: 'FeatureCollection', features: data.bays.features.filter((f) => !isCheap(f)) } as any,
      { renderer: this.renderer, style: bayStyle, onEachFeature: onEach as any } as L.GeoJSONOptions,
    ).addTo(this.map);
    this.cheapLayer = L.geoJSON(
      { type: 'FeatureCollection', features: data.bays.features.filter(isCheap) } as any,
      { renderer: this.renderer, style: bayStyle, onEachFeature: onEach as any } as L.GeoJSONOptions,
    ).addTo(this.map);

    this.buildCheapMarkers();
    this.buildFreePoints();
    this.map.on('zoomend', () => this.updateZoomLayers());
    this.updateZoomLayers();
  }

  private tariff(code: string): Tariff | undefined {
    return this.data.meta.tariffs[code];
  }

  private setTiles() {
    // Standard OSM tiles (low volume, attributed, browser sends the Referer).
    // Dark mode inverts them in CSS rather than loading a second tile set.
    this.tiles?.remove();
    this.tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Parking data © City of Edinburgh Council, contains OS data © Crown copyright and database right',
    }).addTo(this.map);
  }

  private freeZoneStyle(): L.PathOptions {
    const c = cssVar('--free');
    return { color: c, weight: 2.5, opacity: 0.9, fillColor: c, fillOpacity: 0.07 };
  }

  private bayStyle(f: Feature<AreaGeom, BayProps>): L.PathOptions {
    const t = this.tariff(f.properties.t);
    const selected = f.properties.seg === this.selectedSeg;
    const freeNow = this.freeNow && t && !isControlledAt(t.schedule, this.now);
    if (t?.cheap) {
      const c = freeNow ? cssVar('--freenow') : cssVar('--cheap');
      return { color: c, fillColor: c, weight: selected ? 9 : 5, opacity: 1, fillOpacity: 0.9 };
    }
    if (freeNow) {
      const c = cssVar('--freenow');
      return { color: c, fillColor: c, weight: selected ? 7 : 3, opacity: 0.9, fillOpacity: 0.7 };
    }
    const band = BANDS.findIndex((b) => (t?.pencePerHour ?? Infinity) <= b) + 1;
    const c = cssVar(`--band-${band}`);
    return { color: c, fillColor: c, weight: selected ? 7 : 2, opacity: selected ? 1 : 0.55, fillOpacity: 0.45 };
  }

  private restyle() {
    this.now = new Date();
    this.paidLayer.setStyle((f) => this.bayStyle(f as any));
    this.cheapLayer.setStyle((f) => this.bayStyle(f as any));
    this.freeZoneLayer.setStyle(() => this.freeZoneStyle());
    this.freePointLayer.eachLayer((l) => (l as L.CircleMarker).setStyle(this.freePointStyle()));
  }

  private cheapSegments(): Segment[] {
    return this.data.segments.filter((s) => this.tariff(s.t)?.cheap);
  }

  private buildCheapMarkers() {
    for (const seg of this.cheapSegments()) {
      const t = this.tariff(seg.t)!;
      const pin = L.marker(toLatLng(seg.label), {
        icon: L.divIcon({ className: '', html: '<div class="cheap-pin">£1</div>', iconSize: [30, 30], iconAnchor: [15, 15] }),
        keyboard: true,
        title: `${seg.street}: ${t.cost}`,
        alt: `${seg.street}, ${t.cost}`,
      });
      pin.on('click', (e) => {
        L.DomEvent.stop(e);
        this.handlers.onSegmentTap(seg);
      });
      this.pinLayer.addLayer(pin);

      const label = L.marker(toLatLng(seg.label), {
        icon: L.divIcon({ className: '', html: `<div class="price-label">${t.cost}</div>`, iconSize: [0, 0] }),
        interactive: false,
        keyboard: false,
      });
      this.labelLayer.addLayer(label);
    }
  }

  private freePointStyle(): L.CircleMarkerOptions {
    return {
      radius: 7,
      color: '#fff',
      weight: 2,
      fillColor: cssVar('--free'),
      fillOpacity: 1,
    };
  }

  private buildFreePoints() {
    for (const f of this.data.freePoints.features) {
      const m = L.circleMarker(toLatLng(f.geometry.coordinates), { ...this.freePointStyle(), renderer: this.renderer });
      m.on('click', (e) => {
        L.DomEvent.stop(e);
        this.handlers.onFreePointTap(f);
      });
      this.freePointLayer.addLayer(m);
    }
  }

  private updateZoomLayers() {
    const z = this.map.getZoom();
    const toggle = (layer: L.Layer, on: boolean) => {
      if (on && !this.map.hasLayer(layer)) layer.addTo(this.map);
      if (!on && this.map.hasLayer(layer)) layer.remove();
    };
    toggle(this.pinLayer, z <= PIN_MAX_ZOOM);
    toggle(this.labelLayer, z >= LABEL_MIN_ZOOM);
    toggle(this.freePointLayer, z >= FREE_POINT_MIN_ZOOM);
  }

  setShowPaid(on: boolean) {
    this.showPaid = on;
    if (on) this.paidLayer.addTo(this.map);
    else this.paidLayer.remove();
    this.cheapLayer.bringToFront();
  }

  isShowingPaid() {
    return this.showPaid;
  }

  setFreeNow(on: boolean) {
    this.freeNow = on;
    this.restyle();
  }

  /** Re-evaluate "free now" colouring, e.g. once a minute. */
  tick() {
    if (this.freeNow) this.restyle();
  }

  select(segId: string | null) {
    const prev = this.selectedSeg;
    this.selectedSeg = segId;
    for (const id of [prev, segId]) {
      if (!id) continue;
      for (const l of this.bayLayersBySeg.get(id) ?? []) {
        l.setStyle(this.bayStyle((l as any).feature));
        if (id === segId) l.bringToFront();
      }
    }
  }

  flyTo(point: LngLat, zoom = 17) {
    this.map.flyTo(toLatLng(point), Math.max(zoom, this.map.getZoom()), { duration: 0.6 });
  }

  fitPoints(points: LngLat[]) {
    if (!points.length) return;
    const b = L.latLngBounds(points.map(toLatLng));
    this.map.flyToBounds(b, { paddingTopLeft: [24, 80], paddingBottomRight: [24, 320], maxZoom: 17, duration: 0.6 });
  }

  showDestination(point: LngLat | null, label = '') {
    this.destMarker?.remove();
    this.destMarker = null;
    if (!point) return;
    this.destMarker = L.marker(toLatLng(point), {
      icon: L.divIcon({ className: '', html: '<div class="dest-pin"></div>', iconSize: [22, 22], iconAnchor: [11, 22] }),
      title: label,
      alt: `Destination: ${label}`,
      zIndexOffset: 1000,
    }).addTo(this.map);
  }

  showMe(point: LngLat) {
    if (this.meMarker) {
      this.meMarker.setLatLng(toLatLng(point));
      return;
    }
    this.meMarker = L.marker(toLatLng(point), {
      icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      interactive: false,
      keyboard: false,
      zIndexOffset: 900,
    }).addTo(this.map);
  }
}
