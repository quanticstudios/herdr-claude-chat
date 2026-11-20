// Chat design tokens: herdr theme colors plus the type and spacing scale of docs/type-spacing-spec.md.
import { theme, settings } from "herdr";

export function tokens() {
  const c = theme();
  return {
    c,
    font: { ui: "Geist", mono: "JetBrains Mono" },
    size: { body: 14, ui: 13, small: 12, tiny: 11, code: 12.5 },
    lh: { body: 1.55, ui: 1.45, code: 1.45 },
    space: (n) => n * 4,
    radius: { card: 12, block: 8, chip: 6 },
    row: 28,
    measure: 960,
  };
}

// why: Herdr's zoom scales the px a mod writes, but on_size_change reports zoomed px; this turns a measured size back into written px.
export const unzoom = (px) => px / (Number(settings().zoom) || 1);
