import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const configDirectory = mkdtempSync(join(tmpdir(), "big-cat-e2e-config-"));
const emptyGitConfig = join(configDirectory, "gitconfig");
writeFileSync(emptyGitConfig, "");
process.on("exit", () =>
  rmSync(configDirectory, { recursive: true, force: true }),
);

// Big Cat's server half shells out to GIT from this process, so the test
// process itself must not see the developer's GIT configuration (signing,
// hooks, default branch names, pagers, …).
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: emptyGitConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Big Cat",
  GIT_AUTHOR_EMAIL: "big-cat@example.com",
  GIT_COMMITTER_NAME: "Big Cat",
  GIT_COMMITTER_EMAIL: "big-cat@example.com",
  GIT_TERMINAL_PROMPT: "0",
});

/**
 * A throwaway directory, optionally turned into a GIT repository, that is
 * deleted when the test's `using` scope ends.
 */
export class Workspace {
  readonly directory: string;

  private constructor() {
    // Resolve /var → /private/var on macOS so paths match GIT's output.
    this.directory = realpathSync(mkdtempSync(join(tmpdir(), "big-cat-e2e-")));
  }

  /** An empty directory that is not a GIT repository. */
  static empty(): Workspace {
    return new Workspace();
  }

  /** An empty repository on `main` without any commits. */
  static repository(): Workspace {
    return new Workspace().init();
  }

  init(): this {
    this.git("init", "-q", "-b", "main");
    return this;
  }

  path(...segments: string[]): string {
    return join(this.directory, ...segments);
  }

  write(file: string, content: string): this {
    const path = this.path(file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return this;
  }

  git(...args: string[]): string {
    return this.run(args);
  }

  /**
   * Writes and stages `files`, then commits them. Returns the full hash.
   * Without files, the commit is empty.
   */
  commit(
    message: string,
    files: Record<string, string> = {},
    { date }: { date?: Date } = {},
  ): string {
    for (const [file, content] of Object.entries(files)) {
      this.write(file, content);
      this.git("add", "--", file);
    }
    const empty = Object.keys(files).length === 0 ? ["--allow-empty"] : [];
    const env: Record<string, string> = date
      ? {
          GIT_AUTHOR_DATE: date.toISOString(),
          GIT_COMMITTER_DATE: date.toISOString(),
        }
      : {};
    this.run(["commit", "-q", ...empty, "-m", message], env);
    return this.git("rev-parse", "HEAD");
  }

  private run(args: string[], env: Record<string, string> = {}): string {
    return execFileSync("git", args, {
      cwd: this.directory,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  [Symbol.dispose]() {
    rmSync(this.directory, { recursive: true, force: true });
  }
}
