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
import { useEffect, useMemo, useState, type ComponentType } from 'react'
import { transport } from '../api/transport'
import { t } from '../i18n'
import { NODE_KINDS } from '../nodes/catalog'
import { useEngines } from '../store/engine'
import { useLayout } from '../store/layout'
import { useModel } from '../store/model'
import { useSession } from '../store/session'
import { useViewport } from '../store/viewport'
import { IdChip, Label, NumField, Section, StatusMark, type MarkState } from '../ui'
import { isParamLocked, rowsFromSnapshot, rowsFromTower } from '../viewport/sceneTree'
import { ParamField } from './ParamField'
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

/* ── инспектор ────────────────────────────────────────────────── */

/** Настройки выбранного узла графа — поля строятся по каталогу типов. */
function NodeInspector() {
  const nodeId = useSession((x) => x.selectedNodeId)
  const graph = useSession((x) => x.graph)
  const update = useSession((x) => x.updateNodeParam)

  const node = graph.nodes.find((n) => n.id === nodeId)
  if (!node) return <Label>{t('inspect.emptyNode')}</Label>

  const specs = NODE_KINDS[node.kind].params

  return (
    <>
      <div className={s.kv}>
        <Label>{t('inspect.node')}</Label>
        <span className={s.kvValue}>{node.title}</span>
      </div>
      <div className={s.kv}>
        <Label>{t('inspect.kind')}</Label>
        <span className={s.kvValue}>{node.kind}</span>
      </div>
      <div className={s.fields}>
        {specs.map((spec) => (
          <ParamField
            key={spec.key}
            spec={spec}
            value={node.params?.[spec.key]}
            onChange={(value) => update(node.id, spec.key, value)}
          />
        ))}
      </div>
    </>
  )
}

/** Свойства выделенной части модели — значения настоящие, из геометрии сцены. */
function PartInspector() {
  const params = useViewport((v) => v.params)
  const selected = useViewport((v) => v.selected)
  // Ищем в том же дереве, что показывает аутлайнер, — иначе выделение
  // настоящей части не находилось бы среди демонстрационных.
  const snapshot = useModel((m) => m.snapshot)
  const parametric = useEngines((e) => e.boundEngine) !== 'sketchup'
  const rows = useMemo(
    () => (snapshot ? rowsFromSnapshot(snapshot) : parametric ? rowsFromTower(params) : []),
    [snapshot, parametric, params],
  )
  if (selected.length > 1) {
    // Разбирать по полям набор объектов бессмысленно — показываем состав.
    const names = selected.map((id) => rows.find((r) => r.id === id)?.name ?? id).join(', ')
    return (
      <div className={s.fields}>
        <div className={s.kv}>
          <Label>{t('inspect.selectedCount')}</Label>
          <span className={s.kvValue}>{selected.length}</span>
        </div>
        <Label tone="muted">{names}</Label>
      </div>
    )
  }

  const part = selected[0] ? rows.find((r) => r.id === selected[0]) : null

  if (!part) return <Label>{t('inspect.empty')}</Label>

  const material = part.material ?? part.tag ?? '—'
  const [x, y, z] = part.size

  return (
    <div className={s.fields}>
      <div className={s.kv}>
        <Label>{t('inspect.name')}</Label>
        <span className={s.kvValue}>{part.name}</span>
      </div>
      <div className={s.kv}>
        <Label>{t('inspect.kind')}</Label>
        <span className={s.kvValue}>{part.kind}</span>
      </div>
      <div className={s.kv}>
        <Label>{t('inspect.material')}</Label>
        <span className={s.kvValue}>{material}</span>
      </div>
      <div className={s.kv}>
        <Label>{t('inspect.size')}</Label>
        {/* Снимок из движка габарит не приносит. Нули вместо размера были бы
            прямой ложью, поэтому показываем прочерк. */}
        <span className={s.kvValue}>
          {x || y || z
            ? `${x.toLocaleString('ru-RU')} × ${y.toLocaleString('ru-RU')} × ${z.toLocaleString('ru-RU')} ${t('common.mm')}`
            : '—'}
        </span>
      </div>
      <div className={s.kv}>
        <Label>{t('inspect.triangles')}</Label>
        <span className={s.kvValue}>{part.triangles.toLocaleString('ru-RU')}</span>
      </div>
    </div>
  )
}

