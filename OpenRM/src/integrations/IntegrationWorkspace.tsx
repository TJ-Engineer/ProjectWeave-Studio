/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- Effects synchronize remote connector evidence. */
import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Link2,
  LockKeyhole,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
} from "lucide-react";

import type { components } from "../api/generated";
import { apiRequest } from "../api/runtime";

type Connector = components["schemas"]["JiraConnector"];
type Delivery = components["schemas"]["JiraDelivery"];
type Props = { notify: (message: string) => void; projectId: string };

const statusLabel = (value: string) => value.replaceAll("_", " ").toUpperCase();

export function IntegrationWorkspace({ notify, projectId }: Props) {
  const [connector, setConnector] = useState<Connector | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [mode, setMode] = useState<"loading" | "live" | "offline">("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadWorkspace = async () => {
    setError("");
    try {
      const [connectorResponse, deliveryResponse] = await Promise.all([
        apiRequest<Connector>(`/api/v1/projects/${projectId}/connectors/jira`),
        apiRequest<{ items: Delivery[] }>(`/api/v1/projects/${projectId}/connectors/jira/deliveries`),
      ]);
      setConnector(connectorResponse);
      setDeliveries(deliveryResponse.items);
      setMode("live");
    } catch (requestError) {
      setMode("offline");
      setError(requestError instanceof Error ? requestError.message : "Could not load connector evidence");
    }
  };

  useEffect(() => {
    void loadWorkspace();
  }, [projectId]);

  const runCommand = async (command: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError("");
    try {
      await command();
      notify(success);
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      await loadWorkspace();
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Connector command failed";
      setError(message);
      notify(message);
    } finally {
      setBusy(false);
    }
  };

  const configure = async () => {
    const current = connector?.configuration;
    const connectorMode = window.prompt("Connector mode: dry_run, active, or disabled", current?.mode || "dry_run")?.trim();
    if (!connectorMode || !["dry_run", "active", "disabled"].includes(connectorMode)) return;
    const baseUrl = window.prompt("Jira base URL", current?.base_url || "https://jira.example.com")?.trim();
    if (!baseUrl) return;
    const projectKey = window.prompt("Jira project key", current?.remote_project_key || "OPENRM")?.trim();
    if (!projectKey) return;
    const secretRef = window.prompt("Secret reference (never the secret value)", current?.secret_ref || "env:JIRA_API_TOKEN")?.trim();
    if (!secretRef) return;
    await runCommand(() => apiRequest(`/api/v1/projects/${projectId}/connectors/jira`, {
      method: "PUT",
      body: JSON.stringify({
        expected_version: current?.version || 0,
        mode: connectorMode,
        base_url: baseUrl,
        remote_project_key: projectKey,
        secret_ref: secretRef,
        field_mapping: current?.field_mapping || { requirement_key: "labels", revision_reference: "comment" },
        max_attempts: current?.max_attempts || 5,
      }),
    }), `Jira connector configured in ${connectorMode} mode`);
  };

  const enqueue = async () => {
    if (!connector?.configuration || connector.configuration.mode === "disabled") {
      return notify("Configure an enabled Jira connector first");
    }
    const issueKey = window.prompt("Jira issue key", `${connector.configuration.remote_project_key}-1`)?.trim();
    if (!issueKey) return;
    const message = window.prompt("Controlled revision reference", "OpenRM baseline evidence is ready for review.")?.trim();
    if (!message) return;
    await runCommand(() => apiRequest(`/api/v1/projects/${projectId}/connectors/jira/deliveries`, {
      method: "POST",
      body: JSON.stringify({
        event_key: `web:revision:${Date.now()}`,
        operation: "comment_revision",
        external_issue_key: issueKey,
        payload: {
          body: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: message }] }],
          },
        },
      }),
    }), `Governed Jira delivery queued for ${issueKey}`);
  };

  const replay = async (delivery: Delivery) => {
    await runCommand(
      () => apiRequest(`/api/v1/projects/${projectId}/connectors/jira/deliveries/${delivery.id}/replay`, { method: "POST" }),
      `${delivery.event_key} returned to the delivery queue`,
    );
  };

  const configuration = connector?.configuration;

  return (
    <section className="connector-live-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">Governed delivery integration • Replayable evidence</div>
          <h1>Jira connector operations</h1>
          <p>Configure secret references, enqueue allowlisted writes, honor rate limits, and recover dead letters without moving controlled intent out of OpenRM.</p>
        </div>
        <div className="page-actions">
          <button className="secondary-button" onClick={() => void loadWorkspace()} disabled={busy}><RefreshCw size={15} /> Refresh</button>
          <button className="secondary-button" onClick={() => void configure()} disabled={busy}><Settings2 size={15} /> Configure</button>
          <button className="primary-button" onClick={() => void enqueue()} disabled={busy || !configuration}><Send size={15} /> Queue Jira update</button>
        </div>
      </header>

      <div className={`workspace-mode ${mode}`} role="status" aria-live="polite">
        {mode === "loading" && <><RefreshCw size={14} /> Loading connector policy and delivery evidence…</>}
        {mode === "live" && <><CheckCircle2 size={14} /> Live connector queue • {configuration?.mode || "not configured"}</>}
        {mode === "offline" && <><AlertTriangle size={14} /> Connector API unavailable</>}
      </div>
      {error && <div className="workspace-error" role="alert">{error}</div>}

      <div className="connector-live-grid">
        <section className="panel connector-live-hero">
          <div className="jira-mark" aria-hidden="true">J</div>
          <div>
            <span className="panel-kicker">Jira Software adapter</span>
            <h2>{configuration ? `${configuration.remote_project_key} • v${configuration.version}` : "Configuration required"}</h2>
            <p>{configuration ? configuration.base_url : "Create an immutable configuration event before delivery work begins."}</p>
          </div>
          <span className={`status-pill ${configuration?.mode.replaceAll("_", "-") || "planned"}`}>{statusLabel(configuration?.mode || "not configured")}</span>
          <div className="connector-governance-note"><LockKeyhole size={14} /><span><strong>{configuration?.secret_ref || "External secret reference"}</strong>Secret values are never persisted in OpenRM.</span></div>
        </section>
        <ConnectorMetric icon={Activity} value={String((connector?.pending || 0) + (connector?.retrying || 0))} label="In flight" />
        <ConnectorMetric icon={CheckCircle2} value={String(connector?.delivered || 0)} label="Delivered" />
        <ConnectorMetric icon={AlertTriangle} value={String(connector?.dead_letters || 0)} label="Dead letters" warning={(connector?.dead_letters || 0) > 0} />
      </div>

      <section className="panel connector-delivery-panel">
        <div className="panel-heading compact">
          <div><span className="panel-kicker">Idempotent delivery ledger</span><h2>Outbound evidence</h2></div>
          <span className="connector-slo"><ShieldCheck size={14} /> Retry-After + bounded backoff</span>
        </div>
        <div className="connector-delivery-head"><span>Event</span><span>Jira target</span><span>Status</span><span>Attempts</span><span>Evidence</span><span>Action</span></div>
        {deliveries.map((delivery) => <article className="connector-delivery-row" key={delivery.id}>
          <span><code>{delivery.event_key}</code><small>{delivery.operation.replaceAll("_", " ")}</small></span>
          <strong>{delivery.external_issue_key}</strong>
          <span className={`status-pill ${delivery.status.replaceAll("_", "-")}`}>{statusLabel(delivery.status)}</span>
          <strong>{delivery.attempts}</strong>
          <span><code>{delivery.payload_hash.slice(0, 12)}…</code><small>{delivery.last_error || `${delivery.attempt_history.length} attributable attempts`}</small></span>
          <span>{delivery.status === "dead_letter" ? <button className="secondary-button compact-button" onClick={() => void replay(delivery)} disabled={busy}><RotateCcw size={13} /> Replay</button> : delivery.status === "delivered" ? <CheckCircle2 className="verified-mark" size={18} /> : <RefreshCw className="connector-spin" size={16} />}</span>
        </article>)}
        {deliveries.length === 0 && <div className="empty-requirements"><Link2 size={22} /> No Jira delivery events have been queued.</div>}
      </section>
    </section>
  );
}

function ConnectorMetric({ icon: Icon, value, label, warning = false }: { icon: typeof Activity; value: string; label: string; warning?: boolean }) {
  return <div className={`mini-stat panel connector-live-metric ${warning ? "warning" : ""}`}><Icon size={18} /><strong>{value}</strong><span>{label}</span></div>;
}
