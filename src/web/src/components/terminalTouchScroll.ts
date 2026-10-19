import type { Terminal } from "@xterm/xterm";

/** Keep touch scrolling on the same input path as a desktop mouse wheel for TUIs. */
export function installTerminalTouchScroll(host: HTMLElement, terminal: Terminal): () => void {
  let finger: number | undefined;
  let lastY = 0;
  let pending = 0;
  let startX = 0;
  let startY = 0;
  let dragging = false;
  const previousTouchAction = host.style.touchAction;
  // Reserve one-finger panning for the terminal, but retain browser pinch zoom.
  host.style.touchAction = "pinch-zoom";

  const reset = () => { finger = undefined; pending = 0; dragging = false; };
  const start = (event: TouchEvent) => {
    reset();
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    finger = touch.identifier;
    startX = touch.clientX;
    startY = lastY = touch.clientY;
  };
  const move = (event: TouchEvent) => {
    if (finger === undefined) return;
    if (event.touches.length !== 1) { reset(); return; }
    const touch = Array.from(event.touches).find(t => t.identifier === finger);
    if (!touch) { reset(); return; }
    if (!dragging) {
      const dx = Math.abs(touch.clientX - startX);
      const dy = Math.abs(touch.clientY - startY);
      if (Math.max(dx, dy) < 6) return;
      if (dx > dy) { reset(); return; }
      dragging = true;
    }
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    pending += lastY - touch.clientY;
    lastY = touch.clientY;
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    const rowHeight = (screen?.getBoundingClientRect().height ?? 0) / terminal.rows;
    if (!Number.isFinite(rowHeight) || rowHeight <= 0) return;
    const lines = Math.trunc(pending / rowHeight);
    if (lines === 0) return;
    pending -= lines * rowHeight;

    // scrollLines only moves local history. Alternate buffers have no history;
    // mouse-aware apps (Claude/tmux/etc.) need xterm's own wheel encoding instead.
    if (terminal.modes.mouseTrackingMode !== "none"
        || terminal.buffer.active.type === "alternate"
        || terminal.options.scrollback === 0) {
      terminal.element?.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaY: lines, clientX: touch.clientX, clientY: touch.clientY,
      }));
    } else {
      terminal.scrollLines(lines);
    }
  };
  const options = { capture: true, passive: false };
  host.addEventListener("touchstart", start, { capture: true, passive: true });
  host.addEventListener("touchmove", move, options);
  host.addEventListener("touchend", reset, true);
  host.addEventListener("touchcancel", reset, true);
  return () => {
    host.removeEventListener("touchstart", start, true);
    host.removeEventListener("touchmove", move, true);
    host.removeEventListener("touchend", reset, true);
    host.removeEventListener("touchcancel", reset, true);
    host.style.touchAction = previousTouchAction;
    reset();
  };
}
