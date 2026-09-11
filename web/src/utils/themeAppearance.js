import themeList from 'simple-mind-map-plugin-themes/themeList'

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
