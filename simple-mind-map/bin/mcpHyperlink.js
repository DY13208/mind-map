function linkValue(value) {
  const text = String(value == null ? '' : value).trim()
  return text ? text : null
}

function hyperlinkFields(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const fields = {}
  if (source.hyperlink !== undefined) fields.hyperlink = linkValue(source.hyperlink)
  if (source.hyperlinkTitle !== undefined) {
    fields.hyperlinkTitle = linkValue(source.hyperlinkTitle)
  } else if (source.hyperlink_title !== undefined) {
    fields.hyperlinkTitle = linkValue(source.hyperlink_title)
  }
  return fields
}

module.exports = { hyperlinkFields }
