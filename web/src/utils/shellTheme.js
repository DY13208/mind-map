import Vue from 'vue'

const STORAGE_KEY = 'product-shell-theme'
const ROOT_CLASS = 'shellDark'

function initialTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'dark' || saved === 'light') return saved
  } catch (error) {
    /* storage unavailable */
  }
  return typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export const shellTheme = Vue.observable({ theme: initialTheme() })

// 下拉菜单、消息框挂在 body 上，不在 .productShell 里，需要根节点 class 才能跟着变深
export function applyShellThemeToRoot(active) {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle(
    ROOT_CLASS,
    !!active && shellTheme.theme === 'dark'
  )
}

export function toggleShellTheme() {
  shellTheme.theme = shellTheme.theme === 'dark' ? 'light' : 'dark'
  try {
    localStorage.setItem(STORAGE_KEY, shellTheme.theme)
  } catch (error) {
    /* preference is optional */
  }
  applyShellThemeToRoot(true)
}
