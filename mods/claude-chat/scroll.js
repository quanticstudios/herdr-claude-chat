// The transcript's scroll position, pure: which rows to draw and where, checked by scroll.check.mjs.

// why: gpui-kit's `list` can't scroll from code and throws on per-row handlers, so rows are windowed here.
// invariant: scrolled up, the position is an item id plus its top's distance above the viewport top.

/** A rough height for an item that hasn't been drawn yet. */
export function estimate(it) {
  const text = typeof it.text === "string" ? it.text.length : 0;
  if (it.kind === "user") return 56 + Math.ceil(text / 80) * 22 + (it.images?.length ? 72 : 0);
  if (it.kind === "reply") return 20 + Math.ceil(text / 90) * 22 + (it.text.split("\n\n").length - 1) * 10;
  if (it.kind === "todo") return 48 + (it.items?.length ?? 0) * 26;
  if (it.kind === "turn") return 28;
  return 32;
}

export class Viewport {
  constructor() {
    this.pinned = true;
    this.topId = null;
    this.topOff = 0;
    this.vh = 0;
    this.h = new Map();
  }

  height(it) { return this.h.get(it.id) ?? estimate(it); }

  /** Records a drawn row's height and answers whether it changed. */
  measure(id, height) {
    if (this.h.get(id) === height) return false;
    this.h.set(id, height);
    return true;
  }

  pin() { this.pinned = true; this.topId = null; this.topOff = 0; }

  /** The rows to draw, given `indexOf(id)` that maps an id to its index or -1. */
  window(items, indexOf, margin = this.vh) {
    const n = items.length;
    const ti = this.pinned || this.topId == null ? -1 : indexOf(this.topId);
    if (ti < 0 && !this.pinned) this.pin();
    if (this.pinned) {
      let i = n, sum = 0;
      while (i > 0 && sum < this.vh + margin) sum += this.height(items[--i]);
      return { pinned: true, aStart: i, start: i, end: n, off: 0 };
    }
    let end = ti, sum = -this.topOff;
    while (end < n && sum < this.vh + margin) sum += this.height(items[end++]);
    let aStart = ti, up = 0;
    while (aStart > 0 && up < margin) up += this.height(items[--aStart]);
    return { pinned: false, aStart, start: ti, end, off: this.topOff };
  }

  /** Moves by dy pixels, where a positive dy reveals older rows. */
  scroll(items, indexOf, dy) {
    const n = items.length;
    if (!n || !dy) return;
    let i, off;
    if (this.pinned) {
      if (dy < 0) return;
      // why: the viewport's top sits vh + dy above the content's bottom; find the row holding it.
      const target = this.vh + dy;
      let cum = 0;
      for (i = n - 1; i >= 0; i--) {
        cum += this.height(items[i]);
        if (cum >= target) break;
      }
      if (i < 0) {
        if (cum <= this.vh) return;
        i = 0; cum = target;
      }
      off = cum - target;
    } else {
      i = indexOf(this.topId);
      if (i < 0) return this.pin();
      off = this.topOff - dy;
      while (off < 0 && i > 0) off += this.height(items[--i]);
      if (off < 0) off = 0;
      while (off >= this.height(items[i]) && i < n - 1) off -= this.height(items[i++]);
    }
    // why: at or past the bottom snaps to pinned, so new output follows again.
    let below = -off;
    for (let j = i; j < n && below <= this.vh; j++) below += this.height(items[j]);
    if (below <= this.vh) return this.pin();
    this.pinned = false;
    this.topId = items[i].id;
    this.topOff = off;
  }

  /** Pixels of content above the viewport's top, counted up to `limit`. */
  above(items, indexOf, limit) {
    if (this.pinned) {
      let sum = -this.vh;
      for (let i = items.length - 1; i >= 0 && sum < limit; i--) sum += this.height(items[i]);
      return Math.max(0, sum);
    }
    let sum = this.topOff;
    for (let i = indexOf(this.topId) - 1; i >= 0 && sum < limit; i--) sum += this.height(items[i]);
    return sum;
  }
}
