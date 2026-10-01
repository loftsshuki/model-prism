import type { Metadata } from "next";
import { OAuthConsent, RedirectToSignIn, Show } from "@clerk/nextjs";

export const metadata: Metadata = {
  title: "Authorize Model Prism",
  referrer: "strict-origin-when-cross-origin",
};

export default function OAuthConsentPage() {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return <main className="min-h-screen grid place-items-center bg-cream px-6 text-sm text-ink">OAuth consent is not configured on this deployment.</main>;
  }

  return (
    <main className="min-h-screen grid place-items-center bg-cream px-4 py-8">
      <Show when="signed-in">
        <OAuthConsent
          appearance={{
            variables: {
              colorPrimary: "#4a7c59",
            },
          }}
        />
      </Show>
      {/* Signed-out visitors used to get a blank page and the agent's authorization stalled.
          Clerk returns them here, with the original authorization request, after sign-in. */}
      <Show when="signed-out">
        <RedirectToSignIn />
      </Show>
    </main>
  );
}
