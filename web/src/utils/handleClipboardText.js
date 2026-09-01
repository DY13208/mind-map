import { imgToDataUrl } from 'simple-mind-map/src/utils/index'
import { parseClipboardToNodes } from './parseClipboardTree'

// 处理知犀
const handleZHIXI = async data => {
  try {
    try {
      if (!Array.isArray(data)) {
        data = String(data).replace('￿﻿', '')
        data = JSON.parse(data)
      }
    } catch (error) {
      console.log(error)
    }
    if (!Array.isArray(data)) {
      data = []
    }
    const newNodeList = []
    const waitLoadImageList = []
    const walk = (list, newList) => {
      list.forEach(async item => {
        let newRoot = {}
        newList.push(newRoot)
        newRoot.data = {
          text: item.data.text,
          hyperlink: item.data.hyperlink,
          hyperlinkTitle: item.data.hyperlinkTitle,
          note: item.data.note
        }
        // 图片
        if (item.data.image) {
          let resolve = null
          let promise = new Promise(_resolve => {
            resolve = _resolve
          })
          waitLoadImageList.push(promise)
          try {
            newRoot.data.image = await imgToDataUrl(item.data.image)
            newRoot.data.imageSize = item.data.imageSize
            resolve()
          } catch (error) {
            resolve()
          }
        }
        // 子节点
        newRoot.children = []
        if (item.children && item.children.length > 0) {
          const children = []
          item.children.forEach(item2 => {
            // 概要
            if (item2.data.type === 'generalize') {
              newRoot.data.generalization = [
                {
                  text: item2.data.text
                }
              ]
            } else {
              children.push(item2)
            }
          })
          walk(children, newRoot.children)
        }
      })
    }
    walk(data, newNodeList)
    await Promise.all(waitLoadImageList)
    return {
      simpleMindMap: true,
      data: newNodeList
    }
  } catch (error) {
    return ''
  }
}

const handleClipboardText = async (text, extra = {}) => {
  const raw = text == null ? '' : String(text)
  const html = (extra && extra.html) || ''
  // 知犀数据格式1
  try {
    let parsedData = JSON.parse(raw)
    if (parsedData.__c_zx_v !== undefined) {
      const res = await handleZHIXI(parsedData.children)
      return res
    }
    // 本应用内部复制的节点 JSON，交给默认粘贴逻辑
    if (parsedData && parsedData.simpleMindMap) {
      return ''
    }
  } catch (error) {}
  // 知犀数据格式2
  if (raw.includes('￿﻿')) {
    const res = await handleZHIXI(raw)
    return res
  }
  // XMind / 大纲 / HTML 列表 / OPML
  const tree = parseClipboardToNodes(raw, html)
  if (tree && tree.length) {
    return {
      simpleMindMap: true,
      data: tree
    }
  }
  return ''
}

export default handleClipboardText
