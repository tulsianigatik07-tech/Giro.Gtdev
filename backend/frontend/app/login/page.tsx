import type { Metadata } from "next";
import { LoginForm } from "@/features/auth/login-form";
import { PlatformNavigation } from "@/components/platform/platform-navigation";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-col bg-background px-4 py-8 sm:px-6">
      <header className="mx-auto flex w-full max-w-[760px] flex-wrap items-center justify-between gap-4">
        <Logo />
        <PlatformNavigation />
      </header>
      <div className="flex flex-1 items-center justify-center py-8">
        <section className="w-full max-w-[400px]" aria-labelledby="login-title">
          <div className="mt-7 rounded-dialog border border-border-subtle bg-card p-7">
            <p className="type-metadata-label text-muted-foreground">Engineering workspace</p>
            <h1 id="login-title" aria-label="Welcome to Giro" className="mt-2 type-display text-foreground">Welcome to <span className="italic text-primary">Giro</span><span className="not-italic">.</span></h1>
            <p className="mt-2 type-body text-text-secondary">Enter the access token issued by your Giro deployment to open your repository workspace.</p>
            <LoginForm />
            <p className="mt-4 type-metadata text-muted-foreground">Tokens remain in this browser tab and are validated by your Giro backend.</p>
          </div>
        </section>
      </div>
    </main>
  );
}

function Logo() {
  return <div className="flex items-center justify-center gap-3"><span className="grid size-9 place-items-center rounded-control bg-primary type-body-strong text-primary-foreground">G</span><span className="type-panel-title text-foreground">Giro</span><span className="rounded-badge bg-inset px-1.5 type-metadata text-muted-foreground">DEV</span></div>;
}
