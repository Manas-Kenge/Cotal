import assert from "node:assert/strict";

export async function renderNative() {
  const { TextRenderable } = await import("@opentui/core");
  const { createTestRenderer } = await import("@opentui/core/testing");
  const test = await createTestRenderer({ width: 48, height: 6 });
  try {
    test.renderer.root.add(new TextRenderable(test.renderer, { id: "offline-proof", content: "Cotal offline feasibility" }));
    await test.renderOnce();
    const frame = test.captureCharFrame();
    assert.ok(frame.includes("Cotal offline feasibility"));
    return { package: "@opentui/core", version: "0.8.0", nativeFrame: frame, scope: "native headless renderer; no full TUI, Solid transform or interactive terminal" };
  } finally {
    await test.dispose();
  }
}
