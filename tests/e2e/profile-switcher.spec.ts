import { expect, test, type Route } from "@playwright/test";

const projectId = "00000000-0000-4000-8000-000000000102";

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

const localProfile = {
  id: "00000000-0000-4000-8000-000000000701",
  subject: "local-user",
  email: null,
  display_name: "Local user",
  title: null,
  department: null,
  bio: null,
  organization_role: "administrator",
  project_memberships: [],
  created_at: "2026-11-13T12:00:00Z",
  updated_at: "2026-11-13T12:00:00Z",
};

const authorProfile = {
  ...localProfile,
  id: "00000000-0000-4000-8000-000000000702",
  subject: "ada-lovelace",
  email: "ada@example.com",
  display_name: "Ada Lovelace",
  organization_role: "author",
};

test("switches the local workspace identity from the profile menu", async ({ page }) => {
  const authorizationHeaders: string[] = [];

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    authorizationHeaders.push(request.headers().authorization || "");
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/profile") return json(route, localProfile);
    if (path === "/api/v1/users") return json(route, { items: [authorProfile, localProfile] });
    if (path === "/api/v1/projects") return json(route, { items: [{
      id: projectId,
      key: "OPENRM",
      name: "OpenRM",
      requirement_prefix: "ORM",
      next_requirement_number: 1,
      description: "Controlled workspace",
      created_at: "2026-11-13T12:00:00Z",
    }] });
    if (path.endsWith("/requirements")) return json(route, { items: [], total: 0, limit: 25, offset: 0 });
    if (path.endsWith("/workspace/folders") || path.endsWith("/workspace/tags") || path.endsWith("/workspace/saved-views")) {
      return json(route, { items: [] });
    }
    return json(route, { items: [] });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open profile menu for Local user" }).click();
  const menu = page.getByRole("menu", { name: "User profiles" });
  await expect(menu.getByText("Local development")).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: /Ada Lovelace/ })).toBeVisible();

  await menu.getByRole("menuitemradio", { name: /Ada Lovelace/ }).click();

  await expect(page.getByRole("button", { name: "Open profile menu for Ada Lovelace" })).toBeVisible();
  await expect.poll(() => authorizationHeaders).toContain("Bearer dev:ada-lovelace:author");
});
