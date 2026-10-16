import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Read through the installed adapter's own SDK. Never return credentials, paths,
// arbitrary settings or execute a model prompt just to populate a picker.
const require = createRequire(pathToFileURL(process.argv.at(-1)));
const { resolveSettings } = await import(pathToFileURL(require.resolve("@anthropic-ai/claude-agent-sdk")).href);
const resolved = await resolveSettings({ cwd: process.cwd() });
const fields = (settings) => ({
  effort: settings?.effortLevel ?? null,
  context: settings?.autoCompactWindow ?? null,
});
const sources = resolved.sources.map(({ settings }) => ({
  ...fields(settings),
  models: Object.fromEntries(Object.entries(settings.modelSettings ?? {}).map(([model, value]) => [model, fields(value)])),
}));
console.log(JSON.stringify({
  sources,
  effort_env: process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null,
  context_env: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? null,
}));
