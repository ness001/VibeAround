import { expect, test } from "bun:test";
import { installTerminalTouchScroll } from "../src/components/terminalTouchScroll";
import type { Terminal } from "@xterm/xterm";

class TestWheelEvent extends Event {
  static DOM_DELTA_LINE = 1;
  deltaY: number;
  constructor(type: string, options: WheelEventInit) { super(type, options); this.deltaY = options.deltaY ?? 0; }
}
function fixture(type: "normal" | "alternate" = "normal", mouse = "none", scrollback = 5000) {
  const host = new EventTarget() as EventTarget & { style: { touchAction: string }; querySelector: () => unknown };
  host.style = { touchAction: "auto" };
  host.querySelector = () => ({ getBoundingClientRect: () => ({ height: 200 }) });
  const lines: number[] = [], wheels: number[] = [];
  const element = new EventTarget();
  element.addEventListener("wheel", e => wheels.push((e as TestWheelEvent).deltaY));
  const term = { rows: 10, modes: { mouseTrackingMode: mouse }, buffer: { active: { type } }, options: { scrollback }, element, scrollLines: (n: number) => lines.push(n) };
  const dispose = installTerminalTouchScroll(host as unknown as HTMLElement, term as unknown as Terminal);
  const touch = (name: string, y: number, count = 1, x = 50) => {
    const e = new Event(name, { cancelable: true });
    Object.defineProperty(e, "touches", { value: Array.from({ length: count }, (_, identifier) => ({ identifier, clientX: x, clientY: y })) });
    host.dispatchEvent(e); return e;
  };
  return { host, lines, wheels, touch, dispose };
}

test("normal scrollback uses row-sized deltas in both directions and retains fractions", () => {
  const f = fixture();
  f.touch("touchstart", 100); f.touch("touchmove", 107); f.touch("touchmove", 125); f.touch("touchmove", 145); f.touch("touchmove", 100);
  expect(f.lines).toEqual([-1, -1, 2]); expect(f.wheels).toEqual([]); f.dispose();
});
for (const [label, type, mouse, scrollback] of [
  ["alternate", "alternate", "none", 5000], ["mouse reporting", "normal", "vt200", 5000], ["tmux", "normal", "none", 0],
] as const) test(`${label} delegates to xterm wheel handling instead of local scrollback`, () => {
  const previous = globalThis.WheelEvent;
  globalThis.WheelEvent = TestWheelEvent as unknown as typeof WheelEvent;
  try {
    const f = fixture(type, mouse, scrollback);
    f.touch("touchstart", 100); f.touch("touchmove", 140);
    expect(f.wheels).toEqual([-2]); expect(f.lines).toEqual([]); f.dispose();
  } finally { globalThis.WheelEvent = previous; }
});
test("taps, horizontal gestures, multitouch and cancelled touches do not scroll", () => {
  const f = fixture();
  f.touch("touchstart", 100); expect(f.touch("touchmove", 102).defaultPrevented).toBe(false);
  f.touch("touchend", 102, 0); f.touch("touchmove", 180);
  f.touch("touchstart", 100); f.touch("touchmove", 120, 1, 120);
  f.touch("touchstart", 100); expect(f.touch("touchmove", 150, 2).defaultPrevented).toBe(false);
  f.touch("touchstart", 100); f.touch("touchcancel", 100, 0); f.touch("touchmove", 180);
  expect(f.lines).toEqual([]); f.dispose();
});
test("cleanup restores touch behavior and removes listeners", () => {
  const f = fixture(); expect(f.host.style.touchAction).toBe("pinch-zoom");
  f.dispose(); expect(f.host.style.touchAction).toBe("auto");
  f.touch("touchstart", 100); f.touch("touchmove", 180); expect(f.lines).toEqual([]);
});
