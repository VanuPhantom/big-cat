import { execFile } from "node:child_process";
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
  message: string;
};

async function git(
  directory: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: directory,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    signal,
  });
  return stdout.trim();
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
    const [branch, output] = await Promise.all([
      git(directory, ["branch", "--show-current"], signal),
      git(
        directory,
        [
          "log",
          `--max-count=${limit}`,
          "--date=short",
          `--pretty=format:%H%x1f%an%x1f%ad%x1f%s%x1e`,
        ],
        signal,
      ),
    ]);

    return {
      repository,
      branch: branch || "detached HEAD",
      commits: parseCommits(output),
      message: "",
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      repository: "",
      branch: "",
      commits: [],
      message: "No Git repository found for this OpenCode location.",
    };
  }
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

    await context.rpc.register(BigCat, {
      log: (input, request) => {
        const { directory } = input as { directory: string };
        return readLog(
          directory || context.location.directory,
          maxCommits,
          request.signal,
        );
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
          ),
        };
      },
    });
  },
});
