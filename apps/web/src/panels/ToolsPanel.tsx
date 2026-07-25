import type { ExportFormat, KnowledgeHit } from '@complex/protocol'
import {
  ArrowUp,
  Box,
  Circle,
  FlipHorizontal,
  Grid3x3,
  Layers,
  Move,
  RotateCw,
  Scissors,
  Spline,
  Square,
  Triangle,
} from 'lucide-react'
import { useEffect, useState, type ComponentType } from 'react'
import { transport } from '../api/transport'
import { t } from '../i18n'
import { useEngines } from '../store/engine'
import { useSession } from '../store/session'
import { useViewport } from '../store/viewport'
import { IdChip, Label, NumField, Section, StatusMark, type MarkState } from '../ui'
import s from './panels.module.css'

type IconType = ComponentType<{ size?: number; strokeWidth?: number }>

const CREATE: Array<[IconType, string]> = [
  [Box, 'tools.box'],
  [Circle, 'tools.cylinder'],
  [Triangle, 'tools.sphere'],
  [Square, 'tools.plane'],
]

const MODIFY: Array<[IconType, string]> = [
  [ArrowUp, 'tools.extrude'],
  [RotateCw, 'tools.revolve'],
  [Scissors, 'tools.boolean'],
  [Grid3x3, 'tools.array'],
  [Spline, 'tools.fillet'],
  [Layers, 'tools.chamfer'],
  [FlipHorizontal, 'tools.mirror'],
  [Move, 'tools.transform'],
]

const ENGINE_MARK: Record<string, MarkState> = {
  online: 'ok',
  busy: 'running',
  offline: 'idle',
  error: 'error',
}

const FORMATS: ExportFormat[] = ['3dm', 'skp', 'fbx', 'obj', 'glb', 'stl', 'step']

function ToolGrid({ items }: { items: Array<[IconType, string]> }) {
  return (
    <div className={s.grid}>
      {items.map(([Icon, key]) => {
        const label = t(key as Parameters<typeof t>[0])
        return (
          <button key={key} type="button" className={s.gridBtn} title={label}>
            <Icon size={15} strokeWidth={1} />
            <span className={s.gridBtnLabel}>{label}</span>
          </button>
        )
      })}
    </div>
  )
}

/* ── инспектор: правит параметры демо-модели прямо во вьюпорте ─── */

function Inspector() {
  const params = useViewport((v) => v.params)
  const setParam = useViewport((v) => v.setParam)
  const selected = useViewport((v) => v.selected)

  return (
    <>
      <div className={s.kv}>
        <Label>{t('inspect.name')}</Label>
        <span className={s.kvValue}>{selected ?? t('inspect.empty')}</span>
      </div>
      <div className={s.fields}>
        <NumField label="этажей" value={params.floors} onChange={(v) => setParam('floors', v)} />
        <NumField
          label="шаг"
          value={params.floorHeight}
          unit={t('common.mm')}
          step={25}
          onChange={(v) => setParam('floorHeight', v)}
        />
        <NumField
          label="радиус"
          value={params.radius}
          unit={t('common.mm')}
          step={100}
          onChange={(v) => setParam('radius', v)}
        />
        <NumField
          label="кручение"
          value={params.twistDeg}
          unit={t('common.deg')}
          onChange={(v) => setParam('twistDeg', v)}
        />
        <NumField label="сторон" value={params.sides} onChange={(v) => setParam('sides', v)} />
        <NumField
          label="ребро"
          value={params.ribSize}
          unit={t('common.mm')}
          step={10}
          onChange={(v) => setParam('ribSize', v)}
        />
      </div>
    </>
  )
}

/* ── движки ───────────────────────────────────────────────────── */

function Engines() {
  const engines = useEngines((e) => e.engines)
  const bound = useEngines((e) => e.boundEngine)
  const bind = useEngines((e) => e.bind)

  return (
    <div className={s.fields}>
      {engines.map((engine) => (
        <button
          key={engine.id}
          type="button"
          className={s.engine}
          data-bound={engine.id === bound || undefined}
          onClick={() => bind(engine.id)}
          title={engine.id === bound ? t('engine.bound') : t('engine.bind')}
        >
          <StatusMark state={ENGINE_MARK[engine.status] ?? 'idle'} />
          <span className={s.engineName}>{engine.label}</span>
          <span className={s.engineMeta}>
            :{engine.port}
            {engine.version ? ` · ${engine.version}` : ''}
          </span>
        </button>
      ))}
    </div>
  )
}

/* ── экспорт ──────────────────────────────────────────────────── */

function Export() {
  const [format, setFormat] = useState<ExportFormat>('3dm')
  const [progress, setProgress] = useState<number | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const sessionId = useSession((x) => x.activeId)
  const engine = useEngines((e) => e.boundEngine)

  const run = async () => {
    if (!sessionId || progress !== null) return
    setProgress(0)
    for await (const event of transport.runJob({ sessionId, engine, action: 'export', format })) {
      if (event.type === 'job-progress') {
        setProgress(event.progress)
        setStage(event.message ?? null)
      }
      if (event.type === 'job-end') {
        setProgress(null)
        setStage(null)
      }
    }
  }

  return (
    <>
      <div className={s.formats}>
        {FORMATS.map((f) => (
          <button
            key={f}
            type="button"
            className={s.format}
            data-active={f === format || undefined}
            onClick={() => setFormat(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <Label>{t('export.hint')}</Label>
      <button
        type="button"
        className={s.wideBtn}
        disabled={!sessionId || progress !== null}
        onClick={() => void run()}
      >
        {t('export.run')} · {format}
      </button>
      {progress !== null ? (
        <>
          <div className={s.progress}>
            <span className={s.progressFill} style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <Label>{stage ?? ''}</Label>
        </>
      ) : null}
    </>
  )
}

/* ── база знаний ──────────────────────────────────────────────── */

function Knowledge() {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<KnowledgeHit[]>([])

  useEffect(() => {
    let cancelled = false
    if (!query.trim()) {
      setHits([])
      return
    }
    const id = setTimeout(() => {
      void transport.searchKnowledge(query).then((next) => {
        if (!cancelled) setHits(next)
      })
    }, 220)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [query])

  return (
    <>
      <input
        className={s.kbInput}
        value={query}
        placeholder={t('kb.placeholder')}
        onChange={(e) => setQuery(e.target.value)}
      />
      {hits.length === 0 ? (
        <Label>{t('kb.empty')}</Label>
      ) : (
        hits.map((hit) => (
          <div key={hit.id} className={s.hit}>
            <span className={s.hitTitle}>{hit.title}</span>
            <span className={s.hitText}>{hit.excerpt}</span>
            <span className={s.hitMeta}>
              <IdChip>{hit.score.toFixed(2)}</IdChip>
              <Label>{hit.source}</Label>
            </span>
          </div>
        ))
      )}
    </>
  )
}

/* ── панель целиком ───────────────────────────────────────────── */

export function ToolsPanel() {
  return (
    <div className={s.tools}>
      <div className={s.toolsScroll}>
        <Section title={t('tools.section.create')}>
          <ToolGrid items={CREATE} />
        </Section>
        <Section title={t('tools.section.modify')}>
          <ToolGrid items={MODIFY} />
        </Section>
        <Section title={t('tools.section.inspect')}>
          <Inspector />
        </Section>
        <Section title={t('tools.section.engine')}>
          <Engines />
        </Section>
        <Section title={t('tools.section.export')} defaultOpen={false}>
          <Export />
        </Section>
        <Section title={t('tools.section.kb')} defaultOpen={false}>
          <Knowledge />
        </Section>
      </div>
    </div>
  )
}
