<script setup lang="ts">
/**
 * <ClearanceTag> 放行对账状态徽标。
 * 放行（success）/ 挂起（danger，带原因）/ 未对账（info）/ 待核回填（warning）。
 * 被样带布设页、覆盖度汇总页、巡护台账页消费。
 */
import { computed } from 'vue'
import { CircleCheck, Clock, Lock, QuestionFilled } from '@element-plus/icons-vue'
import type { Belt } from '@/types/belt'
import { HOLD_REASON_LABEL } from '@/types/clearance'

const props = withDefaults(
  defineProps<{
    clearance?: Belt['clearance']
    size?: 'small' | 'default'
    showNote?: boolean
  }>(),
  { size: 'small', showNote: false }
)

type TagType = 'success' | 'danger' | 'info' | 'warning'

const tagType = computed<TagType>(() => {
  const status = props.clearance?.status
  if (status === 'released') return 'success'
  if (status === 'held') {
    return props.clearance?.holdReason === 'verifying' ? 'warning' : 'danger'
  }
  return 'info'
})

const label = computed(() => {
  const status = props.clearance?.status
  if (status === 'released') return '放行'
  if (status === 'held') {
    const reason = props.clearance?.holdReason
    return reason ? `挂起·${HOLD_REASON_LABEL[reason]}` : '挂起'
  }
  return '未对账'
})

const tagIcon = computed(() => {
  const status = props.clearance?.status
  if (status === 'released') return CircleCheck
  if (status === 'held') return props.clearance?.holdReason === 'verifying' ? QuestionFilled : Lock
  return Clock
})
</script>

<template>
  <span class="clearance-tag">
    <el-tag :type="tagType" :size="size" effect="light" round>
      <el-icon class="clearance-tag__icon"><component :is="tagIcon" /></el-icon>
      {{ label }}
    </el-tag>
    <span v-if="showNote && clearance?.reconcileNote" class="clearance-tag__note">{{ clearance.reconcileNote }}</span>
  </span>
</template>

<style scoped>
.clearance-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.clearance-tag__icon {
  vertical-align: -1px;
}

.clearance-tag__note {
  font-size: 12px;
  color: #7c9995;
}
</style>
