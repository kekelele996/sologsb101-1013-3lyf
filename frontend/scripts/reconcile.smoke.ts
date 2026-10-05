/* 集成冒烟测试：fake-indexeddb 下跑完整对账域服务（node 执行，esbuild 打包） */
import 'fake-indexeddb/auto'
import { db } from '../src/utils/db'
import { patrolDb, setLedgerFaultEnabled } from '../src/utils/patrolDb'
import {
  backfillLegacyFilings,
  flushLedgerOutbox,
  readjudgeAfterClosure,
  readjudgeAfterFiling,
  reconcileBelts
} from '../src/utils/reconcile'
import type { Reef } from '../src/types/reef'
import type { Site } from '../src/types/site'
import type { Belt } from '../src/types/belt'
import type { Filing } from '../src/types/filing'
import type { Closure } from '../src/types/closure'

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

async function seedFixture(): Promise<{ reef: Reef; site: Site; belts: Belt[] }> {
  const now = Date.now()
  const reef: Reef = {
    id: 'r1', name: '测试礁区', location: '', areaKm2: 1, protectStatus: '核心区',
    manager: '', createdAt: now, updatedAt: now
  }
  const site: Site = {
    id: 's1', reefId: 'r1', no: 'S-01', lat: 1, lng: 1, depthM: 5,
    substrate: '珊瑚礁石', createdAt: now, updatedAt: now
  }
  const mkBelt = (id: string, date: string): Belt => ({
    id, siteId: 's1', no: id, lengthM: 50, orientation: '北', surveyDate: date, observer: '甲',
    createdAt: now, updatedAt: now
  })
  const belts = [mkBelt('b1', '2026-10-05'), mkBelt('b2', '2026-10-06')]
  await db.reefs.put(reef)
  await db.sites.put(site)
  await db.belts.bulkPut(belts)
  return { reef, site, belts }
}

async function putFiling(partial: Partial<Filing> & Pick<Filing, 'reefName' | 'siteNo' | 'surveyDate' | 'status'>): Promise<void> {
  const now = Date.now()
  await patrolDb.filings.put({
    id: `f_${Math.random().toString(36).slice(2)}`,
    no: `NO_${Math.random().toString(36).slice(2, 8)}`,
    teamName: '组', leader: '', remark: '', source: 'normal', reviewer: '',
    createdAt: now, updatedAt: now,
    ...partial
  })
}

async function putClosure(partial: Partial<Closure> & Pick<Closure, 'startDate' | 'endDate' | 'status'>): Promise<void> {
  const now = Date.now()
  await patrolDb.closures.put({
    id: `c_${Math.random().toString(36).slice(2)}`,
    no: `CL_${Math.random().toString(36).slice(2, 8)}`,
    reefName: '测试礁区', siteNo: 'S-01', reason: 'r', issuer: '巡护',
    revokedBy: '', revokedAt: null, revokeNote: '',
    createdAt: now, updatedAt: now,
    ...partial
  })
}

async function beltStatus(id: string): Promise<string | undefined> {
  return (await db.belts.get(id))?.clearance?.status
}

