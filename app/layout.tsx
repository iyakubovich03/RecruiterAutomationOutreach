import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "First Role · Recruiter workspace", description: "Find recruiting contacts, review email evidence, and send personal outreach." };
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) { return <html lang="en"><body>{children}</body></html>; }
