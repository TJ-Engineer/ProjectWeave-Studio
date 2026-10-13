import Link from "next/link";
import { redirect } from "next/navigation";
import { LogoutButton } from "@/components/logout-button";
import { currentIdentity } from "@/lib/session";

export default async function MetricDefinitionsPage() {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  return (
    <main className="page-shell prose-page">
      <header className="topbar">
        <Link className="brand" href="/projects">
          <span>V</span> Vibe JIRA
        </Link>
        <div className="user-actions">
          <span>{identity.displayName}</span>
          <LogoutButton />
        </div>
      </header>
      <article>
        <p className="eyebrow">Release 1 metric contract</p>
        <h1>Kanban metric definitions</h1>
        <p>
          Metrics derive from immutable creation and status-category transition
          events. All report boundaries and daily buckets use UTC.
        </p>
        <h2>Lead time</h2>
        <p>Creation to the first entry into a Done status.</p>
        <h2>Cycle time</h2>
        <p>
          First entry into In progress to the first later entry into Done,
          including any intervening return to To do.
        </p>
        <h2>Throughput</h2>
        <p>Issues first completed in the selected UTC date range.</p>
        <h2>Aging WIP</h2>
        <p>
          Time since the latest entry into In progress for work currently in
          that category.
        </p>
        <h2>Status time and cumulative flow</h2>
        <p>
          Category time accumulates between events. Cumulative flow samples each
          category at the end of the UTC day; today's point uses now.
        </p>
        <p>
          Reorders, edits, comments, deletion, and restoration do not change
          flow state. Reopened issues keep their original completion boundary.
        </p>
      </article>
    </main>
  );
}
