import { Plugin } from "@opencode/plugin/tui";
import { Show, createSignal } from "solid-js";
import { GitDiffPanel, type DiffPanel } from "./GitDiffPanel.js";
import { GitLogSidebar } from "./GitLogSidebar.js";

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
