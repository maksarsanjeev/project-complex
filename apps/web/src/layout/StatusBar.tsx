import { isMockTransport } from '../api/transport'
import { t } from '../i18n'
import { useChat } from '../store/chat'
import { useEngines } from '../store/engine'
import { useSession } from '../store/session'
import { useViewport } from '../store/viewport'
import { IdChip, Label } from '../ui'
import s from './layout.module.css'

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className={s.statusItem}>
      <Label>{label}</Label>
      <span className={s.statusValue}>{value}</span>
    </div>
  )
}

export function StatusBar() {
  const stats = useViewport((v) => v.stats)
  const mode = useViewport((v) => v.mode)
  const engines = useEngines((e) => e.engines)
  const bound = useEngines((e) => e.boundEngine)
  const sending = useChat((c) => c.sending)
  const chatMode = useChat((c) => c.mode)
  const loading = useSession((x) => x.loading)

  const engine = engines.find((e) => e.id === bound)

  return (
    <footer className={s.status}>
      <Item label={t('statusbar.engine')} value={engine ? `${engine.label}:${engine.port}` : '—'} />
      <Item label={t('statusbar.fps')} value={String(stats.fps)} />
      <Item label={t('statusbar.tris')} value={stats.triangles.toLocaleString('ru-RU')} />
      <Item label={t('hud.objects')} value={String(stats.objects)} />
      <Item label={t('statusbar.units')} value={t('common.mm')} />
      <Item label="display" value={mode} />

      <div className={s.statusRight}>
        <Item
          label={t('statusbar.agent')}
          value={sending ? `${chatMode} · ${t('status.running')}` : `${chatMode} · ${t('status.idle')}`}
        />
        <Item label={t('statusbar.queue')} value={loading ? '1' : '0'} />
        {isMockTransport ? (
          <div className={s.statusItem}>
            <IdChip invert>{t('statusbar.mock')}</IdChip>
          </div>
        ) : null}
      </div>
    </footer>
  )
}
