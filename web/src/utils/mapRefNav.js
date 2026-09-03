import mapRefUtil from 'simple-mind-map/src/utils/mapRef'
import { resolveFileRef } from '@/utils/fileApi'

const VIEW_PREFIX = 'mind-map-view:'

export function normalizeMapRef(value) {
  return mapRefUtil.normalizeMapRef(value)
}

export function captureMapView(mindMap) {
  if (!mindMap || !mindMap.view) return null
  const selectedUids = (
    (mindMap.renderer && mindMap.renderer.activeNodeList) ||
    []
  )
    .map(node => node.getData && node.getData('uid'))
    .filter(Boolean)
  return {
    view: mindMap.view.getTransformData(),
    selectedUids,
    at: Date.now()
  }
}

export function restoreMapView(mindMap, snapshot) {
  if (!mindMap || !mindMap.view || !snapshot || !snapshot.view) return
  try {
    mindMap.view.setTransformData(snapshot.view)
  } catch (err) {
    console.warn('[mapRef] restore view failed', err)
  }
}

export function saveMapView(roomKey, snapshot) {
  if (!roomKey || !snapshot) return
  try {
    sessionStorage.setItem(VIEW_PREFIX + roomKey, JSON.stringify(snapshot))
  } catch (err) {
    // ignore quota
  }
}

export function loadMapView(roomKey) {
  if (!roomKey) return null
  try {
    const raw = sessionStorage.getItem(VIEW_PREFIX + roomKey)
    return raw ? JSON.parse(raw) : null
  } catch (err) {
    return null
  }
}

export async function inspectMapRef(ref) {
  const normalized = normalizeMapRef(ref)
  if (!normalized) {
    return { exists: false, nodeExists: false }
  }
  return resolveFileRef(normalized.mapId, normalized.nodeId)
}
