import { useMemo } from "react";
import { Badge, MetricCard, useCountUp } from "@ai-room/design-system";
import type { MetricDto } from "../api/types.js";
import { METRIC_CATALOG } from "../lib/metrics.js";

/**
 * 50+ metric dashboard.
 *
 * Every catalog row is rendered. A row without a server value shows UNAVAILABLE
 * with the reason; demo values are tagged DEMO and counted up for readability.
 */
export function MetricGrid({ values, demo = false, limit }: { values: readonly MetricDto[]; demo?: boolean; limit?: number }) {
  const byId = useMemo(() => new Map(values.map((v) => [v.id, v])), [values]);
  const rows = limit ? METRIC_CATALOG.slice(0, limit) : METRIC_CATALOG;

  return (
    <div className="air-metric-grid" role="list" aria-label="프로젝트 지표">
      {rows.map((def) => {
        const value = byId.get(def.id);
        return (
          <div key={def.id} role="listitem">
            <AnimatedMetric def={def} value={value} demo={demo} />
          </div>
        );
      })}
    </div>
  );
}

function AnimatedMetric({ def, value, demo }: { def: (typeof METRIC_CATALOG)[number]; value: MetricDto | undefined; demo: boolean }) {
  const numeric = typeof value?.value === "number" ? value.value : value?.value === null || value === undefined ? null : null;
  const counted = useCountUp(numeric, { duration: 800, decimals: numeric !== null && !Number.isInteger(numeric) ? 1 : 0 });
  const display = counted === null ? null : numeric !== null && !Number.isInteger(numeric) ? counted : String(Math.round(counted)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  return (
    <div style={{ display: "grid", gap: 2 }}>
      <MetricCard
        id={def.id}
        label={def.label}
        value={display}
        unit={value?.unit}
        source={value ? { evidence: value.evidence ?? def.evidence, scope: def.scope, observedAt: value.observed_at } : { evidence: def.evidence, scope: def.scope }}
        unavailableReason={value ? undefined : "서버 값 없음 — 소스 데이터 미제공"}
        hint={demo ? "데모 값" : undefined}
      />
      {demo ? (
        <div style={{ marginTop: -22, marginLeft: 8, pointerEvents: "none" }}>
          <Badge tone="warn" shape="dashed" title="데모 픽스처">DEMO</Badge>
        </div>
      ) : null}
    </div>
  );
}
