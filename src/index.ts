import { execFile } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Plugin } from "@opencode/plugin";
import { BigCat } from "./rpc.js";

const execFileAsync = promisify(execFile);
const fieldSeparator = "\u001f";
const recordSeparator = "\u001e";

type Commit = {
  hash: string;
  author: string;
  date: string;
  subject: string;
};

type GitLog = {
  repository: string;
  branch: string;
  commits: Commit[];
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  message: string;
};

async function git(
  directory: string,
  args: string[],
  signal: AbortSignal,
  { trim = true }: { trim?: boolean } = {},
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: directory,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    signal,
  });
  return trim ? stdout.trim() : stdout;
}

function parseCommits(output: string): Commit[] {
  return output
    .split(recordSeparator)
    .filter(Boolean)
    .flatMap((rawRecord) => {
      const record = rawRecord.trim();
      const [hash, author, date, subject] = record.split(fieldSeparator);
      return hash && author && date !== undefined && subject !== undefined
        ? [{ hash, author, date, subject }]
        : [];
    });
}

async function readCommitLog(
  directory: string,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  try {
    return await git(
      directory,
      [
        "log",
        `--max-count=${limit}`,
        "--date=short",
        `--pretty=format:%H%x1f%an%x1f%ad%x1f%s%x1e`,
      ],
      signal,
    );
  } catch (error) {
    if (signal.aborted) throw error;
    // Git log exits unsuccessfully when HEAD has no commits yet.
    try {
      await git(directory, ["rev-parse", "--verify", "HEAD"], signal);
    } catch {
      if (signal.aborted) throw error;
      return "";
    }
    throw error;
  }
}

async function readLog(
  directory: string,
  limit: number,
  signal: AbortSignal,
): Promise<GitLog> {
  try {
    const repository = await git(
      directory,
      ["rev-parse", "--show-toplevel"],
      signal,
    );
    const [branch, output, stagedChanges, unstagedChanges] = await Promise.all([
      git(directory, ["branch", "--show-current"], signal),
      readCommitLog(directory, limit, signal),
      git(directory, ["diff", "--name-only", "--staged"], signal),
      git(directory, ["diff", "--name-only"], signal),
    ]);

    return {
      repository,
      branch: branch || "detached HEAD",
      commits: parseCommits(output),
      hasStagedChanges: Boolean(stagedChanges),
      hasUnstagedChanges: Boolean(unstagedChanges),
      message: "",
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      repository: "",
      branch: "",
      commits: [],
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      message: "No GIT repository found for this OpenCode location.",
    };
  }
}

// Git rewrites these files on commits, checkouts, resets, rebases, and staging.
const watchedGitDirFiles = new Set(["HEAD", "index", "packed-refs"]);

type RepositoryWatcher = {
  kind: "repository" | "directory";
  close: () => void;
};

