import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity, Archive, ArrowRight, BookOpen, Boxes, Check, CheckCircle2, ChevronDown,
  ChevronRight, CircleDot, Cloud, Code2, Database, FileCheck2, FileClock, FileText,
  GitBranch, GitCommitHorizontal, Link2, LockKeyhole, LogOut, Menu, MoreHorizontal, PackageCheck,
  RefreshCw, Search, ServerCog, ShieldCheck, TestTube2, Trash2, Users, X, Zap,
} from "lucide-react";
import "./styles.css";
import { AdministrationWorkspace } from "./administration/AdministrationWorkspace";
import { BaselinesWorkspace } from "./baselines/BaselinesWorkspace";
import { HelpWorkspace } from "./help/HelpWorkspace";
import { IntegrationWorkspace } from "./integrations/IntegrationWorkspace";
import { RequirementsWorkspace } from "./requirements/RequirementsWorkspace";
import { ReviewsWorkspace } from "./reviews/ReviewsWorkspace";
import { TraceabilityWorkspace } from "./traceability/TraceabilityWorkspace";
import { VerificationWorkspace } from "./verification/VerificationWorkspace";
import {
  beginSignIn,
  initializeAuthentication,
  selectDevelopmentProfile,
  signOut,
  type AuthenticatedUser,
  type DevelopmentProfileRole,
} from "./api/auth";
import { loadRuntimeConfiguration, runtimeConfiguration } from "./api/config";
import { apiRequest, apiRequestAs } from "./api/runtime";
import type { components } from "./api/generated";

type Project = components["schemas"]["Project"];
type StorageObject = components["schemas"]["StorageObject"];
type StorageObjectListResponse = components["schemas"]["StorageObjectListResponse"];
type UserProfile = components["schemas"]["UserProfile"];
type PageHeaderProps = { eyebrow: React.ReactNode; title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode };

const NAV_ITEMS = [
  { id: "requirements", label: "Requirements", icon: FileText, count: "Live" },
  { id: "traceability", label: "Traceability", icon: Link2, count: "Live" },
  { id: "baselines", label: "Baselines", icon: GitBranch },
  { id: "reviews", label: "Reviews", icon: CheckCircle2, count: "Live" },
  { id: "verification", label: "Verification", icon: TestTube2 },
];

const PLATFORM_ITEMS = [
  { id: "administration", label: "Administration", icon: Users, count: "Live" },
  { id: "help", label: "Help", icon: BookOpen },
  { id: "storage", label: "Object storage", icon: Cloud },
  { id: "integrations", label: "Integrations", icon: Zap, count: "1" },
  { id: "architecture", label: "Architecture", icon: Boxes },
];

