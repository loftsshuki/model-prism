import { SignUp } from "@clerk/nextjs";
import Link from "next/link";

export default function SignUpPage() {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) return <main className="p-6">Account sign-up is not configured on this deployment.</main>;
  return <main className="flex flex-col items-center px-4 py-10 gap-6">
    <Link href="/" className="font-display text-2xl text-green">Model Prism</Link>
    <h1 className="text-xl">Create your private review account</h1>
    <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />
  </main>;
}
