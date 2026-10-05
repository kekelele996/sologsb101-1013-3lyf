/* 纯逻辑冒烟测试（esbuild 打包后 node 执行，不依赖 DOM/IndexedDB） */
import { decideClearance } from '../src/utils/clearance'
import type { Closure } from '../src/types/closure'
import type { Filing } from '../src/types/filing'
import { reconcileKey } from '../src/types/filing'
import { closureActiveOn, closureCoversSite } from '../src/types/closure'

let passed = 0
function assert(name: string, cond: boolean, extra = ''): void {
  if (!cond) {
    console.error(`FAIL: ${name} ${extra}`)
    process.exitCode = 1
  } else {
    passed += 1
    console.log(`ok - ${name}`)
  }
}

const today = '2026-10-05'
const filingApproved: Filing = {
  id: 'f1', no: 'BA-1', reefName: '清澜湾', siteNo: 'S-01', surveyDate: today,
  teamName: '组', leader: '', remark: '', status: 'approved', source: 'normal', reviewer: 'x',
  createdAt: 1, updatedAt: 1
}
const filingVerifying: Filing = { ...filingApproved, id: 'f2', no: 'BA-2', status: 'verifying' }
const filingRejected: Filing = { ...filingApproved, id: 'f3', no: 'BA-3', status: 'rejected' }

const closureActive: Closure = {
  id: 'c1', no: 'NO-1', reefName: '清澜湾', siteNo: 'S-01', startDate: today, endDate: today,
  reason: '', issuer: '', status: 'active', revokedBy: '', revokedAt: null, revokeNote: '',
  createdAt: 1, updatedAt: 1
}
const closureRevoked: Closure = { ...closureActive, status: 'revoked' }
const closureWholeReef: Closure = { ...closureActive, no: 'NO-2', siteNo: '' }
const closureOtherSite: Closure = { ...closureActive, no: 'NO-3', siteNo: 'S-09' }

// 1 无报备挂起
let d = decideClearance({ reefName: '清澜湾', siteNo: 'S-01', surveyDate: today }, [], [])
assert('无报备 -> held/unfiled', d.status === 'held' && d.holdReason === 'unfiled', JSON.stringify(d))

// 2 已批准放行
d = decideClearance({ reefName: '清澜湾', siteNo: 'S-01', surveyDate: today }, [filingApproved], [])
assert('已批准 -> released', d.status === 'released' && d.filingNo === 'BA-1', JSON.stringify(d))

// 3 待核挂起
d = decideClearance({ reefName: '清澜湾', siteNo: 'S-01', surveyDate: today }, [filingVerifying], [])
assert('待核 -> held/verifying', d.status === 'held' && d.holdReason === 'verifying')

// 4 拒绝挂起
d = decideClearance({ reefName: '清澜湾', siteNo: 'S-01', surveyDate: today }, [filingRejected], [])
assert('拒绝 -> held/rejected', d.status === 'held' && d.holdReason === 'rejected')

// 5 即使批准，落禁入期也挂起 closed
d = decideClearance({ reefName: '清澜湾', siteNo: 'S-01', surveyDate: today }, [filingApproved], [closureActive])
assert('批准但禁入期 -> held/closed', d.status === 'held' && d.holdReason === 'closed' && d.closureNo === 'NO-1', JSON.stringify(d))

// 6 禁入期撤销 -> 放行
d = decideClearance({ reefName: '清澜湾', siteNo: 'S-01', surveyDate: today }, [filingApproved], [closureRevoked])
assert('撤销禁入期 -> released', d.status === 'released')

// 7 全礁区禁入覆盖 S-02
assert('全礁区通告覆盖任意站位', closureCoversSite(closureWholeReef, 'S-02'))
// 8 指定站位通告不覆盖别的站位
assert('站位通告不覆盖他人', !closureCoversSite(closureOtherSite, 'S-01'))
// 9 撤销通告在当天不生效
assert('撤销通告 activeOn=false', !closureActiveOn(closureRevoked, today))
// 10 日期区间外不生效
assert('窗口外不生效', !closureActiveOn({ ...closureActive, startDate: '2026-10-06', endDate: '2026-10-07' }, today))

// 11 站位编号在不同礁区互不串：永兴岛 S-01 有批准，清澜湾 S-01 无报备仍挂起
const yrApproved = { ...filingApproved, reefName: '永兴岛', no: 'BA-Y' }
d = decideClearance({ reefName: '清澜湾', siteNo: 'S-01', surveyDate: today }, [yrApproved], [])
assert('跨礁区同站位号不串批', d.status === 'held' && d.holdReason === 'unfiled')

// 12 对账键格式
assert('对账键含礁区', reconcileKey(' 清澜湾 ', 's-01', today) === `清澜湾::s-01::${today}`)

// 13 多个报备中只要有一张批准即放行
d = decideClearance(
  { reefName: '清澜湾', siteNo: 'S-01', surveyDate: today },
  [filingRejected, filingVerifying, filingApproved],
  []
)
assert('同键多报备含批准 -> released', d.status === 'released')

console.log(`\n${passed} assertions passed`)
