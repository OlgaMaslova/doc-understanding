import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DocRace — six extraction approaches, side by side",
  description:
    "Ask a question of a document, watch six extraction approaches answer it side by side, and see exactly what each one cost you.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
