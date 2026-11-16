# UI upgrade B - working notes

Base: 5b89cab95ab95fd412da7341418738f369dcf289 on ui-upgrade-b.
Unit baseline: 211 files, 2969 tests green.

## WP-5 evidence repair
- 03/11 scenes originally shot an empty state: the harness lacked control.conversation.timeline, so the pane errored (page.entries is not iterable). Added the timeline stub plus content assertions.
- Genuine befores for 03/11 re-shot from a worktree at 631169b1 with the fixed harness; after shots re-taken on the WP-5 tree.
