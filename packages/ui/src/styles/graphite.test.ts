import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./graphite.css", import.meta.url), "utf8");
function luminance(hex: string) {
  const rgb = hex.match(/\w\w/g)!.map(x => parseInt(x, 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
  return rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722;
}
test("Graphite text roles and accent meet WCAG AA on every surface", () => {
  for (const block of css.matchAll(/(?::root, \.dark|html\.light) \{([^}]+)\}/g)) {
    const tokens = Object.fromEntries([...block[1]!.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/g)].map(m => [m[1], m[2]]));
    if (!tokens.text) continue;
    for (const ink of ["text", "text-dim", "muted", "accent"]) {
      for (const surface of ["ink", "rail", "card", "raised", "accent-soft"]) {
        const a = luminance(tokens[ink]!); const b = luminance(tokens[surface]!);
        expect((Math.max(a,b)+.05)/(Math.min(a,b)+.05)).toBeGreaterThanOrEqual(4.5);
      }
    }
    // Status tones are read as text (sources page, rail) in both themes.
    for (const ink of ["ok", "warn", "danger"]) {
      for (const surface of ["ink", "rail", "card", "raised"]) {
        const a = luminance(tokens[ink]!); const b = luminance(tokens[surface]!);
        expect((Math.max(a,b)+.05)/(Math.min(a,b)+.05)).toBeGreaterThanOrEqual(4.5);
      }
    }
    for (const [ink, soft] of [["ok", "ok-soft"], ["warn", "warn-soft"]] as const) {
      const a = luminance(tokens[ink]!); const b = luminance(tokens[soft]!);
      expect((Math.max(a,b)+.05)/(Math.min(a,b)+.05)).toBeGreaterThanOrEqual(4.5);
    }
    for (const fill of ["accent", "accent-hover"]) {
      const a=luminance(tokens[fill]!); const b=luminance(tokens["accent-text-on-accent"]!);
      expect((Math.max(a,b)+.05)/(Math.min(a,b)+.05)).toBeGreaterThanOrEqual(4.5);
    }
  }
});
test("library reading text uses the shared scale and never a size below 14", () => {
  for (const name of ["card", "detail", "views", "web-preview-card", "filters", "library-actions", "selectbar", "palette", "tag-popover"]) {
    const source=readFileSync(new URL(`../../../../apps/web/src/components/${name}.tsx`,import.meta.url),"utf8");
    for (const match of source.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)/g)) expect(Number(match[1])).toBeGreaterThanOrEqual(14);
  }
  expect(css).toContain("--text-body:14px");
});
