import { expect, test, type Page, type Route } from "@playwright/test";

const projectId = "00000000-0000-4000-8000-000000000101";

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockStorageApi(page: Page) {
  let objects = [
    {
      key: "verification/run-1/linked-result.json",
      size_bytes: 2048,
      etag: "linked-etag",
      last_modified: "2026-11-12T18:00:00Z",
      linked: true,
      link_count: 1,
    },
    {
      key: "imports/unlinked.reqifz",
      size_bytes: 4096,
      etag: "unlinked-etag",
      last_modified: "2026-11-12T19:00:00Z",
      linked: false,
      link_count: 0,
    },
  ];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/projects" && request.method() === "GET") {
      return json(route, { items: [{ id: projectId, key: "OPENRM", name: "OpenRM", requirement_prefix: "ORM", next_requirement_number: 1, description: "Test", created_at: "2026-11-12T18:00:00Z" }] });
    }
    if (url.pathname.endsWith("/storage/objects") && request.method() === "GET") {
      return json(route, { items: objects, prefix: `organizations/test/projects/${projectId}/`, total_size_bytes: objects.reduce((total, object) => total + object.size_bytes, 0) });
    }
    if (url.pathname.endsWith("/storage/objects") && request.method() === "DELETE") {
      const key = url.searchParams.get("key");
      const object = objects.find((candidate) => candidate.key === key);
      if (!object) return json(route, { error: { message: "Object does not exist" } }, 404);
      if (object.linked) return json(route, { error: { message: "Linked evidence objects cannot be deleted" } }, 409);
      objects = objects.filter((candidate) => candidate.key !== key);
      return json(route, { key, deleted: true, version_id: "delete-marker-1" });
    }
    return json(route, { error: { message: `Unhandled ${request.method()} ${url.pathname}` } }, 404);
  });
}

test("deletes only unlinked project objects", async ({ page }) => {
  await mockStorageApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Object storage" }).click();

  await expect(page.getByRole("heading", { name: "S3-compatible storage" })).toBeVisible();
  await expect(page.getByText("Linked ×1")).toBeVisible();
  await expect(page.getByText("Unlinked", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete verification/run-1/linked-result.json" })).toBeDisabled();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete imports/unlinked.reqifz" }).click();
  await expect(page.getByText("Deleted unlinked object imports/unlinked.reqifz")).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete imports/unlinked.reqifz" })).toHaveCount(0);
});
