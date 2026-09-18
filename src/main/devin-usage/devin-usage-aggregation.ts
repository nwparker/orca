import { createUsageEventAggregation } from '../usage/usage-event-aggregation'
import type { DevinUsageAttributedEvent, DevinUsageMetric } from './types'

export const devinUsageAggregation = createUsageEventAggregation<
  DevinUsageAttributedEvent,
  DevinUsageMetric
>({
  metric: {
    empty: () => ({ estimatedCostUsd: null }),
    fromEvent: (event) => ({ estimatedCostUsd: event.estimatedCostUsd }),
    fold: (target, source) => {
      if (target.estimatedCostUsd === null && source.estimatedCostUsd === null) {
        return
      }
      target.estimatedCostUsd = (target.estimatedCostUsd ?? 0) + (source.estimatedCostUsd ?? 0)
    }
  },
  cloneSessionForMerge: (session) => ({
    ...session,
    locationBreakdown: session.locationBreakdown.map((entry) => ({ ...entry })),
    modelBreakdown: session.modelBreakdown.map((entry) => ({ ...entry })),
    locationModelBreakdown: session.locationModelBreakdown.map((entry) => ({ ...entry }))
  })
})
