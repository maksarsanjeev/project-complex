import { Canvas } from '@react-three/fiber'
import { Crosshair, Grid3x3, Maximize2, X } from 'lucide-react'
import { Suspense, useCallback, useState, type DragEvent } from 'react'
import { t } from '../i18n'
import { useViewport, type DisplayMode, type Projection } from '../store/viewport'
import { IconButton, Label, Segmented, type SegmentedOption } from '../ui'
import { Scene } from './Scene'
import { useModel } from '../store/model'
import { useLoadedModel } from './loader'
import s from './Viewport.module.css'

const MODES: ReadonlyArray<SegmentedOption<DisplayMode>> = [
  { value: 'shaded', label: 'shaded' },
  { value: 'wire', label: 'wire' },
  { value: 'clay', label: 'clay' },
  { value: 'xray', label: 'x-ray' },
]

const PROJECTIONS: ReadonlyArray<SegmentedOption<Projection>> = [
  { value: 'persp', label: 'персп' },
  { value: 'ortho', label: 'орто' },
]

/** Панель инструментов вьюпорта — её отдаём в шапку центральной панели. */
export function ViewportToolbar() {
  const mode = useViewport((v) => v.mode)
  const setMode = useViewport((v) => v.setMode)
  const projection = useViewport((v) => v.projection)
  const setProjection = useViewport((v) => v.setProjection)
  const grid = useViewport((v) => v.grid)
  const toggleGrid = useViewport((v) => v.toggleGrid)
  const gizmo = useViewport((v) => v.gizmo)
  const toggleGizmo = useViewport((v) => v.toggleGizmo)
  const fit = useViewport((v) => v.fit)

  // Чип показывает то, что сейчас в кадре: перетащенный файл либо снимок
  // из движка. Крестик у снимка возвращает демо-башню, у файла — тоже.
  const fileName = useLoadedModel((l) => l.name)
  const fileError = useLoadedModel((l) => l.error)
  const clearFile = useLoadedModel((l) => l.clear)
  const snapshot = useModel((m) => m.snapshot)
  const modelError = useModel((m) => m.error)
  const clearModel = useModel((m) => m.clear)

  const name = fileName ?? snapshot?.title ?? null
  const error = fileError ?? modelError
  const clear = fileName ? clearFile : clearModel

  return (
    <div className={s.toolbar}>
      <Segmented options={MODES} value={mode} onChange={setMode} />
      <Segmented options={PROJECTIONS} value={projection} onChange={setProjection} />
      <IconButton active={grid} onClick={toggleGrid} title={t('viewport.grid')}>
        <Grid3x3 size={13} strokeWidth={1} />
      </IconButton>
      <IconButton active={gizmo} onClick={toggleGizmo} title={t('viewport.gizmo')}>
        <Crosshair size={13} strokeWidth={1} />
      </IconButton>
      <IconButton onClick={fit} title={t('viewport.fit')}>
        <Maximize2 size={13} strokeWidth={1} />
      </IconButton>

      {name ? (
        <span className={s.filechip}>
          <span className={s.filename}>{name}</span>
          <IconButton onClick={clear} title={t('common.close')}>
            <X size={11} strokeWidth={1} />
          </IconButton>
        </span>
      ) : null}
      {error ? <span className={s.error}>{error}</span> : null}
    </div>
  )
}

/**
 * Ссылки на настройки канваса держим стабильными. Литералы в пропсах заставляли
 * r3f переконфигурировать канвас на каждый рендер — а вместе с этим пересоздавался
 * объект size, и камера отскакивала в вид по умолчанию посреди вращения и зума.
 */
const GL_OPTIONS = { antialias: true, alpha: true }
const DPR: [number, number] = [1, 2]
const deselect = () => useViewport.getState().select(null)

/**
 * Счётчики вынесены в отдельный компонент: они обновляются несколько раз в
 * секунду во время взаимодействия, и подписка на них в самом Viewport
 * перерисовывала бы всё дерево канваса.
 */
function HudStats() {
  const stats = useViewport((v) => v.stats)
  const selected = useViewport((v) => v.selected)

  return (
    <div className={s.hudTL}>
      <div className={s.hudRow}>
        <Label>{t('hud.objects')}</Label>
        <span className={s.hudValue}>{stats.objects}</span>
      </div>
      <div className={s.hudRow}>
        <Label>{t('hud.tris')}</Label>
        <span className={s.hudValue}>{stats.triangles.toLocaleString('ru-RU')}</span>
      </div>
      <div className={s.hudRow}>
        <Label>{t('hud.selection')}</Label>
        <span className={s.hudValue}>{selected ?? '—'}</span>
      </div>
    </div>
  )
}

export function Viewport() {
  const mode = useViewport((v) => v.mode)
  const projection = useViewport((v) => v.projection)
  const params = useViewport((v) => v.params)

  const load = useLoadedModel((l) => l.load)
  const loading = useLoadedModel((l) => l.loading)

  const [dragging, setDragging] = useState(false)

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setDragging(false)
      const file = e.dataTransfer.files.item(0)
      if (file) void load(file)
    },
    [load],
  )

  return (
    <div
      className={s.root}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className={s.canvas}>
        <Canvas frameloop="demand" dpr={DPR} gl={GL_OPTIONS} onPointerMissed={deselect}>
          <Suspense fallback={null}>
            <Scene />
          </Suspense>
        </Canvas>
      </div>

      <div className={s.frame} aria-hidden>
        <span />
        <span />
        <span />
        <span />
      </div>

      <div className={s.hud}>
        <HudStats />

        <div className={s.hudTR}>
          <Label tone="ink2">{mode}</Label>
          <Label tone="ink2">
            {projection === 'persp' ? t('viewport.projection.persp') : t('viewport.projection.ortho')}
          </Label>
        </div>

        <div className={s.hudBL}>
          <div className={s.hudRow}>
            <Label>{t('hud.units')}</Label>
            <span className={s.hudValue}>{t('common.mm')}</span>
          </div>
          <div className={s.hudRow}>
            <Label>{t('hud.snap')}</Label>
            <span className={s.hudValue}>100</span>
          </div>
          <div className={s.hudRow}>
            <Label>H</Label>
            <span className={s.hudValue}>
              {(params.floors * params.floorHeight).toLocaleString('ru-RU')}
            </span>
            <Label>{t('common.mm')}</Label>
          </div>
        </div>
      </div>

      {dragging || loading ? (
        <div className={s.drop}>
          <div className={s.dropInner}>
            <Label tone="strong">{loading ? t('viewport.loading') : t('viewport.drop')}</Label>
          </div>
        </div>
      ) : null}
    </div>
  )
}
