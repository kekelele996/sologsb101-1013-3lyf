<script setup lang="ts">
/**
 * 巡护队页：/patrol 作业报备单、批准站位与禁入期管理。
 * 巡护队管报备单 / 批准站位 / 禁入期，普查队管样带与覆盖长度；
 * 录完样带后按站位编号对账，未批准或落在禁入期的样带挂起，补报通过后放行；
 * 撤销禁入期后先前挂起样带重新判定；写入失败只重试巡护队一侧。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Plus, RefreshLeft, Stamp, Warning } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { usePatrolStore } from '@/stores/patrolStore'
import {
  BELT_REPORT_STATE_TYPE,
  REPORT_STATUS_TYPE,
  createEmptyNoEntryPeriod,
  createEmptyPatrolReport
} from '@/types/patrol'
import type { BeltReportState, NoEntryPeriod, PatrolReport, ReportStatus } from '@/types/patrol'
import { initDatabase } from '@/utils/db'

const router = useRouter()
const reefStore = useReefStore()
const beltStore = useBeltStore()
const patrolStore = usePatrolStore()

/** 样带 → 站位编号 / 礁区名（对账按站位编号） */
const beltView = computed(() =>
  beltStore.belts.map((belt) => {
    const site = reefStore.siteById(belt.siteId)
    const reef = site ? reefStore.reefById(site.reefId) : null
    return {
      belt,
      stationNo: site?.no ?? '—',
      reefName: reef?.name ?? '未知礁区'
    }
  })
)

/** 挂起 / 待核样带（需巡护队处理） */
const pendingBelts = computed(() =>
  beltView.value
    .filter((item) => item.belt.reportState === '已挂起' || item.belt.reportState === '待核')
    .sort((a, b) => b.belt.surveyDate.localeCompare(a.belt.surveyDate))
)

const stats = computed(() => ({
  reportCount: patrolStore.reports.length,
  approvedStationCount: patrolStore.approvedStationNos.size,
  activeNoEntryCount: patrolStore.noEntryPeriods.filter((p) => !p.revoked).length,
  pendingCount: pendingBelts.value.length
}))

/** 已批准站位编号列表 */
const approvedStationList = computed(() => Array.from(patrolStore.approvedStationNos).sort())

/* ------------------------------ 报备单表单 ------------------------------ */

const reportDialogVisible = ref(false)
const reportForm = reactive(createEmptyPatrolReport())

function openReportDialog(): void {
  Object.assign(reportForm, createEmptyPatrolReport())
  reportForm.reportNo = patrolStore.nextReportNo()
  reportForm.workDate = new Date().toISOString().slice(0, 10)
  reportDialogVisible.value = true
}

async function submitReport(): Promise<void> {
  if (!reportForm.stationNo.trim()) {
    ElMessage.warning('请填写站位编号')
    return
  }
  if (!reportForm.workDate) {
    ElMessage.warning('请选择作业日期')
    return
  }
  await patrolStore.createReport({
    reportNo: reportForm.reportNo.trim() || patrolStore.nextReportNo(),
    stationNo: reportForm.stationNo.trim(),
    workDate: reportForm.workDate,
    status: reportForm.status,
    remark: reportForm.remark.trim()
  })
  reportDialogVisible.value = false
  ElMessage.success('报备单已登记')
}

async function setReportStatus(report: PatrolReport, status: ReportStatus): Promise<void> {
  await patrolStore.setReportStatus(report.id, status)
  ElMessage.success(`报备单 ${report.reportNo} 已${status}，相关样带已重新对账`)
}

async function removeReport(report: PatrolReport): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除报备单「${report.reportNo}」将重新对账，确认删除？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await patrolStore.removeReport(report.id)
  ElMessage.success('报备单已删除')
}

/* ------------------------------ 禁入期表单 ------------------------------ */

const noEntryDialogVisible = ref(false)
const noEntryForm = reactive(createEmptyNoEntryPeriod())

function openNoEntryDialog(): void {
  Object.assign(noEntryForm, createEmptyNoEntryPeriod())
  noEntryDialogVisible.value = true
}

async function submitNoEntry(): Promise<void> {
  if (!noEntryForm.name.trim()) {
    ElMessage.warning('请填写禁入期名称 / 事由')
    return
  }
  if (noEntryForm.startDate > noEntryForm.endDate) {
    ElMessage.warning('开始日期不能晚于结束日期')
    return
  }
  await patrolStore.createNoEntryPeriod({ ...noEntryForm, name: noEntryForm.name.trim(), reason: noEntryForm.reason.trim() })
  noEntryDialogVisible.value = false
  ElMessage.success('禁入期已划定，挂起样带已重新判定')
}

async function revokeNoEntry(period: NoEntryPeriod): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `撤销禁入期「${period.name}」后，先前因禁入期挂起的样带将重新判定，确认撤销？`,
      '撤销禁入期',
      { type: 'warning', confirmButtonText: '撤销并重新判定', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await patrolStore.revokeNoEntryPeriod(period.id)
  ElMessage.success('禁入期已撤销，挂起样带已重新判定')
}

