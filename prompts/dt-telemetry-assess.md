# Telemetry assessment prompt

You are assessing a telemetry finding (APM trace, error rate spike, latency regression, or log pattern) for actionability. Your goal is to determine whether this finding warrants creating a Linear ticket for a developer to investigate and fix.

## Finding details

- **Type**: {{finding_type}} (error_spike / latency_regression / log_pattern)
- **Service**: {{service_name}}
- **Environment**: {{environment}}
- **Time range**: {{time_range}}
- **Current value**: {{current_value}}
- **Baseline value**: {{baseline_value}}
- **Change**: {{change_description}}

## Assessment criteria

### For error rate spikes

1. **Magnitude**: How much higher than baseline? A 2x spike is worth investigating; a 10% bump might not be.
2. **Duration**: Has the elevated rate persisted for hours, or was it a brief burst?
3. **Error types**: Are these new error types, or known/expected errors at a higher volume?
4. **Correlation**: Does the spike correlate with a deployment, traffic spike, or dependent service issue?
5. **User impact**: Are these errors reaching end users, or are they internal/retry-able?

### For latency regressions

1. **Percentile**: Is this a P50 regression (broad impact) or P99 (tail latency)?
2. **Magnitude**: How many milliseconds of regression? Is it proportionally significant?
3. **Affected endpoints**: Which endpoints are slow? Are they user-facing critical paths?
4. **Duration**: Has the regression been sustained, or is it a temporary blip?
5. **Root cause hints**: Are there slow database queries, external service timeouts, or resource contention?

### For log patterns

1. **Novelty**: Is this a new error type that wasn't present before?
2. **Frequency**: How often is this pattern occurring?
3. **Trend**: Is the frequency increasing, stable, or decreasing?
4. **Severity**: Is the error message indicative of a serious issue (data corruption, auth failure, resource exhaustion)?
5. **Stack trace**: Does the stack trace point to a specific code location?

### Severity mapping

- **Critical**: User-facing errors at high volume, data integrity issues, security-related errors
- **High**: Significant latency regression on critical paths, sustained error spike > 5x baseline
- **Medium**: Moderate regressions, new error patterns at low volume, non-critical service degradation
- **Low**: Minor latency changes, log patterns at very low volume, internal-only impact

### Confidence scoring

- **0.9+**: Clear regression with sustained metrics change and identifiable cause
- **0.7-0.9**: Likely issue, metrics show clear change but root cause is uncertain
- **0.5-0.7**: Possible issue, change is marginal or might be environmental
- **Below 0.5**: Probably not actionable — skip

## Service-to-repo mapping

Map service names to repos and paths:
- Services matching the configured `service_filter` pattern (from Deep Thought config) → the main application repo, likely in `services/<service-name>/`
- Infrastructure-related → the infrastructure repo (from config)
- If unclear, set `target_repo` to null

## Output format

Produce a JSON assessment:

```json
{
  "actionable": true,
  "confidence": 0.8,
  "severity": "medium",
  "type": "latency_regression",
  "target_repo": "<target_repo from config>",
  "affected_service": "api-gateway",
  "affected_paths": ["services/api-gateway/router.go"],
  "title": "API gateway P99 latency increased 300ms over 12 hours",
  "description": "The api-gateway service shows a sustained P99 latency increase...\n\nCurrent P99: 850ms\nBaseline P99: 550ms\nAffected endpoints: /v3/groups, /v3/messages\n\nSuggested investigation:\n1. Check recent deployments\n2. Review database query plans\n3. Check dependent service latencies",
  "priority": 3,
  "skip_reason": null
}
```

If not actionable, set `actionable: false` and provide `skip_reason`.
