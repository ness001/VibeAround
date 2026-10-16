import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@va/i18n";
import { FolderBrowser, folderBreadcrumbs } from "../src/components/FolderBrowser";
import { FolderListingSchema } from "../src/api/sessions";

const root = "C:\\Users\\tester\\repos";
const listing = { root, path: root, parent_path: null, folders: [{ name: "project", path: `${root}\\project` }] };
const render = (props: Partial<React.ComponentProps<typeof FolderBrowser>> = {}) => renderToStaticMarkup(
  <I18nProvider><FolderBrowser listing={listing} loading={false} onNavigate={() => {}} onRetry={() => {}} {...props} /></I18nProvider>,
);

test("root listing exposes navigable folders without a path textbox", () => {
  const markup = render();
  expect(markup).toContain('aria-label="Open folder project"');
  expect(markup).toContain('data-slot="browsed-folder"');
  expect(markup.match(/<button[^>]*aria-label="Up one folder"[^>]*>/)?.[0]).toContain('disabled=""');
  expect(markup).not.toContain("<input");
});

test("breadcrumbs preserve Windows and Unix nested folder paths", () => {
  expect(folderBreadcrumbs(root, `${root}\\project\\src`)).toEqual([
    { name: "project", path: `${root}\\project` }, { name: "src", path: `${root}\\project\\src` },
  ]);
  expect(folderBreadcrumbs("/repos", "/repos/project/src")).toEqual([
    { name: "project", path: "/repos/project" }, { name: "src", path: "/repos/project/src" },
  ]);
  expect(folderBreadcrumbs("/", "/repos")).toEqual([{ name: "repos", path: "/repos" }]);
  expect(folderBreadcrumbs(root, root)).toEqual([]);
});

test("nested folders expose up navigation, empty folders remain selectable", () => {
  const html = render({ listing: { ...listing, path: `${root}\\project`, parent_path: root, folders: [] } });
  expect(html.match(/<button[^>]*aria-label="Up one folder"[^>]*>/)?.[0]).not.toContain('disabled=""');
  expect(html).toContain("No subfolders.");
});

test("loading and errors do not present stale child choices", () => {
  const loading = render({ loading: true });
  expect(loading).toContain('role="status"');
  expect(loading).not.toContain('aria-label="Open folder project"');
  const failed = render({ error: "Access denied" });
  expect(failed).toContain('role="alert"');
  expect(failed).toContain("Retry");
  expect(failed).not.toContain('aria-label="Open folder project"');
});

test("server listing validates nullable parent and directory entries", () => {
  expect(FolderListingSchema.parse(listing)).toEqual(listing);
  expect(FolderListingSchema.safeParse({ ...listing, folders: [{ path: root }] }).success).toBe(false);
  expect(FolderListingSchema.safeParse({ ...listing, parent_path: 1 }).success).toBe(false);
});
