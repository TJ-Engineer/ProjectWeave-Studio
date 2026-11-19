/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- Effects synchronize remote review evidence. */
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  ClipboardCheck,
  GitBranch,
  LockKeyhole,
  MessageSquareText,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserPlus,
} from "lucide-react";

import type { components } from "../api/generated";
import { apiRequest, apiRequestAs, runtimeConfig } from "../api/runtime";

type Baseline = components["schemas"]["Baseline"];
type Membership = components["schemas"]["ProjectMembership"];
type Review = components["schemas"]["ReviewPackage"];
type ReviewComment = components["schemas"]["ReviewComment"];
type Props = { notify: (message: string) => void; projectId: string };

const statusLabel = (status: Review["status"]) => status.replaceAll("_", " ").toUpperCase();
const initials = (subject: string) => subject.split(/[._@ -]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "RV";

export function ReviewsWorkspace({ notify, projectId }: Props) {
  const config = runtimeConfig();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [baselines, setBaselines] = useState<Baseline[]>([]);
  const [members, setMembers] = useState<Membership[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"loading" | "live" | "offline">("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadWorkspace = async () => {
    setError("");
    try {
      const [reviewResponse, baselineResponse, membershipResponse] = await Promise.all([
        apiRequest<{ items: Review[] }>(`/api/v1/projects/${projectId}/reviews`),
        apiRequest<{ items: Baseline[] }>(`/api/v1/projects/${projectId}/baselines`),
        apiRequest<{ items: Membership[] }>(`/api/v1/projects/${projectId}/members`),
      ]);
      setReviews(reviewResponse.items);
      setBaselines(baselineResponse.items);
      setMembers(membershipResponse.items);
      setSelectedId((current) => reviewResponse.items.some((item) => item.id === current)
        ? current
        : reviewResponse.items[0]?.id || null);
      setMode("live");
    } catch (requestError) {
      setMode("offline");
      setError(requestError instanceof Error ? requestError.message : "Could not load the review workspace");
    }
  };

  useEffect(() => {
    void loadWorkspace();
  }, [projectId]);

  const selected = reviews.find((review) => review.id === selectedId) || null;
  const baseline = baselines.find((item) => item.id === selected?.baseline_id) || null;
  const completion = selected
    ? Math.min(100, Math.round((selected.approval_count / selected.required_approvals) * 100))
    : 0;
  const availableReviewers = useMemo(
    () => members.filter((member) => member.role === "reviewer" || member.role === "administrator"),
    [members],
  );

  const runCommand = async (command: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await command();
      notify(success);
      await loadWorkspace();
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Review command failed";
      setError(message);
      notify(message);
    } finally {
      setBusy(false);
    }
  };

  const createReview = async () => {
    if (mode !== "live") return notify("Start the API before creating a review package");
    const target = baselines[0];
    if (!target) return notify("Create a signed baseline before assembling a review package");
    const title = window.prompt("Review package title", `Review BL-${String(target.sequence).padStart(3, "0")}`);
    if (!title?.trim()) return;
    await runCommand(async () => {
      const response = await apiRequest<{ review_id: string }>(`/api/v1/projects/${projectId}/reviews`, {
        method: "POST",
        headers: { "X-Idempotency-Key": `web-review-${Date.now()}` },
        body: JSON.stringify({
          baseline_id: target.id,
          title: title.trim(),
          description: `Controlled review of immutable baseline BL-${String(target.sequence).padStart(3, "0")}.`,
          required_approvals: 1,
        }),
      });
      setSelectedId(response.review_id);
    }, "Baseline-bound review package created");
  };

  const assignReviewer = async () => {
    if (!selected || selected.status !== "draft") return;
    const suggested = availableReviewers.find((member) => !selected.participants.some((participant) => participant.subject === member.subject))?.subject
      || config.reviewerSubject;
    const subject = window.prompt("Reviewer subject", suggested);
    if (!subject?.trim()) return;
    const normalizedSubject = subject.trim();
    await runCommand(async () => {
      if (!members.some((member) => member.subject === normalizedSubject && (member.role === "reviewer" || member.role === "administrator"))) {
        await apiRequest(`/api/v1/projects/${projectId}/members`, {
          method: "POST",
          body: JSON.stringify({ subject: normalizedSubject, role: "reviewer" }),
        });
      }
      await apiRequest(`/api/v1/projects/${projectId}/reviews/${selected.id}/participants`, {
        method: "POST",
        headers: { "X-Idempotency-Key": `web-reviewer-${Date.now()}` },
        body: JSON.stringify({ subject: normalizedSubject, role_label: "Independent reviewer", required: true }),
      });
    }, `${normalizedSubject} assigned as an independent reviewer`);
  };

  const startReview = async () => {
    if (!selected) return;
    await runCommand(() => apiRequest(`/api/v1/projects/${projectId}/reviews/${selected.id}/start`, {
      method: "POST",
      headers: { "X-Idempotency-Key": `web-review-start-${Date.now()}` },
      body: JSON.stringify({ rationale: "Review scope and independent participants are ready." }),
    }), `Review round ${selected.current_round + 1} started`);
  };

  const addComment = async () => {
    if (!selected) return;
    const body = window.prompt("Review comment");
    if (!body?.trim()) return;
    const blocking = window.confirm("Should this comment block approval until it is resolved?");
    await runCommand(() => apiRequestAs(`/api/v1/projects/${projectId}/reviews/${selected.id}/comments`, config.reviewerToken, {
      method: "POST",
      headers: { "X-Idempotency-Key": `web-review-comment-${Date.now()}` },
      body: JSON.stringify({ body: body.trim(), blocking }),
    }), blocking ? "Blocking review comment recorded" : "Review comment recorded");
  };

  const resolveComment = async (comment: ReviewComment) => {
    if (!selected) return;
    const resolution = window.prompt("Resolution evidence", "Addressed in the controlled baseline scope.");
    if (!resolution?.trim()) return;
    await runCommand(() => apiRequest(`/api/v1/projects/${projectId}/reviews/${selected.id}/comments/${comment.id}/resolve`, {
      method: "POST",
      headers: { "X-Idempotency-Key": `web-review-resolution-${Date.now()}` },
      body: JSON.stringify({ resolution: resolution.trim() }),
    }), "Comment resolution recorded as append-only evidence");
  };

  const decide = async (decision: "approved" | "changes_requested") => {
    if (!selected) return;
    const comment = window.prompt(
      decision === "approved" ? "Approval note (optional)" : "Required change rationale",
      decision === "approved" ? "Reviewed against the bound baseline." : "Changes required before approval.",
    );
    if (comment === null || (decision === "changes_requested" && !comment.trim())) return;
    await runCommand(() => apiRequestAs(`/api/v1/projects/${projectId}/reviews/${selected.id}/decisions`, config.reviewerToken, {
      method: "POST",
      headers: { "X-Idempotency-Key": `web-review-decision-${Date.now()}` },
      body: JSON.stringify({ decision, comment: comment.trim() }),
    }), decision === "approved" ? "Signed approval evidence recorded" : "Signed changes-requested decision recorded");
  };

  return (
    <section className="reviews-live-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">Controlled decisions • Immutable baseline scope</div>
          <h1>Review room</h1>
          <p>Assign independent reviewers, resolve structured feedback, and sign decisions against exact baseline evidence.</p>
        </div>
        <div className="page-actions">
          <button className="secondary-button" onClick={() => void loadWorkspace()} disabled={busy} aria-label="Refresh reviews"><RefreshCw size={15} /> Refresh</button>
          <button className="primary-button" onClick={() => void createReview()} disabled={busy || baselines.length === 0}><Plus size={16} /> Create review package</button>
        </div>
      </header>

      <div className={`workspace-mode ${mode === "live" ? "live" : mode}`} role="status" aria-live="polite">
        {mode === "loading" && <><RefreshCw size={14} /> Connecting to controlled reviews…</>}
        {mode === "live" && <><CheckCircle2 size={14} /> Live review evidence • {reviews.length} packages • {baselines.length} signed baselines</>}
        {mode === "offline" && <><AlertTriangle size={14} /> API unavailable — start the service to manage review evidence</>}
      </div>
      {error && <div className="workspace-error" role="alert">{error}</div>}

      <div className="review-live-grid">
        <aside className="panel review-package-list" aria-label="Review packages">
          <div className="panel-heading compact"><div><span className="panel-kicker">Controlled packages</span><h2>Review history</h2></div><ClipboardCheck size={17} /></div>
          {reviews.map((review) => (
            <button key={review.id} className={`review-package-card ${selected?.id === review.id ? "selected" : ""}`} onClick={() => setSelectedId(review.id)}>
              <span className={`review-state-dot ${review.status}`} />
              <span><code>RV-{String(review.sequence).padStart(3, "0")}</code><strong>{review.title}</strong><small>BL-{String(review.baseline_sequence).padStart(3, "0")} • round {review.current_round}</small></span>
              <span className={`status-pill ${review.status.replaceAll("_", "-")}`}>{statusLabel(review.status)}</span>
            </button>
          ))}
          {reviews.length === 0 && <div className="empty-requirements">No review packages yet. Freeze a baseline, then create the first controlled package.</div>}
        </aside>

        <div className="review-live-content">
          {selected ? <>
            <section className="panel review-main">
              <div className="review-title-row">
                <div><span className={`status-pill ${selected.status.replaceAll("_", "-")}`}>{statusLabel(selected.status)}</span><h2>{selected.title}</h2><p>{selected.description || "No package description."}</p></div>
                <div className="due-card"><span>Bound scope</span><strong>BL-{String(selected.baseline_sequence).padStart(3, "0")}</strong><small>{baseline?.manifest_hash.slice(0, 10) || selected.baseline_id.slice(0, 10)}…</small></div>
              </div>
              <div className="review-stat-row">
                <div><strong>{selected.approval_count}<span>/{selected.required_approvals}</span></strong><small>Required approvals</small></div>
                <div><strong>{selected.artifact_count}</strong><small>Exact revisions</small></div>
                <div><strong>{selected.open_comment_count}</strong><small>Open comments</small></div>
                <div><strong>{selected.blocking_comment_count}</strong><small>Blocking approval</small></div>
              </div>
              <div className="large-progress" aria-label={`${completion}% of required approvals recorded`}><span style={{ width: `${completion}%` }} /></div>
              <div className="review-command-row">
                {selected.status === "draft" && <button className="secondary-button" onClick={() => void assignReviewer()} disabled={busy}><UserPlus size={15} /> Assign reviewer</button>}
                {(selected.status === "draft" || selected.status === "changes_requested") && <button className="primary-button" onClick={() => void startReview()} disabled={busy}><Play size={15} /> Start round</button>}
                {selected.status === "in_review" && <button className="secondary-button" onClick={() => void addComment()} disabled={busy}><MessageSquareText size={15} /> Add reviewer comment</button>}
              </div>
              <div className="participant-header"><span>Participant</span><span>Role</span><span>Decision</span></div>
              {selected.participants.map((participant) => (
                <div className="participant-row" key={participant.id}>
                  <span className="person"><i>{initials(participant.subject)}</i><strong>{participant.subject}</strong></span>
                  <span>{participant.role_label}{participant.required ? " • required" : ""}</span>
                  <span className={`status-pill ${participant.current_decision?.replaceAll("_", "-") || "pending"}`}>{participant.current_decision ? statusLabel(participant.current_decision) : "PENDING"}</span>
                </div>
              ))}
              {selected.participants.length === 0 && <div className="review-empty-row">Assign at least {selected.required_approvals} independent reviewer before starting.</div>}
            </section>

            <aside className="panel approval-panel review-decision-panel">
              <div className="approval-icon"><ShieldCheck size={28} /></div>
              <span className="panel-kicker">Independent decision</span>
              <h2>{selected.status === "approved" ? "Approval complete" : selected.status === "in_review" ? "Record signed evidence" : "Awaiting active round"}</h2>
              <p>Decisions use the configured reviewer identity and are signed against this package, round, and immutable baseline.</p>
              <div className="commit-bound"><GitBranch size={16} /><span>Bound baseline<code>BL-{String(selected.baseline_sequence).padStart(3, "0")}</code></span><LockKeyhole size={14} /></div>
              {selected.status === "in_review" && <>
                <button className="primary-button full-width" onClick={() => void decide("approved")} disabled={busy}><CheckCircle2 size={16} /> Record approval</button>
                <button className="secondary-button full-width" onClick={() => void decide("changes_requested")} disabled={busy}>Request changes</button>
              </>}
              {selected.status === "approved" && <div className="approval-success"><BadgeCheck size={20} /> Policy threshold satisfied</div>}
              <small className="review-policy-note">Reviewer: {config.reviewerSubject} • package and baseline authors are policy-blocked.</small>
            </aside>

            <section className="panel comment-panel review-comments-live">
              <div className="panel-heading compact"><div><span className="panel-kicker">Append-only discussion</span><h2>Review comments</h2></div><span className="review-count-chip">{selected.comments.length} total</span></div>
              {selected.comments.map((comment) => (
                <article className={`comment ${comment.blocking ? "blocking" : ""}`} key={comment.id}>
                  <span className="comment-avatar">{initials(comment.created_by)}</span>
                  <div><div className="comment-meta"><strong>{comment.created_by}</strong>{comment.target_key && <code>{comment.target_key}</code>}<span>{new Date(comment.created_at).toLocaleString()}</span></div><p>{comment.body}</p><div className="comment-evidence-row">{comment.blocking && <span className="blocking-chip"><AlertTriangle size={12} /> Blocks approval</span>}{comment.resolved ? <span className="resolved-chip"><CheckCircle2 size={12} /> Resolved: {comment.resolution}</span> : <span>Open evidence item</span>}</div></div>
                  {!comment.resolved && <button className="secondary-button compact-button" onClick={() => void resolveComment(comment)} disabled={busy}>Resolve</button>}
                </article>
              ))}
              {selected.comments.length === 0 && <div className="review-empty-row">No review comments have been recorded for this baseline scope.</div>}
            </section>

            <section className="panel decision-ledger">
              <div className="panel-heading compact"><div><span className="panel-kicker">Cryptographic evidence</span><h2>Decision ledger</h2></div><LockKeyhole size={17} /></div>
              {selected.decisions.map((decision) => <div className="decision-row" key={decision.id}><span className={`decision-seal ${decision.signature_valid ? "valid" : "invalid"}`}>{decision.signature_valid ? <BadgeCheck size={16} /> : <AlertTriangle size={16} />}</span><span><strong>{decision.subject} • {statusLabel(decision.decision)}</strong><small>Round {decision.round} • {new Date(decision.decided_at).toLocaleString()}</small></span><code>{decision.evidence_hash.slice(0, 12)}…</code><span className={`status-pill ${decision.signature_valid ? "approved" : "blocked"}`}>{decision.signature_valid ? "SIGNATURE VALID" : "INVALID"}</span></div>)}
              {selected.decisions.length === 0 && <div className="review-empty-row">No signed decisions have been recorded.</div>}
            </section>
          </> : <section className="panel review-no-selection"><ClipboardCheck size={30} /><h2>Select a review package</h2><p>Package scope, participants, discussion, and signed decisions will appear here.</p></section>}
        </div>
      </div>
    </section>
  );
}
