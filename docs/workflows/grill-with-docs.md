# Grill-with-docs delivery workflow

This workflow turns a confirmed design into reviewable delivery without losing
the distinction between product truth, execution state, and implementation
evidence. The target application's plan and storyboard own the product story;
Vibe JIRA owns execution tracking; GitHub owns branches, commits, and pull
requests.

The first pilot was Vibe Knowledge story `KNW-01`. It completed on 2026-10-17
after the clean Docker Compose gate passed and its implementation change was
reviewed and merged.

## Sources of truth

| Concern                               | Owner                                                                         | Rule                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Product scope and release claim       | Target application's `IMPLEMENTATION_PLAN.md` and `DEVELOPMENT_STORYBOARD.md` | A tracker or pull request cannot silently broaden scope or close a release gate.           |
| Resolved delivery language            | Root `GLOSSARY.md`                                                            | Use canonical terms in storyboards, issues, branches, and pull requests.                   |
| Consequential architecture            | Target application's `docs/decisions/`                                        | Add an ADR only for a hard-to-reverse, surprising decision made between real alternatives. |
| Work state, ownership, and blockers   | Vibe JIRA                                                                     | The issue state must describe the work that is actually active.                            |
| Proposed repository change and review | GitHub branch and pull request                                                | A pull request contains one focused, reviewable change and its verification.               |

`KNW-01` is a canonical story ID. Vibe JIRA generates unpadded tracker keys, so
the pilot uses `KNW-1`, `KNW-2`, and so on. Keep `KNW-01` in each summary,
description, and label; never rewrite the storyboard to match a generated key.

## Workflow

### 1. Ground the conversation

Before asking design questions or changing state:

1. Read the target application's storyboard, the relevant implementation-plan
   section, and its README.
2. Inspect the affected implementation, contracts, migrations, and tests.
3. Find environmental facts directly. Do not ask the user to rediscover facts
   available in the repository or tools.
4. Surface conflicts between the proposal, glossary, code, and recorded
   evidence.

### 2. Grill the design tree

Model the decision as a tree. In each round, ask the entire current design
frontier: every question whose prerequisites are already settled. Number the
questions, recommend an answer, and word each one so that "yes" accepts the
recommendation.

The user owns decisions; the agent owns fact-finding. Recompute the frontier
after every round. Do not create issues, branches, or implementation changes
until the frontier is empty and the user confirms the shared understanding.

### 3. Capture the story contract

Record the confirmed outcome, acceptance criteria, permission rules, affected
content or data states, non-goals, and required evidence in the target
storyboard or a linked specification. Update the glossary immediately when a
domain term is resolved. Do not create an ADR for a routine or reversible
workflow choice.

No story may claim more than the evidence demonstrates. A failed gate remains
open with its exact failure mode recorded.

### 4. Decompose into Vibe JIRA issues

Create one epic that mirrors the canonical story and child issues that can be
implemented or verified independently. Prefer user-visible vertical slices or
discrete evidence gates over component-only tasks.

Every child issue contains:

- canonical story ID and observable outcome;
- acceptance criteria and explicit non-goals;
- permission, tenancy, workflow, or revision rules when relevant;
- source-of-truth paths;
- required automated and manual evidence;
- named blocker or dependency;
- GitHub branch and pull-request links once they exist.

Use the canonical story ID as a normalized lowercase label (`knw-01`) and as a
summary prefix (`[KNW-01]`). Let Vibe JIRA generate the tracker key.

### 5. Start one issue on one branch

Create a branch only when work begins. Use:

```text
<type>/<tracker-key-lowercase>-<short-slug>
```

Allowed types are `docs`, `feat`, `fix`, `test`, and `ops`. Branch from current
`main`, keep unrelated workspace changes out, and do not create empty holding
branches. For the documentation pilot the branch is
`docs/knw-2-grill-with-docs`.

Move the Vibe JIRA issue to **In Progress** when the branch has real work. Keep
one primary product story active unless the storyboard explicitly permits an
engineering enabler in parallel.

### 6. Implement and verify

Implement the smallest complete slice using established architecture. Preserve
runtime validation, authorization, tenant scope, optimistic concurrency,
idempotency, audit, history, and outbox behavior on existing mutation paths.

Run the smallest relevant check while iterating and the broader gate
proportionate to risk. Record commands and results. UI work also requires
desktop and responsive inspection plus keyboard exercise. Never convert a
missing, skipped, or network-blocked check into a passing claim.

### 7. Open and review the pull request

Open a focused pull request whose title begins with the conventional change
type. Its body links the canonical story and Vibe JIRA issue and contains:

- outcome and scope;
- acceptance checklist;
- verification performed;
- permission, migration, and recovery notes when applicable;
- remaining risks or blocked gates;
- documentation and decision updates.

Use a draft pull request while acceptance work is incomplete. Move the Vibe
JIRA issue to **Review** only when the change is ready for human review. Do not
merge or mark the issue done merely because a pull request exists.

### 8. Reconcile completion

After review and merge, update Vibe JIRA and the target storyboard from the same
evidence set. Mark an issue **Done** only when its acceptance evidence exists.
Mark the canonical story done only when every required child and release gate is
closed. Preserve historical issue, branch, pull-request, and evidence links.

## Status mapping

