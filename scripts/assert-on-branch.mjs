#!/usr/bin/env node
// Fail loudly when HEAD is detached, instead of letting a later push silently no-op.
//
// THE HAZARD (measured, git 2.51.0):
//   With HEAD detached and new commits made on the detached HEAD, pushing by branch
//   name pushes the BRANCH ref — which does not contain those commits:
//
//       $ git push origin main
//       Everything up-to-date
//       $ echo $?
//       0
//
//   Exit 0, reassuring message, and the work is still off-branch. (The bare `git push`
//   form is loud on this git — "fatal: You are not currently on a branch." — so the
//   silent variant is the one that names a branch, which is also the form scripts and
//   agents most often use.) The remedy `git push origin HEAD` does NOT work either:
//   git refuses the partial refname and demands `HEAD:<branch>`.
//
// WHY A GUARD AND NOT A FIX — the detach is EXTERNAL to this repository:
//   - A controlled run on a real branch in the main checkout showed the verify chain
//     does not detach HEAD:
//         before:          probe/detached-head-test
//         after typecheck: probe/detached-head-test
//         after smoke:     probe/detached-head-test
//     An earlier attribution of the detaches to `npm run verify` was wrong.
//   - `grep -rnE "git (checkout|switch|worktree|reset)" scripts/ package.json .github/`
//     has no hits: no repo script performs a checkout.
//   - There is no .husky directory, core.hooksPath is the default .git/hooks, and no
//     non-sample hook is installed.
//   - The detaches appear only in agent worktree reflogs, with the signature
//     `checkout: moving from <branch> to <SHA>` later followed by
//     `moving from <SHA> to <branch>` — i.e. an external tool snapshotting and
//     restoring a worktree. Which tool is not established, and this comment does not
//     guess.
//
// Deliberately NOT part of `npm run verify`. GitHub Actions checks pull requests out in
// detached HEAD mode ("In a pull request trigger, `ref` is required as GitHub Actions
// checks out in detached HEAD mode" — actions/checkout v4 README), and .github/workflows/ci.yml
// runs on `pull_request` with no `ref:` input, so a detached HEAD is legitimate there.
// Wiring this into verify would make the repo's own verification command fail in CI and in
// any transiently-detached worktree. It guards the PUSH, so it belongs on the push path:
// `npm run preflight:push` and the opt-in .githooks/pre-push hook.
//
// Read-only: this script runs `git symbolic-ref` / `git rev-parse` and nothing else.
// It never checks out, resets, or otherwise modifies git state. Node built-ins only.
//
// Exit codes:
//   0  HEAD is on a branch
//   1  HEAD is detached
//   2  cannot determine (git unavailable, or not inside a work tree) — fail-closed,
//      because "unknown" is not the same as "safe"

import { spawnSync } from "node:child_process";

/** Run a read-only git command. Returns null when git fails or is unavailable. */
function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);

if (branch) {
  process.stdout.write(`on branch ${branch} — push target is unambiguous\n`);
  process.exit(0);
}

// No symbolic ref. Distinguish "detached HEAD" from "not a usable git work tree".
const head = git(["rev-parse", "HEAD"]);
if (head === null) {
  process.stderr.write(
    [
      "assert-on-branch: cannot determine the current branch.",
      "git is unavailable, this is not a git work tree, or the repository has no commits.",
      "Refusing to report a clean branch state that was never verified.",
      ""
    ].join("\n")
  );
  process.exit(2);
}

const remotes = git(["remote"]) || "";
const exampleRemote = remotes.split("\n").find((line) => line.trim().length > 0) || "origin";

process.stderr.write(
  [
    "",
    "  HEAD IS DETACHED — do not push from this state.",
    "",
    `  current commit: ${head}`,
    "",
    "  A push by branch name from a detached HEAD pushes the BRANCH ref, which does not",
    "  contain the commits you just made. Git reports 'Everything up-to-date' and exits 0,",
    "  so the push looks successful while the work stays off-branch.",
    "",
    "  Two remedies:",
    "",
    "    1. Reattach, then push normally:",
    "         git checkout <branch>",
    "",
    "    2. Or push this commit with an explicit refspec:",
    `         git push ${exampleRemote} HEAD:<branch>`,
    "",
    "  ('git push <remote> HEAD' is not a substitute — git rejects the partial refname.)",
    "",
    "  If you did not detach HEAD yourself: the detaches seen in this repo came from external",
    "  worktree/session tooling. No script in this repository performs a checkout.",
    "",
    ""
  ].join("\n")
);
process.exit(1);
