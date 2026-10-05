/**
 * 放行对账判定（纯函数，不写任何库）。
 * 规则（与业务约定逐字对齐）：
 * 1. 调查日期落在任一「生效中」禁入期（覆盖该站位）→ 挂起，原因 closed；
 * 2. 巡护队没有该「礁区 + 站位编号 + 调查日期」的报备 → 挂起，原因 unfiled（等补报）；
 * 3. 报备待核（历史回填）→ 挂起，原因 verifying（等巡护核对放行）；
 * 4. 报备被拒绝 → 挂起，原因 rejected；
 * 5. 报备已批准且不在禁入期 → 放行。
 */
import type { Closure } from '@/types/closure'
import { closureActiveOn, closureCoversSite } from '@/types/closure'
import type { Filing } from '@/types/filing'
import type { ClearanceDecision, HoldReason } from '@/types/clearance'

/** 对账判定输入（只需双方对账键字段，不依赖具体库对象） */
export interface DecisionInput {
  reefName: string
  siteNo: string
  surveyDate: string
}

/** 拒绝（或待核）原因按报备状态映射 */
function holdFromFilingStatus(status: Filing['status']): HoldReason {
  if (status === 'verifying') return 'verifying'
  return 'rejected'
}

function decision(
  status: ClearanceDecision['status'],
  holdReason: HoldReason | null,
  note: string,
  extra: Partial<Pick<ClearanceDecision, 'closureNo' | 'filingNo'>> = {}
): ClearanceDecision {
  return {
    status,
    holdReason,
    closureNo: null,
    filingNo: null,
    note,
    ...extra
  }
}

/**
 * 判定单条样带的放行结论。
 * @param filings 巡护队一侧该对账键下的报备（调用方负责按键过滤；传全部也可，内部再过滤）
 * @param closures 全部生效 / 已撤销禁入期（内部按站位与日期判断）
 */
export function decideClearance(
  input: DecisionInput,
  filings: Filing[],
  closures: Closure[]
): ClearanceDecision {
  const hitClosure = closures.find(
    (closure) =>
      closure.reefName.trim() === input.reefName.trim() &&
      closureCoversSite(closure, input.siteNo) &&
      closureActiveOn(closure, input.surveyDate)
  )
  if (hitClosure) {
    return decision(
      'held',
      'closed',
      `调查日期 ${input.surveyDate} 落在禁入期（${hitClosure.no}：${hitClosure.startDate} ~ ${hitClosure.endDate}），撤销禁入期后自动重判`,
      { closureNo: hitClosure.no }
    )
  }

  const sameKey = filings.filter(
    (filing) =>
      filing.reefName.trim() === input.reefName.trim() &&
      filing.siteNo.trim() === input.siteNo.trim() &&
      filing.surveyDate.trim() === input.surveyDate.trim()
  )
  const approved = sameKey.find((filing) => filing.status === 'approved')
  if (approved) {
    return decision(
      'released',
      null,
      `报备 ${approved.no} 已批准，站位 ${input.siteNo} 于 ${input.surveyDate} 在批准作业范围内，放行`,
      { filingNo: approved.no }
    )
  }
  if (sameKey.length === 0) {
    return decision(
      'held',
      'unfiled',
      `站位 ${input.siteNo} 于 ${input.surveyDate} 没有报备记录，先挂起，待巡护队补报通过后放行`
    )
  }
  // 没有批准件：优先暴露「拒绝」，其次「待核」
  const rejected = sameKey.find((filing) => filing.status === 'rejected')
  const verifying = sameKey.find((filing) => filing.status === 'verifying')
  const blocker = rejected ?? verifying ?? sameKey[0]
  const reason = holdFromFilingStatus(blocker.status)
  return decision(
    'held',
    reason,
    blocker.status === 'verifying'
      ? `报备 ${blocker.no} 为历史回填待核，待巡护队核对通过后放行`
      : `报备 ${blocker.no} 已被拒绝，挂起；可重新补报后再对账`,
    { filingNo: blocker.no }
  )
}
