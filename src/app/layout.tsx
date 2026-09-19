import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { AccountSession } from "@/components/account-session";
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
  const enabled = Boolean(process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const live = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith("pk_live_");
  const content = enabled ? <ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up" signInFallbackRedirectUrl="/" signUpFallbackRedirectUrl="/settings" afterSignOutUrl="/" proxyUrl={live ? "/__clerk" : undefined}
    localization={{ signIn: { start: { title: "Sign in to Model Prism" } }, signUp: { start: { title: "Create your Model Prism account" } } }}>
    <AccountSession>{children}</AccountSession>
  </ClerkProvider> : children;
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{content}</body>
    </html>
  );
}
