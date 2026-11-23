/** @jsxImportSource @opentui/solid */
/**
 * A miniature OpenCode host for end-to-end tests, modelled on OpenCode's own
 * TUI plugin tests (`packages/tui/test` in the OpenCode repository): render
 * with OpenTUI's `testRender`, assert on `captureCharFrame()`, and drive the
 * UI with `mockMouse`/`mockInput`.
 *
 * Unlike a component test, nothing of Big Cat is stubbed. Both halves of the
 * plugin are loaded through their package entrypoints and wired together
 * through an RPC bridge, so a test exercises the real GIT commands, the real
 * filesystem watchers, the real RPC contract, and the real UI against a
 * throwaway repository.
 */
import type { KeyEvent } from "@opentui/core";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { PluginContextProvider } from "@opencode/plugin/tui";
import {
  For,
  type JSX,
  Show,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
} from "solid-js";
import server from "../../../src/index.ts";
import tui from "../../../src/tui/index.tsx";
import { RpcBridge } from "./rpc.ts";

export const sidebarWidth = 42;

type Slot = "sidebar.content" | "session.panel";
type Claim = { slot: Slot; render: (input: any) => JSX.Element };
type Dialog = { render: () => JSX.Element; onClose?: () => void };
type Toast = { message: string; variant?: string };
type Panel = { name: string; presentation: "panel" | "fullscreen" };
type KeymapCommand = { bind?: string | false; run: () => unknown };

export type HostOptions = {
  /** The directory OpenCode is located in. */
  directory: string;
  /** Plugin options, as given in `opencode.jsonc`. */
  options?: Record<string, unknown>;
  /** Start the server half only when `startServer()` is called. */
  deferServer?: boolean;
  width?: number;
  height?: number;
};

function color(hex: string) {
  return RGBA.fromHex(hex);
}

/** Just enough of OpenCode's resolved theme for Big Cat. */
const primary = color("#fab283");

function theme() {
  const text = color("#d0d0d0");
  const muted = color("#808080");
  const syntax = new Proxy({}, { get: () => text });
  return {
    primary,
    text: { base: text, muted },
    background: { base: color("#0a0a0a") },
    syntax,
    markdown: syntax,
    diff: {
      text: { added: color("#4fd6be"), removed: color("#c53b53") },
      background: {
        added: color("#20303b"),
        removed: color("#37222c"),
        context: color("#0a0a0a"),
      },
      lineNumber: {
        text: muted,
        background: { added: color("#1b2b34"), removed: color("#2d1f26") },
      },
    },
  };
}

