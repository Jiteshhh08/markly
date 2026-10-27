// STAGE 5 pure document-editor helpers.
//
// Kept as plain JS (no JSX, no React) so insertion, duplication, reordering,
// undo/redo and export-gating rules are testable without a browser. The API
// remains the validation boundary; these helpers only build well-formed block
// candidates for the server's Zod schemas.

export const BLOCK_TYPES = Object.freeze([
  'title',
  'experimentNumber',
  'heading',
  'subheading',
  'paragraph',
  'bulletList',
  'numberedList',
  'code',
  'spacer',
  'pageBreak',
])

export const BLOCK_LABELS = Object.freeze({
  title: 'Document title',
  experimentNumber: 'Experiment number',
  heading: 'Section heading',
  subheading: 'Subheading',
  paragraph: 'Paragraph',
  bulletList: 'Bullet list',
  numberedList: 'Numbered list',
  code: 'Code block',
  spacer: 'Spacer',
  pageBreak: 'Page break',
})

export const TEXT_BLOCK_TYPES = Object.freeze([
  'title',
  'experimentNumber',
  'heading',
  'subheading',
  'paragraph',
])

export const LIST_BLOCK_TYPES = Object.freeze(['bulletList', 'numberedList'])

let fallbackCounter = 0

export function newBlockId() {
  const cryptoApi = globalThis.crypto
  if (cryptoApi?.randomUUID) return `blk_${cryptoApi.randomUUID()}`
  fallbackCounter += 1
  return `blk_${Date.now()}_${fallbackCounter}`
}

export function defaultTextFor(type) {
  if (type === 'title') return 'Untitled document'
  if (type === 'experimentNumber') return 'Experiment No. 1'
  if (type === 'heading') return 'Section heading'
  if (type === 'subheading') return 'Subheading'
  return 'Write a paragraph…'
}

export function createBlock(type, { id = newBlockId(), text = null, items = null, height = 24 } = {}) {
  if (!BLOCK_TYPES.includes(type)) throw new Error(`Unsupported block type: ${type}`)
  if (type === 'pageBreak') return { id, type, content: {} }
  if (type === 'spacer') return { id, type, content: { height } }
  if (type === 'code') {
    return {
      id,
      type,
      content: { text: text ?? '// Write code here', language: null },
    }
  }
  if (LIST_BLOCK_TYPES.includes(type)) {
    return {
      id,
      type,
      content: { items: Array.isArray(items) && items.length ? items : [text ?? 'List item'] },
    }
  }
  return { id, type, content: { text: text ?? defaultTextFor(type) } }
}

export function cloneBlock(block, { id = newBlockId(), keepSource = false } = {}) {
  const next = {
    id,
    type: block.type,
    content: structuredCloneSafe(block.content ?? {}),
  }
  if (block.style) next.style = structuredCloneSafe(block.style)
  // A duplicated generated block becomes a manual copy: regeneration must not
  // silently delete the user's duplicate.
  if (keepSource && block.source) next.source = structuredCloneSafe(block.source)
  return next
}

