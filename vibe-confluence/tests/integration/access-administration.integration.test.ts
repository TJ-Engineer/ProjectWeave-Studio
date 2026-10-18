import { randomUUID } from "node:crypto";
import { type UserIdentity } from "@knowledge/contracts";
import {
  closePool,
  createPage,
  createSpace,
  getPageRestrictionAdministration,
  getPageWorkspace,
  getPool,
  listPages,
  listSpaceMembers,
  publishPage,
  removeSpaceMember,
  updatePageRestriction,
  upsertSpaceMember,
} from "@knowledge/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (
  testDatabaseUrl &&
  !new URL(testDatabaseUrl).pathname.slice(1).endsWith("_test")
) {
  throw new Error("Integration tests require a database name ending in _test");
}
if (testDatabaseUrl) process.env.DATABASE_URL = testDatabaseUrl;

const organizationId = randomUUID();

function identity(
  displayName: string,
  organizationRole: "ADMIN" | "MEMBER" = "MEMBER",
): UserIdentity {
  const id = randomUUID();
  return {
    id,
    organizationId,
    email: `${id}@example.test`,
    displayName,
    organizationRole,
  };
}

const organizationAdmin = identity("Organization Admin", "ADMIN");
const secondAdmin = identity("Second Admin");
const draftOwner = identity("Draft Owner");
const removableEditor = identity("Removable Editor");
const viewer = identity("Viewer");
const candidate = identity("Candidate");
const inactiveCandidate = identity("Inactive Candidate");
const identities = [
  organizationAdmin,
  secondAdmin,
  draftOwner,
  removableEditor,
  viewer,
  candidate,
  inactiveCandidate,
];

async function publishFreshPage(actor: UserIdentity, pageId: string) {
  const workspace = await getPageWorkspace(actor, pageId);
  return publishPage(
    actor,
    pageId,
    {
      title: workspace.draft.title,
      document: workspace.draft.document,
      baseRevisionId: workspace.draft.baseRevisionId,
      version: workspace.draft.version,
      summary: "Access administration fixture",
    },
    `publish-${randomUUID()}`,
    randomUUID(),
  );
}