function App({ user }: { user: AuthenticatedUser }) {
  const configuration = runtimeConfiguration();
  const [page, setPage] = useState("requirements");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState("");
  const fallbackProject: Project = {
    id: configuration.projectId,
    key: configuration.projectKey,
    name: configuration.projectName,
    requirement_prefix: configuration.projectKey === "OPENRM" ? "ORM" : configuration.projectKey.replaceAll("-", "").slice(0, 8),
    next_requirement_number: 1,
    description: "Configured OpenRM workspace",
    created_at: "2026-11-01T12:00:00Z",
  };
  const storageKey = `openrm.activeProject.${configuration.organizationId}`;
  const [projects, setProjects] = useState<Project[]>([fallbackProject]);
  const [activeProjectId, setActiveProjectId] = useState(() => localStorage.getItem(storageKey) || configuration.projectId);
  const activeProject = projects.find((project) => project.id === activeProjectId) || projects[0] || fallbackProject;

  useEffect(() => {
    void apiRequest<{ items: Project[] }>("/api/v1/projects")
      .then((response) => {
        if (response.items.length === 0) return;
        setProjects(response.items);
        setActiveProjectId((current) => response.items.some((project) => project.id === current) ? current : response.items[0].id);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => localStorage.setItem(storageKey, activeProject.id), [activeProject.id, storageKey]);

  const currentLabel = useMemo(
    () => [...NAV_ITEMS, ...PLATFORM_ITEMS].find((item) => item.id === page)?.label || "Requirements",
    [page],
  );
  const navigate = (target: string) => {
    setPage(target);
    setSidebarOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };

  return (
    <div className="app-shell">
      <Sidebar page={page} open={sidebarOpen} onClose={() => setSidebarOpen(false)} onNavigate={navigate} projectKey={activeProject.key} projectName={activeProject.name} />
      <main className="main-shell">
        <header className="topbar">
          <button className="mobile-menu icon-button" onClick={() => setSidebarOpen(true)} aria-label="Open menu"><Menu size={19} /></button>
          <div className="breadcrumb"><span>{activeProject.name}</span><ChevronRight size={14} /><strong>{currentLabel}</strong></div>
          <div className="topbar-actions">
            <span className="live-data-chip"><CircleDot size={12} /> {page === "help" ? "Product guide" : "Live controlled data"}</span>
            <label className="project-switcher">
              <span className="sr-only">Active project</span>
              <select value={activeProject.id} onChange={(event) => setActiveProjectId(event.target.value)}>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.key} — {project.name}</option>)}
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </label>
            <button className="help-button" onClick={() => navigate("help")} aria-current={page === "help" ? "page" : undefined}><BookOpen size={15} /> Help</button>
            <ProfileMenu user={user} onManageProfiles={() => navigate("administration")} />
          </div>
        </header>
        <section className="page-stage" key={page}>
          {page === "requirements" && <RequirementsWorkspace notify={notify} projectId={activeProject.id} />}
          {page === "traceability" && <TraceabilityWorkspace notify={notify} projectId={activeProject.id} />}
          {page === "baselines" && <BaselinesWorkspace notify={notify} projectId={activeProject.id} />}
          {page === "reviews" && <ReviewsWorkspace notify={notify} projectId={activeProject.id} />}
          {page === "verification" && <VerificationWorkspace notify={notify} projectId={activeProject.id} />}
          {page === "storage" && <Storage notify={notify} projectId={activeProject.id} />}
          {page === "integrations" && <IntegrationWorkspace notify={notify} projectId={activeProject.id} />}
          {page === "administration" && <AdministrationWorkspace
            projects={projects}
            activeProjectId={activeProject.id}
            notify={notify}
            onProjectCreated={(project) => {
              setProjects((current) => [...current.filter((item) => item.id !== project.id), project].sort((left, right) => left.key.localeCompare(right.key)));
              setActiveProjectId(project.id);
            }}
          />}
          {page === "architecture" && <Architecture />}
          {page === "help" && <HelpWorkspace />}
        </section>
      </main>
      {toast && <div className="toast"><CheckCircle2 size={17} /> {toast}</div>}
    </div>
  );
}

const profileInitials = (value: string) => value
  .split(/[@ ._-]+/)
  .filter(Boolean)
  .slice(0, 2)
  .map((part) => part[0]?.toUpperCase())
  .join("") || "OR";

const profileDisplayName = (profile: UserProfile) => profile.display_name
  || profile.email
  || (profile.subject === "local-user" ? "Local user" : profile.subject);

