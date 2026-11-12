"use client";

import { Loader2Icon } from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/** A small status dot stands in for an icon: the words carry the message. */
const dot = (tone: "ok" | "danger" | "warn" | "neutral") => <span className="cn-toast-dot" data-tone={tone} aria-hidden="true" />;

/**
 * Themed from the app's own tokens (--card, --text, --line), so it follows
 * light and dark with the page instead of Sonner's built-in palettes.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      position="bottom-right"
      gap={8}
      icons={{
        success: dot("ok"),
        info: dot("neutral"),
        warning: dot("warn"),
        error: dot("danger"),
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--card)",
          "--normal-text": "var(--text)",
          "--normal-border": "var(--line)",
          "--border-radius": "10px",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
          title: "cn-toast-title",
          description: "cn-toast-description",
          icon: "cn-toast-icon",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
