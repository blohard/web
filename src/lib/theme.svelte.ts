// The palette: the system's by default, or pinned light or dark by the reader,
// remembered in this browser. A pin sets data-theme on the document root, which
// app.css honours over the system either way; the discussion widget's frame
// uses the same attribute for the page that embeds it.
import { readJSON, writeJSON } from './storage'

export type Theme = 'auto' | 'light' | 'dark'
const KEY = 'blohard.theme'

function read(): Theme {
  const t = readJSON<unknown>(KEY, 'auto')
  return t === 'light' || t === 'dark' ? t : 'auto'
}

function apply(t: Theme) {
  if (typeof document === 'undefined') return
  if (t === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
}

class ThemeChoice {
  current = $state<Theme>(read())

  set(t: Theme) {
    this.current = t
    writeJSON(KEY, t)
    apply(t)
  }
}

export const theme = new ThemeChoice()
apply(theme.current)
