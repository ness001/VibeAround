import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@va/i18n";
import { ChatHeader } from "../src/components/chat/ChatHeader";

for (const connected of [true, false]) {
  for (const showSessionSidebar of [true, false]) {
    test(`new chat is a primary labeled header action (connected=${connected}, sidebar=${showSessionSidebar})`, () => {
      const markup = renderToStaticMarkup(
        <I18nProvider>
          <ChatHeader
            selectedAgent="claude"
            agentLabel="Claude Code"
            routeLabel="Claude Code / Direct"
            headerSessionLabel={null}
            connected={connected}
            showSessionSidebar={showSessionSidebar}
            onShowMobileSessions={() => {}}
            onToggleSessionSidebar={() => {}}
            onNewChat={() => {}}
          />
        </I18nProvider>,
      );
      const button = markup.match(/<button[^>]*aria-label="New chat"[^>]*>[\s\S]*?<\/button>/)?.[0];
      expect(button).toBeDefined();
      expect(button).toContain('data-variant="default"');
      expect(button).toContain("bg-primary");
      expect(button).toContain("h-11");
      expect(button).toContain("New chat</button>");
      expect(button).not.toContain(' disabled=""');
      expect(button).not.toMatch(/class="[^"]*\bhidden\b/);
    });
  }
}
