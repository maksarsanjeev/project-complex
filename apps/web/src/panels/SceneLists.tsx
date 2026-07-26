import { t } from '../i18n'
import { useModel } from '../store/model'
import { rowsFromSnapshots } from '../viewport/sceneTree'
import { Label } from '../ui'
import { RenameField } from './RenameField'
import s from './panels.module.css'
import { useMemo } from 'react'

/**
 * Теги, материалы и определения — рядом с деревом сцены, а не в панели
 * инструментов справа.
 *
 * Всё это части одной модели, и человек смотрит на них подряд: увидел объект в
 * дереве, тут же поправил его материал. Разносить их по разным краям экрана
 * значило заставлять ходить туда-обратно ради каждой мелочи.
 */

/**
 * Теги модели — списком, а не деревом.
 *
 * В SketchUp тег ничего не содержит: это ярлык на объекте для управления
 * видимостью. Рисовать его веткой дерева значит показывать структуру, которой
 * в файле нет, — поэтому он живёт отдельным списком, как и в самом приложении.
 */
export function Tags() {
  // Селектор возвращает то, что лежит в сторе, и ничего не вычисляет: `?? []`
  // и любое построение внутри него создают новый объект на каждый рендер,
  // zustand видит новую ссылку и уходит в бесконечное обновление. Проверено
  // на живой странице — React error #185.
  const snapshots = useModel((m) => m.snapshots)
  const tags = snapshots.flatMap((x) => x.tags ?? [])
  const rows = useMemo(() => rowsFromSnapshots(snapshots), [snapshots])

  if (!tags?.length) return <Label tone="muted">{t('tags.empty')}</Label>

  return (
    <div className={s.fields}>
      {tags.map((tag) => {
        const used = rows.filter((r) => r.tag === tag.name).length
        return (
          <div key={tag.id ?? tag.name} className={s.kv}>
            {/* Тег по умолчанию (Layer0) переименовать нельзя — SketchUp его
                имя не отдаёт. Движок откажет, и имя останется прежним. */}
            <RenameField id={tag.id} name={tag.name} className={s.renameLabel} />
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
export function Materials() {
  const snapshots = useModel((m) => m.snapshots)
  const materials = snapshots.flatMap((x) => x.materials ?? [])

  // Неиспользуемые вниз: они есть в файле, но на модель не влияют.
  const sorted = useMemo(
    () => [...(materials ?? [])].sort((a, b) => b.used - a.used),
    [materials],
  )

  if (!materials?.length) return <Label tone="muted">{t('materials.empty')}</Label>

  return (
    <div className={s.fields}>
      {sorted.map((mat) => (
        <div key={mat.id ?? mat.name} className={s.kv}>
          <span className={s.matName}>
            <span
              className={s.swatch}
              style={{
                background: mat.color
                  ? `rgb(${mat.color.r}, ${mat.color.g}, ${mat.color.b})`
                  : 'transparent',
                opacity: mat.alpha,
              }}
            />
            <RenameField id={mat.id} name={mat.name} className={s.renameLabel} />
          </span>
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
export function Definitions() {
  const definitions = useModel((m) => m.snapshots).flatMap((x) => x.definitions ?? [])

  if (!definitions?.length) return <Label tone="muted">{t('definitions.empty')}</Label>

  return (
    <div className={s.fields}>
      {definitions.map((d) => (
        <div key={d.id ?? d.name} className={s.kv}>
          {/* Имя определения наследуют безымянные экземпляры и библиотека
              компонентов — правка видна сразу во всех. */}
          <RenameField id={d.id} name={d.name} className={s.renameLabel} />
          <span className={s.kvValue}>
            {d.group ? t('definitions.group') : t('definitions.component')} · {d.instances}{' '}
            {t('definitions.instances')}
          </span>
        </div>
      ))}
    </div>
  )
}

