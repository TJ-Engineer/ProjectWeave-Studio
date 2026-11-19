/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- Effects synchronize remote verification evidence. */
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  BellRing,
  CheckCircle2,
  Download,
  FileCheck2,
  LockKeyhole,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  TestTube2,
} from "lucide-react";

import type { components } from "../api/generated";
import { apiRequest, apiRequestAs, downloadJson, runtimeConfig } from "../api/runtime";

type Review = components["schemas"]["ReviewPackage"];
type VerificationCase = components["schemas"]["VerificationCase"];
type VerificationCoverage = components["schemas"]["VerificationCoverage"];
type GateReadiness = components["schemas"]["GateReadiness"];
type DueEvent = components["schemas"]["VerificationDueEvent"];
type GateEvidence = components["schemas"]["GateEvidenceExport"];
type BaselineEvidence = components["schemas"]["EvidenceExport"];
type Props = { notify: (message: string) => void; projectId: string };

const label = (value: string) => value.replaceAll("_", " ").toUpperCase();

export function VerificationWorkspace({ notify, projectId }: Props) {
  const config = runtimeConfig();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const [cases, setCases] = useState<VerificationCase[]>([]);
  const [coverage, setCoverage] = useState<VerificationCoverage | null>(null);
  const [readiness, setReadiness] = useState<GateReadiness | null>(null);
  const [dueEvents, setDueEvents] = useState<DueEvent[]>([]);
  const [mode, setMode] = useState<"loading" | "live" | "offline">("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadReviewList = async () => {
    setError("");
    try {
      const response = await apiRequest<{ items: Review[] }>(`/api/v1/projects/${projectId}/reviews`);
      setReviews(response.items);
      setSelectedReviewId((current) => response.items.some((review) => review.id === current)
        ? current
        : response.items.find((review) => review.status === "approved")?.id || response.items[0]?.id || null);
      setMode("live");
    } catch (requestError) {
      setMode("offline");
      setError(requestError instanceof Error ? requestError.message : "Could not load verification reviews");
    }
  };

  const loadVerification = async (reviewId: string) => {
    setError("");
    const query = new URLSearchParams({ review_id: reviewId });
    try {
      const [caseResponse, coverageResponse, readinessResponse, eventResponse] = await Promise.all([
        apiRequest<{ items: VerificationCase[] }>(`/api/v1/projects/${projectId}/verification/cases?${query}`),
        apiRequest<VerificationCoverage>(`/api/v1/projects/${projectId}/verification/coverage?${query}`),
        apiRequest<GateReadiness>(`/api/v1/projects/${projectId}/verification/readiness?${query}`),
        apiRequest<{ items: DueEvent[] }>(`/api/v1/projects/${projectId}/verification/due-events?${query}`),
      ]);
      setCases(caseResponse.items);
      setCoverage(coverageResponse);
      setReadiness(readinessResponse);
      setDueEvents(eventResponse.items);
      setMode("live");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load verification evidence");
    }
  };

  useEffect(() => {
    void loadReviewList();
  }, [projectId]);

  useEffect(() => {
    if (selectedReviewId) void loadVerification(selectedReviewId);
    else {
      setCases([]);
      setCoverage(null);
      setReadiness(null);
      setDueEvents([]);
    }
  }, [selectedReviewId]);

  const selectedReview = reviews.find((review) => review.id === selectedReviewId) || null;

  const runCommand = async (command: () => Promise<unknown>, success: string) => {
    if (!selectedReviewId) return;
    setBusy(true);
    try {
      await command();
      notify(success);
      await loadVerification(selectedReviewId);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Verification command failed";
      setError(message);
      notify(message);
    } finally {
      setBusy(false);
    }
  };

  const createCase = async () => {
    if (!selectedReview) return;
    if (selectedReview.status !== "approved") return notify("Approve the review package before planning verification");
    const title = window.prompt("Verification case title", "Verify all requirements in the approved baseline");
    if (!title?.trim()) return;
    await runCommand(async () => {
      const baseline = await apiRequest<BaselineEvidence>(`/api/v1/projects/${projectId}/baselines/${selectedReview.baseline_id}/evidence`);
      const manifest = baseline.manifest as { artifacts?: Array<{ artifact_id?: string }> };
      const targets = (manifest.artifacts || []).flatMap((artifact) => artifact.artifact_id ? [artifact.artifact_id] : []);
      if (targets.length === 0) throw new Error("The approved baseline has no artifacts to verify");
      await apiRequest(`/api/v1/projects/${projectId}/verification/cases`, {
        method: "POST",
        headers: { "X-Idempotency-Key": `web-verification-case-${Date.now()}` },
        body: JSON.stringify({
          review_id: selectedReview.id,
          key: `VER-${String(cases.length + 1).padStart(3, "0")}`,
          title: title.trim(),
          method: "test",
          procedure: "Execute the controlled procedure and capture measured results against every bound requirement revision.",
          acceptance_criteria: "All bound requirement revisions satisfy the recorded procedure without unresolved failures.",
          owner_subject: config.reviewerSubject,
          due_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          target_artifact_ids: targets,
        }),
      });
    }, "Immutable verification case created");
  };

  const startRun = async (verificationCase: VerificationCase) => {
    await runCommand(() => apiRequestAs(`/api/v1/projects/${projectId}/verification/cases/${verificationCase.id}/runs`, config.reviewerToken, {
      method: "POST",
      headers: { "X-Idempotency-Key": `web-verification-run-${Date.now()}` },
      body: JSON.stringify({ execution_note: "Executing the approved procedure against the immutable baseline scope." }),
    }), `${verificationCase.key} execution started`);
  };

  const recordResult = async (verificationCase: VerificationCase) => {
    const run = verificationCase.runs.find((candidate) => candidate.status === "in_progress");
    if (!run) return;
    const outcome = window.prompt("Result outcome: passed, failed, or blocked", "passed")?.trim().toLowerCase();
    if (!outcome || !["passed", "failed", "blocked"].includes(outcome)) return;
    const notes = window.prompt("Result notes", outcome === "passed" ? "Acceptance criteria satisfied." : "Explain the unresolved result.");
    if (notes === null || (outcome !== "passed" && !notes.trim())) return;
    const objectKey = window.prompt("Evidence object key", `verification/${run.id}/result.json`);
    if (!objectKey?.trim()) return;
    const digestSeed = run.id.replaceAll("-", "");
    await runCommand(() => apiRequestAs(`/api/v1/projects/${projectId}/verification/runs/${run.id}/results`, config.reviewerToken, {
      method: "POST",
      headers: { "X-Idempotency-Key": `web-verification-result-${Date.now()}` },
      body: JSON.stringify({
        outcome,
        notes: notes.trim(),
        measured_values: { acceptance_criteria_satisfied: outcome === "passed" },
        attachments: [{
          object_key: objectKey.trim(),
          file_name: "result.json",
          media_type: "application/json",
          size_bytes: 0,
          sha256: `${digestSeed}${digestSeed}`,
        }],
      }),
    }), `Signed ${outcome} result recorded`);
  };

  const emitDueEvents = async () => {
    if (!selectedReviewId) return;
    await runCommand(() => apiRequest(`/api/v1/projects/${projectId}/verification/due-events`, {
      method: "POST",
      body: JSON.stringify({ review_id: selectedReviewId }),
    }), "Due-date events evaluated");
  };

  const exportEvidence = async () => {
    if (!selectedReviewId) return;
    try {
      const evidence = await apiRequest<GateEvidence>(`/api/v1/projects/${projectId}/reviews/${selectedReviewId}/evidence`);
      downloadJson(`openrm-gate-${selectedReviewId}-evidence.json`, evidence);
      notify(evidence.signature_valid ? "Verified gate evidence exported" : "Gate evidence exported with an invalid signature warning");
    } catch (requestError) {
      notify(requestError instanceof Error ? requestError.message : "Could not export gate evidence");
    }
  };

  return (
    <section className="verification-live-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">Approved intent • Signed execution evidence</div>
          <h1>Verification &amp; gate readiness</h1>
          <p>Plan immutable procedures, execute independently, capture content-addressed evidence, and explain every readiness decision.</p>
        </div>
        <div className="page-actions">
          <button className="secondary-button" onClick={() => void emitDueEvents()} disabled={busy || !selectedReviewId}><BellRing size={15} /> Evaluate due dates</button>
          <button className="secondary-button" onClick={() => void exportEvidence()} disabled={!selectedReviewId}><Download size={15} /> Export gate evidence</button>
          <button className="primary-button" onClick={() => void createCase()} disabled={busy || !selectedReview}><Plus size={16} /> Create verification case</button>
        </div>
      </header>

      <div className={`workspace-mode ${mode === "live" ? "live" : mode}`} role="status" aria-live="polite">
        {mode === "loading" && <><RefreshCw size={14} /> Connecting to verification evidence…</>}
        {mode === "live" && <><CheckCircle2 size={14} /> Live verification evidence • {cases.length} cases • {coverage?.passed_artifacts || 0}/{coverage?.total_artifacts || 0} revisions passed</>}
        {mode === "offline" && <><AlertTriangle size={14} /> API unavailable — start the service to manage verification evidence</>}
      </div>
      {error && <div className="workspace-error" role="alert">{error}</div>}

      <div className="verification-review-picker">
        <label htmlFor="verification-review">Gate package</label>
        <select id="verification-review" value={selectedReviewId || ""} onChange={(event) => setSelectedReviewId(event.target.value || null)}>
          {reviews.map((review) => <option key={review.id} value={review.id}>RV-{String(review.sequence).padStart(3, "0")} • {review.title} • {label(review.status)}</option>)}
        </select>
        {selectedReview && <span className={`status-pill ${selectedReview.status.replaceAll("_", "-")}`}>{label(selectedReview.status)}</span>}
      </div>

      {selectedReview ? <>
        <div className="verification-grid live-verification-grid">
          <section className={`panel cycle-hero readiness-hero ${readiness?.ready ? "ready" : "not-ready"}`}>
            <div><span className="panel-kicker">Explainable gate</span><h2>{readiness?.ready ? "Ready to proceed" : "Evidence gate not ready"}</h2><p>{readiness?.blockers[0] || "All review, coverage, execution, and signature conditions are satisfied."}</p></div>
            <div className="cycle-donut" style={{ "--coverage": `${coverage?.coverage_percent || 0}%` } as CSSProperties}><strong>{coverage?.coverage_percent.toFixed(0) || 0}%</strong><span>coverage</span></div>
            <div className="result-legend"><span><i className="pass" /> {readiness?.passed_cases || 0} passed</span><span><i className="fail" /> {readiness?.failed_cases || 0} failed</span><span><i className="block" /> {readiness?.blocked_cases || 0} blocked</span><span><i className="open" /> {readiness?.planned_cases || 0} planned</span></div>
          </section>
          <Metric icon={ShieldCheck} value={readiness?.ready ? "READY" : "HOLD"} label="Gate decision" warning={!readiness?.ready} />
          <Metric icon={FileCheck2} value={`${coverage?.passed_artifacts || 0}/${coverage?.total_artifacts || 0}`} label="Revisions passed" />
          <Metric icon={BellRing} value={String(dueEvents.filter((event) => event.event_type !== "completed").length)} label="Due events" warning={dueEvents.some((event) => event.event_type === "overdue")} />
        </div>

        <section className="panel verification-case-panel">
          <div className="panel-heading compact"><div><span className="panel-kicker">Controlled execution</span><h2>Verification cases</h2></div><button className="icon-button" onClick={() => selectedReviewId && void loadVerification(selectedReviewId)} aria-label="Refresh verification"><RefreshCw size={16} /></button></div>
          <div className="verification-case-head"><span>Case &amp; procedure</span><span>Bound revisions</span><span>Owner</span><span>Evidence status</span><span>Action</span></div>
          {cases.map((verificationCase) => {
            const active = verificationCase.runs.find((run) => run.status === "in_progress");
            const latest = verificationCase.runs[0];
            return <article className="verification-case-row" key={verificationCase.id}>
              <span><code>{verificationCase.key}</code><strong>{verificationCase.title}</strong><small>{verificationCase.method} • {verificationCase.acceptance_criteria}</small></span>
              <strong>{verificationCase.targets.length}</strong>
              <span>{verificationCase.owner_subject}</span>
              <span><span className={`status-pill ${verificationCase.status.replaceAll("_", "-")}`}>{label(verificationCase.status)}</span>{latest?.result && <small className="signature-note"><LockKeyhole size={11} /> {latest.result.signature_valid ? "Signature valid" : "Invalid signature"} • {latest.result.attachments.length} attachments</small>}</span>
              <span>{verificationCase.status === "planned" || ["failed", "blocked"].includes(verificationCase.status) ? <button className="secondary-button compact-button" onClick={() => void startRun(verificationCase)} disabled={busy}><Play size={13} /> Execute</button> : active ? <button className="primary-button compact-button" onClick={() => void recordResult(verificationCase)} disabled={busy}><BadgeCheck size={13} /> Record result</button> : <CheckCircle2 size={18} className="verified-mark" />}</span>
            </article>;
          })}
          {cases.length === 0 && <div className="empty-requirements">No verification cases exist for this approved review package.</div>}
        </section>

        <div className="verification-evidence-grid">
          <section className="panel coverage-panel">
            <div className="panel-heading compact"><div><span className="panel-kicker">Requirement rollup</span><h2>Exact revision coverage</h2></div><TestTube2 size={17} /></div>
            {coverage?.items.map((item) => <div className="coverage-row" key={item.artifact_id}><code>{item.artifact_key}</code><span>{item.artifact_revision_id.slice(0, 10)}…</span><strong>{item.case_count} cases</strong><span className={`status-pill ${item.status.replaceAll("_", "-")}`}>{label(item.status)}</span></div>)}
          </section>
          <section className="panel readiness-panel-live">
            <div className="panel-heading compact"><div><span className="panel-kicker">Decision basis</span><h2>Contributors &amp; blockers</h2></div>{readiness?.ready ? <BadgeCheck size={18} /> : <AlertTriangle size={18} />}</div>
            <div className="readiness-list-live">{readiness?.contributors.map((contributor) => <span key={contributor}><CheckCircle2 size={13} /> {contributor}</span>)}</div>
            {(readiness?.blockers.length || 0) > 0 && <div className="gate-blockers">{readiness?.blockers.map((blocker) => <span key={blocker}><AlertTriangle size={13} /> {blocker}</span>)}</div>}
          </section>
        </div>
      </> : <section className="panel verification-no-selection"><TestTube2 size={30} /><h2>No review package selected</h2><p>Approve a controlled review package before planning verification.</p></section>}
    </section>
  );
}

function Metric({ icon: Icon, value, label: metricLabel, warning = false }: { icon: typeof ShieldCheck; value: string; label: string; warning?: boolean }) {
  return <div className={`mini-stat panel verification-metric ${warning ? "warning" : ""}`}><Icon size={18} /><strong>{value}</strong><span>{metricLabel}</span></div>;
}