| Vibe JIRA status | Meaning in this workflow                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Backlog          | Captured but not yet refined or scheduled.                                                                  |
| Selected         | Confirmed story contract; ready to start, or waiting on a named external prerequisite.                      |
| In Progress      | Active work exists on a named branch.                                                                       |
| Review           | A non-draft pull request is ready and required checks are available.                                        |
| Done             | Acceptance evidence is complete and the change is merged, or a documented no-code verification is complete. |

When Vibe JIRA has no dedicated blocked state, retain the truthful lifecycle
state, add the `blocked` label, and name the dependency in the description.

## KNW-01 pilot

Project: **Vibe Knowledge (`KNW`)**  
Epic: **`KNW-1` — `[KNW-01] Draft, publish, compare, and restore first slice`**

Workflow change: [`docs/knw-2-grill-with-docs`](https://github.com/TJ-Engineer/ProjectWeave-Studio/tree/docs/knw-2-grill-with-docs) · [superseded pull request #1](https://github.com/TJ-Engineer/ProjectWeave-Studio/pull/1)

Final gate: [`ops/knw-8-compose-gate`](https://github.com/TJ-Engineer/ProjectWeave-Studio/tree/ops/knw-8-compose-gate) · [merged pull request #2](https://github.com/TJ-Engineer/ProjectWeave-Studio/pull/2)

| Key     | Pilot issue                                              | Completion evidence                                                               |
| ------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `KNW-2` | Record the confirmed grill-with-docs delivery contract   | Done; exact documentation is on `main`; redundant pull request #1 was superseded. |
| `KNW-3` | Prove development auth and scoped publication access     | Done from recorded PostgreSQL and browser evidence.                               |
| `KNW-4` | Prove validated draft autosave and stale-write safety    | Done from recorded unit, integration, build, and browser evidence.                |
| `KNW-5` | Prove atomic immutable publication and conflict handling | Done from recorded unit and PostgreSQL evidence.                                  |
| `KNW-6` | Prove revision comparison and restore-as-new             | Done from the verified browser journey.                                           |
| `KNW-7` | Record PostgreSQL and browser acceptance evidence        | Done from recorded PostgreSQL, desktop, responsive, and keyboard evidence.        |
| `KNW-8` | Close the clean Compose startup gate                     | Done by reviewed and merged pull request #2 plus authenticated S3 evidence.       |

Historical implementation predates this tracking pilot, so `KNW-3` through
`KNW-7` cite storyboard evidence instead of inventing retroactive branches or
pull requests. `KNW-8` closed the only remaining product gate with a successful
clean Compose startup, review evidence, and a merged change.

## M1 application

The workflow was applied prospectively to M1 on 2026-10-18. The design frontier
closed after decisions Q1–Q38 and the user confirmed the shared understanding
before any M1 issue or branch was created.

Epic: **`KNW-9` — `[M1] Spaces and authoring`**

Contract issue: **`KNW-10` — `[M1] Record the confirmed spaces-and-authoring contract`**

First branch: **`docs/knw-10-m1-contract`**

Contract merge: **[GitHub pull request #4](https://github.com/TJ-Engineer/ProjectWeave-Studio/pull/4)**

| Canonical story | Story issue | Execution issues          | Dependency                       |
| --------------- | ----------- | ------------------------- | -------------------------------- |
| `SPC-01`        | `KNW-11`    | `KNW-14` through `KNW-17` | `KNW-10` merged                  |
| `PGE-01`        | `KNW-12`    | `KNW-18` through `KNW-21` | `SPC-01` complete and reconciled |
| `EDT-01`        | `KNW-13`    | `KNW-22` through `KNW-25` | `PGE-01` complete and reconciled |

The confirmed product contract lives in
[`vibe-confluence/docs/m1-spaces-and-authoring-contract.md`](../../vibe-confluence/docs/m1-spaces-and-authoring-contract.md).
The M1 issues were created in To Do. `KNW-10` moved to In Progress only after
the documentation branch contained real work, to Review after the non-draft
pull request and required checks were available, and to Done after PR #4
merged. `KNW-14` followed the same sequence and is Done after
[GitHub PR #5](https://github.com/TJ-Engineer/ProjectWeave-Studio/pull/5)
merged as `6cb7a1c`. `KNW-15` is Done after
[GitHub PR #6](https://github.com/TJ-Engineer/ProjectWeave-Studio/pull/6)
merged as `003be52`. `KNW-16` completed after
[GitHub PR #7](https://github.com/TJ-Engineer/ProjectWeave-Studio/pull/7) merged
as `99889ec`. `KNW-11` remains Selected and `KNW-17` is the sole active
execution issue on `test/knw-17-adversarial-access-evidence`. No story or
release completion is inferred until that evidence gate is reconciled.

## Pull-request checklist

- [ ] Vibe JIRA issue and canonical story are linked.
- [ ] Scope matches the confirmed story contract and non-goals.
- [ ] Runtime validation, authorization, and data-integrity paths are covered.
- [ ] Relevant focused and broader checks are recorded accurately.
- [ ] UI evidence includes desktop, responsive, and keyboard behavior when relevant.
- [ ] Glossary, ADR, API, operator, user, and storyboard documentation are updated when required.
- [ ] Remaining risks and blocked gates are explicit.
