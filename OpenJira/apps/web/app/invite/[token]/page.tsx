import { InvitationForm } from "@/components/invitation-form";

export default async function InvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="invitation-heading">
        <div className="brand-mark" aria-hidden="true">
          V
        </div>
        <p className="eyebrow">Vibe JIRA invitation</p>
        <h1 id="invitation-heading">Activate your account</h1>
        <p className="muted">Choose a password to join the workspace.</p>
        <InvitationForm token={token} />
      </section>
    </main>
  );
}
