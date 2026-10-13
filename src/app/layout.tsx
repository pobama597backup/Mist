import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "M.I.S.T. — Master Intelligence & System Topology",
  description:
    "A sovereign, local-first AI companion. One web app, one local process, zero cloud lock-in. It listens, thinks, remembers, acts, and speaks.",
  icons: {
    icon: [
      { url: "/mist-logo-192.png", type: "image/png", sizes: "192x192" },
      { url: "/mist-logo-64.png", type: "image/png", sizes: "64x64" },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: "#020617",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      {/* v-redesign: the old inline --glass-opacity/--blur-intensity/--accent-color
          defaults were BOTH wrongly named (vs the store's writers) and wrongly
          valued (20% vs 30, 40px vs 16, #8b5cf6 vs #a855f7) — and nothing ever
          consumed them. The appearance tokens now live in globals.css :root with
          the true shipped defaults; app-shell mirrors the store prefs onto them. */}
      <body
        className={`${inter.variable} ${jetbrains.variable} antialiased bg-background text-foreground overflow-x-hidden`}
      >
        {children}
        <SonnerToaster position="top-center" offset="4.5rem" richColors theme="dark" />
      </body>
    </html>
  );
}
