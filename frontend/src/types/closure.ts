/**
 * 禁入期（巡护队一侧持有）
 * 巡护队对礁区 / 站位划定的禁止下水区间；处于生效禁入期内的样带即使有报备也要挂起。
 */

/** 禁入期状态：active 生效中，revoked 已由巡护队撤销（保留记录留档，不物理删除） */
export type ClosureStatus = 'active' | 'revoked'

export const CLOSURE_STATUSES: ClosureStatus[] = ['active', 'revoked']

export const CLOSURE_STATUS_LABEL: Record<ClosureStatus, string> = {
  active: '生效中',
  revoked: '已撤销'
}

export interface Closure {
  id: string
  /** 禁入通告号，如 NO-20261005-001 */
  no: string
  /** 礁区名（对账键之一） */
  reefName: string
  /**
   * 站位编号：为空字符串表示覆盖整个礁区；
   * 也可填多个站位编号，逗号分隔，如 "S-01,S-02"
   */
  siteNo: string
  /** 禁入起始日 YYYY-MM-DD（含） */
  startDate: string
  /** 禁入截止日 YYYY-MM-DD（含） */
  endDate: string
  /** 禁入事由（生态敏感期 / 执法管控 / 极端海况等） */
  reason: string
  /** 发布人 */
  issuer: string
  status: ClosureStatus
  /** 撤销人 / 撤销时间 / 撤销说明 */
  revokedBy: string
  revokedAt: number | null
  revokeNote: string
  createdAt: number
  updatedAt: number
}

export type NewClosure = Omit<Closure, 'id' | 'createdAt' | 'updatedAt'>

/** 生成禁入通告号 */
export function nextClosureNo(startDate: string): string {
  const compactDate = startDate.replace(/-/g, '')
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `NO-${compactDate}-${rand}`
}

/** 判断某条禁入期是否覆盖指定站位 */
export function closureCoversSite(closure: Pick<Closure, 'siteNo'>, siteNo: string): boolean {
  const scoped = closure.siteNo.trim()
  if (scoped.length === 0) return true
  return scoped
    .split(/[,，、\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .includes(siteNo.trim())
}

/** 判断禁入期在指定日期是否生效（含起止两端） */
export function closureActiveOn(
  closure: Pick<Closure, 'status' | 'startDate' | 'endDate'>,
  surveyDate: string
): boolean {
  if (closure.status !== 'active') return false
  return surveyDate >= closure.startDate && surveyDate <= closure.endDate
}
