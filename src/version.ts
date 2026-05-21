// Keep in sync with package.json on each release.
export const VERSION = "0.3.1"

const PACKAGE_JSON_URL = "https://raw.githubusercontent.com/oribarilan/vimcode/main/package.json"

type Toast = (opts: { message: string; variant: string; duration: number }) => void

export function checkForUpdate(toast: Toast) {
  fetch(PACKAGE_JSON_URL, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.json())
    .then((pkg: any) => {
      const latest = pkg?.version
      if (latest && latest !== VERSION) {
        toast({ message: `vimcode update available: v${VERSION} → v${latest}`, variant: "info", duration: 5000 })
      }
    })
    .catch(() => {})
}
