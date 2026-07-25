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
import { Maximize2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../i18n'
import { useLayout } from '../store/layout'
import { useSession } from '../store/session'
import { IconButton, Label } from '../ui'
import { NODE_KINDS, NODE_ORDER } from './catalog'
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
          ×
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

/* ── граф ─────────────────────────────────────────────────────── */

function Graph() {
  const graph = useSession((x) => x.graph)
  const setGraph = useSession((x) => x.setGraph)
  const theme = useLayout((x) => x.theme)
  const tab = useLayout((x) => x.tab)

  const [nodes, setNodes, onNodesChange] = useNodesState<ComplexFlowNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [paletteOpen, setPaletteOpen] = useState(false)
  /** Растёт при каждой загрузке документа извне — по нему пересобираем вид. */
  const [loadTick, setLoadTick] = useState(0)
  const counter = useRef(0)
  /** Документ, который мы сами только что отдали в стор — перечитывать его не нужно. */
  const committed = useRef<GraphDoc | null>(null)
  const { screenToFlowPosition, fitView } = useReactFlow()

  // Следим за самим документом, а не за id сессии: select() выставляет activeId
  // до того, как придут данные, и по id мы прочитали бы ещё пустой граф.
  useEffect(() => {
    if (graph === committed.current) return
    counter.current = graph.nodes.length
    setNodes(toFlowNodes(graph))
    setEdges(toFlowEdges(graph))
    setLoadTick((t) => t + 1)
  }, [graph, setNodes, setEdges])

  // Вписываем граф, когда вкладка становится активной: при монтировании она
  // скрыта и нулевого размера, поэтому встроенный fitView отрабатывает вхолостую.
  // Завязка на loadTick, а не на graph — иначе вид прыгал бы после каждого
  // перетаскивания узла, ведь оно тоже коммитит документ.
  useEffect(() => {
    if (tab !== 'nodes') return
    const id = setTimeout(() => fitView({ padding: 0.18, duration: 180 }), 90)
    return () => clearTimeout(id)
  }, [tab, loadTick, fitView])

  const push = useCallback(
    (nextNodes: ComplexFlowNode[], nextEdges: Edge[]) => {
      const doc = toDoc(nextNodes, nextEdges)
      committed.current = doc
      setGraph(doc)
    },
    [setGraph],
  )

  const commit = useCallback(() => push(nodes, edges), [push, nodes, edges])

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) => {
        const next = addEdge({ ...connection, type: 'step' }, current)
        push(nodes, next)
        return next
      })
    },
    [nodes, setEdges, push],
  )

  const addNode = useCallback(
    (kind: NodeKind) => {
      const spec = NODE_KINDS[kind]
      counter.current += 1
      const index = counter.current
      const node: ComplexFlowNode = {
        id: `nd-new-${index}`,
        type: 'complex',
        position: screenToFlowPosition({
          x: window.innerWidth / 2 - 60,
          y: window.innerHeight / 2 - 120,
        }),
        data: {
          code: `ND-${String(index).padStart(2, '0')}`,
          kind,
          title: spec.title,
          inputs: spec.inputs,
          outputs: spec.outputs,
          status: 'pending',
        },
      }
      setNodes((current) => {
        const next = [...current, node]
        push(next, edges)
        return next
      })
      setPaletteOpen(false)
    },
    [edges, screenToFlowPosition, setNodes, push],
  )

  // Tab открывает палитру — как в нодовых редакторах Blender/Houdini.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return
      if (e.key === 'Tab') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
      if (e.key === 'Escape') setPaletteOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
        onNodeDragStop={() => commit()}
        onNodesDelete={() => commit()}
        onEdgesDelete={() => commit()}
        fitView
        minZoom={0.2}
        maxZoom={2.5}
        proOptions={{ hideAttribution: false }}
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
        <Palette onPick={addNode} onClose={() => setPaletteOpen(false)} />
      ) : (
        <div className={s.hint}>
          <Label>{t('nodes.paletteHint')}</Label>
        </div>
      )}

      {paletteOpen ? null : (
        <button
          type="button"
          className={s.floatBtn}
          onClick={() => fitView({ padding: 0.18, duration: 200 })}
        >
          <Maximize2 size={12} strokeWidth={1} />
          {t('nodes.fit')}
        </button>
      )}
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
