// =============================================================================
// ROOT LAYOUT — Wraps every page in the app
// =============================================================================
//
// In Next.js, layout.tsx is like a "shell" that wraps all pages.
// It provides:
//   - The <html> and <body> tags (required for any web page)
//   - Global CSS imports (loaded once, applied everywhere)
//   - Metadata (title, description — shows in browser tab and Google results)
//
// The {children} prop is the actual page content.
// When you visit "/", children = the page.tsx component.
// When you visit "/about", children = the about/page.tsx component.
//
// This file does NOT have 'use client' — it runs on the server.
// Layouts should almost always be server components because they
// don't need interactivity (no clicks, no typing, no state).

import type { Metadata } from "next";
import "./globals.css";

// Metadata — shows up in the browser tab and search engine results
export const metadata: Metadata = {
  title: "Uttarakhand University Assistant",
  description:
    "AI-powered chatbot to explore courses, placements, admissions, and more for universities in Uttarakhand",
};

// The RootLayout component — wraps every page
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
