const el = () => document.getElementById('toast')!;
let timer: number | undefined;

export function toast(message: string, ms = 2200): void {
  const t = el();
  t.textContent = message;
  t.hidden = false;
  // Restart the entry animation on repeated toasts.
  t.style.animation = 'none';
  void t.offsetWidth;
  t.style.animation = '';
  clearTimeout(timer);
  timer = window.setTimeout(() => (t.hidden = true), ms);
}
