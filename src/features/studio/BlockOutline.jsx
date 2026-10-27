import { useState } from 'react'
import { Button, cx } from '../../components/ui.jsx'
import { Icon } from '../../components/icons.jsx'
import { BLOCK_LABELS, BLOCK_TYPES, blockOutlineText } from './documentEditor.js'

// STAGE 5 left panel: ordered outline with native drag-and-drop plus explicit
// move-up/move-down buttons for keyboard and assistive-technology users.

export function BlockOutline({
  blocks,
  selectedId,
  onSelect,
  onAdd,
  onMove,
  onDuplicate,
  onDelete,
  onDropBlock,
}) {
  const [newType, setNewType] = useState('paragraph')
  const [draggingId, setDraggingId] = useState(null)

  function startDrag(event, id) {
    setDraggingId(id)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
  }

  function dropOn(event, targetId) {
    event.preventDefault()
    const sourceId = event.dataTransfer.getData('text/plain') || draggingId
    setDraggingId(null)
    if (sourceId && sourceId !== targetId) onDropBlock(sourceId, targetId)
  }

  return (
    <aside className="flex h-full min-h-0 flex-col border-line bg-white lg:border-r" aria-label="Document outline">
      <div className="border-b border-line-soft px-3.5 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[12px] font-bold uppercase tracking-[0.07em] text-ink-400">Outline</h2>
          <span className="text-[11.5px] font-semibold text-ink-300">{blocks.length} blocks</span>
        </div>
        <div className="mt-2 flex gap-1.5">
          <select
            aria-label="Block type to insert"
            value={newType}
            onChange={(event) => setNewType(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-line bg-white px-2 py-1.5 text-[12px] font-semibold text-ink-700 focus:border-pine-800 focus:outline-none focus:ring-2 focus:ring-pine-900/15"
          >
            {BLOCK_TYPES.map((type) => (
              <option key={type} value={type}>
                {BLOCK_LABELS[type]}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={() => onAdd(newType)} aria-label="Insert block">
            <Icon name="plus" className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>
      </div>

      <ol className="min-h-0 flex-1 overflow-y-auto px-2 py-2" aria-label="Document blocks">
        {blocks.length === 0 && (
          <li className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-[12.5px] text-ink-400">
            No body blocks yet. Add one above.
          </li>
        )}
        {blocks.map((block, index) => {
          const selected = block.id === selectedId
          return (
            <li
              key={block.id}
              draggable
              onDragStart={(event) => startDrag(event, block.id)}
              onDragEnd={() => setDraggingId(null)}
              onDragOver={(event) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(event) => dropOn(event, block.id)}
              className={cx(
                'group mb-1.5 rounded-lg border p-1.5 transition-colors',
                selected
                  ? 'border-pine-900/30 bg-pine-50'
                  : 'border-transparent hover:border-line hover:bg-paper',
                draggingId === block.id && 'opacity-50',
              )}
            >
              <div className="flex items-start gap-1.5">
                <span
                  className="mt-0.5 flex h-5 w-5 shrink-0 cursor-grab items-center justify-center rounded bg-rail text-[10px] font-bold text-ink-400"
                  title="Drag to reorder"
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <button
                  type="button"
                  onClick={() => onSelect(block.id)}
                  aria-current={selected ? 'true' : undefined}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block text-[11px] font-bold uppercase tracking-[0.04em] text-ink-300">
                    {BLOCK_LABELS[block.type] ?? block.type}
                  </span>
                  <span className="mt-0.5 block truncate text-[12.5px] font-semibold text-ink-800">
                    {blockOutlineText(block)}
                  </span>
                  {block.source?.section && (
                    <span className="mt-0.5 block text-[10.5px] font-medium text-pine-700">
                      {block.source.section}
                      {block.source.stepNumber ? ` · step ${block.source.stepNumber}` : ''}
                    </span>
                  )}
                </button>
                <span className="flex shrink-0 flex-col gap-0.5">
                  <button
                    type="button"
                    aria-label={`Move ${BLOCK_LABELS[block.type] ?? block.type} up`}
                    title="Move up"
                    disabled={index === 0}
                    onClick={() => onMove(block.id, -1)}
                    className="rounded p-0.5 text-ink-300 hover:bg-rail hover:text-ink-800 disabled:opacity-25"
                  >
                    <Icon name="arrowUp" className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${BLOCK_LABELS[block.type] ?? block.type} down`}
                    title="Move down"
                    disabled={index === blocks.length - 1}
                    onClick={() => onMove(block.id, 1)}
                    className="rounded p-0.5 text-ink-300 hover:bg-rail hover:text-ink-800 disabled:opacity-25"
                  >
                    <Icon name="arrowDown" className="h-3.5 w-3.5" />
                  </button>
                </span>
              </div>
              <div className="mt-1 flex justify-end gap-1 opacity-70 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => onDuplicate(block.id)}
                  aria-label={`Duplicate ${BLOCK_LABELS[block.type] ?? block.type}`}
                  title="Duplicate"
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-semibold text-ink-400 hover:bg-rail hover:text-ink-800"
                >
                  <Icon name="copy" className="h-3 w-3" />
                  Duplicate
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(block.id)}
                  aria-label={`Delete ${BLOCK_LABELS[block.type] ?? block.type}`}
                  title="Delete"
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-semibold text-ink-400 hover:bg-[#FDECEC] hover:text-[#8F1D17]"
                >
                  <Icon name="trash" className="h-3 w-3" />
                  Delete
                </button>
              </div>
            </li>
          )
        })}
      </ol>
    </aside>
  )
}
