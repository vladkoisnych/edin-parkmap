// Bottom sheet: one at a time, closes on ✕, Escape, or a downward swipe.

const sheet = () => document.getElementById('sheet')!;
const body = () => document.getElementById('sheet-body')!;
let onCloseCb: (() => void) | null = null;

export function openSheet(content: Node, onClose?: () => void): void {
  const prev = onCloseCb;
  onCloseCb = null;
  prev?.();
  body().replaceChildren(content);
  sheet().hidden = false;
  sheet().scrollTop = 0;
  onCloseCb = onClose ?? null;
}

export function closeSheet(): void {
  if (sheet().hidden) return;
  sheet().hidden = true;
  body().replaceChildren();
  const cb = onCloseCb;
  onCloseCb = null;
  cb?.();
}

export function isSheetOpen(): boolean {
  return !sheet().hidden;
}

export function initSheet(): void {
  const s = sheet();
  s.querySelector('.sheet-close')!.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheet();
  });

  // Swipe down from the top of the sheet to dismiss.
  let startY: number | null = null;
  s.addEventListener(
    'touchstart',
    (e) => {
      startY = s.scrollTop <= 0 ? e.touches[0].clientY : null;
    },
    { passive: true },
  );
  s.addEventListener(
    'touchmove',
    (e) => {
      if (startY == null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 0) s.style.transform = `translateY(${dy}px)`;
    },
    { passive: true },
  );
  s.addEventListener('touchend', (e) => {
    if (startY == null) return;
    const dy = e.changedTouches[0].clientY - startY;
    s.style.transform = '';
    startY = null;
    if (dy > 80) closeSheet();
  });
}

/** Tiny DOM builder to keep views readable without a framework. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: (Node | string | null | false | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}
