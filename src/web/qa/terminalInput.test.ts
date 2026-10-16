import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// xterm's disableStdin suppresses protocol replies as well as keyboard input.
// Real mobile-browser/ConPTY coverage lives in local-tools/phone-test/verify-terminal.cjs.
test("mobile terminals keep stdin enabled for cursor-query replies and user input", () => {
  const source = readFileSync(new URL("../src/components/TerminalView.tsx", import.meta.url), "utf8");
  expect(source).toMatch(/disableStdin:\s*false/);
  expect(source).not.toMatch(/disableStdin:\s*isMobile/);
  expect(source).toContain("term.onData");
});
