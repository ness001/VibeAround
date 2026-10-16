import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@va/i18n";
import { NewChatWorkspacePicker } from "../src/components/chat/NewChatWorkspacePicker";

const props = {
  workspaces: [{ path: "C:\\projects\\current", is_default: true, is_builtin: false }],
  defaultWorkspacePath: "C:\\projects\\default",
  selectedWorkspacePath: "C:\\projects\\current",
  onWorkspaceChange: () => {},
  onCreateWorkspace: async () => true,
  onAddWorkspace: async () => true,
};

function render(overrides: Partial<React.ComponentProps<typeof NewChatWorkspacePicker>> = {}) {
  return renderToStaticMarkup(<I18nProvider><NewChatWorkspacePicker {...props} {...overrides} /></I18nProvider>);
}

test("folder choice uses current folder by default and exposes both alternatives", () => {
  const html = render();
  expect(html).toContain("Where should this chat work?");
  expect(html).toContain("Use current folder");
  expect(html).toContain("Choose another folder");
  expect(html).toContain("Create a new project folder");
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain("C:\\projects\\current");
  expect(html).not.toContain("C:\\projects\\default");
  expect(html).not.toContain("Workspaces");
  expect(html).not.toContain("<form");
  expect(html).toContain('aria-label="Configure root folder"');
});

test("CLI reuses folder selection with correct launch language", () => {
  const html = render({ purpose: "cli" });
  expect(html).toContain("Where should this CLI run?");
  expect(html).not.toContain("Where should this chat work?");
});

test("pending folder operations disable all choices and errors are accessible", () => {
  const html = render({ creating: true, createError: "Folder already exists" });
  const buttons = html.match(/<button[^>]*>/g) ?? [];
  expect(buttons.length).toBe(3);
  expect(buttons.every(button => button.includes('disabled=""'))).toBe(true);
  expect(html).toContain('role="alert"');
  expect(html).toContain("Folder already exists");
});

test("default folder is shown before an explicit selection", () => {
  expect(render({ selectedWorkspacePath: undefined })).toContain("C:\\projects\\default");
});
