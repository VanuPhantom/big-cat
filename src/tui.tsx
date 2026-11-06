import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { SyntaxStyle } from "@opentui/core"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { BigCat } from "./rpc.js"

type GitLog = {
  repository: string
  branch: string
  commits: Array<{ hash: string; author: string; date: string; subject: string }>
  message: string
}

type CommitDetails = { message: string }
type CommitDiff = { diff: string }

const emptyLog: GitLog = { repository: "", branch: "", commits: [], message: "" }

function shorten(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

function relativeDate(value: string): string {
  const date = new Date(`${value}T00:00:00`)
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000)
  if (!Number.isFinite(days) || days < 0) return value
  if (days === 0) return "today"
  if (days === 1) return "yesterday"
  return `${days}d ago`
}

function filetypeFromDiff(diff: string): string | undefined {
  const path = diff.match(/^\+\+\+ b\/(.+)$/m)?.[1]
  const extension = path?.split(".").pop()?.toLowerCase()
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
  )[extension ?? ""]
}

function GitLogSidebar() {
  const context = usePlugin()
  const client = () => context.client.rpc(BigCat)
  const directory = () => context.location?.directory ?? context.data.location.default().directory
  const syntaxStyle = createMemo(() => {
    const theme = context.theme
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
        "markup.heading.1": { fg: theme.markdown.heading, bold: true, underline: true },
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
    )
    onCleanup(() => style.destroy())
    return style
  })
  const [log, setLog] = createSignal<GitLog>(emptyLog)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")

  const refresh = async () => {
    setLoading(true)
    setError("")
    try {
      setLog((await client().log({ directory: directory() })) as GitLog)
    } catch {
      setError("Could not load Git log. Try refreshing Big Cat.")
    } finally {
      setLoading(false)
    }
  }

  const inspectCommit = async (commit: GitLog["commits"][number]) => {
    try {
      const { message } = (await client().details({ directory: directory(), hash: commit.hash })) as CommitDetails
      const content = message || "This commit has no message."
      const maxHeight = Math.max(8, context.renderer.height - 12)
      const messageHeight = Math.min(Math.max(4, content.split(/\r?\n/).length), maxHeight)

      context.ui.dialog.show(() => (
        <box flexDirection="column" padding={1} gap={1}>
          <text fg={context.theme.text.base}>{`${commit.hash.slice(0, 7)} ${commit.subject}`}</text>
          <scrollbox height={messageHeight} scrollY>
            <text fg={context.theme.text.muted}>{content}</text>
          </scrollbox>
          <box flexDirection="row" gap={1}>
            <text fg={context.theme.primary} onMouseUp={() => void showCommitDiff(commit)}>
              View diff
            </text>
            <text fg={context.theme.text.muted}>·</text>
            <text fg={context.theme.text.muted} onMouseUp={() => context.ui.dialog.clear()}>
              Cancel
            </text>
          </box>
        </box>
      ))
      context.ui.dialog.set({ size: "large", centered: true })
    } catch {
      context.ui.toast.show({ message: "Could not load commit details.", variant: "error" })
    }
  }

  const showCommitDiff = async (commit: GitLog["commits"][number]) => {
    context.ui.dialog.clear()
    try {
      const { diff } = (await client().diff({ directory: directory(), hash: commit.hash })) as CommitDiff
      if (!diff) {
        await context.ui.dialog.alert({ title: `${commit.hash.slice(0, 7)} diff`, message: "This commit has no file changes." })
        return
      }

      const maxHeight = Math.max(8, context.renderer.height - 8)
      const diffHeight = Math.min(Math.max(6, diff.split("\n").length), maxHeight)
      const hasAddedLines = /^\+(?!\+\+)/m.test(diff)
      const hasRemovedLines = /^-(?!---)/m.test(diff)
      const diffView = context.renderer.width >= 120 && hasAddedLines && hasRemovedLines ? "split" : "unified"
      const theme = context.theme
      context.ui.dialog.show(() => (
        <box flexDirection="column" padding={1} gap={1}>
          <text fg={context.theme.text.base}>{`${commit.hash.slice(0, 7)} diff`}</text>
          <diff
            diff={diff}
            height={diffHeight}
            view={diffView}
            wrapMode="none"
            filetype={filetypeFromDiff(diff)}
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
          <text fg={context.theme.text.muted} onMouseUp={() => context.ui.dialog.clear()}>
            Cancel
          </text>
        </box>
      ))
      context.ui.dialog.set({ size: "xlarge", centered: true })
    } catch {
      context.ui.toast.show({ message: "Could not load the commit diff.", variant: "error" })
    }
  }

  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 15_000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1} gap={1}>
      <box flexDirection="row" gap={1}>
        <text fg={context.theme.text.base}>Big Cat</text>
        <text fg={context.theme.text.muted}>{loading() ? "stretching…" : "Git log"}</text>
      </box>

      <Show when={log().branch}>
        <text fg={context.theme.text.muted}>{shorten(log().branch, 34)}</text>
      </Show>

      <Show when={error() || log().message}>
        <text fg={context.theme.text.muted}>{error() || log().message}</text>
      </Show>

      <Show when={log().commits.length > 0}>
        <text fg={context.theme.text.muted}>Click a commit to inspect it.</text>
      </Show>

      <For each={log().commits}>
        {(commit) => (
          <box flexDirection="column" marginBottom={1} onMouseUp={() => void inspectCommit(commit)}>
            <box flexDirection="row" gap={1}>
              <text fg={context.theme.primary}>{commit.hash.slice(0, 7)}</text>
              <text fg={context.theme.text.muted}>{relativeDate(commit.date)}</text>
            </box>
            <text fg={context.theme.text.base}>{shorten(commit.subject, 46)}</text>
            <text fg={context.theme.text.muted}>{shorten(commit.author, 32)}</text>
          </box>
        )}
      </For>

      <Show when={!loading() && !error() && !log().message && log().commits.length === 0}>
        <text fg={context.theme.text.muted}>No commits yet.</text>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "big-cat.tui",
  setup(context) {
    return context.ui.slot({
      prepend: "sidebar.content",
      render: () => <GitLogSidebar />,
    })
  },
})