/**
 * Параметры демо-модели: правятся здесь, геометрия пересобирается сразу.
 * Поле блокируется, если заблокирована хотя бы одна часть, которую оно меняет.
 */
function ModelParams() {
  const params = useViewport((v) => v.params)
  const setParam = useViewport((v) => v.setParam)
  const locked = useViewport((v) => v.locked)

  const off = (key: keyof typeof params) => isParamLocked(key, locked)
  const anyLocked = (Object.keys(params) as Array<keyof typeof params>).some(off)

  return (
    <>
      <div className={s.fields}>
        <NumField
          label="этажей"
          value={params.floors}
          disabled={off('floors')}
          onChange={(v) => setParam('floors', v)}
        />
        <NumField
          label="шаг"
          value={params.floorHeight}
          unit={t('common.mm')}
          step={25}
          disabled={off('floorHeight')}
          onChange={(v) => setParam('floorHeight', v)}
        />
        <NumField
          label="радиус"
          value={params.radius}
          unit={t('common.mm')}
          step={100}
          disabled={off('radius')}
          onChange={(v) => setParam('radius', v)}
        />
        <NumField
          label="кручение"
          value={params.twistDeg}
          unit={t('common.deg')}
          disabled={off('twistDeg')}
          onChange={(v) => setParam('twistDeg', v)}
        />
        <NumField
          label="сторон"
          value={params.sides}
          disabled={off('sides')}
          onChange={(v) => setParam('sides', v)}
        />
        <NumField
          label="ребро"
          value={params.ribSize}
          unit={t('common.mm')}
          step={10}
          disabled={off('ribSize')}
          onChange={(v) => setParam('ribSize', v)}
        />
      </div>
      {anyLocked ? <Label>{t('inspect.lockedParams')}</Label> : null}
    </>
  )
}

/* ── теги и материалы ─────────────────────────────────────────── */

/**
 * Теги модели — списком, а не деревом.
 *
 * В SketchUp тег ничего не содержит: это ярлык на объекте для управления
 * видимостью. Рисовать его веткой дерева значит показывать структуру, которой
 * в файле нет, — поэтому он живёт отдельным списком, как и в самом приложении.
 */
