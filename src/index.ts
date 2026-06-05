import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { writeClipboard } from "./clipboard";
import { checkForUpdate } from "./version";
import {
  type Action,
  createVimState,
  finishOneShotIfComplete,
  handleInsertKey,
  handleNormalKey,
  handleVisualKey,
  translateKey,
} from "./vim";

const plugin: TuiPluginModule = {
  id: "vimcode",
  tui: async (api, options) => {
    const state = createVimState();
    const startMode = options?.startMode === "normal" ? "normal" : "insert";
    state.mode = startMode;

    // Snapshots for single-step undo of vim changes.
    // The host editor's undo system splits repeated commands into multiple
    // entries, so we save/restore the buffer ourselves.
    let undoSnapshots: Array<{ text: string; cursor: number }> = [];

    const prompt = {
      getLine: (n: number) => getInputText().split("\n")[n] ?? "",
      getLineCount: () => getInputText().split("\n").length,
      getCursorLine: () => api.renderer?.currentFocusedEditor?.visualCursor?.logicalRow ?? 0,
      getCursorOffset: () => api.renderer?.currentFocusedEditor?.cursorOffset ?? 0,
      getPlainText: () => getInputText(),
    };

    // api.prompt doesn't exist on the TUI plugin API. The actual text lives
    // on the focused editor exposed by the renderer.
    function getInputText(): string {
      return api.renderer?.currentFocusedEditor?.plainText ?? "";
    }

    function applyActions(actions: Action[]) {
      let keepUndoSnapshotForBatch = false;
      for (const action of actions) {
        // Any buffer-modifying action (other than our own deleteRange/undo)
        // invalidates the undo snapshot.
        if ((action.type === "cmd" || action.type === "insertText") && !keepUndoSnapshotForBatch) {
          undoSnapshots = [];
        }
        switch (action.type) {
          case "cmd":
            setTimeout(() => api.keymap.dispatchCommand(action.cmd), 0);
            break;
          case "mode":
            if (options?.modeToast !== false) {
              api.ui?.toast?.({ message: action.mode.toUpperCase(), variant: "info", duration: 800 });
            }
            break;
          case "toast":
            api.ui?.toast?.({ message: action.message, variant: "info", duration: action.duration ?? 2000 });
            break;
          case "yank":
            writeClipboard(action.text);
            break;
          case "insertText":
            api.renderer?.currentFocusedEditor?.insertText?.(action.text);
            break;
          case "yankSelection": {
            // Deferred so it runs after any preceding select commands
            setTimeout(() => {
              const editor = api.renderer?.currentFocusedEditor;
              const text = editor?.editorView?.getSelectedText?.() ?? "";
              if (text) {
                state.yankRegister = text;
                writeClipboard(text);
                api.ui?.toast?.({ message: "yanked", variant: "info", duration: 1000 });
              }
              editor?.editorView?.resetSelection?.();
            }, 0);
            break;
          }
          case "clearSelection":
            api.renderer?.currentFocusedEditor?.editorView?.resetSelection?.();
            break;
          case "deleteRange": {
            const editor = api.renderer?.currentFocusedEditor;
            const eb = editor?.editBuffer;
            if (eb?.deleteRange) {
              undoSnapshots.push({ text: editor.plainText ?? "", cursor: editor.cursorOffset ?? 0 });
              const text = editor.plainText ?? "";
              const [sl, sc] = offsetToLineCol(text, action.start);
              const [el, ec] = offsetToLineCol(text, action.end + 1);
              eb.deleteRange(sl, sc, el, ec);
            }
            break;
          }
          case "saveUndoSnapshot": {
            const editor = api.renderer?.currentFocusedEditor;
            if (editor) undoSnapshots.push({ text: editor.plainText ?? "", cursor: editor.cursorOffset ?? 0 });
            keepUndoSnapshotForBatch = true;
            break;
          }
          case "undo": {
            const undoSnapshot = undoSnapshots.pop();
            if (undoSnapshot) {
              const editor = api.renderer?.currentFocusedEditor;
              const eb = editor?.editBuffer;
              if (eb?.setText && editor) {
                eb.setText(undoSnapshot.text);
                editor.cursorOffset = undoSnapshot.cursor;
              }
            } else {
              setTimeout(() => api.keymap.dispatchCommand("input.undo"), 0);
            }
            break;
          }
          case "cursorTo": {
            const editor = api.renderer?.currentFocusedEditor;
            if (editor) editor.cursorOffset = action.offset;
            break;
          }
          case "selectRange": {
            const editor = api.renderer?.currentFocusedEditor;
            editor?.setSelectionInclusive?.(action.start, action.end);
            break;
          }
        }
      }
    }

    function syncCursorStyle() {
      const editor = api.renderer?.currentFocusedEditor;
      if (!editor) return;
      editor.cursorStyle = { style: state.mode === "insert" ? "line" : "block", blinking: true };
    }

    // The Textarea resets cursorStyle during rendering, so re-apply on a
    // short interval. Setting a property is cheaper than the previous
    // approach of writing DECSCUSR escape sequences to stdout, and works
    // in terminals that don't support DECSCUSR (e.g. macOS Terminal.app).
    const cursorInterval = setInterval(syncCursorStyle, 100);
    api.lifecycle?.onDispose?.(() => clearInterval(cursorInterval));

    if (options?.updateCheck !== false) {
      checkForUpdate((opts) => api.ui?.toast?.(opts), api.kv);
    }

    api.keymap.intercept(
      "key",
      (ctx) => {
        if (ctx.event.eventType === "release") return;

        // Pass through when any overlay owns the keyboard: dialogs (command
        // palette, session list, etc.), question prompts, or permission prompts.
        if (api.ui?.dialog?.open) return;
        const route = api.route.current;
        if (route.name === "session") {
          const sid = route.params?.sessionID;
          if (sid) {
            const q = api.state.session.question(sid);
            const p = api.state.session.permission(sid);
            if ((q && q.length > 0) || (p && p.length > 0)) return;
          }
        }

        // Let autocomplete handle Enter/Escape before vim consumes them.
        // dispatchCommand returns { ok } — true when the autocomplete layer
        // is active and handled the command, false when it's hidden/disabled.
        if (state.mode === "insert") {
          if (ctx.event.name === "escape") {
            const r = api.keymap.dispatchCommand("prompt.autocomplete.hide");
            if (r.ok) {
              ctx.consume();
              return;
            }
          }
          if (ctx.event.name === "return" && !ctx.event.ctrl) {
            const r = api.keymap.dispatchCommand("prompt.autocomplete.select");
            if (r.ok) {
              ctx.consume();
              return;
            }
          }
        }

        const event = { ...ctx.event, leader: isLeaderKey(ctx.event, getLeaderBinding(api)) };
        const key = translateKey(event);
        const handlerMode = state.mode;
        const result =
          state.mode === "insert"
            ? handleInsertKey(state, key, event)
            : state.mode === "visual"
              ? handleVisualKey(state, key, event)
              : handleNormalKey(state, key, event, prompt);
        if (handlerMode === "normal") finishOneShotIfComplete(state, result);
        if (result.consume) ctx.consume();
        applyActions(result.actions);
      },
      { priority: 10_000 },
    );
  },
};