function ProfileMenu({ user, onManageProfiles }: { user: AuthenticatedUser; onManageProfiles: () => void }) {
  const configuration = runtimeConfiguration();
  const developmentMode = configuration.authMode === "development";
  const container = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadProfiles = useCallback(async () => {
    if (!developmentMode) return;
    setLoading(true);
    setError("");
    try {
      const directoryToken = configuration.developmentToken || "dev:local-user";
      await apiRequestAs<UserProfile>("/api/v1/profile", directoryToken);
      const response = await apiRequestAs<{ items: UserProfile[] }>("/api/v1/users", directoryToken);
      setProfiles(response.items);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load profiles");
    } finally {
      setLoading(false);
    }
  }, [configuration.developmentToken, developmentMode]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && developmentMode && profiles.length === 0 && !loading) void loadProfiles();
  };

  const switchProfile = (profile: UserProfile) => {
    if (profile.subject === user.subject) {
      setOpen(false);
      return;
    }
    selectDevelopmentProfile({
      subject: profile.subject,
      email: profile.email || undefined,
      displayName: profileDisplayName(profile),
      role: profile.organization_role as DevelopmentProfileRole,
    });
    window.location.reload();
  };

  const activeProfile = profiles.find((profile) => profile.subject === user.subject);

  return (
    <div className="profile-menu" ref={container}>
      <button
        className="avatar"
        aria-label={`Open profile menu for ${user.displayName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${user.displayName} · Profile menu`}
        onClick={toggle}
      >
        {profileInitials(user.displayName)}
      </button>
      {open && <div className="profile-popover panel" role="menu" aria-label="User profiles">
        <div className="profile-current">
          <span className="profile-avatar">{profileInitials(user.displayName)}</span>
          <span><strong>{user.displayName}</strong><small>{user.email || user.subject}</small></span>
        </div>
        {developmentMode && <>
          <div className="profile-menu-label"><span>Switch profile</span><small>Local development</small></div>
          <div className="profile-options">
            {profiles.map((profile) => {
              const name = profileDisplayName(profile);
              const active = profile.subject === user.subject;
              return <button
                key={profile.id}
                className={active ? "active" : ""}
                role="menuitemradio"
                aria-checked={active}
                onClick={() => switchProfile(profile)}
              >
                <span className="profile-avatar compact">{profileInitials(name)}</span>
                <span><strong>{name}</strong><small>{profile.organization_role}{profile.email ? ` · ${profile.email}` : ""}</small></span>
                {active && <Check size={15} aria-hidden="true" />}
              </button>;
            })}
            {loading && <div className="profile-menu-status"><RefreshCw size={13} className="connector-spin" /> Loading profiles…</div>}
            {!loading && !error && profiles.length === 0 && <div className="profile-menu-status">No profiles are available.</div>}
            {error && <div className="profile-menu-error" role="alert">{error}</div>}
          </div>
          <button className="profile-menu-action" role="menuitem" onClick={() => { setOpen(false); onManageProfiles(); }}><Users size={15} /> Manage profiles</button>
        </>}
        <button className="profile-menu-action sign-out" role="menuitem" onClick={() => void signOut()}>
          <LogOut size={15} /> {developmentMode ? `Reset to ${activeProfile?.subject === "local-user" ? "local user" : "default profile"}` : "Sign out"}
        </button>
      </div>}
    </div>
  );
}

type SidebarProps = { page: string; open: boolean; onClose: () => void; onNavigate: (target: string) => void; projectKey: string; projectName: string };

function Sidebar({ page, open, onClose, onNavigate, projectKey, projectName }: SidebarProps) {
  const renderItem = (item: (typeof NAV_ITEMS)[number] | (typeof PLATFORM_ITEMS)[number]) => {
    const Icon = item.icon;
    return <button key={item.id} className={`nav-item ${page === item.id ? "active" : ""}`} onClick={() => onNavigate(item.id)}><Icon size={18} strokeWidth={1.8} /><span>{item.label}</span>{item.count && <small>{item.count}</small>}</button>;
  };
  return (
    <>
      {open && <button className="sidebar-scrim" onClick={onClose} aria-label="Close menu" />}
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark"><GitBranch size={20} /></div>
          <div><div className="brand-name">Open<span>RM</span></div><div className="brand-subtitle">Controlled workspace</div></div>
          <button className="sidebar-close icon-button" onClick={onClose} aria-label="Close menu"><X size={18} /></button>
        </div>
        <div className="project-card"><div className="project-icon">{projectKey.slice(0, 2)}</div><div><strong>{projectName}</strong><span>Live controlled project</span></div><MoreHorizontal size={18} /></div>
        <nav className="sidebar-nav">
          <div className="nav-label platform-label">Workspace</div>{NAV_ITEMS.map(renderItem)}
          <div className="nav-label platform-label">Platform</div>{PLATFORM_ITEMS.map(renderItem)}
        </nav>
        <div className="sidebar-footer"><div className="health-dot" /><div><strong>OpenRM connected</strong><span>PostgreSQL + object storage</span></div><ChevronRight size={15} /></div>
      </aside>
    </>
  );
}

function PageHeader({ eyebrow, title, description, actions = null }: PageHeaderProps) {
  return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</div>;
}