async function removeNoEntry(period: NoEntryPeriod): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除禁入期「${period.name}」将重新对账，确认删除？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await patrolStore.removeNoEntryPeriod(period.id)
  ElMessage.success('禁入期已删除')
}

/* ------------------------------ 挂起样带处理 ------------------------------ */

/** 补报：为挂起样带补一张报备单（待核），核准后放行 */
async function supplementary(item: (typeof pendingBelts.value)[number]): Promise<void> {
  const report = await patrolStore.supplementaryReport(item.belt, item.stationNo)
  ElMessage.success(`已为站位 ${item.stationNo} 补报 ${report.reportNo}（待核），请在报备单列表核准后放行`)
}

/** 重试巡护队侧写入（普查队样带已落库，仅补巡护队报备登记） */
async function retryPatrol(item: (typeof pendingBelts.value)[number]): Promise<void> {
  const result = await patrolStore.retryPatrolSync(item.belt, item.stationNo)
  if (result.ok) ElMessage.success(`样带 ${item.belt.no} 已重新同步巡护队`)
  else ElMessage.warning(`巡护队侧仍写入失败：${result.error ?? '未知错误'}（普查队样带未受影响）`)
}

async function reconcile(): Promise<void> {
  const changed = await patrolStore.reconcileAll()
  ElMessage.success(`对账完成，${changed} 条样带状态发生变化`)
}

function gotoBelts(item: (typeof pendingBelts.value)[number]): void {
  router.push(`/sites/${item.belt.siteId}/belts`)
}

function reportTagType(status: ReportStatus) {
  return REPORT_STATUS_TYPE[status]
}
function beltTagType(state: BeltReportState) {
  return BELT_REPORT_STATE_TYPE[state]
}

