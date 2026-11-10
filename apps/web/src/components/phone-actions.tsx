import type { ReactNode } from "react";
import { Sheet, SheetTrigger, SheetContent, SheetTitle } from "@anansi/ui/components/sheet";
export function PhoneActions({children}:{children:ReactNode}) {
 return <Sheet><SheetTrigger className="phone-actions">Actions</SheetTrigger><SheetContent side="bottom" style={{padding:20,background:"var(--card)",color:"var(--text)",fontSize:14}}><SheetTitle className="sr-only">Library actions</SheetTitle><div className="phone-sheet-actions">{children}</div></SheetContent></Sheet>;
}