function Storage({ notify, projectId }: { notify: (message: string) => void; projectId: string }) {
  const [objects, setObjects] = useState<StorageObject[]>([]);
  const [prefix, setPrefix] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState("");

  const loadObjects = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await apiRequest<StorageObjectListResponse>(`/api/v1/projects/${projectId}/storage/objects?limit=500`);
      setObjects(response.items);
      setPrefix(response.prefix);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load object storage");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Synchronizes the selected project with remote inventory.
    void loadObjects();
  }, [loadObjects]);

  const deleteObject = async (object: StorageObject) => {
    if (object.linked) return;
    if (!window.confirm(`Delete unlinked object “${object.key}”? Versioned storage may retain a recoverable prior version.`)) return;
    setDeleting(object.key);
    try {
      await apiRequest(`/api/v1/projects/${projectId}/storage/objects?key=${encodeURIComponent(object.key)}`, { method: "DELETE" });
      setObjects((current) => current.filter((candidate) => candidate.key !== object.key));
      notify(`Deleted unlinked object ${object.key}`);
    } catch (requestError) {
      notify(requestError instanceof Error ? requestError.message : "Could not delete object");
      await loadObjects();
    } finally {
      setDeleting("");
    }
  };

  const visibleObjects = objects.filter((object) => object.key.toLowerCase().includes(search.trim().toLowerCase()));
  const totalBytes = objects.reduce((total, object) => total + object.size_bytes, 0);
  const linkedObjects = objects.filter((object) => object.linked).length;

  return (
    <>
      <PageHeader eyebrow="Portable object layer • S3 API" title="S3-compatible storage" description="Review live project objects, preserve linked evidence, and remove unlinked files from the configured S3-compatible provider." actions={<button className="secondary-button" disabled={loading} onClick={() => void loadObjects()}><RefreshCw size={15} /> {loading ? "Checking…" : "Refresh objects"}</button>} />
      <div className="storage-grid">
        <section className="panel storage-status">
          <div className="storage-hero-icon"><Cloud size={27} /></div>
          <div><span className={`status-pill ${error ? "blocked" : "connected"}`}><CircleDot size={11} /> {error ? "Unavailable" : "Connected"}</span><h2>Project object inventory</h2><p>{prefix || "Waiting for the configured storage provider"}</p></div>
          <button className="icon-button" aria-label="Refresh object inventory" onClick={() => void loadObjects()}><RefreshCw size={17} /></button>
          <div className="storage-stats"><div><strong>{formatBytes(totalBytes)}</strong><span>Visible storage</span></div><div><strong>{objects.length}</strong><span>Objects</span></div><div><strong>{linkedObjects}</strong><span>Evidence linked</span></div></div>
        </section>
        <section className="panel config-panel">
          <div className="panel-heading compact"><div><span className="panel-kicker">Connection policy</span><h2>Protected deletion</h2></div><LockKeyhole size={17} /></div>
          <ConfigRow label="Scope" value="Organization + project prefix" /><ConfigRow label="Linked files" value="Deletion denied" /><ConfigRow label="Unlinked files" value="Administrator delete" /><ConfigRow label="Recovery" value="Provider versioning" /><ConfigRow label="Audit" value="Deletion event recorded" />
        </section>
      </div>
      <section className="panel object-table">
        <div className="panel-heading compact"><div><span className="panel-kicker">Live objects</span><h2>Controlled files</h2></div><div className="search-box compact"><Search size={15} /><input aria-label="Search objects" placeholder="Search objects…" value={search} onChange={(event) => setSearch(event.target.value)} /></div></div>
        <div className="object-head"><span>Object</span><span>Evidence link</span><span>Provider metadata</span><span>Size</span><span>Modified</span><span>Action</span></div>
        {error && <div className="workspace-error" role="alert">{error}</div>}
        {!error && !loading && visibleObjects.length === 0 && <div className="storage-empty">No objects match this project and search.</div>}
        {visibleObjects.map((object) => <ObjectRow key={object.key} object={object} deleting={deleting === object.key} onDelete={() => void deleteObject(object)} />)}
      </section>
    </>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return <div className="config-row"><span>{label}</span><code>{value}</code><Check size={14} /></div>;
}