export async function startHost(options: HostOptions) {
  const { directory } = options;
  const width = options.width ?? 120;
  const height = options.height ?? 40;
  const rpc = new RpcBridge(directory);

  // --- Server half -------------------------------------------------------
  let stopServer: (() => unknown) | void;
  const startServer = async () => {
    stopServer = await server.setup({
      location: { directory },
      options: options.options ?? {},
      rpc: rpc.server,
    } as any);
  };
  if (!options.deferServer) await startServer();

  // --- TUI host state ----------------------------------------------------
  const [claims, setClaims] = createSignal<Claim[]>([]);
  const [dialog, setDialog] = createSignal<Dialog | undefined>();
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  const [panel, setPanel] = createSignal<Panel | undefined>();
  const fileListeners = new Set<(event: any) => void>();
  const keymapLayers = new Set<() => { commands?: readonly KeymapCommand[] }>();
  let renderer: Awaited<ReturnType<typeof testRender>>["renderer"] | undefined;

  const clearDialog = () => {
    const current = dialog();
    setDialog(undefined);
    current?.onClose?.();
  };

  const context = {
    options: options.options ?? {},
    location: { directory },
    app: { version: "test", channel: "test" },
    get renderer() {
      if (!renderer) throw new Error("The renderer is not ready yet");
      return renderer;
    },
    theme: theme(),
    themeMode: "dark",
    client: { rpc: (definition: any) => rpc.client(definition) },
    data: {
      on: (type: string, handler: (event: any) => void) => {
        if (type !== "filesystem.changed") return () => {};
        fileListeners.add(handler);
        return () => fileListeners.delete(handler);
      },
      location: { default: () => ({ directory }) },
    },
    keymap: {
      layer: (factory: () => { commands?: readonly KeymapCommand[] }) => {
        keymapLayers.add(factory);
        if (getOwner()) onCleanup(() => keymapLayers.delete(factory));
      },
    },
    ui: {
      slot: (claim: any) => {
        const entry: Claim = {
          slot: claim.prepend ?? claim.append ?? claim.replace,
          render: claim.render,
        };
        setClaims((all) => (claim.prepend ? [entry, ...all] : [...all, entry]));
        return () => setClaims((all) => all.filter((item) => item !== entry));
      },
      panel: {
        open: (
          name: string,
          panelOptions?: { presentation?: Panel["presentation"] },
        ) => {
          setPanel({
            name,
            presentation: panelOptions?.presentation ?? "panel",
          });
          return true;
        },
        close: () => setPanel(undefined),
        current: () => panel(),
      },
      dialog: {
        show: (render: () => JSX.Element, onClose?: () => void) => {
          dialog()?.onClose?.();
          setDialog({ render, onClose });
        },
        set: () => {},
        clear: clearDialog,
        alert: (alert: { title: string; message: string }) =>
          new Promise<void>((resolve) => {
            setDialog({
              render: () => (
                <box flexDirection="column" padding={1} gap={1}>
                  <text>{alert.title}</text>
                  <text>{alert.message}</text>
                  <text onMouseUp={clearDialog}>OK</text>
                </box>
              ),
              onClose: resolve,
            });
          }),
      },
      toast: {
        show: (toast: Toast) => setToasts((all) => [...all, toast]),
      },
    },
  };

  const panelInput = {
    get name() {
      return panel()?.name ?? "";
    },
    sessionID: "session",
    get width() {
      return width;
    },
    get presentation() {
      return panel()?.presentation ?? "panel";
    },
    focused: true,
    focus: () => {},
    close: () => setPanel(undefined),
    toggleFullscreen: () => {},
  };

  const render = (slot: Slot, input: unknown) => (
    <For each={claims().filter((claim) => claim.slot === slot)}>
      {(claim) => claim.render(input)}
    </For>
  );

  // --- TUI half ----------------------------------------------------------
  const disposeTui = createRoot((dispose) => {
    const cleanup = tui.setup(context as any);
    return () => {
      void Promise.resolve(cleanup).then((done) => done?.());
      dispose();
    };
  });

  const app = await testRender(
    () => (
      <PluginContextProvider value={context as any}>
        <box width="100%" height="100%" flexDirection="row">
          <Show
            when={panel()?.presentation === "fullscreen"}
            fallback={
              <>
                <box flexGrow={1} flexDirection="column" padding={1}>
                  <text>Session</text>
                  <Show when={panel()}>
                    {render("session.panel", panelInput)}
                  </Show>
                  <For each={toasts()}>
                    {(toast) => (
                      <text>{`[${toast.variant}] ${toast.message}`}</text>
                    )}
                  </For>
                </box>
                <box width={sidebarWidth} flexDirection="column">
                  {render("sidebar.content", { sessionID: "session" })}
                </box>
              </>
            }
          >
            <box width="100%" height="100%">
              {render("session.panel", panelInput)}
            </box>
          </Show>
          <Show when={dialog()}>
            {(current) => (
              <box
                position="absolute"
                left={10}
                top={5}
                width={width - 20}
                zIndex={10}
                border
                backgroundColor="#000000"
              >
                {current().render()}
              </box>
            )}
          </Show>
        </box>
      </PluginContextProvider>
    ),
    { width, height, kittyKeyboard: true },
  );
  renderer = app.renderer;

  // A tiny keymap: the newest layer that binds the key wins.
  const onKey = (key: KeyEvent) => {
    for (const factory of [...keymapLayers].reverse()) {
      const command = factory().commands?.find(
        (candidate) =>
          candidate.bind && candidate.bind.split(",").includes(key.name),
      );
      if (command) {
        command.run();
        return;
      }
    }
  };
  app.renderer.keyInput.on("keypress", onKey);

  /** Renders until `predicate` holds for the frame, or fails with the frame. */
  const waitForFrame = async (
    predicate: (frame: string) => boolean,
    { timeout = 5_000, label }: { timeout?: number; label?: string } = {},
  ): Promise<string> => {
    const deadline = Date.now() + timeout;
    let frame = "";
    while (true) {
      await app.renderOnce();
      frame = app.captureCharFrame();
      if (predicate(frame)) return frame;
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for ${label ?? "frame"}. Last frame:\n${frame}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  /** Polls `condition` (not tied to frames), e.g. for RPC traffic. */
  const waitFor = async (
    condition: () => boolean,
    label: string,
    timeout = 5_000,
  ) => {
    const deadline = Date.now() + timeout;
    while (!condition()) {
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  /**
   * Whether `text` is drawn in the theme's primary color, which is how the
   * sidebar marks the changes indicators as active (and clickable).
   */
  const isHighlighted = (text: string) => {
    for (const line of app.captureSpans().lines) {
      const span = line.spans.find((candidate) =>
        candidate.text.includes(text),
      );
      if (span) return span.fg.equals(primary);
    }
    return undefined;
  };

  const waitForIndicator = (text: string, active: boolean) =>
    waitForFrame(() => isHighlighted(text) === active, {
      label: `${JSON.stringify(text)} to be ${active ? "active" : "inactive"}`,
    });

  const sidebarOf = (frame: string) =>
    frame
      .split("\n")
      .map((line) => line.slice(width - sidebarWidth).trimEnd())
      .join("\n")
      .trim();

  /** Whether `text` is on screen, even if the sidebar wrapped it. */
  const shows = (frame: string, text: string) =>
    frame.includes(text) ||
    sidebarOf(frame).replace(/\s+/g, "").includes(text.replace(/\s+/g, ""));

  const waitForText = (text: string, timeout?: number) =>
    waitForFrame((frame) => shows(frame, text), {
      timeout,
      label: JSON.stringify(text),
    });

  const waitForNoText = (text: string, timeout?: number) =>
    waitForFrame((frame) => !shows(frame, text), {
      timeout,
      label: `${JSON.stringify(text)} to disappear`,
    });

  /** Clicks the first cell of the first occurrence of `text` on screen. */
  const click = async (text: string) => {
    const frame = await waitForText(text);
    const lines = frame.split("\n");
    const y = lines.findIndex((line) => line.includes(text));
    const x = lines[y]!.indexOf(text);
    app.renderer.clearSelection();
    await app.mockMouse.click(x, y);
    await app.renderOnce();
  };

  /** The sidebar, as plain text without trailing padding. */
  const sidebar = async () => {
    await app.renderOnce();
    return sidebarOf(app.captureCharFrame());
  };

  /** Delivers an OpenCode `filesystem.changed` event to the TUI. */
  const emitFileChange = (file: string) => {
    for (const listener of fileListeners) {
      listener({
        type: "filesystem.changed",
        location: { directory },
        data: { file },
      });
    }
  };

  const dispose = async () => {
    app.renderer.keyInput.off("keypress", onKey);
    disposeTui();
    app.renderer.destroy();
    await stopServer?.();
    if (rpc.violations.length > 0) {
      throw new Error(`RPC contract violations:\n${rpc.violations.join("\n")}`);
    }
  };

  return {
    app,
    rpc,
    startServer,
    toasts,
    dialog,
    panel,
    waitFor,
    waitForFrame,
    waitForIndicator,
    waitForText,
    waitForNoText,
    /** Whether the current frame shows `text`, even if the sidebar wrapped it. */
    shows: async (text: string) => {
      await app.renderOnce();
      return shows(app.captureCharFrame(), text);
    },
    click,
    sidebar,
    emitFileChange,
    /** Presses a key: a character, `escape`, or an arrow (`left`, …). */
    press: async (key: string) => {
      if (key === "escape") app.mockInput.pressEscape();
      else if (["up", "down", "left", "right"].includes(key)) {
        app.mockInput.pressArrow(key as "up" | "down" | "left" | "right");
      } else app.mockInput.pressKey(key);
      await app.renderOnce();
    },
    [Symbol.asyncDispose]: dispose,
  };
}

export type Host = Awaited<ReturnType<typeof startHost>>;
