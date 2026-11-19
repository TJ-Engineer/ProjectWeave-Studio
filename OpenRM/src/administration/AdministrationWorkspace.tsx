/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- Effects synchronize administration API state. */
import { useEffect, useState } from "react";
import { CheckCircle2, FolderKanban, Plus, RefreshCw, Save, UserPlus, Users } from "lucide-react";

import type { components } from "../api/generated";
import { apiRequest } from "../api/runtime";

type Project = components["schemas"]["Project"];
type UserProfile = components["schemas"]["UserProfile"];
type Role = "administrator" | "author" | "reviewer" | "viewer";

type Props = {
  projects: Project[];
  activeProjectId: string;
  notify: (message: string) => void;
  onProjectCreated: (project: Project) => void;
};

const ROLES: Role[] = ["administrator", "author", "reviewer", "viewer"];

export function AdministrationWorkspace({ projects, activeProjectId, notify, onProjectCreated }: Props) {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [mode, setMode] = useState<"loading" | "live" | "offline">("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadAdministration = async () => {
    setError("");
    try {
      const currentProfile = await apiRequest<UserProfile>("/api/v1/profile");
      const userResponse = await apiRequest<{ items: UserProfile[] }>("/api/v1/users");
      setUsers(userResponse.items);
      setProfile(currentProfile);
      setMode("live");
    } catch (requestError) {
      setMode("offline");
      setError(requestError instanceof Error ? requestError.message : "Could not load administration data");
    }
  };

  useEffect(() => {
    void loadAdministration();
  }, []);

  const runCommand = async (command: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await command();
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Administration command failed";
      setError(message);
      notify(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="administration-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">Organization administration • controlled access</div>
          <h1>Projects and people</h1>
          <p>Create independently numbered projects, invite users through Cognito, and maintain OpenRM profiles.</p>
        </div>
        <button className="secondary-button" onClick={() => void loadAdministration()} disabled={mode === "loading"}>
          <RefreshCw size={15} /> Refresh
        </button>
      </header>

      <div className={`workspace-status ${mode}`}>
        {mode === "loading" && <><RefreshCw size={14} /> Loading administration…</>}
        {mode === "live" && <><CheckCircle2 size={14} /> Live organization settings</>}
        {mode === "offline" && <><Users size={14} /> Administration unavailable</>}
      </div>
      {error && <div className="workspace-error" role="alert">{error}</div>}

      <div className="administration-grid">
        <ProjectSetup busy={busy} notify={notify} runCommand={runCommand} onProjectCreated={onProjectCreated} />
        <UserInvitation
          projects={projects}
          activeProjectId={activeProjectId}
          busy={busy}
          notify={notify}
          runCommand={runCommand}
          onInvited={loadAdministration}
        />
        <ProfileEditor profile={profile} busy={busy} notify={notify} runCommand={runCommand} onSaved={setProfile} />
      </div>

      <section className="panel administration-users">
        <div className="panel-heading compact">
          <div><span className="panel-kicker">User directory</span><h2>{users.length} OpenRM profiles</h2></div>
          <Users size={18} />
        </div>
        <div className="administration-user-head"><span>User</span><span>Organization role</span><span>Projects</span><span>Profile</span></div>
        {users.map((user) => (
          <div className="administration-user-row" key={user.id}>
            <span><strong>{user.display_name || user.email || user.subject}</strong><small>{user.email || user.subject}</small></span>
            <span className="status-pill connected">{user.organization_role}</span>
            <span>{user.project_memberships.length
              ? user.project_memberships.map((membership) => `${membership.project_key || "Project"} · ${membership.role}`).join(", ")
              : "No project membership"}</span>
            <span>{[user.title, user.department].filter(Boolean).join(" · ") || "Profile not completed"}</span>
          </div>
        ))}
        {mode === "live" && users.length === 0 && <p className="empty-requirements">No user profiles have been created yet.</p>}
      </section>
    </section>
  );
}

function ProjectSetup({ busy, notify, runCommand, onProjectCreated }: {
  busy: boolean;
  notify: (message: string) => void;
  runCommand: (command: () => Promise<void>) => Promise<void>;
  onProjectCreated: (project: Project) => void;
}) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [prefix, setPrefix] = useState("");
  const [description, setDescription] = useState("");
  return (
    <section className="panel administration-card">
      <div className="panel-heading compact"><div><span className="panel-kicker">Project setup</span><h2>Create a project</h2></div><FolderKanban size={18} /></div>
      <p>Each project has its own workspace and requirement numbering prefix.</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        void runCommand(async () => {
          const project = await apiRequest<Project>("/api/v1/projects", {
            method: "POST",
            headers: { "X-Idempotency-Key": `web-project-${Date.now()}` },
            body: JSON.stringify({ name, key, requirement_prefix: prefix, description }),
          });
          onProjectCreated(project);
          setName(""); setKey(""); setPrefix(""); setDescription("");
          notify(`${project.name} created with ${project.requirement_prefix} numbering`);
        });
      }}>
        <label>Project name<input required maxLength={160} value={name} onChange={(event) => setName(event.target.value)} placeholder="Guidance Computer" /></label>
        <div className="editor-grid">
          <label>Project key<input required pattern="[A-Z][A-Z0-9-]{1,15}" value={key} onChange={(event) => setKey(event.target.value.toUpperCase())} placeholder="GUIDANCE" /></label>
          <label>Requirement prefix<input required pattern="[A-Z][A-Z0-9]{1,7}" value={prefix} onChange={(event) => setPrefix(event.target.value.toUpperCase())} placeholder="GNC" /></label>
        </div>
        <label>Description<textarea rows={3} maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <button className="primary-button" disabled={busy}><Plus size={15} /> {busy ? "Creating…" : "Create project"}</button>
      </form>
    </section>
  );
}

