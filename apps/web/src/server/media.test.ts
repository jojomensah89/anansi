import { describe, expect, test } from "bun:test";
import { isFetchableMediaUrl } from "./media.ts";

/**
 * The one URL the server fetches that a page chose.
 *
 * Platform CDNs were the only source of these until webpage capture arrived.
 * Now saving a hostile page can put any http(s) URL in front of that fetch, so
 * this is a request-forgery primitive pointed at whatever the server can reach.
 * The rule is the network location, not what the URL claims to serve.
 */
describe("isFetchableMediaUrl", () => {
  test("ordinary public CDN URLs are fine", () => {
    for (const url of [
      "https://pbs.twimg.com/media/abc.jpg",
      "https://p16-sign.tiktokcdn-us.com/cover~tplv.jpeg",
      "http://images.example.com/a.png",
    ]) {
      expect(isFetchableMediaUrl(url)).toBe(true);
    }
  });

  test("loopback is refused however it is spelled", () => {
    for (const url of [
      "http://127.0.0.1:8788/api/stats",
      "http://127.1.2.3/x.png",
      "http://localhost/x.png",
      "http://LOCALHOST/x.png",
      "http://[::1]/x.png",
      "http://0.0.0.0/x.png",
      "http://anything.localhost/x.png",
    ]) {
      expect(isFetchableMediaUrl(url)).toBe(false);
    }
  });

  test("private and link-local ranges are refused", () => {
    for (const url of [
      "http://10.0.0.5/x.png",
      "http://192.168.1.1/x.png",
      "http://172.16.0.1/x.png",
      "http://172.31.255.254/x.png",
      // The cloud metadata endpoint, the classic target.
      "http://169.254.169.254/latest/meta-data/",
      "http://100.100.100.200/x.png",
      "http://[fd00::1]/x.png",
      "http://[fe80::1]/x.png",
      "http://[::ffff:127.0.0.1]/x.png",
    ]) {
      expect(isFetchableMediaUrl(url)).toBe(false);
    }
  });

  test("public addresses inside near-miss ranges are still allowed", () => {
    // 172.32 is outside 172.16/12, and 11.x is not private at all.
    expect(isFetchableMediaUrl("http://172.32.0.1/x.png")).toBe(true);
    expect(isFetchableMediaUrl("http://11.0.0.1/x.png")).toBe(true);
  });

  test("internal-looking names are refused", () => {
    expect(isFetchableMediaUrl("http://db.internal/x.png")).toBe(false);
    expect(isFetchableMediaUrl("http://printer.local/x.png")).toBe(false);
  });

  test("only http and https, and never with credentials", () => {
    expect(isFetchableMediaUrl("file:///etc/passwd")).toBe(false);
    expect(isFetchableMediaUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isFetchableMediaUrl("gopher://example.com/x")).toBe(false);
    expect(isFetchableMediaUrl("https://user:pass@example.com/x.png")).toBe(false);
    expect(isFetchableMediaUrl("not a url")).toBe(false);
  });
});
