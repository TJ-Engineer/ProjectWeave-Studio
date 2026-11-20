# Release 1 candidate and production launch checklist

- Release-candidate status: `APPROVED` — 2026-10-13
- Production activation status: `NOT APPROVED` — deployment-owned inputs remain below
- Release owner: TJ The Test Director
- Release tag: `v0.1.0` at `9d04490227bd405b37332fdadd58938276a44df3`
- Release image: `ghcr.io/tj-engineer/vibe-jira@sha256:90a72b2133389f5e5927ccf93f87ac393946909c21bb24548c465c75dad9dc55`
- CI evidence: [tag workflow attempt 2](https://github.com/TJ-Engineer/ProjectWeave-Studio/actions/runs/38491265813/attempts/2)

The checked candidate gates close the M5 engineering milestone. Unchecked production-activation gates still prohibit routing production traffic to the release.

## Build and automated gates

- [x] `npm ci`, `npm run check`, and `npm audit --audit-level=high` pass in the tagged workflow.
- [x] Clean-schema and previous-boundary PostgreSQL migration jobs pass; no applied migration changed checksum.
- [x] All 23 PostgreSQL integration tests pass without skips.
- [x] The 70-case Chromium, Firefox, and WebKit browser matrix passes, including permission and Axe gates; the two raw-touch cases skip by design outside Chromium.
- [x] The supported Release 1 envelope passes locally with recorded p95 values of 30.7/52.3/17.5/18.1 ms for board/search/CSV/realtime. Repeat on the selected production hardware if its capacity differs materially.
- [x] The production image passes Trivy with zero high/critical findings and is published with semantic-version, full-revision, OCI provenance, and immutable digest references.

## Deployment and operations

- [ ] Production secrets, HTTPS origin, trusted-proxy behavior, OIDC claims/redirect, object storage, malware scanner, and metrics protection are verified.
- [x] Clean Compose startup reaches healthy state and the documented smoke journey passes in the release-candidate environment.
- [x] SIGTERM stops web and workers without forced kill or OOM; workers finish their active batch.
- [x] The backup/recovery drill passes against release-candidate data, including counts, readiness, and retrieval of every active clean attachment.
- [x] Upgrade from the previous release boundary and the documented restore/forward-repair path are exercised.
- [ ] Dashboards/alerts cover readiness, database pool, outbox age/dead letters, jobs, error rate, latency, disk, and backup freshness.

## Product acceptance

- [x] All twelve acceptance gates in `DEVELOPMENT_STORYBOARD.md` are `DONE` with evidence.
- [x] Keyboard, 320 CSS-pixel reflow, text-spacing, target-size, reduced-motion, forced-colors, and cross-browser Axe evidence is recorded in `accessibility-evidence-2026-10-12.md`.
- [x] Human VoiceOver/Safari and final visual contrast-state sign-off is recorded in the worksheet in `accessibility.md`.
- [ ] Admin and member onboarding, support escalation, data retention, and invitation delivery owners are named.
- [x] The release owner approves `release-notes-0.1.0.md` for the release candidate and accepts its migrations, configuration changes, rollback posture, and residual risks.
- [ ] The production owner fills the observation owner/window, approves the deployment-specific settings, and records the production exit decision.

- Release-candidate sign-off: TJ The Test Director — 2026-10-13
- Production activation sign-off: `PENDING`

A prepared but unexecuted checkbox is not release evidence. The release candidate is complete; the unchecked deployment-specific items remain mandatory before production activation.