function UserInvitation({ projects, activeProjectId, busy, notify, runCommand, onInvited }: {
  projects: Project[];
  activeProjectId: string;
  busy: boolean;
  notify: (message: string) => void;
  runCommand: (command: () => Promise<void>) => Promise<void>;
  onInvited: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [title, setTitle] = useState("");
  const [department, setDepartment] = useState("");
  const [organizationRole, setOrganizationRole] = useState<Role>("author");
  const [projectId, setProjectId] = useState(activeProjectId);
  const [projectRole, setProjectRole] = useState<Role>("author");

  useEffect(() => {
    if (!projects.some((project) => project.id === projectId)) setProjectId(activeProjectId || projects[0]?.id || "");
  }, [activeProjectId, projects]);

  return (
    <section className="panel administration-card">
      <div className="panel-heading compact"><div><span className="panel-kicker">Identity and access</span><h2>Invite a user</h2></div><UserPlus size={18} /></div>
      <p>Cognito emails a temporary sign-in invitation. OpenRM stores only profile and authorization data.</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        void runCommand(async () => {
          await apiRequest<UserProfile>("/api/v1/users", {
            method: "POST",
            body: JSON.stringify({
              email,
              display_name: displayName || null,
              title: title || null,
              department: department || null,
              organization_role: organizationRole,
              project_memberships: projectId ? [{ project_id: projectId, role: projectRole }] : [],
            }),
          });
          setEmail(""); setDisplayName(""); setTitle(""); setDepartment("");
          notify(`Invitation sent to ${email}`);
          await onInvited();
        });
      }}>
        <label>Email<input required type="email" maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Display name<input maxLength={160} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <div className="editor-grid">
          <label>Title<input maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>Department<input maxLength={160} value={department} onChange={(event) => setDepartment(event.target.value)} /></label>
        </div>
        <label>Organization role<select value={organizationRole} onChange={(event) => setOrganizationRole(event.target.value as Role)}>{ROLES.map((role) => <option key={role}>{role}</option>)}</select></label>
        <div className="editor-grid">
          <label>Initial project<select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">No project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.key} — {project.name}</option>)}</select></label>
          <label>Project role<select value={projectRole} onChange={(event) => setProjectRole(event.target.value as Role)}>{ROLES.map((role) => <option key={role}>{role}</option>)}</select></label>
        </div>
        <button className="primary-button" disabled={busy}><UserPlus size={15} /> {busy ? "Sending…" : "Send invitation"}</button>
      </form>
    </section>
  );
}

function ProfileEditor({ profile, busy, notify, runCommand, onSaved }: {
  profile: UserProfile | null;
  busy: boolean;
  notify: (message: string) => void;
  runCommand: (command: () => Promise<void>) => Promise<void>;
  onSaved: (profile: UserProfile) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [title, setTitle] = useState("");
  const [department, setDepartment] = useState("");
  const [bio, setBio] = useState("");
  useEffect(() => {
    setDisplayName(profile?.display_name || "");
    setTitle(profile?.title || "");
    setDepartment(profile?.department || "");
    setBio(profile?.bio || "");
  }, [profile?.id, profile?.updated_at]);
  return (
    <section className="panel administration-card profile-card">
      <div className="panel-heading compact"><div><span className="panel-kicker">My profile</span><h2>Personal details</h2></div><Save size={18} /></div>
      <p>{profile?.email || "Your authenticated OpenRM identity"}</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        void runCommand(async () => {
          const updated = await apiRequest<UserProfile>("/api/v1/profile", {
            method: "PUT",
            body: JSON.stringify({ display_name: displayName, title, department, bio }),
          });
          onSaved(updated);
          notify("Profile updated");
        });
      }}>
        <label>Display name<input maxLength={160} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <div className="editor-grid">
          <label>Title<input maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>Department<input maxLength={160} value={department} onChange={(event) => setDepartment(event.target.value)} /></label>
        </div>
        <label>About<textarea rows={3} maxLength={2000} value={bio} onChange={(event) => setBio(event.target.value)} /></label>
        <button className="secondary-button" disabled={busy || !profile}><Save size={15} /> Save profile</button>
      </form>
    </section>
  );
}
