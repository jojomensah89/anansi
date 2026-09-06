"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { PanelLeft } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "./button.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip.tsx";
import { cn } from "@anansi/ui/lib/utils";

const STORAGE_KEY = "anansi.sidebar.open";

type SidebarContextValue = {
	open: boolean;
	setOpen: (open: boolean) => void;
	toggleSidebar: () => void;
	state: "expanded" | "collapsed";
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebar() {
	const value = useContext(SidebarContext);
	if (!value) throw new Error("useSidebar must be used within a SidebarProvider.");
	return value;
}

export function SidebarProvider({ defaultOpen = true, open: openProp, onOpenChange, children, className, style, ...props }: React.ComponentProps<"div"> & { defaultOpen?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void }) {
	const [internalOpen, setOpenState] = useState(defaultOpen);
	const open = openProp ?? internalOpen;

	useEffect(() => {
		let saved: string | null = null;
		try {
			saved = window.localStorage?.getItem(STORAGE_KEY) ?? null;
		} catch {
			// Fall through to the cookie fallback below.
		}
		if (saved === null) {
			try {
				saved = document.cookie.split("; ").find((entry) => entry.startsWith(`${STORAGE_KEY}=`))?.split("=")[1] ?? null;
			} catch {
				// Storage is an enhancement; an unavailable store must not block the app.
			}
		}
		if (saved !== null && openProp === undefined) setOpenState(saved !== "false");
	}, [openProp]);

	const setOpen = useCallback((next: boolean) => {
		onOpenChange?.(next);
		if (openProp === undefined) setOpenState(next);
		try {
			window.localStorage?.setItem(STORAGE_KEY, String(next));
		} catch {
			// Ignore private-mode and disabled-storage failures, then use the cookie below.
		}
		try {
			document.cookie = `${STORAGE_KEY}=${next}; path=/; max-age=31536000; SameSite=Lax`;
		} catch {
			// Persistence is an enhancement; disabled storage must not block toggling.
		}
	}, [onOpenChange, openProp]);
	const toggleSidebar = useCallback(() => setOpen(!open), [open, setOpen]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
				event.preventDefault();
				toggleSidebar();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [toggleSidebar]);

	const value = useMemo(() => ({ open, setOpen, toggleSidebar, state: open ? "expanded" : "collapsed" } as const), [open, setOpen, toggleSidebar]);
	return (
		<SidebarContext.Provider value={value}>
			<TooltipProvider delay={0}>
				<div
					data-slot="sidebar-wrapper"
					data-state={value.state}
					className={cn("group/sidebar-wrapper", className)}
					style={style}
					{...props}
				>
					{children}
				</div>
			</TooltipProvider>
		</SidebarContext.Provider>
	);
}

export function Sidebar({ collapsible = "icon", className, children, style, ...props }: React.ComponentProps<"aside"> & { collapsible?: "icon" | "none" | "offcanvas" }) {
	const { state } = useSidebar();
	const width = collapsible === "none" || state === "expanded" ? 228 : 58;
	return (
		<aside
			data-slot="sidebar"
			data-state={state}
			data-collapsible={state === "collapsed" ? collapsible : ""}
			className={cn("anansi-sidebar", className)}
			style={{ width, flexShrink: 0, ...style }}
			{...props}
		>
			{children}
		</aside>
	);
}

export function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
	const { toggleSidebar } = useSidebar();
	return (
		<Button
			data-sidebar="trigger"
			data-slot="sidebar-trigger"
			variant="ghost"
			size="icon"
			aria-label="Toggle sidebar"
			className={cn("anansi-sidebar-trigger", className)}
			onClick={(event) => {
				onClick?.(event);
				toggleSidebar();
			}}
			{...props}
		>
			<PanelLeft aria-hidden="true" />
		</Button>
	);
}

export function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="sidebar-header" data-sidebar="header" className={cn("anansi-sidebar-header", className)} {...props} />;
}

export function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="sidebar-content" data-sidebar="content" className={cn("anansi-sidebar-content", className)} {...props} />;
}

export function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="sidebar-footer" data-sidebar="footer" className={cn("anansi-sidebar-footer", className)} {...props} />;
}

export function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="sidebar-group" data-sidebar="group" className={cn("anansi-sidebar-group", className)} {...props} />;
}

export function SidebarGroupLabel({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="sidebar-group-label" data-sidebar="group-label" className={cn("anansi-sidebar-group-label", className)} {...props} />;
}

export function SidebarGroupContent({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="sidebar-group-content" data-sidebar="group-content" className={cn("anansi-sidebar-group-content", className)} {...props} />;
}

export function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
	return <ul data-slot="sidebar-menu" data-sidebar="menu" className={cn("anansi-sidebar-menu", className)} {...props} />;
}

export function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
	return <li data-slot="sidebar-menu-item" data-sidebar="menu-item" className={cn("anansi-sidebar-menu-item", className)} {...props} />;
}

type SidebarMenuButtonProps = useRender.ComponentProps<"button"> & {
	isActive?: boolean;
	tooltip?: string;
};

export function SidebarMenuButton({ className, isActive = false, tooltip, render, children, ...props }: SidebarMenuButtonProps) {
	const { state } = useSidebar();
	const button = useRender({
		defaultTagName: "button",
		props: mergeProps<"button">(
			{
				"data-slot": "sidebar-menu-button",
				"data-sidebar": "menu-button",
				"data-active": isActive,
				className: cn("anansi-sidebar-menu-button", className),
			},
			{ ...props, children },
		),
		render,
		state: { active: isActive },
	});

	if (!tooltip) return button;
	return (
		<Tooltip>
			<TooltipTrigger render={button} />
			<TooltipContent side="right" hidden={state !== "collapsed"}>{tooltip}</TooltipContent>
		</Tooltip>
	);
}

export function SidebarSeparator({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="sidebar-separator" data-sidebar="separator" className={cn("anansi-sidebar-separator", className)} {...props} />;
}

export function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
	return <main data-slot="sidebar-inset" className={cn("anansi-sidebar-inset", className)} {...props} />;
}

export function SidebarRail({ className, ...props }: React.ComponentProps<"button">) {
	const { toggleSidebar } = useSidebar();
	return <button type="button" data-slot="sidebar-rail" aria-label="Toggle sidebar" onClick={toggleSidebar} className={cn("anansi-sidebar-rail", className)} {...props} />;
}

export type SidebarProps = { children?: ReactNode };
export type SidebarStyle = CSSProperties;
