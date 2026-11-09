export function safeAsset(value: unknown, base: string): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const url = new URL(value, base);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    if (url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Pure metadata selection shared by DOM capture and bounded server HTML. */
export function selectPreview(meta: Record<string, string>, base: string, icon?: string) {
  return {
    image: safeAsset(meta["og:image"] || meta["twitter:image"], base),
    description: (meta["og:description"] || meta.description || "").trim().slice(0, 1000),
    siteName: (meta["og:site_name"] || "").trim().slice(0, 200),
    favicon: safeAsset(icon || "/favicon.ico", base),
  };
}
const decode = (s: string) => s.replace(/&(?:amp|quot|apos|lt|gt|#(\d+)|#x([\da-f]+));/gi, (all, dec, hex) => {
  if (dec || hex) { const n = parseInt(dec || hex, hex ? 16 : 10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ""; }
  return ({"&amp;":"&", "&quot;":"\"", "&apos;":"'", "&lt;":"<", "&gt;":">"} as Record<string,string>)[all.toLowerCase()] || all;
});
export function parsePreview(html: string, base: string) {
  const meta: Record<string,string> = {};
  let icon: string | undefined;
  // Ignore comments and raw-text elements: markup-looking text is not metadata.
  html = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  for (const tag of html.match(/<(?:meta|link)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) || []) {
    const attrs: Record<string,string> = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[m[1]!.toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? "");
    const key = (attrs.property || attrs.name || "").toLowerCase();
    if (key && attrs.content && !(key in meta)) meta[key] = attrs.content;
    if (!icon && /(?:^|\s)icon(?:\s|$)/i.test(attrs.rel || "")) icon = attrs.href;
  }
  return selectPreview(meta, base, icon);
}
