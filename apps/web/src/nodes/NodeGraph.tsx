import type { GraphDoc, GraphNode, NodeKind } from '@complex/protocol'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Copy, Plus, Trash2, Unlink, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../i18n'
import { useLayout } from '../store/layout'
import { useSession } from '../store/session'
import { IconButton, Label } from '../ui'
import { NODE_KINDS, NODE_ORDER, defaultParams, portsCompatible } from './catalog'
import { ComplexNode, type ComplexFlowNode } from './ComplexNode'
import s from './nodes.module.css'
import './reactflow.css'

const nodeTypes = { complex: ComplexNode }

/* ── конверсия GraphDoc ⇄ React Flow ──────────────────────────── */

function toFlowNodes(doc: GraphDoc): ComplexFlowNode[] {
  return doc.nodes.map((n) => ({
    id: n.id,
    type: 'complex' as const,
    position: n.position,
    data: {
      code: n.code,
      kind: n.kind,
      title: n.title,
      inputs: n.inputs,
      outputs: n.outputs,
      params: n.params,
      status: n.status,
    },
  }))
}

function toFlowEdges(doc: GraphDoc): Edge[] {
  return doc.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourcePort,
    targetHandle: e.targetPort,
    type: 'step',
  }))
}

function toDoc(nodes: ComplexFlowNode[], edges: Edge[]): GraphDoc {
  return {
    nodes: nodes.map<GraphNode>((n) => ({
      id: n.id,
      code: n.data.code,
      kind: n.data.kind,
      title: n.data.title,
      position: n.position,
      inputs: n.data.inputs,
      outputs: n.data.outputs,
      params: n.data.params,
      status: n.data.status,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourcePort: e.sourceHandle ?? 'out',
      target: e.target,
      targetPort: e.targetHandle ?? 'in',
    })),
  }
}

/* ── палитра узлов ────────────────────────────────────────────── */

