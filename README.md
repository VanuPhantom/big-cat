# Big Cat

> Ooooo, biiiiggg stretch!

Adds a GIT log view to your OpenCode 2.0 installation.

---

_Big Cat_ adds a GIT log to the top of your OpenCode TUI's right-hand sidebar.
It shows the current branch, recent commits, authors, and relative commit
dates. It refreshes as soon as something changes: the plugin watches the
repository's GIT metadata (`HEAD`, the index, and branch refs) to catch
commits, checkouts, staging, resets, and rebases. It also watches the working
tree and listens to OpenCode's file change events, so edits made by external
editors update the unstaged changes indicator without polling.

## Install

_Big Cat_ has not yet been published on NPM.
If you'd like to try it, you can install it from GIT directly:

```sh
npm install git+https://github.com/VanuPhantom/big-cat
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

OpenCode reloads the plugin configuration automatically.
Start or return to a session and Big Cat will appear in the sidebar.

## Usage

- Big Cat uses the GIT state that is visible in the current session's working directory.
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

Big Cat requires GIT to be installed. Outside a GIT repository, it displays a
friendly empty-state message instead of running any GIT commands that mutate
the working tree.
