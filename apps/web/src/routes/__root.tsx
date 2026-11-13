import { Toaster } from "@anansi/ui/components/sonner";
import { SidebarProvider } from "@anansi/ui/components/sidebar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useState } from "react";

import { ConnectionGate } from "../components/connection-gate.tsx";

import appCss from "../index.css?url";
import frameCss from "../styles/frame.css?url";
import shelvesCss from "../styles/shelves.css?url";
import settingsCss from "../styles/settings.css?url";
import sourcesCss from "../styles/sources.css?url";

export interface RouterAppContext {}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Anansi",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      // The app frame and library screen; after index.css so it wins ties.
      { rel: "stylesheet", href: frameCss },
      // Shelves: the rail section, dialog, picker and shelf header.
      { rel: "stylesheet", href: shelvesCss },
      // Settings and Sources; after the frame, so their panels win ties.
      { rel: "stylesheet", href: settingsCss },
      { rel: "stylesheet", href: sourcesCss },
      { rel: "icon", type: "image/png", href: "/favicon.png" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap",
      },
    ],
  }),

  component: RootDocument,
});

function RootDocument() {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false } },
  }));

  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <SidebarProvider>
            <ConnectionGate>
              <div>
                <Outlet />
              </div>
            </ConnectionGate>
          </SidebarProvider>
          <Toaster />
          <TanStackRouterDevtools position="bottom-right" />
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}
