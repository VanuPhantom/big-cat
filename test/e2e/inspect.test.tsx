import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { startHost } from "./harness/host.tsx";
import { Workspace } from "./harness/repository.ts";

describe("inspecting a commit", () => {
  test("shows the full commit message, then its diff file by file", async () => {
    using repo = Workspace.repository();
    repo.commit("Initial commit", { "cat.txt": "meow\n", "dog.txt": "woof\n" });
    const hash = repo.commit(
      "Teach the cat new words\n\nThe cat now purrs as well as meows.",
      { "cat.txt": "meow\npurr\n", "dog.txt": "woof\nbark\n" },
    );
    const short = hash.slice(0, 7);
    await using host = await startHost({ directory: repo.directory });

    await host.click("Teach the cat new words");
    await host.waitForText(`${short} Teach the cat new words`);
    await host.waitForText("The cat now purrs as well as meows.");

    await host.click("View diff");
    await host.waitForText(`${short} diff (2 files)`);
    // The panel is fullscreen: the sidebar is gone.
    expect(await host.shows("Click a commit to inspect it.")).toBe(false);
    expect(host.dialog()).toBeUndefined();
    await host.waitForText("1/2 cat.txt");
    await host.waitForText("purr");
    expect(await host.shows("bark")).toBe(false);

    await host.press("n");
    await host.waitForText("2/2 dog.txt");
    await host.waitForText("bark");

    // Already on the last file.
    await host.press("right");
    await host.waitForText("2/2 dog.txt");

    await host.click("← Prev");
    await host.waitForText("1/2 cat.txt");

    await host.press("escape");
    await host.waitForText("Click a commit to inspect it.");
    expect(host.panel()).toBeUndefined();
  });

  test("Cancel closes the commit dialog", async () => {
    using repo = Workspace.repository();
    repo.commit("Nap in the sun", { "nap.txt": "zzz" });
    await using host = await startHost({ directory: repo.directory });

    await host.click("Nap in the sun");
    await host.waitForText("View diff");
    await host.click("Cancel");
    await host.waitForNoText("View diff");
    expect(host.panel()).toBeUndefined();
  });

  test("Close and q close the diff panel", async () => {
    using repo = Workspace.repository();
    repo.commit("Knock a glass off the table", { "glass.txt": "crash" });
    await using host = await startHost({ directory: repo.directory });

    for (const close of [() => host.click("Close"), () => host.press("q")]) {
      await host.click("Knock a glass off the table");
      await host.click("View diff");
      await host.waitForText("1/1 glass.txt");
      await close();
      await host.waitForText("Click a commit to inspect it.");
    }
  });

  test("explains that an empty commit has no diff", async () => {
    using repo = Workspace.repository();
    repo.commit("Stare at the wall");
    await using host = await startHost({ directory: repo.directory });

    await host.click("Stare at the wall");
    await host.click("View diff");
    await host.waitForText("This commit has no file changes.");
    expect(host.panel()).toBeUndefined();
    await host.click("OK");
    await host.waitForNoText("This commit has no file changes.");
  });

  test("shows a toast when the commit can no longer be read", async () => {
    using repo = Workspace.repository();
    repo.commit("Vanish", { "a.txt": "a" });
    await using host = await startHost({ directory: repo.directory });
    await host.waitForText("Vanish");

    // Pull the repository out from under the sidebar before the click.
    rmSync(repo.path(".git"), { recursive: true, force: true });
    await host.click("Vanish");
    await host.waitForText("[error] Could not load commit details.");
  });
});

describe("working tree changes", () => {
  test("open unstaged and staged diffs from the sidebar", async () => {
    using repo = Workspace.repository();
    repo.commit("Initial commit", {
      "staged.txt": "before\n",
      "unstaged.txt": "before\n",
    });
    await using host = await startHost({ directory: repo.directory });
    await host.waitForText("Initial commit");

    repo.write("staged.txt", "after staging\n");
    repo.git("add", "staged.txt");
    repo.write("unstaged.txt", "after editing\n");
    await host.waitForIndicator("Unstaged changes", true);
    await host.waitForIndicator("Staged changes", true);

    await host.click("Unstaged changes");
    await host.waitForText("Unstaged changes (1 files)");
    await host.waitForText("1/1 unstaged.txt");
    await host.waitForText("after editing");
    await host.press("escape");

    // Closing the fullscreen panel remounts the sidebar, which reloads.
    await host.waitForIndicator("Staged changes", true);
    await host.click("Staged changes");
    await host.waitForText("Staged changes (1 files)");
    await host.waitForText("1/1 staged.txt");
    await host.waitForText("after staging");
    await host.press("escape");
    await host.waitForText("Click a commit to inspect it.");
  });

  test("inactive indicators do nothing when clicked", async () => {
    using repo = Workspace.repository();
    repo.commit("Spotless", { "a.txt": "a" });
    await using host = await startHost({ directory: repo.directory });
    await host.waitForText("Spotless");
    await host.waitForIndicator("Unstaged changes", false);

    await host.click("Unstaged changes");
    await host.click("Staged changes");
    // Give a (wrong) diff request time to come back before asserting.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(host.rpc.calls.map((call) => call.method)).not.toContain(
      "workingDiff",
    );
    expect(host.panel()).toBeUndefined();
    expect(host.dialog()).toBeUndefined();
  });
});
