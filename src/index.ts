import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createVimState, translateKey, handleInsertKey, handleNormalKey, type Action, type Mode } from "./vim"
import { writeClipboard, readClipboard } from "./clipboard"

const plugin: TuiPluginModule = {
  id: "vimcode",
  tui: async (api) => {
    const state = createVimState()

    const prompt = {
      getLine: (n: number) => (api.prompt?.current?.input ?? "").split("\n")[n] ?? "",
      getLineCount: () => (api.prompt?.current?.input ?? "").split("\n").length,
    }

    function applyActions(actions: Action[]) {
      for (const action of actions) {
        switch (action.type) {
          case "cmd":
            setTimeout(() => api.keymap.dispatchCommand(action.cmd), 0)
            break
          case "mode":
            api.ui?.toast?.({ message: action.mode.toUpperCase(), variant: "info", duration: 800 })
            break
          case "toast":
            api.ui?.toast?.({ message: action.message, variant: "info", duration: action.duration ?? 2000 })
            break
          case "yank":
            writeClipboard(action.text)
            break
          case "insert":
            // Save clipboard, write insert text, paste, restore original clipboard
            readClipboard().then((saved) => {
              writeClipboard(action.text)
              setTimeout(() => {
                api.keymap.dispatchCommand("prompt.paste")
                setTimeout(() => writeClipboard(saved), 50)
              }, 0)
            })
            break
        }
      }
    }

    api.keymap.intercept(
      "key",
      (ctx) => {
        if (ctx.event.eventType === "release") return
        const key = translateKey(ctx.event)
        const result = state.mode === "insert"
          ? handleInsertKey(state, key, ctx.event)
          : handleNormalKey(state, key, ctx.event, prompt)
        if (result.consume) ctx.consume()
        applyActions(result.actions)
      },
      { priority: 10_000 },
    )
  },
}

export default plugin
