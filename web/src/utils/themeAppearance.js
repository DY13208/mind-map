import themeList from 'simple-mind-map-plugin-themes/themeList'

export const DEFAULT_LIGHT_THEME = 'default'
export const DEFAULT_DARK_THEME = 'classic'

const BUILTIN_THEMES = [
  {
    name: '默认主题',
    value: 'default',
    dark: false
  },
  ...themeList
]

export function collectThemeMeta(extendThemeGroupList = []) {
  const extendThemes = []
  ;(extendThemeGroupList || []).forEach(group => {
    extendThemes.push(...(group.list || []))
  })
  return [...BUILTIN_THEMES, ...extendThemes]
}

export function findThemeMeta(themeValue, extendThemeGroupList = []) {
  return (
    collectThemeMeta(extendThemeGroupList).find(
      item => item && item.value === themeValue
    ) || null
  )
}

export function isDarkThemeValue(themeValue, extendThemeGroupList = []) {
  const target = findThemeMeta(themeValue, extendThemeGroupList)
  return !!(target && target.dark)
}

export function resolveAppearanceTheme({
  nextDark,
  currentTheme,
  heldLightTheme,
  heldDarkTheme,
  extendThemeGroupList = []
}) {
  const currentIsDark = isDarkThemeValue(currentTheme, extendThemeGroupList)
  const heldLightOk =
    heldLightTheme &&
    !isDarkThemeValue(heldLightTheme, extendThemeGroupList)
  const heldDarkOk =
    heldDarkTheme && isDarkThemeValue(heldDarkTheme, extendThemeGroupList)

  if (nextDark) {
    if (currentIsDark) {
      return {
        theme: currentTheme,
        heldLightTheme: heldLightOk ? heldLightTheme : null,
        heldDarkTheme: currentTheme,
        changed: false
      }
    }
    const theme = heldDarkOk ? heldDarkTheme : DEFAULT_DARK_THEME
    return {
      theme,
      heldLightTheme: currentTheme,
      heldDarkTheme: theme,
      changed: true
    }
  }

  if (!currentIsDark) {
    return {
      theme: currentTheme,
      heldLightTheme: currentTheme,
      heldDarkTheme: heldDarkOk ? heldDarkTheme : null,
      changed: false
    }
  }

  const theme = heldLightOk ? heldLightTheme : DEFAULT_LIGHT_THEME
  return {
    theme,
    heldLightTheme: theme,
    heldDarkTheme: currentTheme,
    changed: true
  }
}
