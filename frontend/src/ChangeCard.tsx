// What an employee wants to change in a blueprint, flow, model provider or employees: on a task's step and in a chat alike.

import { tr } from './core/i18n'
import type { ChangeLine, PendingChange } from './core/domain/types'

export function changeAsk(c: PendingChange) {
  switch (c.kind) {
    case 'blueprint': return tr('我想修改藍圖「{name}」：', { name: c.name })
    case 'provider': return tr('我想修改供應商「{name}」：', { name: c.name })
    case 'employees': return tr('我想修改員工「{name}」：', { name: c.name })
    default: return tr('我想修改任務藍圖「{name}」：', { name: c.name })
  }
}

/** A field this version does not know shows as it came. */
function fieldName(field: string) {
  switch (field) {
    case 'name': return tr('名稱')
    case 'prompt': return 'Prompt'
    case 'comment': return tr('備註')
    case 'tools': return tr('工具')
    case 'skills': return tr('技能')
    case 'source': return tr('新增來源')
    case 'kind': return tr('種類')
    case 'staff': return tr('員工')
    case 'handoff': return tr('交接')
    case 'join': return tr('開始條件')
    case 'node': return tr('步驟')
    case 'edge': return tr('連線')
    case 'condition': return tr('條件')
    case 'baseUrl': return 'Base URL'
    case 'apiKey': return 'API Key'
    case 'prices': return tr('價格')
    case 'models': return tr('模型')
    case 'blueprint': return tr('藍圖')
    case 'model': return tr('模型')
    case 'effort': return tr('思考等級')
    default: return field
  }
}

const added = (l: ChangeLine) => (l.field === 'node' || l.field === 'edge' || l.field === 'source') && !l.before
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
