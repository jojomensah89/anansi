import { useCallback, useEffect, useState } from "react";

/**
 * Preferences about how the library is shown.
 *
 * Deliberately not in the URL and not on the server. A filter answers "what am
 * I looking at right now" and belongs in a link you can send; this answers
 * "how do I like my library", which should survive a reload, not travel with
 * one. Sending someone a link should not quietly impose your settings on them.
 *
 * Local storage rather than a table, because losing it costs a checkbox.
 */
const KEY = "anansi:hide-removed";

function read(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    // Private browsing, or storage disabled. The default is the honest one.
    return false;
  }
}

/**
 * Whether to hide items the platform no longer has saved.
 *
 * Off by default: a library that quietly drops things because a platform
 * changed its mind is not a library. Turning it on makes the view mirror
 * what is currently saved instead.
 */
export function useHideRemoved(): [boolean, (next: boolean) => void] {
  /**
   * Starts false on both server and client, then corrects after mount.
   *
   * Reading localStorage during render would make the server and the first
   * client render disagree, which React resolves by throwing the markup away.
   */
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    setHidden(read());
    const onStorage = (event: StorageEvent) => {
      if (event.key === KEY) setHidden(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const set = useCallback((next: boolean) => {
    setHidden(next);
    try {
      localStorage.setItem(KEY, next ? "1" : "0");
    } catch {
      // The preference simply does not persist. It still applies this session.
    }
  }, []);

  return [hidden, set];
}
