import { Button, Field, cx, inputCls } from '../../components/ui.jsx'
import { Icon } from '../../components/icons.jsx'
import { BLOCK_LABELS, LIST_BLOCK_TYPES, TEXT_BLOCK_TYPES } from './documentEditor.js'

// STAGE 5 right panel: content and the validated formatting controls only.
// There is deliberately no absolute-position or arbitrary-HTML control.

const ALIGNMENTS = [
  ['left', 'Left'],
  ['center', 'Center'],
  ['right', 'Right'],
  ['justify', 'Justify'],
]

function numberOrNull(value) {
  if (value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function NumberControl({ label, value, min, max, step = 1, onChange }) {
  return (
    <label className="flex items-center justify-between gap-2 text-[12px] font-semibold text-ink-600">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value ?? ''}
        onChange={(event) => onChange(numberOrNull(event.target.value))}
        className="w-20 rounded-md border border-line bg-white px-2 py-1 text-right text-[12px] text-ink-800 focus:border-pine-800 focus:outline-none focus:ring-2 focus:ring-pine-900/15"
      />
    </label>
  )
}

export function BlockInspector({ block, onContentChange, onStyleChange, onClearStyle }) {
  if (!block) {
    return (
      <aside className="flex h-full min-h-0 flex-col border-line bg-white lg:border-l" aria-label="Formatting controls">
        <div className="border-b border-line-soft px-3.5 py-3">
          <h2 className="text-[12px] font-bold uppercase tracking-[0.07em] text-ink-400">Format</h2>
        </div>
        <p className="px-4 py-8 text-center text-[12.5px] text-ink-400">
          Select a block in the outline or preview to edit its content and formatting.
        </p>
      </aside>
    )
  }

  const style = block.style ?? {}
  const items = block.content?.items ?? []

  function updateItem(index, value) {
    const next = [...items]
    next[index] = value
    onContentChange({ items: next })
  }

  function addItem() {
    onContentChange({ items: [...items, ''] })
  }

  function removeItem(index) {
    onContentChange({ items: items.filter((_, itemIndex) => itemIndex !== index) })
  }

  return (
    <aside className="flex h-full min-h-0 flex-col border-line bg-white lg:border-l" aria-label="Formatting controls">
      <div className="border-b border-line-soft px-3.5 py-3">
        <h2 className="text-[12px] font-bold uppercase tracking-[0.07em] text-ink-400">Format</h2>
        <p className="mt-1 text-[13px] font-bold text-ink-900">{BLOCK_LABELS[block.type] ?? block.type}</p>
        {block.source?.section && (
          <p className="mt-0.5 text-[11.5px] text-pine-700">
            Generated from {block.source.section}
            {block.source.stepNumber ? ` · step ${block.source.stepNumber}` : ''}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-4">
        <div className="flex flex-col gap-3.5">
          {TEXT_BLOCK_TYPES.includes(block.type) && (
            <Field label="Text" htmlFor={`block-text-${block.id}`}>
              <textarea
                id={`block-text-${block.id}`}
                value={block.content?.text ?? ''}
                onChange={(event) => onContentChange({ text: event.target.value })}
                rows={block.type === 'title' || block.type === 'experimentNumber' ? 2 : 5}
                className={cx(inputCls, 'resize-y leading-relaxed')}
              />
            </Field>
          )}

          {LIST_BLOCK_TYPES.includes(block.type) && (
            <div>
              <p className="mb-1.5 text-[12.5px] font-semibold text-ink-700">List items</p>
              <div className="flex flex-col gap-1.5">
                {items.map((item, index) => (
                  <div key={index} className="flex items-start gap-1.5">
                    <textarea
                      aria-label={`List item ${index + 1}`}
                      value={item}
                      onChange={(event) => updateItem(index, event.target.value)}
                      rows={2}
                      className={cx(inputCls, 'min-w-0 flex-1 resize-y py-1.5 text-[12.5px] leading-relaxed')}
                    />
                    <button
                      type="button"
                      aria-label={`Remove list item ${index + 1}`}
                      title="Remove item"
                      onClick={() => removeItem(index)}
                      className="mt-1 rounded p-1 text-ink-300 hover:bg-[#FDECEC] hover:text-[#8F1D17]"
                    >
                      <Icon name="trash" className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                {items.length === 0 && (
                  <p className="rounded-lg border border-dashed border-line px-2.5 py-3 text-[12px] text-ink-400">
                    This list is empty.
                  </p>
                )}
              </div>
              <Button variant="secondary" size="sm" className="mt-2" onClick={addItem}>
                <Icon name="plus" className="h-3.5 w-3.5" />
                Add item
              </Button>
            </div>
          )}

          {block.type === 'code' && (
            <>
              <Field
                label="Code"
                htmlFor={`block-code-${block.id}`}
                hint="Line breaks and indentation are preserved exactly."
              >
                <textarea
                  id={`block-code-${block.id}`}
                  value={block.content?.text ?? ''}
                  onChange={(event) => onContentChange({ text: event.target.value })}
                  rows={10}
                  wrap="off"
                  spellCheck={false}
                  className="w-full resize-y rounded-lg border border-line bg-pine-950 px-3 py-2 font-mono text-[12px] leading-relaxed text-slate-100 focus:border-pine-700 focus:outline-none focus:ring-2 focus:ring-pine-700/30"
                />
              </Field>
              <Field label="Language" htmlFor={`block-language-${block.id}`}>
                <input
                  id={`block-language-${block.id}`}
                  value={block.content?.language ?? ''}
                  onChange={(event) => onContentChange({ language: event.target.value || null })}
                  placeholder="javascript"
                  className={inputCls}
                />
              </Field>
            </>
          )}

          {block.type === 'spacer' && (
            <Field label="Spacer height (px)" htmlFor={`block-height-${block.id}`}>
              <input
                id={`block-height-${block.id}`}
                type="number"
                min={8}
                max={240}
                value={block.content?.height ?? 24}
                onChange={(event) =>
                  onContentChange({ height: Math.max(8, Math.min(240, Number(event.target.value) || 8)) })
                }
                className={inputCls}
              />
            </Field>
          )}

          {block.type === 'pageBreak' && (
            <div className="rounded-lg border border-line bg-paper px-3 py-3 text-[12.5px] leading-relaxed text-ink-500">
              A manual page break. Everything after it starts on a new page in the preview and in
              renderers that support the saved block model.
            </div>
          )}

          {block.type !== 'pageBreak' && (
            <div className="border-t border-line-soft pt-3.5">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[12.5px] font-bold text-ink-700">Formatting</p>
                <button
                  type="button"
                  onClick={() => onClearStyle()}
                  className="text-[11.5px] font-bold text-pine-800 hover:underline"
                >
                  Reset
                </button>
              </div>

              <div className="flex flex-col gap-2.5">
                <div>
                  <p className="mb-1 text-[12px] font-semibold text-ink-600">Alignment</p>
                  <div className="grid grid-cols-4 gap-1" role="group" aria-label="Block alignment">
                    {ALIGNMENTS.map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={style.align === value}
                        onClick={() => onStyleChange({ align: style.align === value ? null : value })}
                        className={cx(
                          'rounded-md border px-1 py-1 text-[11px] font-semibold transition-colors',
                          style.align === value
                            ? 'border-pine-900 bg-pine-900 text-white'
                            : 'border-line bg-white text-ink-500 hover:bg-rail',
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <NumberControl
                  label="Font size"
                  value={style.fontSize}
                  min={8}
                  max={48}
                  onChange={(value) => onStyleChange({ fontSize: value })}
                />
                <NumberControl
                  label="Line height"
                  value={style.lineHeight}
                  min={0.8}
                  max={3}
                  step={0.05}
                  onChange={(value) => onStyleChange({ lineHeight: value })}
                />
                <NumberControl
                  label="Space before"
                  value={style.spacingBefore}
                  min={0}
                  max={120}
                  onChange={(value) => onStyleChange({ spacingBefore: value })}
                />
                <NumberControl
                  label="Space after"
                  value={style.spacingAfter}
                  min={0}
                  max={120}
                  onChange={(value) => onStyleChange({ spacingAfter: value })}
                />
                <NumberControl
                  label="Indent"
                  value={style.indent}
                  min={0}
                  max={120}
                  onChange={(value) => onStyleChange({ indent: value })}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
