import { type RefObject, useEffect } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Keeps keyboard focus inside a drawer or palette and restores the trigger. */
export function useDialogFocus(
  open: boolean,
  container: RefObject<HTMLElement | null>,
  initial: RefObject<HTMLElement | null>,
  onClose: () => void,
  responsiveInspector = false,
) {
  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => (initial.current ?? container.current)?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !container.current || (responsiveInspector && !window.matchMedia("(max-width: 767px)").matches)) return;
      const focusable = [...container.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((node) => !node.hasAttribute("disabled"));
      if (focusable.length === 0) {
        event.preventDefault();
        container.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === container.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      returnTo?.focus();
    };
  }, [open, container, initial, onClose, responsiveInspector]);
}

// Input modality also keeps repeated keyboard inspector navigation immediate.
if (typeof document !== "undefined") {
 document.addEventListener("keydown", () => { document.documentElement.dataset.input = "keyboard"; }, true);
 document.addEventListener("pointerdown", () => { document.documentElement.dataset.input = "pointer"; }, true);
}
