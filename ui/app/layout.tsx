import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "trace · live execution traces",
  description: "Realtime view of execution traces collected by trace-cli.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
