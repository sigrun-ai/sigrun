import { test, expect } from "vitest";
import * as piTui from "@earendil-works/pi-tui";
test("pi-tui resolves with the components the TUI uses", () => {
  for (const name of ["SelectList", "Editor", "Markdown", "ScrollView", "Loader"]) {
    expect(piTui, name).toHaveProperty(name);
  }
});