function offsetToLineCol(text: string, offset: number): [number, number] {
  const before = text.substring(0, offset);
  const lines = before.split("\n");
  return [lines.length - 1, lines[lines.length - 1].length];
}

function getLeaderBinding(api: any): unknown {
  return api.tuiConfig?.keybinds?.leader ?? api.state?.config?.keybinds?.leader ?? "ctrl+x";
}

function isLeaderKey(
  ev: { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean; super?: boolean },
  binding: unknown,
): boolean {
  if (binding === false || binding === "none") return false;
  if (Array.isArray(binding)) return binding.some((entry) => isLeaderKey(ev, entry));
  if (typeof binding === "object" && binding !== null) {
    const value = binding as {
      key?: unknown;
      name?: unknown;
      ctrl?: boolean;
      shift?: boolean;
      meta?: boolean;
      super?: boolean;
    };
    if (value.key !== undefined) return isLeaderKey(ev, value.key);
    if (typeof value.name === "string") return matchesKeySpec(ev, value);
  }
  if (typeof binding !== "string") return false;
  return binding.split(",").some((part) => matchesKeySpec(ev, parseKeySpec(part)));
}

function parseKeySpec(spec: string): {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  super?: boolean;
} {
  const parts = spec
    .trim()
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts.at(-1) ?? "";
  return {
    name: key,
    ctrl: parts.includes("ctrl"),
    shift: parts.includes("shift"),
    meta: parts.includes("alt") || parts.includes("meta"),
    super: parts.includes("cmd") || parts.includes("super"),
  };
}

function matchesKeySpec(
  ev: { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean; super?: boolean },
  spec: { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean; super?: boolean },
): boolean {
  return (
    ev.name.toLowerCase() === spec.name.toLowerCase() &&
    Boolean(ev.ctrl) === Boolean(spec.ctrl) &&
    Boolean(ev.shift) === Boolean(spec.shift) &&
    Boolean(ev.meta) === Boolean(spec.meta) &&
    Boolean(ev.super) === Boolean(spec.super)
  );
}

export default plugin;