describe.skipIf(!testDatabaseUrl)("access administration", () => {
  beforeAll(async () => {
    await getPool().query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, 'Access Administration Test', $2)`,
      [organizationId, `access-administration-${organizationId}`],
    );
    for (const user of identities) {
      await getPool().query(
        `INSERT INTO users
          (id, organization_id, email, display_name, password_hash, state)
         VALUES ($1, $2, $3, $4, 'unused', $5)`,
        [
          user.id,
          organizationId,
          user.email,
          user.displayName,
          user.id === inactiveCandidate.id ? "DEACTIVATED" : "ACTIVE",
        ],
      );
      await getPool().query(
        `INSERT INTO memberships
          (organization_id, user_id, organization_role)
         VALUES ($1, $2, $3)`,
        [organizationId, user.id, user.organizationRole],
      );
    }
  });

  afterAll(closePool);

  it("versions membership changes and preserves offboarding safeguards", async () => {
    const space = await createSpace(
      organizationAdmin,
      { key: "ACCESS", name: "Access", description: "Administration" },
      randomUUID(),
    );
    let version = 1;
    for (const [user, role] of [
      [secondAdmin, "ADMIN"],
      [draftOwner, "EDITOR"],
      [removableEditor, "EDITOR"],
      [viewer, "VIEWER"],
    ] as const) {
      const result = await upsertSpaceMember(
        organizationAdmin,
        space.key,
        user.id,
        { role, expectedMembershipVersion: version },
        randomUUID(),
      );
      version = result.membershipVersion;
    }
    expect(version).toBe(5);

    const publishedPage = await createPage(
      organizationAdmin,
      space.key,
      { title: "Published policy", parentId: null },
      randomUUID(),
    );
    await publishFreshPage(organizationAdmin, publishedPage.id);
    const restriction = await updatePageRestriction(
      organizationAdmin,
      publishedPage.id,
      {
        restricted: true,
        memberIds: [removableEditor.id, viewer.id],
        expectedVersion: 0,
      },
      randomUUID(),
    );
    expect(restriction).toMatchObject({ restricted: true, version: 1 });

    const memberPage = await listSpaceMembers(organizationAdmin, space.key, {
      kind: "members",
      query: "",
      cursor: null,
      limit: 50,
    });
    const removableBefore = memberPage.items.find(
      (item) => "userId" in item && item.userId === removableEditor.id,
    );
    expect(removableBefore).toMatchObject({ pageGrantCount: 1 });

    const removed = await removeSpaceMember(
      organizationAdmin,
      space.key,
      removableEditor.id,
      version,
      randomUUID(),
    );
    version = removed.membershipVersion;
    expect(removed).toMatchObject({ member: null, affectedPageGrantCount: 1 });
    await expect(
      getPageRestrictionAdministration(organizationAdmin, publishedPage.id),
    ).resolves.toMatchObject({
      memberIds: [viewer.id],
      version: restriction.version + 1,
    });
    await expect(listPages(removableEditor, space.key)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });

    const readded = await upsertSpaceMember(
      organizationAdmin,
      space.key,
      removableEditor.id,
      { role: "EDITOR", expectedMembershipVersion: version },
      randomUUID(),
    );
    version = readded.membershipVersion;
    expect(readded.member).toMatchObject({ pageGrantCount: 0 });
    await expect(
      updatePageRestriction(
        organizationAdmin,
        publishedPage.id,
        {
          restricted: true,
          memberIds: [removableEditor.id, viewer.id],
          expectedVersion: restriction.version,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
    await expect(listPages(removableEditor, space.key)).resolves.toMatchObject({
      pages: [],
    });

    await createPage(
      draftOwner,
      space.key,
      { title: "Private draft", parentId: null },
      randomUUID(),
    );
    await expect(
      upsertSpaceMember(
        organizationAdmin,
        space.key,
        draftOwner.id,
        { role: "VIEWER", expectedMembershipVersion: version },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "UNPUBLISHED_PAGE_OWNER", status: 409 });
    await expect(
      removeSpaceMember(
        organizationAdmin,
        space.key,
        draftOwner.id,
        version,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "UNPUBLISHED_PAGE_OWNER", status: 409 });

    const demotedAdmin = await upsertSpaceMember(
      organizationAdmin,
      space.key,
      secondAdmin.id,
      { role: "EDITOR", expectedMembershipVersion: version },
      randomUUID(),
    );
    version = demotedAdmin.membershipVersion;
    await expect(
      upsertSpaceMember(
        organizationAdmin,
        space.key,
        organizationAdmin.id,
        { role: "EDITOR", expectedMembershipVersion: version },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "LAST_SPACE_ADMIN", status: 409 });
    await expect(
      upsertSpaceMember(
        organizationAdmin,
        space.key,
        candidate.id,
        { role: "VIEWER", expectedMembershipVersion: version - 1 },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });

    await expect(
      listSpaceMembers(draftOwner, space.key, {
        kind: "members",
        query: "",
        cursor: null,
        limit: 20,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    const candidates = await listSpaceMembers(organizationAdmin, space.key, {
      kind: "candidates",
      query: "Candidate",
      cursor: null,
      limit: 1,
    });
    expect(candidates.items).toEqual([
      {
        userId: candidate.id,
        displayName: candidate.displayName,
        email: candidate.email,
      },
    ]);
    expect(candidates.nextCursor).toBeNull();
  });

  it("versions page allowlists and keeps disabled policy history", async () => {
    const spaces = await getPool().query<{ space_key: string }>(
      `SELECT space_key FROM spaces
        WHERE organization_id = $1 AND space_key = 'ACCESS'`,
      [organizationId],
    );
    const spaceKey = spaces.rows[0]!.space_key;
    const pages = await listPages(organizationAdmin, spaceKey);
    const page = pages.pages.find((candidatePage) =>
      candidatePage.currentRevisionId ? true : false,
    )!;
    const current = await getPageRestrictionAdministration(
      organizationAdmin,
      page.id,
    );
    await expect(
      updatePageRestriction(
        organizationAdmin,
        page.id,
        {
          restricted: true,
          memberIds: [viewer.id],
          expectedVersion: current.version - 1,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });

    const disabled = await updatePageRestriction(
      organizationAdmin,
      page.id,
      {
        restricted: false,
        memberIds: [],
        expectedVersion: current.version,
      },
      randomUUID(),
    );
    expect(disabled).toMatchObject({
      restricted: false,
      version: current.version + 1,
      memberIds: [],
    });
    await expect(listPages(viewer, spaceKey)).resolves.toMatchObject({
      pages: expect.arrayContaining([expect.objectContaining({ id: page.id })]),
    });

    const evidence = await getPool().query<{
      audit_count: string;
      outbox_count: string;
    }>(
      `SELECT
        (SELECT count(*) FROM audit_events
          WHERE organization_id = $1
            AND action IN (
              'space.member_added', 'space.member_role_changed',
              'space.member_removed', 'page.restriction_updated'
            )) AS audit_count,
        (SELECT count(*) FROM outbox_events
          WHERE organization_id = $1
            AND topic IN (
              'space.member_added', 'space.member_role_changed',
              'space.member_removed', 'page.restriction_updated'
            )) AS outbox_count`,
      [organizationId],
    );
    expect(evidence.rows[0]).toEqual({
      audit_count: "9",
      outbox_count: "9",
    });
  });
});
