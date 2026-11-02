import Vue from 'vue'

const STORAGE_KEY = 'product-shell-theme'
const ROOT_CLASS = 'shellDark'
const media = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)') : null

export function resolveThemeMode(mode, systemDark) {
  return mode === 'dark' || (mode === 'system' && systemDark) ? 'dark' : 'light'
}

function initialMode() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (['dark', 'light', 'system'].includes(saved)) return saved
  } catch (_) { /* storage unavailable */ }
  return 'system'
}
const mode = initialMode()
export const shellTheme = Vue.observable({ mode, theme: resolveThemeMode(mode, !!(media && media.matches)) })
let rootActive = false

export function applyShellThemeToRoot(active) {
  rootActive = !!active
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-app-appearance', shellTheme.theme)
    document.documentElement.classList.toggle(ROOT_CLASS, rootActive && shellTheme.theme === 'dark')
  }
}

export function setShellThemeMode(mode) {
  if (!['light', 'dark', 'system'].includes(mode)) return
  shellTheme.mode = mode
  shellTheme.theme = resolveThemeMode(mode, !!(media && media.matches))
  try { localStorage.setItem(STORAGE_KEY, mode) } catch (_) { /* optional */ }
  applyShellThemeToRoot(rootActive)
}

export function toggleShellTheme() {
  setShellThemeMode(shellTheme.theme === 'dark' ? 'light' : 'dark')
}

const onSystemChange = event => {
  if (shellTheme.mode !== 'system') return
  shellTheme.theme = resolveThemeMode('system', event.matches)
  applyShellThemeToRoot(rootActive)
}
if (media) {
  if (media.addEventListener) media.addEventListener('change', onSystemChange)
  else media.addListener(onSystemChange)
}
const onStorage = event => {
  if (event.key === STORAGE_KEY) setShellThemeMode(event.newValue || 'system')
}
if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
if (module.hot) module.hot.dispose(() => {
  window.removeEventListener('storage', onStorage)
  if (media) {
    if (media.removeEventListener) media.removeEventListener('change', onSystemChange)
    else media.removeListener(onSystemChange)
  }
})
