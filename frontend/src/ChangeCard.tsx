// What an employee wants to change in a blueprint or flow: on a task's step and in a chat alike.

import { tr } from './core/i18n'
import type { ChangeLine, PendingChange } from './core/domain/types'

export const changeAsk = (c: PendingChange) =>
  c.kind === 'blueprint' ? tr('我想修改藍圖「{name}」：', { name: c.name }) : tr('我想修改任務流程「{name}」：', { name: c.name })

/** A field this version does not know shows as it came. */
function fieldName(field: string) {
  switch (field) {
    case 'name': return tr('名稱')
    case 'prompt': return 'Prompt'
    case 'comment': return tr('備註')
    case 'tools': return tr('工具')
    case 'skills': return tr('技能')
    case 'kind': return tr('種類')
    case 'staff': return tr('員工')
    case 'assignment': return tr('任務分派')
    case 'handoff': return tr('交接')
    case 'join': return tr('開始條件')
    case 'node': return tr('步驟')
    case 'edge': return tr('連線')
    case 'condition': return tr('條件')
    default: return field
  }
}

const added = (l: ChangeLine) => (l.field === 'node' || l.field === 'edge') && !l.before
const removed = (l: ChangeLine) => (l.field === 'node' || l.field === 'edge') && !l.after

export function ChangeLines({ change }: { change: PendingChange }) {
  return (
    <ul className="fx-d-change">
      {change.lines.map((l, i) => (
        <li key={i}>
          <span className="fx-d-change-at">{l.node ? `${l.node} · ${fieldName(l.field)}` : fieldName(l.field)}</span>
          {!added(l) && <del><span className="fx-sr">{tr('修改前')} </span>{l.before || tr('（空白）')}</del>}
          {!removed(l) && <ins><span className="fx-sr">{tr('修改後')} </span>{l.after || tr('（空白）')}</ins>}
        </li>
      ))}
    </ul>
  )
}
