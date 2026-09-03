/**
 * What a parser needs beyond the payload itself.
 *
 * Kept tiny on purpose: the whole value of these being pure functions is that
 * they can run in a Worker on a payload an extension uploaded, in the CLI on a
 * file from disk, and in a test on a fixture — without any of those knowing
 * about the others.
 */
export interface ParseContext {
  /** Unix seconds, stamped on items whose source gives no saved-at. */
  importedAt: number;
}
