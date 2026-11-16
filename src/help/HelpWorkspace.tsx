import { useMemo, useState, type ReactNode } from "react";
import { ArrowUp, BookOpen, Search } from "lucide-react";
import manualSource from "../../docs/user/USER_MANUAL.json";
import { parseManual, sectionSearchText, type ManualBlock } from "./manual";

const INLINE_TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

function renderInline(text: string): ReactNode[] {
  return text.split(INLINE_TOKEN).filter(Boolean).map((token, index) => {
    if (token.startsWith("**") && token.endsWith("**")) {
      return <strong key={`${token}-${index}`}>{token.slice(2, -2)}</strong>;
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      return <code key={`${token}-${index}`}>{token.slice(1, -1)}</code>;
    }
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const [, label, href] = link;
      const external = /^https?:\/\//.test(href);
      return <a key={`${href}-${index}`} href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>{label}</a>;
    }
    return token;
  });
}

function ManualBlockView({ block }: { block: ManualBlock }) {
  if (block.type === "subheading") return <h3 id={block.id}>{block.title}</h3>;
  if (block.type === "unordered-list") return <ul>{block.items.map((item) => <li key={item}>{renderInline(item)}</li>)}</ul>;
  if (block.type === "ordered-list") return <ol>{block.items.map((item) => <li key={item}>{renderInline(item)}</li>)}</ol>;
  if (block.type === "note") return <aside className="help-note">{renderInline(block.text)}</aside>;
  if (block.type === "code") return <pre><code>{block.text}</code></pre>;
  return <p>{renderInline(block.text)}</p>;
}

function formatVerifiedDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" })
    .format(new Date(`${value}T00:00:00Z`));
}

export function HelpWorkspace() {
  const manual = useMemo(() => parseManual(manualSource), []);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const visibleSections = normalizedQuery
    ? manual.sections.filter((section) => sectionSearchText(section).includes(normalizedQuery))
    : manual.sections;

  return (
    <div className="help-workspace" id="help-top">
      <div className="page-header help-heading">
        <div>
          <div className="eyebrow"><BookOpen size={14} /> Product guide • Version {manual.metadata.documentVersion}</div>
          <h1>{manual.title}</h1>
          <p>{manual.summary}</p>
        </div>
        <label className="help-search">
          <span>Search this manual</span>
          <span className="search-box">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Try “baseline” or “access denied”" />
          </span>
        </label>
      </div>

      <div className="help-layout">
        <aside className="help-toc panel">
          <div className="panel-kicker">Table of contents</div>
          <nav aria-label="User manual table of contents">
            {manual.sections.map((section, index) => (
              <a key={section.id} href={`#${section.id}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                {section.title}
              </a>
            ))}
          </nav>
        </aside>

        <article className="help-article panel" aria-label="OpenRM user manual">
          <div className="help-introduction">
            <dl className="help-manual-meta" aria-label="Manual metadata">
              <div><dt>Document version</dt><dd>{manual.metadata.documentVersion}</dd></div>
              <div><dt>Applies to</dt><dd>{manual.metadata.appliesTo}</dd></div>
              <div><dt>Owner</dt><dd>{manual.metadata.owner}</dd></div>
              <div><dt>Last verified</dt><dd>{formatVerifiedDate(manual.metadata.lastVerified)}</dd></div>
              <div><dt>Status</dt><dd>{manual.metadata.status}</dd></div>
            </dl>
            {manual.intro.map((block, index) => <ManualBlockView key={`${block.type}-${index}`} block={block} />)}
          </div>

          {normalizedQuery && (
            <div className="help-results" role="status">
              {visibleSections.length} {visibleSections.length === 1 ? "section" : "sections"} matching “{query.trim()}”
              <button type="button" onClick={() => setQuery("")}>Clear search</button>
            </div>
          )}

          {visibleSections.length > 0 ? visibleSections.map((section) => (
            <section key={section.id} className="help-section" aria-labelledby={`${section.id}-title`}>
              <h2 id={section.id}><span id={`${section.id}-title`}>{section.title}</span></h2>
              {section.blocks.map((block, index) => <ManualBlockView key={`${section.id}-${block.type}-${index}`} block={block} />)}
              <a className="help-back-to-top" href="#help-top"><ArrowUp size={13} /> Back to top</a>
            </section>
          )) : (
            <div className="help-empty" role="status">
              <BookOpen size={24} />
              <h2>No manual sections match that search</h2>
              <p>Try a role, workspace, action, status, or error message.</p>
              <button className="secondary-button" type="button" onClick={() => setQuery("")}>Show the full manual</button>
            </div>
          )}
        </article>
      </div>
    </div>
  );
}
