import { usePlugin } from "@opencode/plugin/tui";
import type { PanelInput } from "@opencode/plugin/tui/context";
import { SyntaxStyle } from "@opentui/core";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";

export type DiffPanel = { title: string; files: string[] };

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
  None = 0,
  Addition = 1,
  Removal = 2,
  Mixed = ChangeKinds.Addition | ChangeKinds.Removal,
}

function diffChangeKinds(diff: string): ChangeKinds {
  let inHunk = false;
  let kind: ChangeKinds = ChangeKinds.None;

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

    kind |= line.startsWith("+")
      ? ChangeKinds.Addition
      : line.startsWith("-")
        ? ChangeKinds.Removal
        : ChangeKinds.None;

    if (kind === ChangeKinds.Mixed) break;
  }

  return kind;
}

function filePathFromDiff(diff: string, index: number): string {
  return (
    diff.match(/^\+\+\+ b\/(.+)$/m)?.[1] ??
    diff.match(/^--- a\/(.+)$/m)?.[1] ??
    diff.match(/^diff --git a\/(.+) b\//m)?.[1] ??
    `file ${index + 1}`
  );
}

export function GitDiffPanel(props: {
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
