# Table Duplicates Test

## 2. Onboarding events

| Event | Priority | Properties | Trigger |
|---|---|---|---|
| `onboarding_completed` | MUST | `duration_seconds`, `solution_ids[]` | Continue from final step |

## 3. Build phase

The animated "setting things up" screen between onboarding and the workspace.

| Event | Priority | Properties | Trigger |
|---|---|---|---|
| `build_started` | MUST | `solution_count`, `solution_ids[]` | Build animation begins |
| `build_completed` | MUST | `duration_seconds` | Animation hits 100% |
| `setup_started` | MUST | `entry_solution_id` | "Start setup" clicked |
