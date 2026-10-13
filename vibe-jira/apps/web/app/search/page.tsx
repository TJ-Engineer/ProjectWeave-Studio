import { issueSearchQuerySchema, type IssueSearchQuery } from "@vibe/contracts";
import { listSavedFilters, searchIssues } from "@vibe/database";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LogoutButton } from "@/components/logout-button";
import { NotificationLink } from "@/components/notification-link";
import { SavedFilterPanel } from "@/components/saved-filter-panel";
import { currentIdentity } from "@/lib/session";

export const dynamic = "force-dynamic";

type SearchParameters = Record<string, string | string[] | undefined>;

function pageUrl(query: IssueSearchQuery, cursor: string): string {
  const parameters = new URLSearchParams();
  const scalar = [
    ["q", query.q],
    ["createdFrom", query.createdFrom],
    ["createdTo", query.createdTo],
    ["updatedFrom", query.updatedFrom],
    ["updatedTo", query.updatedTo],
    ["sort", query.sort],
    ["direction", query.direction],
  ] as const;
  for (const [name, value] of scalar) {
    if (value) parameters.set(name, value);
  }
  for (const [name, values] of [
    ["projects", query.projects],
    ["issueTypes", query.issueTypes],
    ["statuses", query.statuses],
    ["statusCategories", query.statusCategories],
    ["priorities", query.priorities],
    ["assignees", query.assignees],
    ["reporters", query.reporters],
    ["labels", query.labels],
    ["parents", query.parents],
  ] as const) {
    for (const value of values) parameters.append(name, value);
  }
  parameters.set("cursor", cursor);
  parameters.set("limit", String(query.limit));
  return `/search?${parameters.toString()}`;
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParameters>;
}) {
  const identity = await currentIdentity();
  if (!identity) redirect("/login");
  const requested = issueSearchQuerySchema.safeParse(await searchParams);
  const query = requested.success
    ? requested.data
    : issueSearchQuerySchema.parse({});
  const [result, savedFilters] = await Promise.all([
    searchIssues(identity, query),
    listSavedFilters(identity),
  ]);
  const selectedStatuses = new Set(query.statuses);
  return (
    <main className="page-shell search-page">
      <header className="topbar">
        <Link className="brand" href="/projects">
          <span>V</span> Vibe JIRA
        </Link>
        <div className="user-actions">
          <Link className="notification-link" href="/projects">
            Projects
          </Link>
          <NotificationLink />
          <span>{identity.displayName}</span>
          <LogoutButton />
        </div>
      </header>

      <section className="search-heading" aria-labelledby="search-title">
        <p className="eyebrow">Across your projects</p>
        <h1 id="search-title">Search issues</h1>
        <p className="muted">
          Combine fields with AND; multiple choices within one field use OR.
        </p>
      </section>

      {!requested.success && (
        <p className="error-banner" role="alert">
          One or more search values were invalid, so the filters were reset.
        </p>
      )}

      <form className="search-form" action="/search" method="get">
        <label className="search-query-field">
          <span>Words or issue key</span>
          <input
            autoFocus
            defaultValue={query.q}
            maxLength={200}
            name="q"
            placeholder="Search summaries and descriptions…"
            type="search"
          />
        </label>
        <label>
          <span>Projects</span>
          <select
            aria-label="Projects"
            defaultValue={query.projects}
            multiple
            name="projects"
            size={4}
          >
            {result.facets.projects.map((project) => (
              <option key={project.id} value={project.key}>
                {project.key} · {project.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Types</span>
          <select
            defaultValue={query.issueTypes}
            multiple
            name="issueTypes"
            size={5}
          >
            {(["EPIC", "STORY", "TASK", "BUG", "SUBTASK"] as const).map(
              (type) => (
                <option key={type}>{type}</option>
              ),
            )}
          </select>
        </label>
        <label>
          <span>Status categories</span>
          <select
            defaultValue={query.statusCategories}
            multiple
            name="statusCategories"
            size={3}
          >
            <option value="TODO">To do</option>
            <option value="IN_PROGRESS">In progress</option>
            <option value="DONE">Done</option>
          </select>
        </label>
        <label>
          <span>Statuses</span>
          <select
            defaultValue={[...selectedStatuses]}
            multiple
            name="statuses"
            size={5}
          >
            {result.facets.statuses.map((status) => (
              <option key={status.id} value={status.id}>
                {status.projectKey} · {status.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Priorities</span>
          <select
            aria-label="Priorities"
            defaultValue={query.priorities}
            multiple
            name="priorities"
            size={4}
          >
            {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map(
              (priority) => (
                <option key={priority}>{priority}</option>
              ),
            )}
          </select>
        </label>
        <label>
          <span>Assignees</span>
          <select
            defaultValue={query.assignees}
            multiple
            name="assignees"
            size={5}
          >
            <option value="unassigned">Unassigned</option>
            {result.facets.users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.displayName} · {user.email}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Reporters</span>
          <select
            defaultValue={query.reporters}
            multiple
            name="reporters"
            size={5}
          >
            {result.facets.users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.displayName} · {user.email}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Labels</span>
          <input
            defaultValue={query.labels.join(", ")}
            name="labels"
            placeholder="frontend, urgent"
          />
        </label>
        <label>
          <span>Parent issues</span>
          <input
            defaultValue={query.parents.join(", ")}
            name="parents"
            placeholder="ENG-12, OPS-4"
          />
        </label>
        <fieldset className="search-date-range">
          <legend>Created date</legend>
          <label>
            From
            <input
              defaultValue={query.createdFrom}
              name="createdFrom"
              type="date"
            />
          </label>
          <label>
            To
            <input
              defaultValue={query.createdTo}
              name="createdTo"
              type="date"
            />
          </label>
        </fieldset>
        <fieldset className="search-date-range">
          <legend>Updated date</legend>
          <label>
            From
            <input
              defaultValue={query.updatedFrom}
              name="updatedFrom"
              type="date"
            />
          </label>
          <label>
            To
            <input
              defaultValue={query.updatedTo}
              name="updatedTo"
              type="date"
            />
          </label>
        </fieldset>
        <label>
          <span>Sort by</span>
          <select defaultValue={query.sort} name="sort">
            <option value="relevance">Relevance</option>
            <option value="rank">Board rank</option>
            <option value="priority">Priority</option>
            <option value="created">Created</option>
            <option value="updated">Updated</option>
            <option value="key">Issue key</option>
          </select>
        </label>
        <label>
          <span>Direction</span>
          <select defaultValue={query.direction ?? ""} name="direction">
            <option value="">Recommended</option>
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </label>
        <div className="search-actions">
          <button className="primary-button" type="submit">
            Search
          </button>
          <Link className="secondary-button" href="/search">
            Clear
          </Link>
        </div>
      </form>

      <SavedFilterPanel
        currentQuery={query}
        initialFilters={savedFilters}
        projects={result.facets.projects}
      />

      <section
        className="search-results"
        aria-labelledby="search-results-title"
      >
        <div className="search-results-heading">
          <h2 id="search-results-title">Results</h2>
          <span className="muted">{result.items.length} on this page</span>
        </div>
        {result.items.length === 0 && (
          <p className="empty-state">
            No accessible issues match these filters.
          </p>
        )}
        <div className="search-result-list">
          {result.items.map((issue) => (
            <article className="search-result-card" key={issue.id}>
              <div>
                <Link
                  href={`/projects/${issue.project.key}/boards/${issue.project.boardId}?issue=${issue.key}`}
                >
                  <strong>{issue.summary}</strong>
                </Link>
                <p className="muted search-result-description">
                  {issue.description || "No description"}
                </p>
              </div>
              <dl>
                <div>
                  <dt>Key</dt>
                  <dd>{issue.key}</dd>
                </div>
                <div>
                  <dt>Project</dt>
                  <dd>{issue.project.name}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{issue.status.name}</dd>
                </div>
                <div>
                  <dt>Type</dt>
                  <dd>{issue.issueType}</dd>
                </div>
                <div>
                  <dt>Priority</dt>
                  <dd>{issue.priority}</dd>
                </div>
                <div>
                  <dt>Assignee</dt>
                  <dd>{issue.assignee?.displayName ?? "Unassigned"}</dd>
                </div>
              </dl>
              {issue.labels.length > 0 && (
                <div className="label-list" aria-label="Labels">
                  {issue.labels.map((label) => (
                    <span className="label-chip" key={label}>
                      {label}
                    </span>
                  ))}
                </div>
              )}
              <time dateTime={issue.updatedAt}>
                Updated {new Date(issue.updatedAt).toLocaleDateString()}
              </time>
            </article>
          ))}
        </div>
        {result.nextCursor && (
          <Link
            className="secondary-button"
            href={pageUrl(query, result.nextCursor)}
          >
            Next page
          </Link>
        )}
      </section>
    </main>
  );
}
