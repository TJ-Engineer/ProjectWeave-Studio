import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await currentIdentity()) redirect("/spaces");
  return (
    <section className="auth-shell">
      <div className="auth-card">
        <p className="eyebrow">ProjectWeave</p>
        <h1>Welcome to Vibe Knowledge</h1>
        <p className="muted">
          Sign in with the development account configured by the operator.
        </p>
        <LoginForm />
      </div>
    </section>
  );
}