onMounted(() => {
  if (reefStore.reefs.length === 0) void initDatabase()
  patrolStore.start()
  void patrolStore.reconcileAll()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">巡护队报备与禁入期</h2>
        <p class="gb-hint">
          巡护队管作业报备单、批准站位与禁入期；普查队管样带、底质与珊瑚覆盖长度。录完样带后按站位编号对账，
          未批准或落在禁入期的样带挂起，补报通过后放行；撤销禁入期后挂起样带重新判定。
        </p>
      </div>
      <div class="page__actions">
        <el-button :icon="Refresh" @click="reconcile">重新对账</el-button>
        <el-button type="primary" :icon="Plus" @click="openReportDialog">新建报备单</el-button>
        <el-button type="warning" :icon="Warning" @click="openNoEntryDialog">划定禁入期</el-button>
      </div>
    </div>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="两边各持一份：普查队样带照样进礁区结论，但报备状态以巡护队数据为准；挂起 / 待核样带不计入「已批准」口径，需补报或撤销禁入期后放行。"
    />

    <div class="gb-stats-row">
      <StatBadge label="报备单" :value="stats.reportCount" suffix="张" icon="Tickets" />
      <StatBadge label="已批准站位" :value="stats.approvedStationCount" suffix="个" tone="success" icon="CircleCheck" />
      <StatBadge label="有效禁入期" :value="stats.activeNoEntryCount" suffix="项" tone="warning" icon="WarningFilled" />
      <StatBadge label="挂起 / 待核样带" :value="stats.pendingCount" suffix="条" tone="danger" icon="Stamp" />
    </div>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>挂起 / 待核样带（{{ pendingBelts.length }} 条）</h3>
        <span class="gb-hint">按站位编号与作业日期对账；补报单核准或禁入期撤销后自动放行</span>
      </div>
      <EmptyPanel
        v-if="pendingBelts.length === 0"
        title="没有挂起或待核的样带"
        description="所有样带均已批准。新录入样带后会自动按站位编号对账，未批准的样带会出现在这里。"
        compact
      />
      <el-table v-else :data="pendingBelts" border stripe class="gb-table-compact">
        <el-table-column label="礁区 / 站位" min-width="180">
          <template #default="{ row }">
            <div>{{ row.reefName }}</div>
            <div class="gb-hint">站位 {{ row.stationNo }} · 样带 {{ row.belt.no }}（{{ row.belt.orientation }}向）</div>
          </template>
        </el-table-column>
        <el-table-column label="作业日期" width="130">
          <template #default="{ row }"><span class="gb-mono">{{ row.belt.surveyDate }}</span></template>
        </el-table-column>
        <el-table-column label="报备状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="beltTagType(row.belt.reportState)">{{ row.belt.reportState }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="原因" min-width="220">
          <template #default="{ row }">
            <span class="gb-hint">{{ row.belt.suspendReason || '—' }}</span>
            <el-tag v-if="!row.belt.syncedToPatrol" size="small" type="info" effect="plain" class="page__retry-tag">
              巡护队侧未同步
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" @click="supplementary(row)">补报</el-button>
            <el-button
              v-if="!row.belt.syncedToPatrol"
              size="small"
              type="warning"
              :icon="RefreshLeft"
              @click="retryPatrol(row)"
            >
              重试巡护队
            </el-button>
            <el-button size="small" @click="gotoBelts(row)">查看样带</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>作业报备单（{{ patrolStore.reports.length }} 张）</h3>
        <span class="gb-hint">按站位编号 + 作业日期对账；核准后该站位该日期方可下水</span>
      </div>
      <el-table :data="patrolStore.reports" border stripe class="gb-table-compact">
        <el-table-column prop="reportNo" label="报备单编号" width="120" />
        <el-table-column prop="stationNo" label="站位编号" width="110" />
        <el-table-column prop="workDate" label="作业日期" width="130">
          <template #default="{ row }"><span class="gb-mono">{{ row.workDate }}</span></template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="reportTagType(row.status)">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="180" show-overflow-tooltip />
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status !== '已批准'"
              size="small"
              type="success"
              @click="setReportStatus(row, '已批准')"
            >
              批准
            </el-button>
            <el-button
              v-if="row.status !== '已驳回'"
              size="small"
              type="danger"
              plain
              @click="setReportStatus(row, '已驳回')"
            >
              驳回
            </el-button>
            <el-button size="small" type="danger" plain @click="removeReport(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无报备单" description="点击右上角「新建报备单」登记作业站位与日期。" compact />
        </template>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>禁入期（{{ patrolStore.noEntryPeriods.length }} 项）</h3>
        <span class="gb-hint">按日期区间划定，覆盖全部站位；撤销后既往挂起样带重新判定</span>
      </div>
      <el-table :data="patrolStore.noEntryPeriods" border stripe class="gb-table-compact">
        <el-table-column prop="name" label="名称 / 事由" min-width="160" />
        <el-table-column label="起止日期" width="240">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.startDate }} ~ {{ row.endDate }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="说明" min-width="160" show-overflow-tooltip />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag v-if="row.revoked" size="small" type="info" effect="plain">已撤销</el-tag>
            <el-tag v-else size="small" type="warning">有效</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="!row.revoked"
              size="small"
              type="warning"
              @click="revokeNoEntry(row)"
            >
              撤销并重新判定
            </el-button>
            <el-button size="small" type="danger" plain @click="removeNoEntry(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无禁入期" description="点击右上角「划定禁入期」登记禁止下水的时段。" compact />
        </template>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>已批准站位（{{ approvedStationList.length }} 个）</h3>
        <span class="gb-hint">持有已批准报备单的站位编号</span>
      </div>
      <EmptyPanel
        v-if="approvedStationList.length === 0"
        title="暂无已批准站位"
        description="报备单核准后，对应站位会出现在这里。"
        compact
      />
      <div v-else class="page__stations">
        <el-tag v-for="no in approvedStationList" :key="no" size="large" type="success" effect="plain">
          站位 {{ no }}
        </el-tag>
      </div>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>写入演练</h3>
        <span class="gb-hint">模拟巡护队侧写入失败，验证「普查队样带已写入、只重试巡护队一侧」</span>
      </div>
      <el-switch
        v-model="patrolStore.simulateWriteFailure"
        active-text="模拟巡护队侧写入失败"
        inline-prompt
      />
      <p class="gb-hint">
        开启后新录入样带的巡护队报备登记会失败，样带进入「巡护队侧未同步」；关闭后点击挂起样带的「重试巡护队」即可只补巡护队一侧，普查队样带不会重复写入。
      </p>
    </el-card>

    <el-dialog v-model="reportDialogVisible" title="新建作业报备单" width="520px" :close-on-click-modal="false">
      <el-form label-width="104px">
        <el-form-item label="报备单编号">
          <el-input v-model="reportForm.reportNo" placeholder="如 BB-001" maxlength="24" />
        </el-form-item>
        <el-form-item label="站位编号" required>
          <el-input v-model="reportForm.stationNo" placeholder="如 S-01" maxlength="24" />
        </el-form-item>
        <el-form-item label="作业日期" required>
          <el-date-picker v-model="reportForm.workDate" type="date" value-format="YYYY-MM-DD" placeholder="选择作业日期" />
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="reportForm.status">
            <el-radio-button value="待核">待核</el-radio-button>
            <el-radio-button value="已批准">已批准</el-radio-button>
            <el-radio-button value="已驳回">已驳回</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="reportForm.remark" placeholder="选填" maxlength="60" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reportDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitReport">登记报备</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="noEntryDialogVisible" title="划定禁入期" width="520px" :close-on-click-modal="false">
      <el-form label-width="104px">
        <el-form-item label="名称 / 事由" required>
          <el-input v-model="noEntryForm.name" placeholder="如 台风应急响应" maxlength="40" />
        </el-form-item>
        <el-form-item label="开始日期" required>
          <el-date-picker v-model="noEntryForm.startDate" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" />
        </el-form-item>
        <el-form-item label="结束日期" required>
          <el-date-picker v-model="noEntryForm.endDate" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="noEntryForm.reason" placeholder="选填" maxlength="60" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="noEntryDialogVisible = false">取消</el-button>
        <el-button type="warning" @click="submitNoEntry">划定并重新对账</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0b5d5a;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__stations {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__retry-tag {
  margin-left: 8px;
}
</style>
