import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  // TODO: reduce weights to only those used
  weight: ["100", "300", "400", "500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  // TODO: reduce weights to only those used
  weight: ["100", "300", "400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "JOMOTOYA",
  description: "JOMOTOYA",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        style={{
          // @ts-ignore
          "--font-sans": "var(--font-plex-sans)",
          "--font-mono": "var(--font-plex-mono)",
        }}
        className={`${plexSans.variable} ${plexMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