function Palette({ onPick, onClose }: { onPick: (kind: NodeKind) => void; onClose: () => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, NodeKind[]>()
    for (const kind of NODE_ORDER) {
      const group = NODE_KINDS[kind].group
      map.set(group, [...(map.get(group) ?? []), kind])
    }
    return [...map.entries()]
  }, [])

  return (
    <div className={s.palette}>
      <div className={s.paletteHead}>
        <Label tone="strong">{t('nodes.palette')}</Label>
        <IconButton onClick={onClose} title={t('common.close')} style={{ marginLeft: 'auto' }}>
          <X size={12} strokeWidth={1} />
        </IconButton>
      </div>
      {groups.map(([group, kinds]) => (
        <div key={group}>
          <div className={s.paletteGroup}>
            <Label>{group}</Label>
          </div>
          {kinds.map((kind) => (
            <button key={kind} type="button" className={s.paletteItem} onClick={() => onPick(kind)}>
              {NODE_KINDS[kind].title}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

/* ── контекстное меню ─────────────────────────────────────────── */

interface MenuState {
  x: number
  y: number
  target: { kind: 'node'; id: string } | { kind: 'edge'; id: string } | { kind: 'pane' }
}

/* ── граф ─────────────────────────────────────────────────────── */

function Graph() {
  const graph = useSession((x) => x.graph)
  const setGraph = useSession((x) => x.setGraph)
  const selectNode = useSession((x) => x.selectNode)
  const theme = useLayout((x) => x.theme)
  const tab = useLayout((x) => x.tab)

  const [nodes, setNodes, onNodesChange] = useNodesState<ComplexFlowNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [paletteOpen, setPaletteOpen] = useState(false)
  /** Куда поставить следующий узел; null — в центр видимой области. */
  const [dropAt, setDropAt] = useState<{ x: number; y: number } | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [loadTick, setLoadTick] = useState(0)

  const committed = useRef<GraphDoc | null>(null)
  const lastSignature = useRef('')
  const counter = useRef(0)
  const { screenToFlowPosition, fitView, getNodes, getEdges, deleteElements } = useReactFlow()

  // Следим за самим документом, а не за id сессии: select() выставляет activeId
  // до того, как придут данные, и по id мы прочитали бы ещё пустой граф.
  useEffect(() => {
    if (graph === committed.current) return
    counter.current = graph.nodes.length

    // Выделение переносим на новые объекты: инспектор правит параметры через
    // стор, и без этого узел терял бы выделение на каждом нажатии клавиши.
    setNodes((current) => {
      const selectedIds = new Set(current.filter((n) => n.selected).map((n) => n.id))
      return toFlowNodes(graph).map((n) => (selectedIds.has(n.id) ? { ...n, selected: true } : n))
    })
    setEdges(toFlowEdges(graph))

    // Перевписываем вид только когда изменился НАБОР узлов, а не их настройки.
    const signature = graph.nodes.map((n) => n.id).join(',')
    if (signature !== lastSignature.current) {
      lastSignature.current = signature
      setLoadTick((v) => v + 1)
    }
  }, [graph, setNodes, setEdges])

  // Вписываем граф, когда вкладка становится активной: при монтировании она
  // скрыта и нулевого размера, поэтому встроенный fitView отрабатывает вхолостую.
  useEffect(() => {
    if (tab !== 'nodes') return
    const id = setTimeout(() => fitView({ padding: 0.18, duration: 180 }), 90)
    return () => clearTimeout(id)
  }, [tab, loadTick, fitView])

  // Выделение отдаём в стор эффектом, а не колбэком onSelectionChange:
  // тот вызывается в фазе рендера React Flow, и запись оттуда роняет
  // предупреждение «setState во время рендера другого компонента».
  useEffect(() => {
    selectNode(nodes.find((n) => n.selected)?.id ?? null)
  }, [nodes, selectNode])

  const push = useCallback(
    (nextNodes: ComplexFlowNode[], nextEdges: Edge[]) => {
      const doc = toDoc(nextNodes, nextEdges)
      committed.current = doc
      setGraph(doc)
    },
    [setGraph],
  )

  /**
   * Снимок берём у React Flow, а не из замыкания рендера: удаление и
   * перетаскивание сообщают о себе до того, как локальное состояние обновится.
   */
  const commitLatest = useCallback(() => {
    queueMicrotask(() => push(getNodes() as ComplexFlowNode[], getEdges()))
  }, [getNodes, getEdges, push])

  /**
   * Новый список считаем заранее и только потом отдаём в стор. Внутри
   * функции-обновителя setNodes/setEdges этого делать нельзя: она выполняется
   * в фазе рендера, и запись в стор оттуда ломает React.
   */
  const onConnect = useCallback(
    (connection: Connection) => {
      const next = addEdge({ ...connection, type: 'step' }, getEdges())
      setEdges(next)
      push(getNodes() as ComplexFlowNode[], next)
    },
    [getEdges, getNodes, setEdges, push],
  )

  /**
   * Валидация связи: типы портов обязаны совпадать — геометрия не втыкается
   * в параметры. Заодно запрещаем петлю на себя и повторную связь тех же портов.
   */
  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      if (connection.source === connection.target) return false

      const source = nodes.find((n) => n.id === connection.source)
      const target = nodes.find((n) => n.id === connection.target)
      if (!source || !target) return false

      const from = source.data.outputs.find((p) => p.id === connection.sourceHandle)?.type
      const to = target.data.inputs.find((p) => p.id === connection.targetHandle)?.type
      if (!portsCompatible(from, to)) return false

      return !edges.some(
        (e) =>
          e.source === connection.source &&
          e.sourceHandle === connection.sourceHandle &&
          e.target === connection.target &&
          e.targetHandle === connection.targetHandle,
      )
    },
    [nodes, edges],
  )

  const addNode = useCallback(
    (kind: NodeKind) => {
      const spec = NODE_KINDS[kind]
      counter.current += 1
      const index = counter.current

      const node: ComplexFlowNode = {
        id: `nd-new-${index}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'complex',
        position:
          dropAt ??
          screenToFlowPosition({ x: window.innerWidth / 2 - 60, y: window.innerHeight / 2 - 160 }),
        data: {
          code: `ND-${String(index).padStart(2, '0')}`,
          kind,
          title: spec.title,
          inputs: spec.inputs,
          outputs: spec.outputs,
          params: defaultParams(kind),
          status: 'pending',
        },
      }

      const next = [...(getNodes() as ComplexFlowNode[]), node]
      setNodes(next)
      push(next, getEdges())
      setPaletteOpen(false)
      setDropAt(null)
    },
    [dropAt, getNodes, getEdges, screenToFlowPosition, setNodes, push],
  )

  const duplicateNode = useCallback(
    (id: string) => {
      const source = getNodes().find((n) => n.id === id) as ComplexFlowNode | undefined
      if (!source) return
      counter.current += 1
      const index = counter.current

      const copy: ComplexFlowNode = {
        ...source,
        id: `nd-copy-${index}-${Math.random().toString(36).slice(2, 6)}`,
        selected: false,
        position: { x: source.position.x + 40, y: source.position.y + 40 },
        data: { ...source.data, code: `ND-${String(index).padStart(2, '0')}` },
      }

      const next = [...(getNodes() as ComplexFlowNode[]), copy]
      setNodes(next)
      push(next, getEdges())
    },
    [getNodes, getEdges, setNodes, push],
  )

  const removeNode = useCallback(
    (id: string) => {
      // deleteElements сам уберёт повисшие связи.
      void deleteElements({ nodes: [{ id }] }).then(commitLatest)
    },
    [deleteElements, commitLatest],
  )

  const removeEdge = useCallback(
    (id: string) => {
      void deleteElements({ edges: [{ id }] }).then(commitLatest)
    },
    [deleteElements, commitLatest],
  )

  // Tab открывает палитру — как в нодовых редакторах Blender и Houdini.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (e.key === 'Tab') {
        e.preventDefault()
        setDropAt(null)
        setPaletteOpen((v) => !v)
      }
      if (e.key === 'Escape') {
        setPaletteOpen(false)
        setMenu(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Клик мимо закрывает контекстное меню.
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  const minimapColor = theme === 'dark' ? '#f2f2f2' : '#0a0a0a'

  return (
    <div className={s.wrap}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeDragStop={commitLatest}
        onNodesDelete={commitLatest}
        onEdgesDelete={commitLatest}
        deleteKeyCode={['Delete', 'Backspace']}
        onNodeContextMenu={(e, node) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, target: { kind: 'node', id: node.id } })
        }}
        onEdgeContextMenu={(e, edge) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, target: { kind: 'edge', id: edge.id } })
        }}
        onPaneContextMenu={(e) => {
          e.preventDefault()
          const point = { x: e.clientX, y: e.clientY }
          setDropAt(screenToFlowPosition(point))
          setMenu({ x: point.x, y: point.y, target: { kind: 'pane' } })
        }}
        fitView
        minZoom={0.2}
        maxZoom={2.5}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color={minimapColor} />
        <Controls showInteractive={false} position="bottom-right" />
        <MiniMap
          pannable
          zoomable
          position="top-right"
          nodeColor={minimapColor}
          nodeStrokeWidth={0}
          nodeBorderRadius={0}
          maskColor={theme === 'dark' ? 'rgba(242,242,242,.07)' : 'rgba(10,10,10,.06)'}
        />
      </ReactFlow>

      {paletteOpen ? (
        <Palette
          onPick={addNode}
          onClose={() => {
            setPaletteOpen(false)
            setDropAt(null)
          }}
        />
      ) : (
        <button
          type="button"
          className={s.addBtn}
          title={`${t('nodes.palette')} · Tab`}
          onClick={() => {
            setDropAt(null)
            setPaletteOpen(true)
          }}
        >
          <Plus size={15} strokeWidth={1.5} />
        </button>
      )}

      {menu ? (
        <div className={s.menu} style={{ left: menu.x, top: menu.y }}>
          {menu.target.kind === 'node' ? (
            <>
              <button
                type="button"
                className={s.menuItem}
                onClick={() => duplicateNode((menu.target as { id: string }).id)}
              >
                <Copy size={12} strokeWidth={1} />
                {t('nodes.duplicate')}
              </button>
              <button
                type="button"
                className={s.menuItem}
                onClick={() => removeNode((menu.target as { id: string }).id)}
              >
                <Trash2 size={12} strokeWidth={1} />
                {t('nodes.delete')}
                <span className={s.menuKey}>Del</span>
              </button>
            </>
          ) : null}

          {menu.target.kind === 'edge' ? (
            <button
              type="button"
              className={s.menuItem}
              onClick={() => removeEdge((menu.target as { id: string }).id)}
            >
              <Unlink size={12} strokeWidth={1} />
              {t('nodes.deleteEdge')}
            </button>
          ) : null}

          {menu.target.kind === 'pane' ? (
            <button type="button" className={s.menuItem} onClick={() => setPaletteOpen(true)}>
              <Plus size={12} strokeWidth={1} />
              {t('nodes.palette')}
              <span className={s.menuKey}>Tab</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function NodeGraph() {
  return (
    <ReactFlowProvider>
      <Graph />
    </ReactFlowProvider>
  )
}
