import type { GraphNode } from '@complex/protocol'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import { memo } from 'react'
import { StatusMark, cx, type MarkState } from '../ui'
import { PORT_SHAPE } from './catalog'
import s from './nodes.module.css'

export type ComplexNodeData = Pick<
  GraphNode,
  'code' | 'kind' | 'title' | 'inputs' | 'outputs' | 'params' | 'status'
>

export type ComplexFlowNode = Node<ComplexNodeData, 'complex'>

const MARK: Record<NonNullable<GraphNode['status']>, MarkState> = {
  pending: 'idle',
  running: 'running',
  ok: 'ok',
  error: 'error',
}

function ComplexNodeImpl({ data, selected }: NodeProps<ComplexFlowNode>) {
  const params = Object.entries(data.params ?? {}).slice(0, 3)

  return (
    <div className={s.node} data-selected={selected ? 'true' : undefined}>
      <div className={s.head}>
        <span className={s.headTitle}>{data.title}</span>
        <span className={s.headCode}>{data.code}</span>
      </div>

      <div className={s.ports}>
        {data.inputs.map((port) => (
          <div key={port.id} className={s.portRow}>
            <Handle
              id={port.id}
              type="target"
              position={Position.Left}
              className={cx(s.port, s[`port--${PORT_SHAPE[port.type]}`])}
            />
            {port.name}
          </div>
        ))}

        {data.outputs.map((port) => (
          <div key={port.id} className={cx(s.portRow, s['portRow--out'])}>
            {port.name}
            <Handle
              id={port.id}
              type="source"
              position={Position.Right}
              className={cx(s.port, s[`port--${PORT_SHAPE[port.type]}`])}
            />
          </div>
        ))}
      </div>

      {params.length > 0 ? (
        <div className={s.params}>
          {params.map(([key, value]) => (
            <div key={key} className={s.paramRow}>
              <span className={s.paramKey}>{key}</span>
              <span className={s.paramVal}>{String(value)}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className={s.foot}>
        <StatusMark state={MARK[data.status ?? 'pending']} />
        <span className={s.footLabel}>{data.kind}</span>
      </div>
    </div>
  )
}

export const ComplexNode = memo(ComplexNodeImpl)
