// Window placement maths for pet windows; no Electron imports, so it can be unit-tested.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How far each window edge may go past the screen edge: only transparent space, never the character */
export interface Overhang {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** Keep the window inside the work area, except for the overhang each edge may extend past it */
export function clampToArea<R extends Rect>(rect: R, area: Rect, overhang: Overhang): R {
  const minX = area.x - overhang.left;
  const maxX = area.x + area.width - rect.width + overhang.right;
  const minY = area.y - overhang.top;
  const maxY = area.y + area.height - rect.height + overhang.bottom;
  return {
    ...rect,
    x: Math.round(Math.min(Math.max(rect.x, minX), maxX)),
    y: Math.round(Math.min(Math.max(rect.y, minY), maxY)),
  };
}
