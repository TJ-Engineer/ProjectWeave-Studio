import { issueSearchQuerySchema, type IssueSearchQuery } from "@vibe/contracts";
import { getProjectAccess, searchIssues } from "@vibe/database";
import { can } from "@vibe/domain";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { LogoutButton } from "@/components/logout-button";
import { NotificationLink } from "@/components/notification-link";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

type Parameters = Record<string, string | string[] | undefined>;

function nextPageUrl(
  projectKey: string,
  view: "backlog" | "all",
  query: IssueSearchQuery,
  cursor: string,
): string {
  const parameters = new URLSearchParams({ view, cursor });
  if (query.q) parameters.set("q", query.q);
  for (const [name, values] of [
    ["issueTypes", query.issueTypes],
    ["statusCategories", query.statusCategories],
    ["priorities", query.priorities],
    ["assignees", query.assignees],
    ["labels", query.labels],
  ] as const) {
    for (const value of values) parameters.append(name, value);
  }
  parameters.set("sort", query.sort);
  if (query.direction) parameters.set("direction", query.direction);
  return `/projects/${projectKey}/issues?${parameters.toString()}`;
}

export default async function ProjectIssuesPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectKey: string }>;
  searchParams: Promise<Parameters>;
}) {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  const { projectKey } = await params;
  const access = await getProjectAccess(identity.id, projectKey.toUpperCase());
  if (
    !access ||
    !can(access.organizationRole, access.projectRole, "issue:view")
  ) {
    notFound();
  }
  const raw = await searchParams;
  const requested = issueSearchQuerySchema.safeParse(raw);
  const base = requested.success
    ? requested.data
    : issueSearchQuerySchema.parse({});
  const view = raw.view === "all" ? "all" : "backlog";
  const query: IssueSearchQuery = {
    ...base,
    projects: [access.projectKey],
    statusCategories: view === "backlog" ? ["TODO"] : base.statusCategories,
    sort: raw.sort ? base.sort : "key",
    direction: raw.direction ? base.direction : "asc",
  };
  const result = await searchIssues(identity, query);
  const project = result.facets.projects.find(
    (item) => item.id === access.projectId,
  );
  if (!project) notFound();
  return (
    <main className="page-shell issue-list-page">
      <header className="topbar">
        <div className="board-breadcrumbs">
          <Link className="brand" href="/projects">
            <span>V</span> Vibe JIRA
          </Link>
          <span aria-hidden="true">/</span>
          <Link href={`/projects/${project.key}/boards/${project.boardId}`}>
            {project.name}
          </Link>
        </div>
        <div className="user-actions">
          <Link className="notification-link" href="/search">
            Search
          </Link>
          <NotificationLink />
          <span>{identity.displayName}</span>
          <LogoutButton />
        </div>
      </header>

      <section className="issue-list-heading">
        <div>
          <p className="eyebrow">{project.key}</p>
          <h1>Backlog and issues</h1>
          <p className="muted">A durable, cursor-paged list of project work.</p>
        </div>
        <Link
          className="secondary-button"
          href={`/projects/${project.key}/boards/${project.boardId}`}
        >
          Back to board
        </Link>
      </section>

      <nav className="view-tabs" aria-label="Issue list views">
        <Link
          aria-current={view === "backlog" ? "page" : undefined}
          href={`/projects/${project.key}/issues?view=backlog`}
        >
          Backlog
        </Link>
        <Link
          aria-current={view === "all" ? "page" : undefined}
          href={`/projects/${project.key}/issues?view=all`}
        >
          All issues
        </Link>
      </nav>

      <form className="issue-list-filters" method="get">
        <input name="view" type="hidden" value={view} />
        <label>
          Search
          <input
            defaultValue={query.q}
            name="q"
            placeholder="Key, summary, description"
          />
        </label>
        <label>
          Types
          <select
            defaultValue={query.issueTypes}
            multiple
            name="issueTypes"
            size={3}
          >
            {(["EPIC", "STORY", "TASK", "BUG", "SUBTASK"] as const).map(
              (type) => (
                <option key={type}>{type}</option>
              ),
            )}
          </select>
        </label>
        <label>
          Priorities
          <select
            defaultValue={query.priorities}
            multiple
            name="priorities"
            size={3}
          >
            {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map(
              (priority) => (
                <option key={priority}>{priority}</option>
              ),
            )}
          </select>
        </label>
        <label>
          Assignees
          <select
            defaultValue={query.assignees}
            multiple
            name="assignees"
            size={3}
          >
            <option value="unassigned">Unassigned</option>
            {result.facets.users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Labels
          <input defaultValue={query.labels.join(", ")} name="labels" />
        </label>
        <button className="primary-button" type="submit">
          Apply
        </button>
      </form>

      {!requested.success && (
        <p className="error-banner" role="alert">
          Invalid list filters were reset.
        </p>
      )}
      <section
        className="issue-list-results"
        aria-labelledby="issue-list-title"
      >
        <div className="search-results-heading">
          <h2 id="issue-list-title">
            {view === "backlog" ? "Backlog" : "All issues"}
          </h2>
          <span className="muted">{result.items.length} on this page</span>
        </div>
        {result.items.length === 0 ? (
          <p className="empty-state">No issues match this view.</p>
        ) : (
          <div className="issue-list-table-wrap">
            <table className="issue-list-table">
              <caption className="sr-only">
                {view === "backlog" ? "Backlog" : "All project issues"}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Summary</th>
                  <th scope="col">Status</th>
                  <th scope="col">Type</th>
                  <th scope="col">Priority</th>
                  <th scope="col">Assignee</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((issue) => (
                  <tr key={issue.id}>
                    <td>{issue.key}</td>
                    <td>
                      <Link
                        href={`/projects/${project.key}/boards/${project.boardId}?issue=${issue.key}`}
                      >
                        {issue.summary}
                      </Link>
                    </td>
                    <td>{issue.status.name}</td>
                    <td>{issue.issueType}</td>
                    <td>{issue.priority}</td>
                    <td>{issue.assignee?.displayName ?? "Unassigned"}</td>
                    <td>
                      <time dateTime={issue.updatedAt}>
                        {new Date(issue.updatedAt).toLocaleDateString()}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result.nextCursor && (
          <Link
            className="secondary-button"
            href={nextPageUrl(project.key, view, query, result.nextCursor)}
          >
            Next page
          </Link>
        )}
      </section>
    </main>
  );
}
