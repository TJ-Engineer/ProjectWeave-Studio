/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- Effects synchronize remote traceability state. */
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  BadgeCheck,
  Check,
  CheckCircle2,
  Download,
  Link2,
  RefreshCw,
} from "lucide-react";

import type { components } from "../api/generated";
import { apiRequest, downloadJson } from "../api/runtime";

type TraceGraph = components["schemas"]["TraceGraph"];
type TraceMatrixRow = components["schemas"]["TraceMatrixRow"];
type TraceSummary = components["schemas"]["TraceSummary"];
type Relationship = components["schemas"]["Relationship"];

type Props = { notify: (message: string) => void; projectId: string };
type Direction = "both" | "upstream" | "downstream";

const EMPTY_SUMMARY: TraceSummary = {
  total_artifacts: 0,
  covered_artifacts: 0,
  orphan_artifacts: 0,
  relationships: 0,
  suspect_relationships: 0,
  coverage_percent: 0,
};

export function TraceabilityWorkspace({ notify, projectId }: Props) {
  const [graph, setGraph] = useState<TraceGraph>({ nodes: [], edges: [], summary: EMPTY_SUMMARY });
  const [matrix, setMatrix] = useState<TraceMatrixRow[]>([]);
  const [summary, setSummary] = useState<TraceSummary>(EMPTY_SUMMARY);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [direction, setDirection] = useState<Direction>("both");
  const [mode, setMode] = useState<"loading" | "live" | "offline">("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadTrace = async () => {
    setError("");
    try {
      const [graphResponse, matrixResponse, summaryResponse, relationshipResponse] = await Promise.all([
        apiRequest<TraceGraph>(`/api/v1/projects/${projectId}/trace/graph`),
        apiRequest<{ items: TraceMatrixRow[] }>(`/api/v1/projects/${projectId}/trace/matrix`),
        apiRequest<TraceSummary>(`/api/v1/projects/${projectId}/trace/summary`),
        apiRequest<{ items: Relationship[] }>(`/api/v1/projects/${projectId}/relationships`),
      ]);
      setGraph(graphResponse);
      setMatrix(matrixResponse.items);
      setSummary(summaryResponse);
      setRelationships(relationshipResponse.items);
      setSelectedId((current) =>
        graphResponse.nodes.some((node) => node.artifact_id === current)
          ? current
          : graphResponse.nodes[0]?.artifact_id || null,
      );
      setMode("live");
    } catch (requestError) {
      setMode("offline");
      setError(requestError instanceof Error ? requestError.message : "Could not load traceability");
    }
  };

  useEffect(() => {
    void loadTrace();
  }, [projectId]);

  const selected = matrix.find((node) => node.artifact_id === selectedId) || matrix[0] || null;
  const connected = useMemo(() => {
    if (!selected) return [];
    return relationships.filter((relationship) => {
      if (direction === "upstream") return relationship.target_artifact_id === selected.artifact_id;
      if (direction === "downstream") return relationship.source_artifact_id === selected.artifact_id;
      return relationship.source_artifact_id === selected.artifact_id
        || relationship.target_artifact_id === selected.artifact_id;
    });
  }, [direction, relationships, selected]);
  const suspect = connected.find((relationship) => relationship.suspect) || null;

  const resolveImpact = async () => {
    if (!suspect || mode !== "live") return;
    const disposition = window.prompt(
      "Reviewer disposition",
      "Reviewed against the revised source and accepted without downstream change.",
    );
    if (!disposition?.trim()) return;
    setBusy(true);
    try {
      await apiRequest(`/api/v1/projects/${projectId}/relationships/${suspect.id}/resolve`, {
        method: "POST",
        headers: { "X-Idempotency-Key": `web-resolve-${suspect.id}-${suspect.version}-${Date.now()}` },
        body: JSON.stringify({ expected_version: suspect.version, disposition: disposition.trim() }),
      });
      notify("Suspect impact resolved with reviewer evidence");
      await loadTrace();
    } catch (requestError) {
      notify(requestError instanceof Error ? requestError.message : "Could not resolve impact");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="traceability-live-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">Digital thread • Live impact analysis</div>
          <h1>Traceability</h1>
          <p>Inspect directed links, coverage gaps, exact revisions, and suspect impact.</p>
        </div>
        <div className="page-actions">
          <button className="secondary-button" onClick={() => void loadTrace()} disabled={busy}>
            <RefreshCw size={15} /> Refresh
          </button>
          <button
            className="primary-button"
            onClick={() => {
              downloadJson(`openrm-${projectId}-trace.json`, { graph, matrix, summary });
              notify("Trace report exported");
            }}
            disabled={mode !== "live"}
          >
            <Download size={15} /> Export trace report
          </button>
        </div>
      </header>

      <div className={`workspace-mode ${mode === "live" ? "live" : mode}`} role="status" aria-live="polite">
        {mode === "loading" && <><RefreshCw size={14} /> Connecting to the traceability API…</>}
        {mode === "live" && <><CheckCircle2 size={14} /> Live controlled trace • {summary.relationships} relationships</>}
        {mode === "offline" && <><AlertTriangle size={14} /> API unavailable — start the service to inspect controlled trace data</>}
      </div>
      {error && <div className="workspace-error" role="alert">{error}</div>}

      <div className="trace-toolbar panel">
        <strong>{selected ? `${selected.key} • r${selected.revision}` : "Select an artifact"}</strong>
        <div className="trace-direction" aria-label="Trace direction">
          {(["both", "upstream", "downstream"] as Direction[]).map((item) => (
            <button key={item} className={direction === item ? "active" : ""} onClick={() => setDirection(item)}>
              {item === "both" ? "Both directions" : item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </div>
        <span className="toolbar-spacer" />
        <span className="legend-dot covered">Covered</span>
        <span className="legend-dot suspect">Suspect</span>
        <span className="legend-dot gap">Gap</span>
      </div>

      <div className="trace-layout">
        <section className="trace-canvas panel" aria-label="Trace graph">
          <div className="canvas-label">TRACE VIEW • {graph.nodes.length} ARTIFACTS • {graph.edges.length} DIRECTED LINKS</div>
          <div className="trace-live-grid">
            {matrix.map((node) => (
              <button
                key={node.artifact_id}
                className={`trace-live-node ${selected?.artifact_id === node.artifact_id ? "selected" : ""} ${node.suspect_count > 0 ? "suspect" : node.gap ? "gap" : "covered"}`}
                onClick={() => setSelectedId(node.artifact_id)}
                aria-pressed={selected?.artifact_id === node.artifact_id}
              >
                <span className="trace-node-top"><code>{node.key}</code><i className={node.suspect_count > 0 ? "suspect" : node.gap ? "gap" : "covered"} /></span>
                <strong>{node.title}</strong>
                <small>r{node.revision} • ↑ {node.upstream_count} • ↓ {node.downstream_count}</small>
              </button>
            ))}
            {matrix.length === 0 && <div className="empty-requirements">No controlled artifacts are available.</div>}
          </div>
          <div className="trace-edge-list" aria-label="Directed relationships">
            {graph.edges.map((edge) => {
              const source = matrix.find((node) => node.artifact_id === edge.source_artifact_id)?.key || "Unknown";
              const target = matrix.find((node) => node.artifact_id === edge.target_artifact_id)?.key || "Unknown";
              return <span key={edge.relationship_id} className={edge.suspect ? "suspect" : ""}><code>{source}</code><ArrowRight size={12} /><code>{target}</code><small>{edge.relationship_type_key} v{edge.version}</small></span>;
            })}
          </div>
        </section>

        <aside className="trace-inspector panel" aria-label="Selected trace artifact">
          {selected ? <>
            <div className="panel-kicker">Selected artifact</div>
            <div className="trace-selected-id"><code>{selected.key}</code><span className={`status-pill ${selected.suspect_count > 0 ? "suspect" : selected.gap ? "gap" : "covered"}`}>{selected.suspect_count > 0 ? "Suspect" : selected.gap ? "Gap" : "Covered"}</span></div>
            <h2>{selected.title}</h2>
            <p>Current revision r{selected.revision} participates in {selected.upstream_count + selected.downstream_count} controlled relationship(s).</p>
            {suspect && <div className="impact-card"><AlertTriangle size={17} /><div><strong>Impact review required</strong><span>{suspect.suspect_reason || "An endpoint revision changed."}</span></div></div>}
            <div className="trace-stats"><div><strong>{selected.upstream_count}</strong><span>Upstream</span></div><div><strong>{selected.downstream_count}</strong><span>Downstream</span></div><div><strong>{selected.suspect_count}</strong><span>Open impact</span></div></div>
            <div className="inspector-section"><label>Connected relationships</label><div className="trace-connection-list">{connected.map((item) => <span key={item.id}><code>{item.source_key}</code><ArrowRight size={12} /><code>{item.target_key}</code><small>v{item.version}</small></span>)}</div></div>
            <button className="primary-button full-width" onClick={() => void resolveImpact()} disabled={!suspect || busy}><Check size={15} /> {suspect ? "Resolve impact" : "No open impact"}</button>
          </> : <div className="empty-requirements">Select an artifact to inspect its trace.</div>}
        </aside>
      </div>

      <div className="trace-summary-grid">
        <MiniStat icon={BadgeCheck} value={`${summary.coverage_percent}%`} label="Trace coverage" />
        <MiniStat icon={Link2} value={String(summary.relationships)} label="Controlled relationships" />
        <MiniStat icon={AlertTriangle} value={String(summary.suspect_relationships)} label="Suspect links" warning={summary.suspect_relationships > 0} />
        <MiniStat icon={Archive} value={String(summary.orphan_artifacts)} label="Orphan artifacts" warning={summary.orphan_artifacts > 0} />
      </div>
    </section>
  );
}

function MiniStat({ icon: Icon, value, label, warning = false }: { icon: typeof BadgeCheck; value: string; label: string; warning?: boolean }) {
  return <div className={`mini-stat panel ${warning ? "warning" : ""}`}><Icon size={18} /><strong>{value}</strong><span>{label}</span></div>;
}
