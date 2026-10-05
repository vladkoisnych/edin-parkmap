/**
 * Copy text inside the current user gesture. Uses the async Clipboard API
 * where available (HTTPS), falling back to a hidden textarea + execCommand.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back below */
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;font-size:16px';
  document.body.appendChild(ta);
  const selection = document.getSelection();
  const prev = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  if (prev && selection) {
    selection.removeAllRanges();
    selection.addRange(prev);
  }
  return ok;
}

export function copyLabel(street: string): string {
  return `${street}, Edinburgh`;
}
