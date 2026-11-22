import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import plugin from "../.big-cat-test/index.js";

function git(directory, ...args) {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

async function start(directory) {
  let handlers;
  const listeners = new Set();
  const stop = await plugin.setup({
    location: { directory },
    options: {},
    rpc: {
      register: async (_definition, registered) => {
        handlers = registered;
        return {
          events: {
            emit: async (name, data) => {
              for (const listener of listeners) listener(name, data);
            },
          },
        };
      },
    },
  });
  const log = () =>
    handlers.log({ directory }, { signal: new AbortController().signal });
  const changed = (label, action) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`No repository change event for ${label}`));
      }, 3000);
      const listener = (_name, data) => {
        if (data.directory !== directory) return;
        clearTimeout(timeout);
        listeners.delete(listener);
        resolve();
      };
      listeners.add(listener);
      try {
        action();
      } catch (error) {
        clearTimeout(timeout);
        listeners.delete(listener);
        reject(error);
      }
    });
  return { log, changed, stop };
}

test("unborn repository: first commit and staged changes update the sidebar", async () => {
  const directory = mkdtempSync(join(tmpdir(), "big-cat-watch-"));
  let app;
  try {
    git(directory, "init", "-q");
    git(directory, "config", "user.email", "test@example.com");
    git(directory, "config", "user.name", "Test");
    app = await start(directory);
    assert.equal((await app.log()).message, "");
    assert.deepEqual((await app.log()).commits, []);

    writeFileSync(join(directory, "first.txt"), "hello");
    await app.changed("git add", () => git(directory, "add", "first.txt"));
    assert.equal((await app.log()).hasStagedChanges, true);

    await app.changed("git commit", () =>
      git(directory, "commit", "-qm", "first"),
    );
    const result = await app.log();
    assert.equal(result.commits[0].subject, "first");
    assert.equal(result.hasStagedChanges, false);

    await app.changed("edit outside OpenCode", () =>
      writeFileSync(join(directory, "first.txt"), "edited externally"),
    );
    assert.equal((await app.log()).hasUnstagedChanges, true);

    await app.changed("git checkout", () =>
      git(directory, "checkout", "-qb", "feature/nested"),
    );
    assert.equal((await app.log()).branch, "feature/nested");
  } finally {
    await app?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("git init replaces the directory watcher with a repository watcher", async () => {
  const directory = mkdtempSync(join(tmpdir(), "big-cat-init-"));
  let app;
  try {
    app = await start(directory);
    assert.match((await app.log()).message, /No GIT repository/);

    await app.changed("git init", () => git(directory, "init", "-q"));
    assert.equal((await app.log()).message, "");

    writeFileSync(join(directory, "first.txt"), "hello");
    await app.changed("git add after init", () =>
      git(directory, "add", "first.txt"),
    );
    assert.equal((await app.log()).hasStagedChanges, true);
  } finally {
    await app?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("linked worktrees observe their own index and shared branch refs", async () => {
  const root = mkdtempSync(join(tmpdir(), "big-cat-worktree-"));
  const directory = join(root, "worktree");
  const main = join(root, "main");
  let app;
  try {
    mkdirSync(main);
    git(main, "init", "-q");
    git(main, "config", "user.email", "test@example.com");
    git(main, "config", "user.name", "Test");
    writeFileSync(join(main, "first.txt"), "hello");
    git(main, "add", "first.txt");
    git(main, "commit", "-qm", "first");
    git(main, "worktree", "add", "-q", "-b", "linked", directory);

    app = await start(directory);
    assert.equal((await app.log()).branch, "linked");
    writeFileSync(join(directory, "second.txt"), "second");
    await app.changed("git add in worktree", () =>
      git(directory, "add", "second.txt"),
    );
    assert.equal((await app.log()).hasStagedChanges, true);
    await app.changed("git commit in worktree", () =>
      git(directory, "commit", "-qm", "second"),
    );
    assert.equal((await app.log()).commits[0].subject, "second");
  } finally {
    await app?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
