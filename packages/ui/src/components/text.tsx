import type { ComponentProps } from "react";

export function SectionTitle({ className = "", ...props }: ComponentProps<"h2">) {
  return <h2 className={`ui-section-title ${className}`} {...props} />;
}
