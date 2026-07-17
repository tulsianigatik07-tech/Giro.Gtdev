"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { sessionsApi } from "@/services/api/sessions";

const TOKEN_KEY = "giro.access-token";

interface AuthContextValue {
  token: string | null;
  ready: boolean;
  signIn(token: string): Promise<void>;
  signOut(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  const signOut = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken(null);
    router.replace("/login");
  }, [router]);

  const handleUnauthorized = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken(null);
    const destination = pathname !== "/login"
      ? `${pathname}${window.location.search}`
      : null;
    router.replace(destination ? `/login?next=${encodeURIComponent(destination)}` : "/login");
  }, [pathname, router]);

  useEffect(() => {
    setToken(sessionStorage.getItem(TOKEN_KEY));
    setReady(true);
  }, []);

  useEffect(() => {
    window.addEventListener("giro:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("giro:unauthorized", handleUnauthorized);
  }, [handleUnauthorized]);

  useEffect(() => {
    if (!ready) return;
    if (!token && pathname !== "/login") router.replace("/login");
    if (token && pathname === "/login") router.replace("/dashboard");
  }, [pathname, ready, router, token]);

  const signIn = useCallback(async (candidate: string) => {
    const clean = candidate.trim();
    await sessionsApi.list(clean);
    sessionStorage.setItem(TOKEN_KEY, clean);
    setToken(clean);
    const requested = new URLSearchParams(window.location.search).get("next");
    const destination = requested?.startsWith("/") && !requested.startsWith("//")
      ? requested
      : "/dashboard";
    router.replace(destination);
  }, [router]);

  const value = useMemo(() => ({ token, ready, signIn, signOut }), [ready, signIn, signOut, token]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}

export function AuthGuard({ children }: { children: ReactNode }) {
  const { ready, token } = useAuth();
  if (!ready || !token) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4 p-6" aria-label="Loading authentication">
        <div className="h-12 w-56 animate-pulse rounded-lg bg-foreground/[0.05] motion-reduce:animate-none" />
        <div className="h-64 animate-pulse rounded-xl bg-foreground/[0.04] motion-reduce:animate-none" />
      </div>
    );
  }
  return children;
}
