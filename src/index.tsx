/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"
import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { ModeIndicator } from "./indicator"
import { writeClipboard } from "./clipboard"

type Mode = "normal" | "insert"
type Operator = "d" | "c" | "y" | null

// Motions that work standalone and as targets for operators.
// Value is the command to dispatch (repeated by count).
const MOTIONS: Record<string, string> = {
  h: "input.move.left",
  l: "input.move.right",
  j: "input.move.down",
  k: "input.move.up",
  w: "input.word.forward",
  b: "input.word.backward",
  e: "input.word.forward",
  "0": "input.line.home",
  "^": "input.line.home",
  $: "input.line.end",
  G: "input.buffer.end",
}

// Maps operator + motion-key to a delete command.
// `c` uses the same commands then enters insert mode.
const DELETE_MOTION: Record<string, string> = {
  w: "input.delete.word.forward",
  b: "input.delete.word.backward",
  e: "input.delete.word.forward",
  $: "input.delete.to.line.end",
  "0": "input.delete.to.line.start",
  "^": "input.delete.to.line.start",
  h: "input.backspace",
  l: "input.delete",
}

const plugin: TuiPluginModule = {
  id: "vimcode",
  tui: async (api) => {
    const [mode, setMode] = createSignal<Mode>("insert")

    let pendingOp: Operator = null
    let count = 0
    let lineTracker = 0  // shadow line position for yy
    let yankRegister = ""

    function dispatch(cmd: string) {
      setTimeout(() => api.keymap.dispatchCommand(cmd), 0)
    }

    function dispatchN(cmd: string, n: number) {
      for (let i = 0; i < n; i++) dispatch(cmd)
    }

    function consumeCount(): number {
      const n = count || 1
      count = 0
      return n
    }

    function resetPending() {
      pendingOp = null
      count = 0
    }

    function enterInsert() {
      resetPending()
      setMode("insert")
    }

    function updateLineTracker(key: string, n: number) {
      if (key === "j") lineTracker += n
      else if (key === "k") lineTracker = Math.max(0, lineTracker - n)
      else if (key === "G") lineTracker = getLineCount() - 1
      else if (key === "g") lineTracker = 0
    }

    function getPromptText(): string {
      return api.prompt?.current?.input ?? ""
    }

    function getLineCount(): number {
      return getPromptText().split("\n").length
    }

    function getLine(n: number): string {
      return getPromptText().split("\n")[n] ?? ""
    }

    // ── Key intercept ───────────────────────────────────────────
    api.keymap.intercept(
      "key",
      (ctx) => {
        if (ctx.event.eventType === "release") return
        const ev = ctx.event
        const name: string = ev.name

        // ── Insert-mode overrides ──
        if (mode() === "insert") {
          if (name === "escape") {
            ctx.consume()
            lineTracker = 0
            setMode("normal")
            return
          }
          if (name === "return" && !ev.ctrl) {
            ctx.consume()
            dispatch("input.newline")
            return
          }
          if (name === "tab") {
            ctx.consume()
            return
          }
          return
        }

        // ── Normal mode ──
        if (ev.meta || ev.super) return
        if (ev.ctrl) {
          if (name === "r") { ctx.consume(); dispatch("input.redo"); resetPending(); return }
          return
        }

        // Translate shifted keys
        let key = name
        if (ev.shift && name.length === 1) {
          if (/[a-z]/.test(name)) key = name.toUpperCase()
          else if (name === "4") key = "$"
          else if (name === "6") key = "^"
        }

        // Let escape pass through for double-escape interrupt
        if (name === "escape") {
          resetPending()
          return
        }

        ctx.consume()

        // ── Digits: accumulate count ──
        if (/[1-9]/.test(key) || (key === "0" && count > 0)) {
          count = count * 10 + parseInt(key)
          return
        }

        // ── Submit: Enter ──
        if (name === "return") { dispatch("input.submit"); resetPending(); return }

        // ── Command palette ──
        if (key === ":") { dispatch("command.palette.show"); resetPending(); return }

        // ── Paste ──
        if (key === "p") {
          if (yankRegister) writeClipboard(yankRegister)
          dispatch("prompt.paste")
          resetPending()
          return
        }

        // ── Backspace (X) ──
        if (key === "X") { dispatchN("input.backspace", consumeCount()); return }

        // ── Join lines (J) ──
        if (key === "J") {
          const n = consumeCount()
          for (let i = 0; i < n; i++) {
            dispatch("input.line.end")
            dispatch("input.delete")
          }
          return
        }

        // ── Operators: d, c, y ──
        if (key === "d" || key === "c" || key === "y") {
          if (pendingOp === key) {
            // Doubled: dd, cc, yy — operate on line(s)
            const n = consumeCount()
            if (key === "y") {
              const lines: string[] = []
              for (let i = 0; i < n; i++) {
                lines.push(getLine(lineTracker + i))
              }
              const text = lines.join("\n") + "\n"
              yankRegister = text
              writeClipboard(text)
              api.ui?.toast?.({ message: `${n} line${n > 1 ? "s" : ""} yanked`, variant: "info", duration: 1000 })
            } else {
              dispatchN("input.delete.line", n)
              if (key === "c") enterInsert()
            }
            pendingOp = null
            return
          }
          pendingOp = key
          return
        }

        // ── D / C shortcuts ──
        if (key === "D") { dispatch("input.delete.to.line.end"); resetPending(); return }
        if (key === "C") { dispatch("input.delete.to.line.end"); enterInsert(); return }

        // ── Pending operator + motion ──
        if (pendingOp && key in MOTIONS) {
          const n = consumeCount()

          if (pendingOp === "y") {
            // Yank: only yy is reliable (handled above). Other motions: toast a hint.
            api.ui?.toast?.({ message: "Only yy supported for now", variant: "info", duration: 1500 })
            resetPending()
            return
          }

          // d/c + j/k: delete lines
          if (key === "j") {
            dispatchN("input.delete.line", n + 1)
            if (pendingOp === "c") enterInsert()
            else resetPending()
            return
          }
          if (key === "k") {
            dispatchN("input.move.up", n)
            dispatchN("input.delete.line", n + 1)
            if (pendingOp === "c") enterInsert()
            else resetPending()
            return
          }

          // d/c + word/line motions
          const deleteCmd = DELETE_MOTION[key]
          if (deleteCmd) {
            dispatchN(deleteCmd, n)
            if (pendingOp === "c") enterInsert()
            else resetPending()
            return
          }

          // Motion has no delete equivalent (G, gg) — just reset
          resetPending()
          return
        }

        // ── Standalone motions ──
        if (key in MOTIONS) {
          const n = consumeCount()
          dispatchN(MOTIONS[key], n)
          updateLineTracker(key, n)
          return
        }

        // ── gg (buffer home) ──
        if (key === "g") {
          dispatch("input.buffer.home")
          lineTracker = 0
          resetPending()
          return
        }

        // ── Edits ──
        if (key === "x") { dispatchN("input.delete", consumeCount()); return }
        if (key === "u") { dispatch("input.undo"); resetPending(); return }

        // ── Insert entries ──
        if (key === "i") { enterInsert(); return }
        if (key === "a") { dispatch("input.move.right"); enterInsert(); return }
        if (key === "A") { dispatch("input.line.end"); enterInsert(); return }
        if (key === "o") {
          dispatch("input.line.end")
          dispatch("input.newline")
          lineTracker++
          enterInsert()
          return
        }
        if (key === "O") {
          dispatch("input.line.home")
          dispatch("input.newline")
          dispatch("input.move.up")
          enterInsert()
          return
        }

        // Unbound — already consumed above
      },
      { priority: 10_000 },
    )

    // ── Mode indicator ──────────────────────────────────────────
    const indicator = () => <ModeIndicator mode={mode()} theme={api.theme} />

    api.slots.register({
      slots: {
        session_prompt_right: indicator,
        home_prompt_right: indicator,
      },
    })
  },
}

export default plugin
