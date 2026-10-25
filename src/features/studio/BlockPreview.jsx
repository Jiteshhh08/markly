import { cx } from '../../components/ui.jsx'
import { BLOCK_LABELS, LIST_BLOCK_TYPES, paginateBlocks } from './documentEditor.js'

// STAGE 5 centre panel: page-style preview of the saved model. Template-locked
// header/watermark decoration stays outside the editable body and is never
// clickable or included in the block array.

function styleFor(block, defaults = {}) {
  const style = { ...defaults }
  if (block.style?.align) style.textAlign = block.style.align
  if (Number.isInteger(block.style?.fontSize)) style.fontSize = `${block.style.fontSize}px`
  if (Number.isInteger(block.style?.spacingBefore)) style.marginTop = `${block.style.spacingBefore}px`
  if (Number.isInteger(block.style?.spacingAfter)) style.marginBottom = `${block.style.spacingAfter}px`
  if (Number.isInteger(block.style?.indent)) style.paddingLeft = `${block.style.indent}px`
  return style
}

function BlockBody({ block }) {
  const text = block.content?.text ?? ''
  if (block.type === 'title') {
    return (
      <h1 className="text-[26px] font-bold leading-tight" style={styleFor(block, { textAlign: 'center' })}>
        {text || 'Untitled document'}
      </h1>
    )
  }
  if (block.type === 'experimentNumber') {
    return (
      <p className="text-[13px] font-bold" style={styleFor(block, { textAlign: 'center' })}>
        {text || 'Experiment No. —'}
      </p>
    )
  }
  if (block.type === 'heading') {
    return (
      <h2 className="border-b border-ink-900/20 pb-1 text-[17px] font-bold" style={styleFor(block)}>
        {text || 'Section heading'}
      </h2>
    )
  }
  if (block.type === 'subheading') {
    return (
      <h3 className="text-[14.5px] font-bold" style={styleFor(block)}>
        {text || 'Subheading'}
      </h3>
    )
  }
  if (block.type === 'paragraph') {
    return (
      <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed" style={styleFor(block)}>
        {text || 'Empty paragraph'}
      </p>
    )
  }
  if (LIST_BLOCK_TYPES.includes(block.type)) {
    const items = block.content?.items ?? []
    const Tag = block.type === 'numberedList' ? 'ol' : 'ul'
    return (
      <Tag
        className={cx(
          'space-y-1 pl-5 text-[13.5px] leading-relaxed',
          block.type === 'numberedList' ? 'list-decimal' : 'list-disc',
        )}
        style={styleFor(block)}
      >
        {items.length ? (
          items.map((item, index) => (
            <li key={index} className="whitespace-pre-wrap">
              {item || <span className="text-ink-300">Empty item</span>}
            </li>
          ))
        ) : (
          <li className="list-none text-ink-300">Empty list</li>
        )}
      </Tag>
    )
  }
  if (block.type === 'code') {
    return (
      <pre
        className="overflow-x-auto rounded-md border border-line bg-paper px-3 py-2 font-mono text-[11.5px] leading-relaxed"
        style={styleFor(block)}
      >
        {text || '// Empty code block'}
      </pre>
    )
  }
  if (block.type === 'spacer') {
    return <div aria-label="Spacer" style={{ height: `${block.content?.height ?? 24}px` }} />
  }
  return null
}

export function BlockPreview({ document, blocks, selectedId, onSelect }) {
  const pages = paginateBlocks(blocks)
  const templateName = document?.template?.name ?? document?.template?.id ?? 'Template'
  const college = document?.collegeId ?? 'College'

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#E9E6DD]" aria-label="Live document preview">
      <div className="flex items-center justify-between border-b border-line bg-white px-3.5 py-2.5">
        <div>
          <h2 className="text-[12px] font-bold uppercase tracking-[0.07em] text-ink-400">Live preview</h2>
          <p className="mt-0.5 text-[11.5px] text-ink-400">
            {pages.length} page{pages.length === 1 ? '' : 's'} · saved model
          </p>
        </div>
        <span className="rounded-md bg-pine-50 px-2 py-1 text-[10.5px] font-bold text-pine-800 ring-1 ring-inset ring-pine-900/15">
          Template-locked header
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5">
          {pages.map((pageBlocks, pageIndex) => (
            <div
              key={pageIndex}
              className="relative min-h-[560px] overflow-hidden rounded-sm border border-ink-900/10 bg-white px-6 pb-14 pt-24 shadow-[0_8px_24px_rgba(30,42,40,0.16)] sm:px-10"
            >
              <div className="pointer-events-none absolute inset-x-5 top-4 flex items-center justify-between border-b-2 border-pine-900/20 pb-2 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-300">
                <span className="truncate">{college}</span>
                <span className="truncate">{templateName}</span>
              </div>
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 flex select-none items-center justify-center"
              >
                <span className="-rotate-[28deg] text-[64px] font-black uppercase tracking-[0.16em] text-ink-900/[0.045]">
                  {templateName}
                </span>
              </div>
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center border-t border-line-soft py-2 text-[10px] font-semibold text-ink-300">
                Page {pageIndex + 1}
              </div>

              <div className="relative z-10 flex flex-col gap-3">
                {pageBlocks.length === 0 && (
                  <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-[12.5px] text-ink-300">
                    Empty page
                  </p>
                )}
                {pageBlocks.map((block) => {
                  const selected = block.id === selectedId
                  return (
                    <div
                      key={block.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Select ${BLOCK_LABELS[block.type] ?? block.type} block`}
                      onClick={() => onSelect(block.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onSelect(block.id)
                        }
                      }}
                      className={cx(
                        'cursor-pointer rounded-md px-1.5 py-1 outline-none transition-shadow',
                        selected
                          ? 'ring-2 ring-pine-700/50 ring-offset-2'
                          : 'hover:bg-pine-50/40 focus-visible:ring-2 focus-visible:ring-pine-700/40',
                      )}
                    >
                      <BlockBody block={block} />
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
