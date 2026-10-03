// Creation modal (moved from App.jsx in the final stage). Collects the
// assignment brief; generation itself is the App shell's job via onSubmit.
import { useState } from 'react'
import { Button, Field, ModalShell, cx, inputCls } from '../../components/ui.jsx'
import { Icon, Spinner } from '../../components/icons.jsx'
import { DIFFICULTIES, SUBJECTS } from './data.js'

function FormSection({ index, title, hint, children }) {
  return (
    <section className="rounded-xl border border-line bg-white p-4">
      <div className="flex items-baseline gap-2.5">
        <span className="text-[11px] font-bold text-sand-600">{index}</span>
        <div>
          <h3 className="text-[13.5px] font-bold tracking-tight">{title}</h3>
          {hint && <p className="mt-0.5 text-[12.5px] text-ink-500">{hint}</p>}
        </div>
      </div>
      <div className="mt-3.5 flex flex-col gap-3.5">{children}</div>
    </section>
  )
}

export function CreateModal({ initial, templates = [], onClose, onSubmit }) {
  const [form, setForm] = useState({
    aim: initial?.aim ?? '',
    description: initial?.description ?? '',
    subject: initial?.subject ?? 'DBMS',
    experimentNumber: initial?.experimentNumber ?? '',
    technology: initial?.technology ?? '',
    difficulty: initial?.difficulty ?? 'Intermediate',
    templateId: initial?.templateId ?? '',
    includeVivaTitle: initial?.includeVivaTitle ?? false,
    typedConclusion: initial?.typedConclusion ?? true,
  })
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  function set(key, value) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function submit(e) {
    e.preventDefault()
    if (submitting) return
    if (form.aim.trim().length < 4) {
      setError('Please describe the aim in at least 4 characters.')
      return
    }
    if (form.experimentNumber && !/^\d{1,3}$/.test(form.experimentNumber.trim())) {
      setError('Experiment number must be between 1 and 999.')
      return
    }
    setError('')
    setSubmitting(true)
    onSubmit(form)
  }

  return (
    <ModalShell
      title="Create assignment"
      subtitle="Describe the practical — Markly drafts the full department-ready document."
      onClose={onClose}
      wide
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => document.getElementById('create-form')?.requestSubmit()} disabled={submitting} size="lg">
            {submitting ? <Spinner className="h-4 w-4" /> : <Icon name="send" className="h-4 w-4" />}
            {submitting ? 'Generating…' : 'Generate assignment'}
          </Button>
        </div>
      }
    >
      <form id="create-form" onSubmit={submit} className="flex flex-col gap-3">
        <FormSection index="01" title="Basic information" hint="What is this practical about? Be specific — a clear aim produces a better document.">
          <Field label="Aim" htmlFor="f-aim" hint={`${form.aim.trim().length}/2000 characters. Example: “Explore subqueries in SQL”.`}>
            <input
              id="f-aim"
              value={form.aim}
              onChange={(e) => set('aim', e.target.value)}
              placeholder="e.g. Explore subqueries in SQL"
              className={cx(inputCls, 'font-medium')}
              maxLength={2000}
              autoFocus
            />
          </Field>
          <Field label="Description" htmlFor="f-desc" hint="Optional context — scope, outcomes or constraints for this experiment.">
            <textarea
              id="f-desc"
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              rows={2}
              placeholder="Context, scope or outcomes for this experiment…"
              className={inputCls}
              maxLength={4000}
            />
          </Field>
        </FormSection>

        <FormSection index="02" title="Experiment details" hint="Used for headers, filing and difficulty-appropriate depth.">
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <Field label="Subject" htmlFor="f-subject">
              <select id="f-subject" value={form.subject} onChange={(e) => set('subject', e.target.value)} className={inputCls}>
                {SUBJECTS.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
            <Field label="Experiment number" htmlFor="f-exp" hint="1–999. Shown as EXP-07 on cards and headers.">
              <input
                id="f-exp"
                value={form.experimentNumber}
                onChange={(e) => set('experimentNumber', e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
                placeholder="7"
                inputMode="numeric"
                className={inputCls}
              />
            </Field>
            <Field label="Technology" htmlFor="f-tech" hint="Optional — e.g. SQL, Java, Python.">
              <input id="f-tech" value={form.technology} onChange={(e) => set('technology', e.target.value)} placeholder="SQL, Java…" className={inputCls} maxLength={64} />
            </Field>
            <Field label="Difficulty" htmlFor="f-diff" hint="Controls depth of theory and steps.">
              <select id="f-diff" value={form.difficulty} onChange={(e) => set('difficulty', e.target.value)} className={inputCls}>
                {DIFFICULTIES.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </Field>
          </div>
        </FormSection>

        <FormSection index="03" title="Document settings" hint="Format and finishing options for the final document.">
          <Field label="Template" htmlFor="f-template" hint="Department format. The active default is used when left empty.">
            <select id="f-template" value={form.templateId} onChange={(e) => set('templateId', e.target.value)} className={inputCls}>
              <option value="">Default (active template)</option>
              {templates.map((t) => (
                <option key={`${t.id}@${t.version}`} value={t.id}>
                  {t.name} v{t.version}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex flex-col gap-2 rounded-lg bg-paper px-3 py-2.5 ring-1 ring-inset ring-line-soft">
            <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
              <input type="checkbox" checked={form.includeVivaTitle} onChange={(e) => set('includeVivaTitle', e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#1A4543]" />
              <span>
                <span className="font-bold">Include Viva Questions heading</span>
                <span className="block text-[12.5px] text-ink-500">Heading only — questions are handwritten by faculty, never generated. Off for most experiments.</span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
              <input type="checkbox" checked={form.typedConclusion} onChange={(e) => set('typedConclusion', e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#1A4543]" />
              <span>
                <span className="font-bold">Type the conclusion</span>
                <span className="block text-[12.5px] text-ink-500">Uncheck to leave handwriting space (the conclusion itself is compulsory).</span>
              </span>
            </label>
          </div>
        </FormSection>

        {error && <p className="rounded-lg bg-[#FDECEC] px-3 py-2 text-[13px] font-medium text-[#8F1D17]">{error}</p>}
        {submitting && (
          <div className="flex items-center gap-2.5 rounded-xl border border-pine-900/15 bg-pine-50 px-3.5 py-3">
            <Spinner />
            <p className="text-[13px] font-semibold text-pine-900">Generating assignment…</p>
          </div>
        )}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1}>submit</button>
      </form>
    </ModalShell>
  )
}
