import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { startHost } from "./harness/host.tsx";
import { Workspace } from "./harness/repository.ts";

const days = (count: number) => new Date(Date.now() - count * 86_400_000);

describe("the GIT log sidebar", () => {
  test("shows the branch and recent commits, newest first", async () => {
    using repo = Workspace.repository();
    const first = repo.commit(
      "Add the cat",
      { "cat.txt": "meow" },
      { date: days(30) },
    );
    const second = repo.commit("Stretch the cat", { "cat.txt": "meeeow" });
    await using host = await startHost({ directory: repo.directory });

    await host.waitForText("Stretch the cat");
    const sidebar = await host.sidebar();
    expect(sidebar).toContain("Big Cat GIT log");
    expect(sidebar).toContain("main");
    expect(sidebar).toContain("Click a commit to inspect it.");
    expect(sidebar).toContain(`${second.slice(0, 7)} today`);
    expect(sidebar).toMatch(new RegExp(`${first.slice(0, 7)} (29|30|31)d ago`));
    expect(sidebar).toContain("Big Cat\n");
    expect(sidebar.indexOf("Stretch the cat")).toBeLessThan(
      sidebar.indexOf("Add the cat"),
    );
  });

  test("shortens long subjects and branch names to fit", async () => {
    using repo = Workspace.repository();
    repo.git("checkout", "-qb", "feature/an-extraordinarily-long-branch-name");
    repo.commit("A".repeat(80), { "a.txt": "a" });
    await using host = await startHost({ directory: repo.directory });

    await host.waitForText(`${"A".repeat(45)}…`);
    expect(await host.shows("A".repeat(46))).toBe(false);
    expect(await host.sidebar()).toContain(
      "feature/an-extraordinarily-long-b…",
    );
  });

  test("honours the `limit` option", async () => {
    using repo = Workspace.repository();
    for (const n of [1, 2, 3, 4, 5])
      repo.commit(`Commit ${n}`, { "n.txt": `${n}` });
    await using host = await startHost({
      directory: repo.directory,
      options: { limit: 3 },
    });

    await host.waitForText("Commit 5");
    const sidebar = await host.sidebar();
    expect(sidebar).toContain("Commit 3");
    expect(sidebar).not.toContain("Commit 2");
    expect(sidebar).not.toContain("Commit 1");
  });

  test("explains when the directory is not a GIT repository", async () => {
    using directory = Workspace.empty();
    await using host = await startHost({ directory: directory.directory });

    await host.waitForText(
      "No GIT repository found for this OpenCode location.",
    );
    expect(await host.sidebar()).not.toContain("No commits yet.");
  });

  test("shows an empty state for a repository without commits", async () => {
    using repo = Workspace.repository();
    await using host = await startHost({ directory: repo.directory });

    await host.waitForText("No commits yet.");
    expect(await host.sidebar()).toContain("main");
  });

  test("labels a detached HEAD", async () => {
    using repo = Workspace.repository();
    const first = repo.commit("First", { "a.txt": "1" });
    repo.commit("Second", { "a.txt": "2" });
    repo.git("checkout", "-q", first);
    await using host = await startHost({ directory: repo.directory });

    await host.waitForText("detached HEAD");
    expect(await host.sidebar()).not.toContain("Second");
  });

  test("keeps stretching until the server half registers its RPC", async () => {
    using repo = Workspace.repository();
    repo.commit("Ready when you are", { "a.txt": "a" });
    await using host = await startHost({
      directory: repo.directory,
      deferServer: true,
    });

    await host.waitForText("stretching…");
    await host.waitFor(() => host.rpc.calls.length >= 2, "a retried log call");
    expect(await host.sidebar()).not.toContain("Could not load GIT log");

    await host.startServer();
    await host.waitForText("Ready when you are");
    expect(await host.sidebar()).toContain("GIT log");
  });

  test("reports a failing GIT log instead of crashing", async () => {
    using repo = Workspace.repository();
    repo.commit("Doomed", { "a.txt": "a" });
    await using host = await startHost({ directory: repo.directory });
    await host.waitForText("Doomed");

    // A corrupt HEAD makes `git rev-parse --show-toplevel` succeed but the
    // remaining commands fail, which the server reports as an empty state.
    rmSync(repo.path(".git", "HEAD"));
    await host.waitForText(
      "No GIT repository found for this OpenCode location.",
    );
  });
});

describe("live updates", () => {
  test("follow commits, branches, staging, and edits made outside OpenCode", async () => {
    using repo = Workspace.repository();
    repo.commit("First", { "a.txt": "1" });
    await using host = await startHost({ directory: repo.directory });
    await host.waitForText("First");

    repo.commit("Second", { "b.txt": "2" });
    await host.waitForText("Second");

    repo.git("checkout", "-qb", "feature/whiskers");
    await host.waitForText("feature/whiskers");

    // An edit made by another program: only the working-tree watcher sees it.
    repo.write("a.txt", "edited elsewhere");
    await host.waitForIndicator("Unstaged changes", true);
    await host.waitForIndicator("Staged changes", false);

    repo.git("add", "a.txt");
    await host.waitForIndicator("Staged changes", true);
    await host.waitForIndicator("Unstaged changes", false);

    repo.git("commit", "-qm", "Third");
    await host.waitForText("Third");
    await host.waitForIndicator("Staged changes", false);

    repo.git("reset", "-q", "--hard", "HEAD~2");
    await host.waitForNoText("Second");
    expect(await host.sidebar()).not.toContain("Third");
  });

  test("pick up a repository created with `git init`", async () => {
    using directory = Workspace.empty();
    await using host = await startHost({ directory: directory.directory });
    await host.waitForText("No GIT repository found");

    directory.init();
    await host.waitForText("No commits yet.");

    directory.commit("Hello, world", { "hello.txt": "hello" });
    await host.waitForText("Hello, world");
  });

  test("refresh on OpenCode's own filesystem events", async () => {
    using repo = Workspace.repository();
    repo.commit("First", { "a.txt": "1" });
    await using host = await startHost({ directory: repo.directory });
    await host.waitForText("First");
    const calls = host.rpc.calls.filter((call) => call.method === "log").length;

    host.emitFileChange(repo.path("a.txt"));
    await host.waitFor(
      () =>
        host.rpc.calls.filter((call) => call.method === "log").length > calls,
      "a log refresh",
    );
  });
});