async function watchRepository(
  directory: string,
  onChange: () => void,
  onFailure: () => void,
): Promise<RepositoryWatcher | undefined> {
  const signal = AbortSignal.timeout(10_000);
  let gitDir: string;
  let commonDir: string;
  try {
    const output = await git(
      directory,
      ["rev-parse", "--absolute-git-dir", "--git-common-dir"],
      signal,
    );
    const [absoluteGitDir, relativeCommonDir] = output.split(/\r?\n/);
    if (!absoluteGitDir || !relativeCommonDir) return;
    gitDir = absoluteGitDir;
    commonDir = resolve(directory, relativeCommonDir);
  } catch {
    // A directory can become a repository when `git init` creates .git.
    try {
      const watcher = watch(directory, (_event, file) => {
        if (!file || file.toString() === ".git") onChange();
      });
      watcher.on("error", () => {
        watcher.close();
        onFailure();
      });
      return { kind: "directory", close: () => watcher.close() };
    } catch {
      return;
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const watchers: FSWatcher[] = [];
  const close = () => {
    closed = true;
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
  const notify = () => {
    if (closed) return;
    clearTimeout(timer);
    // A single Git operation often touches several files.
    timer = setTimeout(onChange, 150);
  };

  const add = (
    path: string,
    recursive: boolean,
    filter: (file: string) => boolean,
  ) => {
    try {
      const watcher = watch(path, { recursive }, (_event, file) => {
        if (!file || filter(file.toString())) notify();
      });
      watcher.on("error", () => {
        if (closed) return;
        close();
        onFailure();
      });
      watchers.push(watcher);
    } catch {
      // The path may not exist yet, for example in a fresh repository.
    }
  };

  // Watch directories rather than files: GIT replaces files by renaming
  // lock files over them, which detaches file-level watchers.
  add(gitDir, false, (file) => watchedGitDirFiles.has(file));
  if (commonDir !== gitDir) {
    add(commonDir, false, (file) => file === "packed-refs");
  }
  add(join(commonDir, "refs", "heads"), true, (file) => !file.endsWith(".lock"));

  // A watcher that could not be installed cannot keep the sidebar current.
  return watchers.length > 0 ? { kind: "repository", close } : undefined;
}

export default Plugin.define({
  id: "big-cat",
  async setup(context) {
    const configuredLimit = context.options.limit;
    const limit =
      typeof configuredLimit === "number" && Number.isInteger(configuredLimit)
        ? configuredLimit
        : 12;
    const maxCommits = Math.max(1, Math.min(limit, 100));

    const watchers = new Map<string, Promise<RepositoryWatcher | undefined>>();
    let emitChanged: (directory: string) => void = () => {};

    const ensureWatcher = async (directory: string, repository: boolean) => {
      const existing = watchers.get(directory);
      if (existing) {
        const watcher = await existing;
        if (watchers.get(directory) !== existing) {
          return ensureWatcher(directory, repository);
        }
        if (watcher?.kind === (repository ? "repository" : "directory")) {
          return watcher;
        }
        // Switch between repository and directory watchers as Git appears/disappears.
        watcher?.close();
        watchers.delete(directory);
      }
      const pending = watchRepository(
        directory,
        () => emitChanged(directory),
        () => {
          // A future log request can retry without a persistent watcher
          // failure triggering an endless refresh/re-register cycle.
          if (watchers.get(directory) === pending) watchers.delete(directory);
        },
      ).then((watcher) => {
        // Retry on the next log request if the watcher could not be installed.
        if (!watcher && watchers.get(directory) === pending) {
          watchers.delete(directory);
        }
        return watcher;
      });
      watchers.set(directory, pending);
      return pending;
    };

    const registration = await context.rpc.register(BigCat, {
      log: async (input, request) => {
        const { directory: requested } = input as { directory: string };
        const directory = requested || context.location.directory;
        const log = await readLog(directory, maxCommits, request.signal);
        await ensureWatcher(directory, Boolean(log.repository));
        return log;
      },
      details: async (input, request) => {
        const { directory, hash } = input as {
          directory: string;
          hash: string;
        };
        return {
          message: await git(
            directory || context.location.directory,
            ["show", "-s", "--format=%B", hash, "--"],
            request.signal,
          ),
        };
      },
      diff: async (input, request) => {
        const { directory, hash } = input as {
          directory: string;
          hash: string;
        };
        return {
          diff: await git(
            directory || context.location.directory,
            ["show", "--format=", "--no-ext-diff", hash, "--"],
            request.signal,
            // Diffs can end in a significant " " context line.
            { trim: false },
          ),
        };
      },
      workingDiff: async (input, request) => {
        const { directory, staged } = input as {
          directory: string;
          staged: boolean;
        };
        return {
          diff: await git(
            directory || context.location.directory,
            ["diff", "--no-ext-diff", ...(staged ? ["--staged"] : []), "--"],
            request.signal,
            // Diffs can end in a significant " " context line.
            { trim: false },
          ),
        };
      },
    });

    emitChanged = (directory) => {
      registration.events.emit("changed", { directory }).catch(() => {});
    };

    return async () => {
      emitChanged = () => {};
      const pending = [...watchers.values()];
      watchers.clear();
      for (const watcher of await Promise.all(pending)) watcher?.close();
    };
  },
});