function Tags() {
  const tags = useModel((m) => m.snapshot?.tags ?? [])
  const rows = useModel((m) => (m.snapshot ? rowsFromSnapshot(m.snapshot) : []))

  if (!tags.length) return <Label tone="muted">{t('tags.empty')}</Label>

  return (
    <div className={s.fields}>
      {tags.map((tag) => {
        const used = rows.filter((r) => r.tag === tag.name).length
        return (
          <div key={tag.name} className={s.kv}>
            <Label>{tag.name}</Label>
            <span className={s.kvValue}>
              {tag.folder ? `${tag.folder} · ` : ''}
              {used} {t('tags.objects')}
              {tag.visible ? '' : ` · ${t('tags.hidden')}`}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Материалы модели: цвет, прозрачность и на скольких объектах применён. */
function Materials() {
  const materials = useModel((m) => m.snapshot?.materials ?? [])

  if (!materials.length) return <Label tone="muted">{t('materials.empty')}</Label>

  // Неиспользуемые вниз: они есть в файле, но на модель не влияют.
  const sorted = [...materials].sort((a, b) => b.used - a.used)

  return (
    <div className={s.fields}>
      {sorted.map((mat) => (
        <div key={mat.name} className={s.kv}>
          <Label>
            <span
              className={s.swatch}
              style={{
                background: mat.color
                  ? `rgb(${mat.color.r}, ${mat.color.g}, ${mat.color.b})`
                  : 'transparent',
                opacity: mat.alpha,
              }}
            />
            {mat.name}
          </Label>
          <span className={s.kvValue}>
            {mat.used ? `${mat.used} ${t('tags.objects')}` : t('materials.unused')}
            {mat.textured ? ` · ${t('materials.textured')}` : ''}
            {mat.alpha < 1 ? ` · ${Math.round(mat.alpha * 100)}%` : ''}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Определения: что в модели компонент, а что группа.
 *
 * Разница дорогая: у компонента экземпляры связаны — правка одного меняет все
 * остальные. У группы копия независима. Перепутать их значит удивиться, когда
 * правка разойдётся по всей модели.
 */
function Definitions() {
  const definitions = useModel((m) => m.snapshot?.definitions ?? [])

  if (!definitions.length) return <Label tone="muted">{t('definitions.empty')}</Label>

  return (
    <div className={s.fields}>
      {definitions.map((d) => (
        <div key={d.name} className={s.kv}>
          <Label>{d.name}</Label>
          <span className={s.kvValue}>
            {d.group ? t('definitions.group') : t('definitions.component')} · {d.instances}{' '}
            {t('definitions.instances')}
          </span>
        </div>
      ))}
    </div>
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
      <PullModel />
    </div>
  )
}

/**
 * Забрать модель из движка вручную.
 *
 * Само это происходит после каждого ответа модели, но человек ещё и правит
 * файл руками в SketchUp — и вот тогда нужна кнопка. Опрашивать движок по
 * таймеру было бы проще, но сборка меша идёт на его главном потоке, и на
 * тяжёлой сцене это дёргало бы интерфейс самого SketchUp без всякой причины.
 */
function PullModel() {
  const bound = useEngines((e) => e.boundEngine)
  const engines = useEngines((e) => e.engines)
  const pull = useModel((m) => m.pull)
  const loading = useModel((m) => m.loading)
  const snapshot = useModel((m) => m.snapshot)
  const error = useModel((m) => m.error)

  const online = engines.some((e) => e.id === bound && e.status === 'online')

  return (
    <>
      <button
        type="button"
        className={s.pull}
        disabled={loading || !online}
        onClick={() => void pull(bound)}
        title={online ? t('engine.pull.hint') : t('engine.pull.offline')}
      >
        {loading ? t('engine.pull.loading') : t('engine.pull')}
      </button>
      {error ? <Label tone="muted">{error}</Label> : null}
      {snapshot ? (
        <Label tone="muted">
          {snapshot.title} · {snapshot.triangles.toLocaleString('ru')} тр
          {snapshot.truncated ? ' · показано не всё' : ''}
        </Label>
      ) : null}
    </>
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
  const tab = useLayout((l) => l.tab)
  const bound = useEngines((e) => e.boundEngine)

  // Параметрическая модель имеет смысл только там, где движок умеет
  // параметрику: Rhino с Grasshopper и Blender с его модификаторами. В
  // SketchUp такого нет вовсе, и показывать поля, которые не на что положить,
  // значит обещать несуществующее.
  const parametric = bound !== 'sketchup'

  return (
    <div className={s.tools}>
      <div className={s.toolsScroll}>
        <Section title={t('tools.section.create')} defaultOpen={tab === 'viewport'}>
          <ToolGrid items={CREATE} />
        </Section>
        <Section title={t('tools.section.modify')} defaultOpen={false}>
          <ToolGrid items={MODIFY} />
        </Section>

        {/* Инспектор контекстный: в графе — настройки узла, во вьюпорте — свойства части. */}
        <Section title={t('tools.section.inspect')}>
          {tab === 'nodes' ? <NodeInspector /> : <PartInspector />}
        </Section>

        {tab === 'viewport' && parametric ? (
          <Section title={t('tools.section.model')}>
            <ModelParams />
          </Section>
        ) : null}
        <Section title={t('tools.section.tags')} defaultOpen={false}>
          <Tags />
        </Section>
        <Section title={t('tools.section.materials')} defaultOpen={false}>
          <Materials />
        </Section>
        <Section title={t('tools.section.definitions')} defaultOpen={false}>
          <Definitions />
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
