import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@va/i18n";
import { ChatHeader } from "../src/components/chat/ChatHeader";

for (const connected of [true, false]) {
  for (const showSessionSidebar of [true, false]) {
    test(`new chat stays in the sidebar rather than the header (connected=${connected}, sidebar=${showSessionSidebar})`, () => {
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
          />
        </I18nProvider>,
      );
      expect(markup).not.toContain('aria-label="New chat"');
      expect(markup).toContain('aria-label="Show sessions"');
    });
  }
}
