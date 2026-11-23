import { usePlugin } from "@opencode/plugin/tui";
import {
  For,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { BigCat } from "../rpc.js";
import type { DiffPanel } from "./GitDiffPanel.js";

type GitLog = {
  repository: string;
  branch: string;
  commits: Array<{
    hash: string;
    author: string;
    date: string;
    subject: string;
  }>;
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  message: string;
};

type CommitDetails = { message: string };
type CommitDiff = { diff: string };

const emptyLog: GitLog = {
  repository: "",
  branch: "",
  commits: [],
  hasStagedChanges: false,
  hasUnstagedChanges: false,
  message: "",
};

function shorten(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function relativeDate(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return value;
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

function isUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "rpc.unavailable"
  );
}

function splitFileDiffs(diff: string): string[] {
  const files = diff.split(/(?=^diff --git )/m).filter(Boolean);
  return files.length > 0 ? files : [diff];
}

export function GitLogSidebar(props: { openDiff: (diff: DiffPanel) => void }) {
  const context = usePlugin();
  const client = () => context.client.rpc(BigCat);
  const directory = () =>
    context.location?.directory ?? context.data.location.default().directory;
  const [log, setLog] = createSignal<GitLog>(emptyLog);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");

  let refreshing = false;
  let refreshQueued = false;
  let disposed = false;
  // The server half of Big Cat registers its RPC asynchronously, so calls
  // made while OpenCode is starting up can fail with `rpc.unavailable`.
  let unavailableTimer: ReturnType<typeof setTimeout> | undefined;
  let unavailableDelay = 250;
  const maxUnavailableDelay = 8_000;
  const refresh = () => {
    clearTimeout(unavailableTimer);
    unavailableTimer = undefined;
    refreshQueued = true;
    if (refreshing || disposed) return;
    refreshing = true;
    setLoading(true);
    void (async () => {
      let unavailable = false;
      while (refreshQueued && !disposed) {
        refreshQueued = false;
        unavailable = false;
        const requestedDirectory = directory();
        setError("");
        try {
          const next = (await client().log({
            directory: requestedDirectory,
          })) as GitLog;
          unavailableDelay = 250;
          if (requestedDirectory !== directory()) {
            refreshQueued = true;
          } else if (!disposed) {
            setLog(next);
          }
        } catch (cause) {
          if (requestedDirectory !== directory()) {
            refreshQueued = true;
          } else if (
            isUnavailable(cause) &&
            unavailableDelay <= maxUnavailableDelay
          ) {
            unavailable = true;
          } else if (!disposed) {
            setError("Could not load GIT log. Try refreshing Big Cat.");
          }
        }
      }
      refreshing = false;
      if (disposed) return;
      if (unavailable) {
        // Stay in the loading state while waiting for the server to register.
        unavailableTimer = setTimeout(refresh, unavailableDelay);
        unavailableDelay *= 2;
        return;
      }
      setLoading(false);
    })();
  };

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh(), 250);
  };

  const inspectCommit = async (commit: GitLog["commits"][number]) => {
    try {
      const { message } = (await client().details({
        directory: directory(),
        hash: commit.hash,
      })) as CommitDetails;
      const content = message || "This commit has no message.";
      const maxHeight = Math.max(8, context.renderer.height - 12);
      const messageHeight = Math.min(
        Math.max(4, content.split(/\r?\n/).length),
        maxHeight,
      );

      context.ui.dialog.show(() => (
        <box flexDirection="column" padding={1} gap={1}>
          <text
            fg={context.theme.text.base}
          >{`${commit.hash.slice(0, 7)} ${commit.subject}`}</text>
          <scrollbox height={messageHeight} scrollY>
            <text fg={context.theme.text.muted}>{content}</text>
          </scrollbox>
          <box flexDirection="row" gap={1}>
            <text
              fg={context.theme.primary}
              onMouseUp={() => void showCommitDiff(commit)}
            >
              View diff
            </text>
            <text fg={context.theme.text.muted}>·</text>
            <text
              fg={context.theme.text.muted}
              onMouseUp={() => context.ui.dialog.clear()}
            >
              Cancel
            </text>
          </box>
        </box>
      ));
      context.ui.dialog.set({ size: "large", centered: true });
    } catch {
      context.ui.toast.show({
        message: "Could not load commit details.",
        variant: "error",
      });
    }
  };

  const showCommitDiff = async (commit: GitLog["commits"][number]) => {
    context.ui.dialog.clear();
    try {
      const { diff } = (await client().diff({
        directory: directory(),
        hash: commit.hash,
      })) as CommitDiff;
      if (!diff) {
        await context.ui.dialog.alert({
          title: `${commit.hash.slice(0, 7)} diff`,
          message: "This commit has no file changes.",
        });
        return;
      }

      props.openDiff({
        title: `${commit.hash.slice(0, 7)} diff`,
        files: splitFileDiffs(diff),
      });
    } catch {
      context.ui.toast.show({
        message: "Could not load the commit diff.",
        variant: "error",
      });
    }
  };

  const showWorkingDiff = async (staged: boolean) => {
    const title = staged ? "Staged changes" : "Unstaged changes";
    try {
      const { diff } = (await client().workingDiff({
        directory: directory(),
        staged,
      })) as CommitDiff;
      if (!diff) {
        await context.ui.dialog.alert({
          title,
          message: staged
            ? "There are no staged file changes."
            : "There are no unstaged file changes.",
        });
        return;
      }

      props.openDiff({ title, files: splitFileDiffs(diff) });
    } catch {
      context.ui.toast.show({
        message: `Could not load ${title}.`,
        variant: "error",
      });
    }
  };

  onMount(() => {
    // Commits, checkouts, staging, etc., reported by the server's .git watcher.
    const offGitChange = client().events.on("changed", (event) => {
      if (event.data.directory === directory()) scheduleRefresh();
    });
    // Working tree edits, which can change the unstaged changes indicator.
    const offFileChange = context.data.on("filesystem.changed", (event) => {
      if (event.location && event.location.directory !== directory()) return;
      // An initially empty/non-repository directory may become a repository.
      if (log().repository && event.data.file.split(/[\\/]/).includes(".git")) {
        return;
      }
      scheduleRefresh();
    });
    // Subscriptions must be live before the first log request installs a watcher.
    refresh();
    onCleanup(() => {
      disposed = true;
      clearTimeout(refreshTimer);
      clearTimeout(unavailableTimer);
      offGitChange();
      offFileChange();
    });
  });

  // Follow the session to another directory.
  createEffect(on(directory, refresh, { defer: true }));

  return (
    <box
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      gap={1}
    >
      <box flexDirection="row" gap={1}>
        <text fg={context.theme.text.base}>Big Cat</text>
        <text fg={context.theme.text.muted}>
          {loading() ? "stretching…" : "GIT log"}
        </text>
      </box>

      <Show when={log().branch}>
        <text fg={context.theme.text.muted}>{shorten(log().branch, 34)}</text>
      </Show>

      <box flexDirection="row" gap={1}>
        <text
          fg={
            log().hasUnstagedChanges
              ? context.theme.primary
              : context.theme.text.muted
          }
          onMouseUp={
            log().hasUnstagedChanges
              ? () => void showWorkingDiff(false)
              : undefined
          }
        >
          Unstaged changes
        </text>
        <text fg={context.theme.text.muted}>·</text>
        <text
          fg={
            log().hasStagedChanges
              ? context.theme.primary
              : context.theme.text.muted
          }
          onMouseUp={
            log().hasStagedChanges
              ? () => void showWorkingDiff(true)
              : undefined
          }
        >
          Staged changes
        </text>
      </box>

      <Show when={error() || log().message}>
        <text fg={context.theme.text.muted}>{error() || log().message}</text>
      </Show>

      <Show when={log().commits.length > 0}>
        <text fg={context.theme.text.muted}>Click a commit to inspect it.</text>
      </Show>

      <For each={log().commits}>
        {(commit) => (
          <box
            flexDirection="column"
            marginBottom={1}
            onMouseUp={() => void inspectCommit(commit)}
          >
            <box flexDirection="row" gap={1}>
              <text fg={context.theme.primary}>{commit.hash.slice(0, 7)}</text>
              <text fg={context.theme.text.muted}>
                {relativeDate(commit.date)}
              </text>
            </box>
            <text fg={context.theme.text.base}>
              {shorten(commit.subject, 46)}
            </text>
            <text fg={context.theme.text.muted}>
              {shorten(commit.author, 32)}
            </text>
          </box>
        )}
      </For>

      <Show
        when={
          !loading() && !error() && !log().message && log().commits.length === 0
        }
      >
        <text fg={context.theme.text.muted}>No commits yet.</text>
      </Show>
    </box>
  );
}
