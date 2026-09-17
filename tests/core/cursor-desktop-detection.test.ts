import { describe, expect, it } from "vitest";
import { cursorDesktopArtifactPaths, detectCursorDesktop } from "../../src/core/cursor-desktop-detection.js";

describe("Cursor desktop detection", () => {
  it("recognizes an actual standard app artifact without a shell command", () => {
    const candidates = cursorDesktopArtifactPaths("darwin", {}, "/Users/tester");
    const result = detectCursorDesktop({
      platform: "darwin",
      env: {},
      home: "/Users/tester",
      pathExists: (candidate) => candidate === "/Applications/Cursor.app"
    });
    expect(candidates).toContain("/Applications/Cursor.app");
    expect(result).toEqual({ detected: true, source: "application", path: "/Applications/Cursor.app" });
  });

  it("recognizes Cursor-branded editor environment paths", () => {
    expect(detectCursorDesktop({
      platform: "darwin",
      env: { VSCODE_GIT_ASKPASS_MAIN: "/Applications/Cursor.app/Contents/Resources/app/extensions/git/askpass.js" },
      paths: [],
      pathExists: () => false
    }).detected).toBe(true);
    expect(detectCursorDesktop({
      platform: "linux",
      env: { TERM_PROGRAM: "cursor" },
      paths: [],
      pathExists: () => false
    }).detected).toBe(true);
  });

  it("does not mistake generic VS Code signals for Cursor", () => {
    for (const env of [
      { TERM_PROGRAM: "vscode" },
      { TERM_PROGRAM: "Visual Studio Code" },
      { VSCODE_GIT_ASKPASS_MAIN: "/Applications/Visual Studio Code.app/Contents/Resources/app/askpass.js" }
    ]) {
      expect(detectCursorDesktop({ platform: "darwin", env, paths: [], pathExists: () => false })).toEqual({ detected: false });
    }
  });
});
