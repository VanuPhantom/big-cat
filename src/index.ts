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
  repository: string,
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
    optional = false,
  ): boolean => {
    try {
      const watcher = watch(path, { recursive }, (_event, file) => {
        if (!file || filter(file.toString())) notify();
      });
      watcher.on("error", () => {
        if (closed) return;
        if (optional) {
          watcher.close();
          return;
        }
        close();
        onFailure();
      });
      watchers.push(watcher);
      return true;
    } catch {
      return false;
    }
  };

  // Watch directories rather than files: GIT replaces files by renaming
  // lock files over them, which detaches file-level watchers.
  const metadata = [
    add(gitDir, false, (file) => watchedGitDirFiles.has(file)),
    commonDir === gitDir ||
      add(commonDir, false, (file) => file === "packed-refs"),
    add(
      join(commonDir, "refs", "heads"),
      true,
      (file) => !file.endsWith(".lock"),
    ),
  ];
  if (metadata.includes(false)) {
    close();
    return;
  }

  // OpenCode's filesystem events are not guaranteed for edits made outside
  // OpenCode (for example by an editor or a shell in another process).
  add(
    repository,
    true,
    (file) => !file.split(/[\\/]/).includes(".git"),
    true,
  );

  return { kind: "repository", close };
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
    const retries = new Map<string, ReturnType<typeof setTimeout>>();
    const retryDelays = new Map<string, number>();
    let stopped = false;
    let emitChanged: (directory: string) => void = () => {};

    const clearRetry = (directory: string) => {
      clearTimeout(retries.get(directory));
      retries.delete(directory);
    };

    const scheduleRetry = (directory: string) => {
      if (stopped || retries.has(directory)) return;
      const delay = retryDelays.get(directory) ?? 1_000;
      retryDelays.set(directory, Math.min(delay * 2, 30_000));
      retries.set(
        directory,
        setTimeout(() => {
          retries.delete(directory);
          if (stopped) return;
          const signal = AbortSignal.timeout(10_000);
          void git(directory, ["rev-parse", "--show-toplevel"], signal)
            .catch(() => "")
            .then((repository) => ensureWatcher(directory, repository))
            .then((watcher) => {
              if (watcher && !stopped) emitChanged(directory);
            })
            .catch(() => scheduleRetry(directory));
        }, delay),
      );
    };

    const ensureWatcher = async (directory: string, repository: string) => {
      if (stopped) return;
      const existing = watchers.get(directory);
      if (existing) {
        const watcher = await existing;
        if (stopped) return;
        if (watchers.get(directory) !== existing) {
          return ensureWatcher(directory, repository);
        }
        if (watcher?.kind === (repository ? "repository" : "directory")) {
          clearRetry(directory);
          return watcher;
        }
        // Switch between repository and directory watchers as Git appears/disappears.
        watcher?.close();
        watchers.delete(directory);
      }
      const pending = watchRepository(
        directory,
        repository,
        () => {
          retryDelays.delete(directory);
          emitChanged(directory);
        },
        () => {
          if (watchers.get(directory) !== pending) return;
          watchers.delete(directory);
          scheduleRetry(directory);
        },
      ).then((watcher) => {
        if (watchers.get(directory) === pending) {
          if (watcher) clearRetry(directory);
          else {
            watchers.delete(directory);
            scheduleRetry(directory);
          }
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
        await ensureWatcher(directory, log.repository);
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
      stopped = true;
      emitChanged = () => {};
      for (const timer of retries.values()) clearTimeout(timer);
      retries.clear();
      retryDelays.clear();
      const pending = [...watchers.values()];
      watchers.clear();
      for (const watcher of await Promise.all(pending)) watcher?.close();
    };
  },
});
