import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { currentIdentity } from "@/lib/session";
import { oidcEnabled } from "@/lib/oidc";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await currentIdentity()) redirect("/projects");
  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="login-heading">
        <div className="brand-mark" aria-hidden="true">
          V
        </div>
        <p className="eyebrow">Vibe JIRA</p>
        <h1 id="login-heading">Welcome back</h1>
        <p className="muted">Sign in to your engineering workspace.</p>
        <LoginForm oidcEnabled={oidcEnabled()} />
      </section>
    </main>
  );
}
