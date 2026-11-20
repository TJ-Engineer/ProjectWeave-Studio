/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- Effects synchronize remote controlled-change state. */
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Download,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  LockKeyhole,
  Plus,
  RefreshCw,
} from "lucide-react";

import type { components } from "../api/generated";
import { apiRequest, downloadJson } from "../api/runtime";

type Baseline = components["schemas"]["Baseline"];
type BaselineComparison = components["schemas"]["BaselineComparison"];
type Changeset = components["schemas"]["Changeset"];
type EvidenceExport = components["schemas"]["EvidenceExport"];
type Props = { notify: (message: string) => void; projectId: string };

export function BaselinesWorkspace({ notify, projectId }: Props) {
  const [baselines, setBaselines] = useState<Baseline[]>([]);
  const [changesets, setChangesets] = useState<Changeset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [comparison, setComparison] = useState<BaselineComparison | null>(null);
  const [mode, setMode] = useState<"loading" | "live" | "offline">("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadHistory = async () => {
    setError("");
    try {
      const [baselineResponse, changesetResponse] = await Promise.all([
        apiRequest<{ items: Baseline[] }>(`/api/v1/projects/${projectId}/baselines`),
        apiRequest<{ items: Changeset[] }>(`/api/v1/projects/${projectId}/changesets`),
      ]);
      setBaselines(baselineResponse.items);
      setChangesets(changesetResponse.items);
      setSelectedId((current) => baselineResponse.items.some((item) => item.id === current)
        ? current
        : baselineResponse.items[0]?.id || null);
      setMode("live");
    } catch (requestError) {
      setMode("offline");
      setError(requestError instanceof Error ? requestError.message : "Could not load controlled history");
    }
  };

  useEffect(() => {
    void loadHistory();
  }, [projectId]);

  const selectedIndex = Math.max(0, baselines.findIndex((item) => item.id === selectedId));
  const selected = baselines[selectedIndex] || null;
  const previous = baselines[selectedIndex + 1] || null;

  useEffect(() => {
    if (!selected || !previous || mode !== "live") {
      setComparison(null);
      return;
    }
    const query = new URLSearchParams({ from_baseline_id: previous.id, to_baseline_id: selected.id });
    void apiRequest<BaselineComparison>(`/api/v1/projects/${projectId}/baselines/compare?${query}`)
      .then(setComparison)
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : "Could not compare baselines"));
  }, [mode, previous?.id, projectId, selected?.id]);

  const createChangeset = async () => {
    if (mode !== "live") return notify("Start the API before creating a changeset");
    const message = window.prompt("Changeset message", "Capture controlled Phase 3 changes");
    if (!message?.trim()) return;
    setBusy(true);
    try {
      await apiRequest(`/api/v1/projects/${projectId}/changesets`, {
        method: "POST",
        headers: { "X-Idempotency-Key": `web-changeset-${Date.now()}` },
        body: JSON.stringify({ message: message.trim() }),
      });
      notify("Immutable changeset created");
      await loadHistory();
    } catch (requestError) {
      notify(requestError instanceof Error ? requestError.message : "Could not create changeset");
    } finally {
      setBusy(false);
    }
  };

  const createBaseline = async () => {
    if (mode !== "live") return notify("Start the API before creating a baseline");
    if (!changesets[0]) return notify("Create a changeset before freezing a baseline");
    const name = window.prompt("Baseline name", `Baseline ${baselines.length + 1}`);
    if (!name?.trim()) return;
    setBusy(true);
    try {
      await apiRequest(`/api/v1/projects/${projectId}/baselines`, {
        method: "POST",
        headers: { "X-Idempotency-Key": `web-baseline-${Date.now()}` },
        body: JSON.stringify({
          name: name.trim(),
          changeset_id: changesets[0].id,
          supersedes_baseline_id: baselines[0]?.id || null,
        }),
      });
      notify("Signed immutable baseline created");
      await loadHistory();
    } catch (requestError) {
      notify(requestError instanceof Error ? requestError.message : "Could not create baseline");
    } finally {
      setBusy(false);
    }
  };

  const exportEvidence = async (baseline: Baseline) => {
    try {
      const evidence = await apiRequest<EvidenceExport>(`/api/v1/projects/${projectId}/baselines/${baseline.id}/evidence`);
      downloadJson(`openrm-baseline-${baseline.sequence}-evidence.json`, evidence);
      notify(evidence.signature_valid ? "Verified signed evidence exported" : "Evidence exported with an invalid signature warning");
    } catch (requestError) {
      notify(requestError instanceof Error ? requestError.message : "Could not export evidence");
    }
  };

  const diffItems = useMemo(() => {
    if (!comparison) return [];
    return [
      ...comparison.artifacts_added.map((key) => ({ key, type: "added" as const })),
      ...comparison.artifacts_modified.map((key) => ({ key, type: "modified" as const })),
      ...comparison.artifacts_removed.map((key) => ({ key, type: "removed" as const })),
    ];
  }, [comparison]);

  return (
    <section className="baselines-live-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">Controlled history • Deterministic signed snapshots</div>
          <h1>Baselines &amp; changesets</h1>
          <p>Capture attributable diffs, freeze exact revisions, compare states, and export verifiable evidence.</p>
        </div>
        <div className="page-actions">
          <button className="secondary-button" onClick={() => void createChangeset()} disabled={busy}><GitCommitHorizontal size={15} /> Create changeset</button>
          <button className="primary-button" onClick={() => void createBaseline()} disabled={busy}><Plus size={16} /> Create baseline</button>
        </div>
      </header>

      <div className={`workspace-mode ${mode === "live" ? "live" : mode}`} role="status" aria-live="polite">
        {mode === "loading" && <><RefreshCw size={14} /> Connecting to controlled history…</>}
        {mode === "live" && <><CheckCircle2 size={14} /> Live controlled history • {changesets.length} changesets • {baselines.length} baselines</>}
        {mode === "offline" && <><AlertTriangle size={14} /> API unavailable — start the service to manage controlled history</>}
      </div>
      {error && <div className="workspace-error" role="alert">{error}</div>}

      <div className="baseline-grid">
        <section className="panel baseline-list">
          <div className="panel-heading compact"><div><span className="panel-kicker">Protected baselines</span><h2>Project history</h2></div><button className="icon-button" onClick={() => void loadHistory()} aria-label="Refresh baselines"><RefreshCw size={16} /></button></div>
          {baselines.map((baseline) => (
            <button key={baseline.id} className={`baseline-card ${selected?.id === baseline.id ? "selected" : ""}`} onClick={() => setSelectedId(baseline.id)}>
              <span className="baseline-icon"><LockKeyhole size={17} /></span>
              <span><code>BL-{String(baseline.sequence).padStart(3, "0")}</code><strong>{baseline.name}</strong><small>{new Date(baseline.created_at).toLocaleDateString()} • {baseline.artifact_count} artifacts</small></span>
              <span className="baseline-commit"><GitCommitHorizontal size={13} /> {baseline.manifest_hash.slice(0, 7)}</span>
              <ChevronRight size={16} />
            </button>
          ))}
          {baselines.length === 0 && <div className="empty-requirements">No baselines yet. Create a changeset, then freeze the first signed baseline.</div>}
        </section>

        <section className="panel compare-panel">
          <div className="compare-header">
            <div><span className="panel-kicker">Baseline comparison</span><h2>{previous ? `BL-${String(previous.sequence).padStart(3, "0")}` : "Earlier state"} <GitCompareArrows size={18} /> {selected ? `BL-${String(selected.sequence).padStart(3, "0")}` : "Current state"}</h2></div>
            <button className="secondary-button" disabled={!selected} onClick={() => selected && void exportEvidence(selected)}><Download size={14} /> Export signed evidence</button>
          </div>
          <div className="diff-summary">
            <div className="added"><strong>+{comparison?.artifacts_added.length || 0}</strong><span>Added</span></div>
            <div className="modified"><strong>{comparison?.artifacts_modified.length || 0}</strong><span>Modified</span></div>
            <div className="removed"><strong>−{comparison?.artifacts_removed.length || 0}</strong><span>Removed</span></div>
            <div><strong>{comparison?.relationships_changed || 0}</strong><span>Relationship changes</span></div>
          </div>
          <div className="diff-list">
            {diffItems.map((item) => <DiffRow key={`${item.type}-${item.key}`} id={item.key} type={item.type} />)}
            {!comparison && <div className="empty-requirements">Create or select two baselines to compare exact revisions.</div>}
            {comparison && diffItems.length === 0 && comparison.relationships_changed === 0 && <div className="empty-requirements">These baselines contain the same artifact and relationship revisions.</div>}
          </div>
        </section>

        <section className="panel branch-panel">
          <div className="panel-heading compact"><div><span className="panel-kicker">Changeset graph</span><h2>Controlled main line</h2></div><span className="branch-chip"><GitBranch size={13} /> main</span></div>
          <div className="branch-timeline">
            {changesets.map((changeset, index) => (
              <div className="branch-event" key={changeset.id}>
                <span className="branch-node" />{index < changesets.length - 1 && <span className="branch-line" />}
                <code>CS-{String(changeset.sequence).padStart(3, "0")}</code><strong>{changeset.message}</strong><small>{new Date(changeset.created_at).toLocaleDateString()}</small><span className="baseline-tag">+{changeset.added} ~{changeset.modified}</span>
              </div>
            ))}
            {changesets.length === 0 && <div className="empty-requirements">No controlled changesets yet.</div>}
          </div>
        </section>
      </div>
    </section>
  );
}

function DiffRow({ id, type }: { id: string; type: "added" | "modified" | "removed" }) {
  const mark = type === "added" ? "+" : type === "removed" ? "−" : "~";
  return <div className="diff-row"><span className={`diff-mark ${type}`}>{mark}</span><code>{id}</code><span><strong>{type[0].toUpperCase() + type.slice(1)} controlled artifact</strong><small>Exact revision changed between signed manifests</small></span><ChevronRight size={16} /></div>;
}
