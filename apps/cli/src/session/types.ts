/**
 * Whose session makes the request.
 *
 * Day 1 there is exactly one provider — cookies pasted into .env. The
 * interface exists because the build spec's capture section turns on this
 * being swappable: a cookie-reading CLI later, and the extension when there
 * is a hosted tier. Nothing above this file knows which one it got.
 */
export interface XSession {
  authToken: string;
  csrf: string;
  bearer: string;
}

export interface SessionProvider {
  readonly name: string;
  get(): Promise<XSession>;
}
