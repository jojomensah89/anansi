/**
 * Platform marks.
 *
 * Previously a monospace letter in a rounded box, which put a small boxed "x"
 * in the top-right corner of every card — exactly where a close button lives.
 * It read as "dismiss this", which is the worst thing a passive label can do.
 */
import { sourceMarkColor } from "./sourcemark-colors.ts";

/**
 * Each platform in its own colour.
 *
 * A wall of identical grey marks makes you read the handle to know where
 * something came from, which is the one thing a logo is for. Reddit's orange
 * and TikTok's cyan are recognisable at twelve pixels in a way their outlines
 * are not.
 *
 * X and GitHub are both black-on-white brands, so on a dark theme they are the
 * text colour — that is their colour here, not an absence of one.
 */
export function SourceMark({
  source,
  size = 13,
  /** Inherit the surrounding colour instead — for a dimmed or selected row. */
  muted,
}: {
  source: string;
  size?: number;
  muted?: boolean;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    style: muted ? undefined : { color: sourceMarkColor(source) },
  } as const;

  if (source === "github") {
    return (
      <svg {...common} fill="currentColor" aria-label="GitHub">
        <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49l-.01-1.9c-2.78.62-3.37-1.2-3.37-1.2-.46-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.57 2.34 1.12 2.91.86.09-.66.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9l-.01 2.82c0 .27.18.6.69.49A10.03 10.03 0 0 0 22 12.25C22 6.58 17.52 2 12 2z" />
      </svg>
    );
  }

  if (source === "reddit") {
    return (
      <svg {...common} fill="currentColor" aria-label="Reddit">
        <path d="M22 12.06c0-1.2-.98-2.17-2.19-2.17-.59 0-1.12.23-1.51.61-1.49-1.03-3.52-1.7-5.78-1.78l.99-4.62 3.23.69a1.56 1.56 0 1 0 .17-.95l-3.6-.77a.47.47 0 0 0-.56.36l-1.1 5.28c-2.3.06-4.37.73-5.88 1.78a2.18 2.18 0 0 0-1.51-.6A2.18 2.18 0 0 0 2 12.06c0 .87.51 1.62 1.25 1.97a3.9 3.9 0 0 0-.05.63c0 3.2 3.83 5.8 8.55 5.8s8.55-2.6 8.55-5.8c0-.21-.02-.42-.05-.62A2.18 2.18 0 0 0 22 12.06zM7.4 13.6a1.56 1.56 0 1 1 3.12 0 1.56 1.56 0 0 1-3.12 0zm8.72 4.12c-1.07 1.07-3.1 1.15-3.7 1.15-.6 0-2.64-.08-3.7-1.15a.4.4 0 0 1 .57-.57c.67.67 2.1.91 3.13.91 1.04 0 2.47-.24 3.14-.91a.4.4 0 1 1 .56.57zm-.19-2.56a1.56 1.56 0 1 1 0-3.12 1.56 1.56 0 0 1 0 3.12z" />
      </svg>
    );
  }

  if (source === "tiktok") {
    return (
      <svg {...common} fill="currentColor" aria-label="TikTok">
        <path d="M16.6 5.82A4.28 4.28 0 0 1 15.54 3h-3.09v12.4a2.59 2.59 0 0 1-2.59 2.5 2.59 2.59 0 1 1 .77-5.06v-3.1a5.66 5.66 0 0 0-.77-.05A5.66 5.66 0 1 0 15.54 15.4V9.01a7.35 7.35 0 0 0 4.3 1.38V7.3a4.29 4.29 0 0 1-3.24-1.48z" />
      </svg>
    );
  }

  if (source === "web") {
    return (
      <svg
        {...common}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-label="Web"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z" />
      </svg>
    );
  }

  // X, and the fallback. Anything unrecognised showing X's logo is how 419
  // saved web pages ended up branded as tweets.
  return (
    <svg {...common} fill="currentColor" aria-label="X">
      <path d="M13.7 10.62 20.4 3h-1.59l-5.82 6.62L8.34 3H3l7.02 10.01L3 21h1.59l6.14-6.99L15.66 21H21l-7.3-10.38zm-2.17 2.47-.71-1L5.16 4.17h2.44l4.57 6.4.71 1 5.94 8.32h-2.44l-4.85-6.8z" />
    </svg>
  );
}
