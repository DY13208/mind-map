export const FOLDER_STAGE_WIDTH = 340
export const FOLDER_STAGE_HEIGHT = 272

export function fitFolderStage(availableWidth, availableHeight) {
  const width = Math.max(0, Number(availableWidth) || 0)
  const height = Math.max(0, Number(availableHeight) || 0)
  const scale = Math.min(
    width / FOLDER_STAGE_WIDTH,
    height / FOLDER_STAGE_HEIGHT
  )
  return {
    scale,
    width: FOLDER_STAGE_WIDTH * scale,
    height: FOLDER_STAGE_HEIGHT * scale
  }
}

export function fitFolderStageToWidth(availableWidth) {
  const width = Math.max(0, Number(availableWidth) || 0)
  const scale = width / FOLDER_STAGE_WIDTH
  return {
    scale,
    width: FOLDER_STAGE_WIDTH * scale,
    height: FOLDER_STAGE_HEIGHT * scale
  }
}