async function main(): Promise<void> {
  await db.open()
  await patrolDb.open()

  const { belts } = await seedFixture()

  // 1 全新数据无报备：全部挂起 unfiled
  let r = await reconcileBelts()
  assert('全挂起', r.total === 2 && r.held === 2 && r.released === 0, JSON.stringify(r))
  assert('b1 held/unfiled', (await beltStatus('b1')) === 'held' && (await db.belts.get('b1'))?.clearance?.holdReason === 'unfiled')

  // 2 巡护台账留底成功，各 2 条
  assert('巡护台账 2 条', (await patrolDb.reconcileLedger.count()) === 2)
  assert('outbox 为空', (await patrolDb.outbox.count()) === 0)

  // 3 台账写故障：只重发巡护一侧；普查侧结论不变
  setLedgerFaultEnabled(true)
  r = await reconcileBelts(['b1'])
  assert('故障时 ledgerPending=1', r.ledgerPending === 1 && r.held === 1)
  assert('普查侧仍正常写判定（held）', (await beltStatus('b1')) === 'held')
  assert('outbox 有 1 条待重发', (await patrolDb.outbox.count()) === 1)
  // 重试时故障未解除：仍失败，attempts 增长
  let flushed = await flushLedgerOutbox()
  assert('故障未解除重试仍失败', flushed.succeeded === 0 && flushed.stillPending === 1)
  setLedgerFaultEnabled(false)
  flushed = await flushLedgerOutbox()
  assert('解除故障后重试成功（只动巡护库）', flushed.succeeded === 1 && flushed.stillPending === 0)
  assert('普查侧结论未被重试改动', (await beltStatus('b1')) === 'held')

  // 4 补报通过：先前挂起样带放行（只影响同站位同日期）
  const f1006: Filing = {
    id: 'f_ok2', no: 'NO_OK2', reefName: '测试礁区', siteNo: 'S-01', surveyDate: '2026-10-06',
    teamName: '组', leader: '', remark: '', status: 'approved', source: 'normal', reviewer: '巡护',
    createdAt: 0, updatedAt: 0
  }
  await patrolDb.filings.put(f1006)
  r = await readjudgeAfterFiling(f1006)
  assert('补报批准重判 10-06 样带', r.released === 1 && r.held === 0, JSON.stringify(r))
  assert('b2 放行', (await beltStatus('b2')) === 'released')
  // 10-05 没报备仍 held
  assert('b1 仍挂起（无 10-05 批准）', (await beltStatus('b1')) === 'held')
  // 10-05 批准
  const f1005: Filing = {
    id: 'f_ok1', no: 'NO_OK1', reefName: '测试礁区', siteNo: 'S-01', surveyDate: '2026-10-05',
    teamName: '组', leader: '', remark: '', status: 'approved', source: 'normal', reviewer: '巡护',
    createdAt: 0, updatedAt: 0
  }
  await patrolDb.filings.put(f1005)
  await readjudgeAfterFiling(f1005)
  assert('补报 10-05 后 b1 放行', (await beltStatus('b1')) === 'released')

  // 5 禁入期发布 + 对账：已放行样带重新挂起 closed
  await putClosure({ startDate: '2026-10-05', endDate: '2026-10-05', status: 'active', no: 'CL_BAN_05' })
  r = await reconcileBelts()
  assert('禁入期内 b1 重新挂起', (await beltStatus('b1')) === 'held' && (await db.belts.get('b1'))?.clearance?.holdReason === 'closed')
  assert('禁入期外 b2 保持放行', (await beltStatus('b2')) === 'released')

  // 6 撤销禁入期：先前挂起的自动重新判定放行
  const closure = await patrolDb.closures.where('no').equals('CL_BAN_05').first()
  if (!closure) throw new Error('closure missing')
  const revoked: Closure = { ...closure, status: 'revoked', revokedAt: Date.now(), revokedBy: '巡护', revokeNote: '解除' }
  await patrolDb.closures.put(revoked)
  r = await readjudgeAfterClosure(revoked)
  assert('撤禁重判 b1 放行', r.released >= 1 && (await beltStatus('b1')) === 'released', JSON.stringify(r))

  // 7 旧数据回填：按调查日期一张报备，状态 verifying；重判后 held/verifying
  await patrolDb.filings.clear()
  await patrolDb.reconcileLedger.clear()
  const backfill = await backfillLegacyFilings()
  const keys = new Set((await patrolDb.filings.toArray()).map((f) => `${f.reefName}::${f.siteNo}::${f.surveyDate}`))
  assert('回填按站位+日期去重 2 张待核', backfill.created === 2 && (await patrolDb.filings.where('status').equals('verifying').count()) === 2)
  assert('回填键正确', keys.has('测试礁区::S-01::2026-10-05') && keys.has('测试礁区::S-01::2026-10-06'))
  // 幂等：再跑一次不新增
  const second = await backfillLegacyFilings()
  assert('回填幂等', second.created === 0)
  await reconcileBelts()
  assert('回填待核样带挂起 verifying', (await db.belts.get('b1'))?.clearance?.holdReason === 'verifying')
  assert('回填台账 source 标记', (await patrolDb.filings.toArray()).every((f) => f.source === 'legacy_backfill'))

  console.log(`\n${passed} assertions passed`)
}

void main()
