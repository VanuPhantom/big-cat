import { Plugin, usePlugin } from "@opencode/plugin/tui";
import type { PanelInput } from "@opencode/plugin/tui/context";
import { SyntaxStyle } from "@opentui/core";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { BigCat } from "./rpc.js";

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
type DiffPanel = { title: string; files: string[] };

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

function filetypeFromDiff(diff: string): string | undefined {
  const path = diff.match(/^\+\+\+ b\/(.+)$/m)?.[1];
  const extension = path?.split(".").pop()?.toLowerCase();
  return (
    {
      cjs: "javascript",
      cts: "typescript",
      js: "javascript",
      json: "json",
      jsx: "javascriptreact",
      md: "markdown",
      mts: "typescript",
      mjs: "javascript",
      py: "python",
      rs: "rust",
      sh: "bash",
      ts: "typescript",
      tsx: "typescriptreact",
      yml: "yaml",
      yaml: "yaml",
    } as Record<string, string>
  )[extension ?? ""];
}

function splitFileDiffs(diff: string): string[] {
  const files = diff.split(/(?=^diff --git )/m).filter(Boolean);
  return files.length > 0 ? files : [diff];
}

type HunkRange = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
};

function hunkRange(header: string): HunkRange | undefined {
  const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return;

  return {
    oldStart: Number(match[1]),
    oldCount: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newCount: Number(match[4] ?? 1),
  };
}

type DiffHunk = {
  diff: string;
  height: number;
  separator?: string;
};

function hunkHeight(hunk: string, view: "unified" | "split"): number {
  const lines = hunk.split(/\r?\n/).slice(1);
  if (view === "unified") {
    return Math.max(1, lines.filter((line) => /^[ +\-]/.test(line)).length);
  }

  let rows = 0;
  for (let index = 0; index < lines.length;) {
    const kind = lines[index]?.[0];
    if (kind === undefined) {
      index++;
      continue;
    }
    if (kind === " ") {
      rows++;
      index++;
      continue;
    }
    if (kind === "\\") {
      index++;
      continue;
    }

    let additions = 0;
    let removals = 0;
    while (index < lines.length) {
      const change = lines[index]?.[0];
      if (change === "+") additions++;
      else if (change === "-") removals++;
      else break;
      index++;
    }
    rows += Math.max(additions, removals);
  }
  return Math.max(1, rows);
}

function splitDiffHunks(diff: string, view: "unified" | "split"): DiffHunk[] {
  const parts = diff.split(/(?=^@@ )/m);
  const header = parts.shift() ?? "";
  let previous: HunkRange | undefined;

  const hunks = parts.flatMap((part) => {
    const current = hunkRange(part);
    if (!current) return [];
    const entry: DiffHunk = {
      diff: `${header}${part}`,
      height: hunkHeight(part, view),
    };
    if (!previous) {
      previous = current;
      return [entry];
    }

    const unchangedOld = Math.max(
      0,
      current.oldStart - (previous.oldStart + previous.oldCount),
    );
    const unchangedNew = Math.max(
      0,
      current.newStart - (previous.newStart + previous.newCount),
    );
    previous = current;

    if (unchangedOld === 0 && unchangedNew === 0) return [entry];

    const unchanged =
      unchangedOld === unchangedNew
        ? `${unchangedNew} unchanged lines`
        : `${unchangedOld}/${unchangedNew} unchanged lines`;
    return [{ ...entry, separator: `──── ${unchanged} omitted ────` }];
  });

  return hunks.length > 0
    ? hunks
    : [{ diff, height: Math.max(1, diff.split(/\r?\n/).length) }];
}

enum ChangeKinds {
  Addition,
  Removal,
  Mixed,
}

function diffChangeKinds(diff: string): ChangeKinds {
  let inHunk = false;
  let kind: ChangeKinds | undefined;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    const lineKind = line.startsWith("+")
      ? ChangeKinds.Addition
      : line.startsWith("-")
        ? ChangeKinds.Removal
        : undefined;

    if (lineKind === undefined) continue;
    if (kind !== undefined && kind !== lineKind) return ChangeKinds.Mixed;
    kind = lineKind;
  }

  return kind ?? ChangeKinds.Addition;
}