function structuredCloneSafe(value) {
  if (value == null) return value
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

export function insertBlockAt(blocks, block, index = blocks.length) {
  const next = [...(blocks ?? [])]
  const at = Math.max(0, Math.min(Number.isInteger(index) ? index : next.length, next.length))
  next.splice(at, 0, block)
  return next
}

export function deleteBlock(blocks, id) {
  return (blocks ?? []).filter((block) => block.id !== id)
}

export function duplicateBlock(blocks, id) {
  const list = blocks ?? []
  const index = list.findIndex((block) => block.id === id)
  if (index < 0) return { blocks: list, block: null }
  const copy = cloneBlock(list[index])
  return { blocks: insertBlockAt(list, copy, index + 1), block: copy }
}

export function moveBlock(blocks, id, direction) {
  const list = blocks ?? []
  const index = list.findIndex((block) => block.id === id)
  if (index < 0) return list
  const target = index + (direction < 0 ? -1 : 1)
  if (target < 0 || target >= list.length) return list
  return moveBlockToIndex(list, id, target)
}

export function moveBlockToIndex(blocks, id, targetIndex) {
  const list = blocks ?? []
  const from = list.findIndex((block) => block.id === id)
  if (from < 0) return list
  const next = [...list]
  const [block] = next.splice(from, 1)
  const target = Math.max(0, Math.min(Number.isInteger(targetIndex) ? targetIndex : next.length, next.length))
  next.splice(target, 0, block)
  return next
}

export function updateBlock(blocks, id, patch) {
  return (blocks ?? []).map((block) => (block.id === id ? { ...block, ...patch } : block))
}

export function updateBlockContent(blocks, id, content) {
  return (blocks ?? []).map((block) =>
    block.id === id ? { ...block, content: { ...block.content, ...content } } : block,
  )
}

export function updateListItems(blocks, id, items) {
  return updateBlockContent(blocks, id, { items })
}

export function updateBlockStyle(blocks, id, stylePatch) {
  return (blocks ?? []).map((block) => {
    if (block.id !== id) return block
    const style = { ...(block.style ?? {}) }
    for (const [key, value] of Object.entries(stylePatch ?? {})) {
      if (value === undefined || value === null || value === '') delete style[key]
      else style[key] = value
    }
    const next = { ...block }
    if (Object.keys(style).length) next.style = style
    else delete next.style
    return next
  })
}

export function clearBlockStyle(blocks, id) {
  return (blocks ?? []).map((block) => {
    if (block.id !== id) return block
    const next = { ...block }
    delete next.style
    return next
  })
}

export function createHistory(blocks) {
  return { past: [], present: blocks ?? [], future: [] }
}

const HISTORY_LIMIT = 100

export function commitHistory(history, nextBlocks) {
  if (!history) return createHistory(nextBlocks)
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: nextBlocks,
    future: [],
  }
}

export function undoHistory(history) {
  if (!history?.past?.length) return history
  const previous = history.past[history.past.length - 1]
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future].slice(0, HISTORY_LIMIT),
  }
}

export function redoHistory(history) {
  if (!history?.future?.length) return history
  const [next, ...rest] = history.future
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: next,
    future: rest,
  }
}

export function replaceHistoryPresent(history, blocks) {
  return {
    past: history?.past ?? [],
    present: blocks ?? [],
    future: [],
  }
}

export function serializeBlocks(blocks) {
  return JSON.stringify(blocks ?? [])
}

export function isDocumentDirty(blocks, savedSnapshot) {
  if (savedSnapshot == null) return false
  return serializeBlocks(blocks) !== savedSnapshot
}

export function paginateBlocks(blocks) {
  const pages = [[]]
  for (const block of blocks ?? []) {
    if (block.type === 'pageBreak') {
      pages.push([])
    } else {
      pages[pages.length - 1].push(block)
    }
  }
  return pages
}

export function canExportDocument({ dirty, saving, conflict } = {}) {
  return !dirty && !saving && !conflict
}

export function documentSaveStatus({
  loading = false,
  saving = false,
  conflict = false,
  failed = false,
  dirty = false,
} = {}) {
  if (loading) return { key: 'loading', label: 'Loading…', tone: 'neutral' }
  if (saving) return { key: 'saving', label: 'Saving…', tone: 'neutral' }
  if (conflict) return { key: 'conflict', label: 'Save conflict', tone: 'danger' }
  if (failed) return { key: 'failed', label: 'Save failed', tone: 'danger' }
  if (dirty) return { key: 'dirty', label: 'Unsaved changes', tone: 'warning' }
  return { key: 'saved', label: 'Saved', tone: 'success' }
}

export function exportBlockedMessage({ dirty, saving, conflict } = {}) {
  if (conflict) return 'Reload the latest document before exporting.'
  if (saving) return 'Wait for the current save to finish before exporting.'
  if (dirty) return 'Save your changes before exporting — exports use the persisted document.'
  return ''
}

export function blockOutlineText(block) {
  if (!block) return ''
  if (block.type === 'pageBreak') return 'Page break'
  if (block.type === 'spacer') return `Spacer · ${block.content?.height ?? 24}px`
  if (LIST_BLOCK_TYPES.includes(block.type)) {
    const items = block.content?.items ?? []
    return items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : 'Empty list'
  }
  const text = String(block.content?.text ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return 'Empty block'
  return text.length > 58 ? `${text.slice(0, 58)}…` : text
}

export function blockTypeLabel(type) {
  return BLOCK_LABELS[type] ?? type
}