function ObjectRow({ object, deleting, onDelete }: { object: StorageObject; deleting: boolean; onDelete: () => void }) {
  const Icon = object.key.endsWith(".json") ? FileClock : object.key.endsWith(".pdf") ? FileCheck2 : Archive;
  return <div className="object-row"><span className="object-name"><i><Icon size={17} /></i><span><strong>{object.key.split("/").at(-1)}</strong><small>{object.key}</small></span></span><span>{object.linked ? <span className="status-pill approved">Linked ×{object.link_count}</span> : <span className="status-pill planned">Unlinked</span>}</span><span className="integrity-ok"><ShieldCheck size={14} /> {object.etag ? `ETag ${object.etag.slice(0, 10)}…` : "Metadata available"}</span><span>{formatBytes(object.size_bytes)}</span><span>{object.last_modified ? new Date(object.last_modified).toLocaleString() : "Unknown"}</span><button className="icon-button danger-button" aria-label={`Delete ${object.key}`} title={object.linked ? "Linked evidence cannot be deleted" : "Delete unlinked object"} disabled={object.linked || deleting} onClick={onDelete}>{deleting ? <RefreshCw size={16} /> : <Trash2 size={16} />}</button></div>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) { value /= 1024; unit = units[index]; }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function Architecture() {
  return (
    <>
      <PageHeader eyebrow="Open architecture • Self-hostable by design" title="OpenRM platform architecture" description="A modular architecture focused on auditability, portability, and controlled evolution." />
      <section className="architecture-map panel">
        <div className="architecture-label">USER EXPERIENCE</div>
        <div className="architecture-layer frontend-layer"><ArchitectureBox icon={Code2} label="React + TypeScript" detail="Responsive web workspace" /><ArchitectureBox icon={Users} label="OIDC identity" detail="Cognito-backed authentication" /><ArchitectureBox icon={Activity} label="API consumers" detail="Web • SDK • integrations" /></div>
        <div className="architecture-arrow"><ArrowRight size={18} /></div>
        <div className="architecture-label">CONTROL PLANE</div>
        <div className="architecture-layer rust-layer"><ArchitectureBox icon={ServerCog} label="Rust services" detail="Axum • Tokio • SQLx" feature /><ArchitectureBox icon={Code2} label="REST API" detail="/v1 • OpenAPI 3.1 • JSON" feature /><ArchitectureBox icon={GitCommitHorizontal} label="Revision engine" detail="Immutable controlled history" feature /><ArchitectureBox icon={ShieldCheck} label="Policy & audit" detail="RBAC • attributable events" feature /><ArchitectureBox icon={PackageCheck} label="Async workers" detail="Outbox • retries • connectors" feature /></div>
        <div className="architecture-arrow"><ArrowRight size={18} /></div>
        <div className="architecture-label">VERSIONED INTEGRATION PLANE</div>
        <div className="architecture-layer integration-layer"><ArchitectureBox icon={Code2} label="Connector contracts" detail="Versioned adapter boundaries" /><ArchitectureBox icon={CheckCircle2} label="Jira connector" detail="Governed outbound delivery" /><ArchitectureBox icon={Zap} label="Delivery worker" detail="Idempotent retry and replay" /></div>
        <div className="architecture-arrow"><ArrowRight size={18} /></div>
        <div className="architecture-label">PORTABLE DATA PLANE</div>
        <div className="architecture-layer data-layer"><ArchitectureBox icon={Database} label="PostgreSQL" detail="Artifacts • revisions • graph" /><ArchitectureBox icon={Cloud} label="S3-compatible objects" detail="Attachments • evidence • exports" /><ArchitectureBox icon={Archive} label="Open interchange" detail="ReqIF • CSV • JSON" /></div>
      </section>
    </>
  );
}

function ArchitectureBox({ icon: Icon, label, detail, feature = false }: { icon: React.ComponentType<{ size?: number }>; label: string; detail: string; feature?: boolean }) {
  return <div className={`architecture-box ${feature ? "feature" : ""}`}><Icon size={22} /><span><strong>{label}</strong><small>{detail}</small></span></div>;
}

function SignInScreen({ error }: { error?: string }) {
  const [busy, setBusy] = useState(false);
  return <main className="sign-in-shell"><section className="sign-in-card"><div className="brand-mark"><GitBranch size={24} /></div><div className="eyebrow">Controlled configuration and requirements</div><h1>Sign in to OpenRM</h1><p>Use your OpenRM invitation to access an authorized project workspace.</p>{error && <div className="workspace-error" role="alert">{error}</div>}<button className="primary-button" disabled={busy} onClick={() => { setBusy(true); void beginSignIn().catch(() => setBusy(false)); }}><LockKeyhole size={16} /> {busy ? "Opening secure sign-in…" : "Continue to secure sign-in"}</button></section></main>;
}

async function bootstrapApplication() {
  const root = createRoot(document.getElementById("root")!);
  try {
    await loadRuntimeConfiguration();
    const authentication = await initializeAuthentication();
    root.render(<React.StrictMode>{authentication.authenticated ? <App user={authentication.user} /> : <SignInScreen />}</React.StrictMode>);
  } catch (error) {
    root.render(<React.StrictMode><SignInScreen error={error instanceof Error ? error.message : "OpenRM could not initialize"} /></React.StrictMode>);
  }
}

void bootstrapApplication();
