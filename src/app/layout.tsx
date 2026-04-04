import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Model Prism — Multi-Model Analysis",
  description: "One input, many angles. Fan out prompts across dozens of LLMs and synthesize the results.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
