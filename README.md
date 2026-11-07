# Big Cat

> Ooooo, biiiiggg stretch!

Adds a Git log view to your OpenCode 2.0 installation.

---

_Big Cat_ adds a Git log to the top of your OpenCode TUI's right-hand sidebar.
It shows the current branch, recent commits, authors, and relative commit
dates, and refreshes automatically every 15 seconds.

## Install

Install the plugin from npm once published:

```sh
npm install big-cat
```

Then add it to your project's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["big-cat"],
}
```

For local development, reference this directory instead:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/big-cat"],
}
```

OpenCode reloads plugin configuration automatically. Start or return to a
session and Big Cat will appear in the sidebar.

## Usage

- Big Cat reads the repository associated with the active OpenCode location;
  it never changes Git state.
- Click a commit to read its complete commit message. Choose **View diff** to
  open its patch in a fullscreen panel, or **Cancel** to return to the log.
- The diff panel shows one file at a time. Use **Prev** and **Next**, or the
  `p`/`n` and left/right arrow keys, to move between files. Press `Esc` or `q`,
  or click **Close**, to return to the session.
- Diffs use OpenCode's theme colors, line numbers, and syntax highlighting for
  supported file types. On wide terminals, files with both additions and
  removals use a split view; add-only and remove-only files use a unified
  view.
- Set `limit` to choose how many commits to show (1–100, default: 12):

```jsonc
{
  "plugins": [
    {
      "package": "big-cat",
      "options": { "limit": 20 },
    },
  ],
}
```

## Development

```sh
npm install
npm run check
```

Big Cat requires Git to be installed. Outside a Git repository, it displays a
friendly empty-state message instead of running any Git commands that mutate
the working tree.
