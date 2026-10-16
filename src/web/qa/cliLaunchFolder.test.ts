import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { canLaunchCliFolder } from "../src/components/CliLaunchDialog";

test("CLI launch requires a confirmed nonempty folder and no pending operation", () => {
  expect(canLaunchCliFolder("C:\\projects\\app", false, false, false)).toBe(true);
  for (const path of [undefined, "", "   "]) {
    expect(canLaunchCliFolder(path, false, false, false)).toBe(false);
  }
  for (const flags of [[true, false, false], [false, true, false], [false, false, true]]) {
    expect(canLaunchCliFolder("/projects/app", flags[0], flags[1], flags[2])).toBe(false);
  }
});

test("tool and profile CLI launch forward the confirmed project folder", () => {
  const hook = readFileSync(new URL("../src/hooks/useSessions.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  expect(hook).toContain("createSession({ tool, project_path: projectPath, theme, cols, rows })");
  expect(hook).toContain("launch_target: launchTarget,\n          project_path: projectPath,");
  expect(hook).toContain('console.error("[VibeAround] createSession:", e);\n        throw e;');
  expect(hook).toContain('console.error("[VibeAround] create profile session:", e);\n        throw e;');
});

test("CLI launch confirmation reuses the folder picker and waits for successful launch", () => {
  const dialog = readFileSync(new URL("../src/components/CliLaunchDialog.tsx", import.meta.url), "utf8");
  expect(dialog).toContain('purpose="cli"');
  expect(dialog).toContain("onEditingChange={setEditing}");
  expect(dialog).toContain("await onLaunch(selectedPath!);\n      onClose();");
  expect(dialog).toContain("const path = await action();\n      setSelectedPath(path);");
  const menu = readFileSync(new URL("../src/components/AddCliDropdown.tsx", import.meta.url), "utf8");
  expect(menu).toContain("start: path => onAddCli(tool, path)");
  expect(menu).toContain("start: path => onAddProfileCli(profile.id, target.id, path)");
  expect(menu).not.toContain("onSelect={() => onAddCli(tool)}");
});