function filePathFromDiff(diff: string, index: number): string {
  return (
    diff.match(/^\+\+\+ b\/(.+)$/m)?.[1] ??
    diff.match(/^--- a\/(.+)$/m)?.[1] ??
    diff.match(/^diff --git a\/(.+) b\//m)?.[1] ??
    `file ${index + 1}`
  );
}

function GitLogSidebar(props: { openDiff: (diff: DiffPanel) => void }) {
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
  const refresh = () => {
    refreshQueued = true;
    if (refreshing || disposed) return;
    refreshing = true;
    setLoading(true);
    void (async () => {
      while (refreshQueued && !disposed) {
        refreshQueued = false;
        const requestedDirectory = directory();
        setError("");
        try {
          const next = (await client().log({
            directory: requestedDirectory,
          })) as GitLog;
          if (requestedDirectory !== directory()) {
            refreshQueued = true;
          } else if (!disposed) {
            setLog(next);
          }
        } catch {
          if (requestedDirectory !== directory()) {
            refreshQueued = true;
          } else if (!disposed) {
            setError("Could not load GIT log. Try refreshing Big Cat.");
          }
        }
      }
      refreshing = false;
      if (!disposed) setLoading(false);
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

function GitDiffPanel(props: {
  panel: PanelInput;
  diff: DiffPanel | undefined;
}) {
  const context = usePlugin();
  const panel = props.diff;
  const [activeFile, setActiveFile] = createSignal(0);
  const fileDiff = createMemo(() => panel?.files[activeFile()] ?? "");
  const fileCount = () => panel?.files.length ?? 0;
  const previousFile = () => setActiveFile((index) => Math.max(0, index - 1));
  const nextFile = () =>
    setActiveFile((index) => Math.min(fileCount() - 1, index + 1));
  createEffect(() => {
    props.diff?.title;
    setActiveFile(0);
  });
  context.keymap.layer(() => ({
    commands: [
      {
        id: "big-cat.diff.close",
        title: "Close GIT diff",
        bind: "escape,q",
        run: props.panel.close,
      },
      {
        id: "big-cat.diff.previous-file",
        title: "Previous GIT diff file",
        bind: "p,left",
        run: previousFile,
      },
      {
        id: "big-cat.diff.next-file",
        title: "Next GIT diff file",
        bind: "n,right",
        run: nextFile,
      },
    ],
  }));
  const syntaxStyle = createMemo(() => {
    const theme = context.theme;
    const style = SyntaxStyle.fromStyles(
      {
        default: { fg: theme.text.base },
        comment: { fg: theme.syntax.comment, italic: true },
        string: { fg: theme.syntax.string },
        number: { fg: theme.syntax.number },
        boolean: { fg: theme.syntax.number },
        constant: { fg: theme.syntax.number },
        keyword: { fg: theme.syntax.keyword, italic: true },
        "keyword.import": { fg: theme.syntax.keyword },
        function: { fg: theme.syntax.function },
        "function.call": { fg: theme.syntax.variable },
        "function.method": { fg: theme.syntax.function },
        "function.method.call": { fg: theme.syntax.variable },
        variable: { fg: theme.syntax.variable },
        "variable.parameter": { fg: theme.syntax.variable },
        "variable.member": { fg: theme.syntax.function },
        property: { fg: theme.syntax.variable },
        type: { fg: theme.syntax.type },
        "type.definition": { fg: theme.syntax.type, bold: true },
        operator: { fg: theme.syntax.operator },
        punctuation: { fg: theme.syntax.punctuation },
        "punctuation.delimiter": { fg: theme.syntax.operator },
        "punctuation.special": { fg: theme.syntax.operator },
        "markup.heading": { fg: theme.markdown.heading, bold: true },
        "markup.heading.1": {
          fg: theme.markdown.heading,
          bold: true,
          underline: true,
        },
        "markup.heading.2": { fg: theme.markdown.heading, bold: true },
        "markup.heading.3": { fg: theme.markdown.heading, bold: true },
        "markup.heading.4": { fg: theme.markdown.heading, bold: true },
        "markup.heading.5": { fg: theme.markdown.heading, bold: true },
        "markup.heading.6": { fg: theme.markdown.heading, bold: true },
        "markup.bold": { fg: theme.markdown.strong, bold: true },
        "markup.strong": { fg: theme.markdown.strong, bold: true },
        "markup.italic": { fg: theme.markdown.emphasis, italic: true },
        "markup.list": { fg: theme.markdown.listItem },
        "markup.quote": { fg: theme.markdown.blockQuote, italic: true },
        "markup.raw": { fg: theme.markdown.code },
        "markup.raw.block": { fg: theme.markdown.code },
        "markup.link": { fg: theme.markdown.link, underline: true },
        "markup.link.url": { fg: theme.markdown.link, underline: true },
        "markup.link.label": { fg: theme.markdown.linkText, underline: true },
        label: { fg: theme.markdown.linkText },
      },
      context.renderer.nativeScene,
    );
    onCleanup(() => style.destroy());
    return style;
  });

  if (!panel) return <box />;

  const changeKind = createMemo(() => diffChangeKinds(fileDiff()));
  const diffView = createMemo(() =>
    context.renderer.width >= 120 && changeKind() === ChangeKinds.Mixed
      ? "split"
      : "unified",
  );
  const fileHunks = createMemo(() => splitDiffHunks(fileDiff(), diffView()));
  const theme = context.theme;

  return (
    <box
      flexDirection="column"
      height="100%"
      minHeight={0}
      overflow="hidden"
      padding={1}
      gap={1}
    >
      <box flexDirection="row" flexShrink={0} justifyContent="space-between">
        <text
          fg={theme.text.base}
        >{`${panel.title} (${fileCount()} files)`}</text>
        <text fg={theme.text.muted} onMouseUp={props.panel.close}>
          Close
        </text>
      </box>
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text fg={theme.text.muted} onMouseUp={previousFile}>
          ← Prev
        </text>
        <text
          fg={theme.text.base}
        >{`${activeFile() + 1}/${fileCount()} ${filePathFromDiff(fileDiff(), activeFile())}`}</text>
        <text fg={theme.text.muted} onMouseUp={nextFile}>
          Next →
        </text>
      </box>
      <scrollbox flexGrow={1} flexShrink={1} minHeight={0} scrollY>
        <box flexDirection="column" width="100%">
          <For each={fileHunks()}>
            {(hunk) => (
              <box flexDirection="column" flexShrink={0}>
                <Show when={hunk.separator}>
                  <text fg={theme.text.muted}>{hunk.separator}</text>
                </Show>
                <diff
                  diff={hunk.diff}
                  height={hunk.height}
                  width="100%"
                  flexShrink={0}
                  view={diffView()}
                  wrapMode="none"
                  filetype={filetypeFromDiff(fileDiff())}
                  syntaxStyle={syntaxStyle()}
                  fg={theme.text.base}
                  addedBg={theme.diff.background.added}
                  removedBg={theme.diff.background.removed}
                  contextBg={theme.diff.background.context}
                  addedSignColor={theme.diff.text.added}
                  removedSignColor={theme.diff.text.removed}
                  lineNumberFg={theme.diff.lineNumber.text}
                  lineNumberBg={theme.background.base}
                  addedLineNumberBg={theme.diff.lineNumber.background.added}
                  removedLineNumberBg={theme.diff.lineNumber.background.removed}
                  showLineNumbers
                />
              </box>
            )}
          </For>
        </box>
      </scrollbox>
    </box>
  );
}

export default Plugin.define({
  id: "big-cat.tui",
  setup(context) {
    const [diff, setDiff] = createSignal<DiffPanel | undefined>();
    const sidebar = context.ui.slot({
      prepend: "sidebar.content",
      render: () => (
        <GitLogSidebar
          openDiff={(next) => {
            setDiff(next);
            context.ui.panel.open("big-cat.diff", {
              presentation: "fullscreen",
            });
          }}
        />
      ),
    });
    const panel = context.ui.slot({
      append: "session.panel",
      render: (input) => (
        <Show when={input.name === "big-cat.diff"}>
          <GitDiffPanel panel={input} diff={diff()} />
        </Show>
      ),
    });
    return () => {
      sidebar();
      panel();
    };
  },
});
