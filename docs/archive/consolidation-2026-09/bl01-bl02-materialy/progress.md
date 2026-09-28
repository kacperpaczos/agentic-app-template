# SDD ledger — plan: /home/paczos/Documents/agentic-app-template-wt/integracja/docs/plans/2026-09-17-bl01-bl02.md

Spec: /home/paczos/Documents/agentic-app-template-wt/integracja/docs/ARCHITECTURE.md (binding)
Integration branch: bl01-bl02/integracja; base main 7f569c0; plan commit bd615a7
Baseline: pnpm verify exit 0, vitest 278/278 (scratchpad/baseline-verify.log)
User instance baseline: scratchpad/user-instance-baseline.txt (pid 1819385 on 8791, dist sha 356bffc0…)
E2E lock: /home/paczos/Documents/agentic-app-template-wt/.e2e.lock
Worktrees root: /home/paczos/Documents/agentic-app-template-wt/

## Rulings (preflight)
- Ruling: work in agentic-app-template, not AgenticApp — BL-01/BL-02 are the template backlog; AgenticApp is the user's live instance (8791) — cost if wrong: port changes to AgenticApp later.
- Ruling: parallel implementers in separate git worktrees (skill says sequential) — user explicitly requested independent tasks in isolated worktrees; conflicts resolved at merge — cost if wrong: extra merge/rework rounds.
- Ruling: worktrees under /home/paczos/Documents/agentic-app-template-wt/ (same fs as pnpm store; /tmp is tmpfs) — cost if wrong: an extra directory the user must remove.
- Ruling: single flock for all Playwright runs + port 8798 for every new scripted spec — hardcoded spec ports 8792–8799 would collide across worktrees — cost if wrong: slower wall-clock.
- Ruling: implementers prove agent behaviour with the scripted stand-in calling real tool handlers; real model only in Task 8 (≤12 turns) — subscription budget — cost if wrong: late discovery of model-behaviour gaps in Task 8.
- Ruling: AD-1..AD-9 (one OpenUI view runtime for default and agent views, data only via registered read descriptors, URL view state, versioned UI snapshot, per-conversation agent-views space with server-side lang-core validation, record actions via same tool handlers) — spec sections "Semantyczny interfejs…" and L3.14/L3.18 require default and agent views to share catalog and operations — cost if wrong: large refactor of views.
- Ruling: Task 5 (module detail screens as compositions) added beyond BL text — L3.14 requires default views to be real OpenUI compositions — cost if wrong: extra scope ~1 task.
- Ruling: implementers and reviewers on opus (Task 5 on sonnet) — broad cross-package integration with subtle invariants — cost if wrong: higher token spend.

## Pre-flight scan
| Pair / task | Produces → consumes | Finding | Ruling |
|---|---|---|---|
| T1 → T2..T8 | views.ts contracts, tools split, DataTable, uiSemantics, useReadOperation, scripted `call` | foundation must freeze interfaces | contracts frozen after T1 merge; changes need controller approval |
| T2 × T3 | UiCommandRunner, toAppContext, prompt.ts, scripted SCENARIOS, AppShell | textual conflicts likely | T3 reads state only via uiSemantics; controller resolves textual conflicts |
| T2 × T4 | DataTable (sort/page vs groupBy) | same render path | T4 groupBy as separate function + minimal hook-in |
| T4 × T5 | ServerModule.views startup validation vs new detail views | semantic: T5 compositions must pass T4 validator | post-merge verify on integration branch is the gate |
| T6 ← T2,T3,T4,T5 | URL page/filter, uiVersion, parser, detail views | needs all of wave 1 | wave 2 starts after full wave-1 merge |
| T7 ← T4,T5 | agent_view tools, case_offer_items read op | needs T4,T5 | wave 2 |
| T8 ← all | everything | needs wave 2 | wave 3 |
| T1 self | tests vs code | consistent (tools split behaviour-preserving, covered by mcp-schema tests) | — |
| T2 self | e2e (c) needs >1 page with 4 suppliers | test inserts rows into its own DB before start | allowed by G6 (API/DB may prepare data) |
| T3 self | snapshot sort/page before T2 merge | fields null until T2 | acceptable; post-merge e2e covers |
| T4 self | validator applied to all openui cards may break existing openui cards | none exist in tests/e2e (grep) | apply; startup validation of module views |
| T5 self | preserves testids used by app.spec/session-restore | consistent | — |
| T6 self | depends on Task 4 parser utility | consistent | — |
| T7 self | refresh proof via 3 mutation paths | consistent | — |
| T8 self | model turns budget ≤12 | consistent | — |

## Progress
- Task 1: dispatched (implementer opus, BASE bd615a7, worktree t1-fundament) 2026-09-17T15:48:14+02:00
- Task 1: implementer DONE_WITH_CONCERNS commits bd615a7..c459ed6 (verify 314/314, e2e 49 passed, module-swap ok)
- Task 1: review — spec ✅, quality Needs fixes: Important I1 DataSummary false `matched` (slice before describe); I2 descriptor schema doesn't check unitField/route placeholders ∈ fields
- Task 1: Ruling: include Minor 5 (useDescribeInstance unregister/register churn), Minor 6 (no `state` for loading/error/forbidden instances) and Minor 4 (prompt says "innych pol wynik nie ma" — false for comparison/case_overview) in fix round 1 — Task 3 snapshot versions/failure reporting and model-facing prompt build on them — cost if wrong: small extra fix scope
- Task 1: minor (deferred): M1 primaryOperation not cross-checked with composition → handoff to Task 4 validator
- Task 1: minor (deferred): M2 legacy `<kind>-tile-<id>` testid shim in DataTable → migrate selectors later (Task 8/final)
- Task 1: minor (deferred): M3 pageSize advertised but ignored → Task 2 applies it
- Task 1: minor (deferred): M7 two formatters (module formatMinor/formatQuantity vs formatFieldValue) → Task 5 migrates module screens
- Task 1: minor (deferred): M8 registry atomicity comment vs tool-name conflict after push (pre-existing)
- Task 1: minor (deferred): M9 resolveLive default branch misclassifies unexpected errors
- Task 1: minor (deferred): M10 startup errors plain Error vs AppError
- Task 1: minor (deferred): M11 ComposedView RenderErrorBoundary never resets (key by composition)
- Task 1: minor (deferred): M12 small duplications (frame branches, DataSummary inline record link, stableJson)
- Task 1: minor (deferred): M13 chart series keyed by label; duplicate categories; number rounding 3 decimals
- Task 1: minor (deferred): M14 composed-views e2e asserts exactly 4 suppliers on shared instance
- Task 1: ⚠️ items to verify by controller: chat renderer partial props firing POST /api/read during streaming (check at integration e2e/final review); agent-ui.spec selectors (Task 8 run)
- Task 1: fix round 1 dispatched (resume implementer) with I1, I2, R1, R2, R3; FIX_BASE c459ed6
## Wave-1 handoffs (carry into dispatches)
- T2: apply pageSize (M3); URL sort/page via sortRecords/buildDataModel; fill semantic `sort`/`page`
- T3: instance `state` (R2) + in-place description updates (R1); compositionVersion = hash of /api/ui/views composition
- T4: validator cross-checks ViewDefinition.primaryOperation against a DataTable in the composition (M1); new props (groupBy) APPENDED at end of dataTablePropsSchema (positional OpenUI args follow schema key order); check chat streaming partial props do not fire POST /api/read for incomplete sources (⚠️ from T1 review)
- T5: migrate module screens to formatFieldValue (M7); use record.route and params
- Task 1: fix round 1/5 (5 addressed, 0 open — I1,I2,R1,R2,R3; commits c459ed6..d268ab3)
- Task 1: complete (commits bd615a7..d268ab3, review clean)
- Task 1: merged into integracja
- Wave 1: dispatched 2026-09-17T16:51:09+02:00 BASE 3097586 — Task 2 (opus, t2-stan-widoku), Task 3 (opus, t3-opis-ui), Task 4 (opus, t4-widoki-agenta), Task 5 (sonnet, t5-ekrany-modulu)
- Ruling: sortable = every descriptor field unless sortable:false — practical default for module authors; agent can only name declared fields anyway — cost if wrong: module must opt out per field
- Ruling: module OpenUI components get a server-side declaration (ServerModule.openuiComponents) in Task 4 with React-free shared props schemas; Task 5 defines schemas React-free; coordinator reconciles at merge — AD-8 allows module components in agent views and startup validation of module views needs them — cost if wrong: one reconciliation round at merge
- Ruling: server UI snapshot store in memory (transient UI state), no_client after restart — cost if wrong: add persistence later
- Task 5: implementer DONE commit b852ae5 (verify 332, e2e composed-views 7, app+access 17, restore+chat 13, measurements+filter 9); decision: detail views without UiTarget (record screens reached via record.route)
- Task 5: review — spec ❌ (G9): I1 detailComponents.tsx:63 hardcoded priceBasis label duplicates descriptor enum labels (M7 migration incomplete); I2 views-foundation.test.ts:186 hardcoded id list instead of deriving non-parametrized views
- Task 5: Ruling: include Minor "h2 headings became TextContent" (views.ts:161,164) in fix round — accessibility regression introduced by this task (L2.5 area) — cost if wrong: trivial
- Task 5: minor (deferred): unitPriceMinor field shape duplicated browser vs server descriptor (module browser/server boundary)
- Task 5: minor (deferred): listCaseOfferItems returns undeclared offerId
- Task 5: minor (deferred): gating-read pattern for record screens has no shared abstraction
- Task 5: fix round 1 dispatched (resume implementer), FIX_BASE b852ae5
- Task 3: implementer DONE_WITH_CONCERNS commits 3097586..bdc71e8 (verify 353, e2e 76 passed non-model specs, 11 detection trials)
- Task 3: Ruling: keep out-of-scope fix 05cfe10 (RunEventStream.read lost wake-up) in Task 3 — genuine platform bug on the real-model path (PreToolUse then UI command), one line + regression test; reviewer to verify — cost if wrong: revert one commit
- Task 3: concern forwarded to Task 2: repeating identical ui_filter → not_applied; Task 2 told it may cherry-pick 05cfe10
- Task 3: review — spec ❌ (target naming depends on incidental cache); Important I1 url >2000 → appContext parse 500 on every send + silent PUT rejection; I2 freshness not bound to client (cross-tab minVersion, closed tabs never stale); I3 snapshot target/view from incidental cache (mount useUiTargets/useViewDefinitions in publisher); events.ts fix verified correct
- Task 3: Ruling: include Minor (f) ack timing budget (flush budget not tied to server 8 s UI-command timeout) in fix round — Task 6 adds reveal waits into the same budget — cost if wrong: small
- Task 3: minor (deferred): chatWiring flush delays queued feedback up to 1.5 s; header setConversation window
- Task 3: minor (deferred): G9 small dups (client-id regex vs uiClientIdSchema, double size check, chunked body read before size check)
- Task 3: minor (deferred): settle loop rebuilds full snapshot every 50 ms; debounce without max wait
- Task 3: minor (deferred): no wait/prompt retry on context-floor older_than_requested; ui_state result up to 256 KB to model; waitFor ignores cancellation; nextPublication creates owner state
- Task 3: minor (deferred): events.ts regression + $last tests live in ui-snapshot.test.ts instead of runtime.test.ts
- Task 3: fix round 1 dispatched (resume implementer), FIX_BASE bdc71e8
- Merge note T2×T3: after both merge, ui_sort result must pass uiVersion + uiClientId (Task 3 I2 shape); handle in merge round
- Task 5: fix round 1 implementer DONE commit 1508ed1 (verify 332; e2e 37/37); scoped re-review dispatched (sonnet)
- Task 2: implementer DONE_WITH_CONCERNS commits 3097586..bae56ba (verify 363, e2e 79 non-model specs, module-swap ok); cherry-picked T3 05cfe10 as 95fd5dc; moved dataSortSchema views.ts→ui.ts; router codec plain strings; module views DataTable(...,null,10)
- Task 2: concern forwarded to Task 4: validator must accept null for skipped optional positional args
- Task 2: review dispatched (opus)
- Task 5: fix round 1/5 (3 addressed, 0 open — I1,I2,R1; commits b852ae5..1508ed1)
- Task 5: complete (commits 3097586..1508ed1, review clean)
- Task 5: minor (deferred): comments in shared/openui-components.ts & detailComponents.tsx claim server validation via ServerModule.openuiComponents — true only after Task 4 merge; verify at T4 merge
- Task 5: minor (deferred): provenance screen h2 "Zrodlo" without page h1 (pre-existing)
- Task 5: merged into integracja 9643b76; controller verify exit 0, vitest 332/332
- Task 4: implementer DONE_WITH_CONCERNS commits 3097586..b9bf798 (verify 358, e2e 68 in 13 specs incl agent-views 6, module-swap ok, 16 detection trials); lang-core bundled via apps/server/build.mjs (flagged); pre-existing canvas geometry reset-to-(0,0) bug fixed; streaming partial-source reads confirmed & gated
- Task 4: review dispatched (opus)
- Note: my handoff example to T4 "DataTable(source, columns, title, null, 10)" was wrong; T2 actually uses DataTable(source, columns, null, 10) (null skips title) — verify at T2×T4 merge that module views pass T4 validator
- Task 2: review — spec ✅, quality Needs fixes: Important I1 UiCommandRunner caches failed /api/ui/views as [] for session → false not_sortable, clear without view check
- Task 2: Ruling: include Minors M1 (ui_sort clear on target without sortable view navigates & reports executed/cleared), M2 (Apply turns agent eq into contains silently), M5 (prompt target list under wrong heading), M6 (vacuous assertion view-state.spec.ts:241) in fix round — truthfulness of agent result / user-visible data / model-facing prompt / evidence quality — cost if wrong: small scope
- Task 2: minor (deferred): M3 untested filterOutcome idempotency path (no screen uses it)
- Task 2: minor (deferred): M4 parallel channels filterOutcome/viewStates/uiSemantics; page mapping twice; total meaning differs AppContext.filters vs semantic instance; target-by-route lookup in 4 places → reconcile at T2×T3 merge
- Task 2: minor (deferred): M7 unused `sort` option in scripted ui step; M8 reserved-key message says "sesji"; M9 two primary DataTables collide on viewStates; M10 focus on disabled Next, 4.8 s client wait vs slow reads
- Task 2: fix round 1 dispatched (resume implementer), FIX_BASE bae56ba
- Task 4: review — spec ❌: I1 patch via mergeStatements silently no-op/partial/deletes statements while reporting success (L3.17); I2 conversation rule bypass via generic canvas tools + ui_catalog lists other conversations' spaces (AD-8); I3 canvas_changed doesn't invalidate qk.agentViews (page updates only at run end); I4 MarkDownRenderer in agent-views whitelist contradicts its rationale (external images, model-typed value lists)
- Task 4: Ruling: lang-core declared in apps/server/package.json (same pinned 0.2.18), drop BUNDLED special case in build.mjs — existing pattern: app re-declares runtime deps of platform packages; one mechanism for the production image — cost if wrong: one lockfile importer line
- Task 4: Ruling: include Minors M2 (prompt patch example drops sort to null), M4 (test named MCP-compat checks nothing; filler assertions), M5 (POST /api/canvas/spaces accepts scopeKind conversation → orphaned spaces) in fix round — model-facing guidance, tests asserting nothing, invariant hole — cost if wrong: small
- Task 4: minor (deferred): M3 G9 small dups (unknown-op message twice, null-strip+safeParse twice, scoped-space SELECT twice, CanvasHost not using CanvasSurface)
- Task 4: minor (deferred): M6 read operations list stale ≤5 min / partial-name error flashes while streaming
- Task 4: minor (deferred): M7 page error/empty states not exercised in UI tests; M8 openui-validation.ts 662 lines could be split
- Task 4: minor (deferred): M9 groupBy not in semantic instance description (T3 area) → handle at T3×T4 merge
- Task 4: fix round 1 dispatched (resume implementer), FIX_BASE b9bf798
- Task 3: fix round 1 implementer DONE_WITH_CONCERNS commits bdc71e8..666f789 (verify 365; e2e 38 covering; I3 diagnosis corrected: catalog was loaded via banner, real gaps module views + active space cards after GC)
- Task 2: fix round 1 implementer DONE_WITH_CONCERNS commit 3993c4f (verify 368; e2e 27 covering); new reason views_unavailable; uiCommandPlan.ts pure module
- Task 2: Ruling: ui_filter clear=true on a target that declares no filter must not navigate and answers executed:false reason not_filterable (base test view-filter.test.ts:284 "dziala na kazdym celu" changed with rationale); clearing on targets that declare a filter keeps working regardless of current params — consistency with ui_sort R1; a no-op clear must not move the user — cost if wrong: agent cannot use clear as a navigation side effect (it has ui_navigate)
- Task 2: minor (deferred): runner switches workspace before refusal checks (not reachable today: ui_filter/ui_sort never send spaceId)
- Task 2: re-review round 1 dispatched (opus) on bae56ba..3993c4f; fix round 2 (ui_filter clear ruling) sent to implementer in parallel
- Task 3: fix round 1/5 (4 addressed, 0 open — I1,I2,I3,R1; commits bdc71e8..666f789)
- Task 3: Ruling: fix round 2 for new-in-fix Minors N1 (heartbeat republishes previous owner's snapshot after access switch → cross-identity leak, L6.4/L10.11), N2 (heartbeat vouches for last accepted snapshot after newer one rejected → stale reported fresh, L6.17), N3 (prompt prints clamped url without truncation flag), N5 (rejected status used for local "nothing described"), plus report sections 1.2/2.5/10.9 contradicting current behaviour — identity isolation and freshness honesty are load-bearing for T6/T8 — cost if wrong: one more small round
- Task 3: minor (deferred): N4 minVersion without ack/marker still applied to chosen tab; GET ?conversationId&minVersion not bound to a tab
- Task 3: minor (deferred): N6 duplicated tab DELETE can retire original tab's snapshot (≤15 s)
- Task 3: minor (deferred): N7 every ['canvas'] invalidation refetches active space on all screens
- Task 3: minor (deferred): perform's catalog fetch unbounded vs ack deadline (pre-existing)
- Task 3: fix round 2 dispatched (resume implementer), FIX_BASE 666f789
- Task 2: fix round 2 implementer DONE commit de247be (verify 370; e2e 15; detection checks 3) — re-review pending after round-1 verdict
- Task 2: fix round 1/5 (5 addressed, 0 open — I1,R1,R2,R3,R4; commits bae56ba..3993c4f)
- Task 2: minor (deferred): loadViews memoized with useMemo instead of useRef (UiCommandRunner.tsx:66-69)
- Task 2: re-review round 2 dispatched (sonnet) on 3993c4f..de247be
- Task 4: fix round 1 implementer DONE_WITH_CONCERNS commits b9bf798..7970288 (verify 363; e2e 31 covering; module-swap ok; detection trials repeated on clean tree after a procedural mistake — first series not evidence)
- Task 4: re-review round 1 dispatched (opus) on b9bf798..7970288
- Ruling: wave-1 merge procedure — T2 merged first by controller (no conflicts expected vs T1+T5 base); then T3's implementer merges integracja into its branch and resolves (UiCommandRunner/prompt/tools/appState/scripted overlaps; ui_sort must return uiVersion/uiClientId/uiPublication; reconcile AppContext.filters total vs semantic total), runs G10 gate, scoped re-review of merge commit, controller merges; then T4's implementer merges integracja (T2+T3+T5) and reconciles T5 module OpenUI components into openuiComponents declarations, T2 module compositions (null args, pageSize) and T3 snapshot (groupBy in description), gate, re-review, merge — implementers know their code; textual conflicts are semantic here — cost if wrong: two extra review rounds
- Task 2: fix round 2/5 (2 addressed, 0 open — R5,R6; commits 3993c4f..de247be)
- Task 2: complete (commits 3097586..de247be, review clean)
- Task 2: merged into integracja eb6985e (one comment-only conflict in module views.ts resolved by controller, both texts kept); controller verify exit 0, vitest 375/375; controller e2e on merged branch running (composed-views, view-state, view-filter, app, access-context, session-restore, ui-navigation, scripted-call)
- Integration e2e after T2 merge: 51 passed (8 specs) exit 0; removed untracked generated docs/evidence/chat-ux-2026-09-16
- Task 4: fix round 1/5 (8 addressed, 0 open — I1..I4, R1..R4; commits b9bf798..7970288)
- Ruling: merge order changed to T4 before T3 — T4 ready now, T3 still in fix round 2; T3 will reconcile with T2+T4 at its merge — cost if wrong: T3 merge round slightly larger
- Task 4: Ruling: merge round also closes re-review Minors M1 (patch line unreadable by lang-core with existing name silently kept → compare each patch statement text with merged result), M2 (no-op patch bumps version when source had blank lines/comments), M4 (unchanged shortcut skips expectedSpecVersion conflict) — same L3.17 honesty as I1 — cost if wrong: small
- Task 4: minor (deferred): M3 duplicate orphaned_statement messages; M5 e2e 3 s empty-state window tight under load; M6 prompt `name = null` doesn't say remove reference from root
- Task 4: minor (deferred): comment lines with quotes/parens refused as partial (lang-core autoClose, pre-existing); ui_catalog.currentSpaceId may show another conversation's space id (access refused)
- Task 4: merge round dispatched (resume implementer): merge integracja eb6985e into t4 branch
- Task 3: fix round 2 implementer DONE_WITH_CONCERNS commit 4a26129 (verify 369; e2e 35 covering; 9/9 detection trials on committed code; same procedural mistake as T4 — uncommitted uiSnapshot.ts wiped by trial checkout, re-applied)
- Ruling: dispatch-common.md gains mandatory detection-trial procedure (commit first, clean tree, restore, check clean) — two implementers lost uncommitted work — cost if wrong: none
- Task 3: fix round 2/5 (5 addressed, 1 open — N1,N2,N3,N5,report addressed; NEW Important A1: uiSemantics registry + shell conversationId/spaceId not cleared on access switch, QueryCache.clear() doesn't notify observers → previous owner's instances (visibleRecordIds, filters, counts) captured under new scope and published to new owner's store, unbounded duration (L10.11); commits 666f789..4a26129)
- Task 3: Ruling: fix round 3 includes A1 + Minor 1 (conflict-renewal send and #failed alive skip scope re-check) + publisher inputs not reloaded after switch (target/view/cards null for new owner) + report stale sentences (1.2 line 35, addenda 212/282, header comment uiSnapshot.ts:22-27) — identity isolation load-bearing for T6/T8 and L10.11 — cost if wrong: one more round
- Task 3: minor (deferred): transient 5xx/401 recorded as refusal stops heartbeat retries (honest but less resilient)
- Task 3: minor (deferred): cookie-before-scope gap in switchAccessContext (ms window, affects all mutations; pre-existing)
- Final-review note: chat panel/useAppState not reset on owner switch → previous owner's chat content may remain visible (pre-existing; relates to L10.11/T12 assessment)
- Task 3: fix round 3 dispatched (resume implementer), FIX_BASE 4a26129
- Task 4: merge round implementer DONE_WITH_CONCERNS: merge commit dabc157 (7970288 + eb6985e), fix commit 9aec7be (M1,M2,M4; composition sort only on sortable fields; grouping over current page; module OpenUI declarations unified in shared/openui-components.ts for 6 components); verify 415; e2e 63 (10 specs); module-swap ok
- Task 4: minor (deferred): `$x` in module component props not checked against view params (typo passes startup)
- Task 4: minor (deferred): signature comment in module views.ts omits groupBy
- Task 4: merge round verdict — MR1,MR2,MR3,M1,M2,M4,S1 OK; new Minor N1: full-source no-op shortcut (sameComposition) hides syntax/duplicate refusals (agent-views.ts:194, openui-validation.ts:316)
- Task 4: Ruling: fix N1 before merge (one reorder: statementsOf problems before sameComposition) — same L3.17 honesty class as M1 — cost if wrong: trivial
- Task 4: minor (deferred): patch refusals checked before stale-version conflict (pre-existing order)
- Task 4: minor (deferred → T3 merge): grouping reorders rows within page while visibleRecordIds keeps sorted order; description doesn't mention groupBy
- Task 4: minor (deferred): refusal code naming unsortable_field vs not_sortable; message text duplicated from model.ts:105
- Task 4: N1 fix implementer DONE commit 8701b29 (agent-views 31/31, verify 416, detection check); re-review dispatched (sonnet)
- Task 4: N1 fix verdict — addressed, no new breakage (commits 9aec7be..8701b29)
- Task 4: complete (commits 3097586..8701b29 incl. merge dabc157, review clean; 1 open deferred minor: $x in module component props not checked vs params)
- Task 4: merged into integracja da7b868 (no conflicts); controller verify exit 0, vitest 416/416; controller e2e (10 specs) running
- Integration e2e after T4 merge: 63 passed (10 specs) exit 0; removed untracked generated evidence
- Task 3: fix round 3 implementer DONE_WITH_CONCERNS commits 4a26129..96a2fad (verify 373; e2e 31; 10/10 detection trials on clean tree; A1 leak reproduced on unfixed code and fixed via access epoch on registry entries; extra leak fixed: previous conversation in reported url `c` param)
- Final-review note: chat table still shows previous owner's rows on screen after switch (pre-existing, outside T3) — L10.11/T12 assessment must consider it
- Task 3: fix round 3/5 (4 addressed, 0 open — A1,M1,P1,report; commits 4a26129..96a2fad)
- Task 3: minor (deferred): conflict branch renews tab identity before scope check (harmless); re-rendered publisher fetches previous owner's space as new owner (refused, noise)
- Final-review note: chat table re-describes itself under new epoch with previous owner's composition inputs after re-render (records are new owner's/forbidden) — root cause chat not reset on owner switch (pre-existing)
- Ruling: AppContext.filters[target].total vs semantic instance total — no behaviour change; only primary instances (no composition filter) feed AppContext.filters, so values coincide; document both definitions precisely in contracts at T3 merge — cost if wrong: later confusion for agent-view tables with fixed filters
- Task 3: merge round dispatched (resume implementer): merge integracja da7b868 (T1,T5,T2,T4) + reconciliation + minors (epoch at render, contract doc wording, report sentences 209/355)
- Task 3: merge round implementer DONE_WITH_CONCERNS: merge e58796b (96a2fad + da7b868, 10 conflicted files), fixes 09ba0ed, 5e94c3c; verify 468; module-swap ok; 17 non-model specs 100 passed; 10/10 detection checks
- Task 3: merge round verdict — MR1, I1..I5, B1..B3 OK; NEW Important L1: cardsSpaceId bypasses held-at-switch filter (snapshotSource.ts:116, uiSnapshot.ts:93) → previous owner's space id in new owner's snapshot after switch then opening /
- Task 3: Ruling: merge-round fix includes L1 + Minor (/agent-views reports working-space cards on refetch error or without `c`) + card order tie-breaker `ORDER BY created_at, id` + prompt/doc: `cards: null` means unknown — identity isolation and description honesty — cost if wrong: small
- Task 3: merge-round fix dispatched (resume implementer), FIX_BASE 5e94c3c
- Ruling: start Task 7 now from integracja da7b868 (T1,T5,T2,T4) without waiting for T3 — its dependencies are T4,T5 only; T3 overlaps (scripted-server, prompt, DataTable description) resolved at T7 merge — cost if wrong: one merge round
- Task 7: worktree t7-interakcje BASE da7b868
- Task 7: dispatched 2026-09-17T19:21:03+02:00 (opus) BASE da7b868; rulings: RecordAction contract (tool of same module, effect write, key mapping checked at startup, no z.record), POST /api/actions with read input + operationId, money form parse next to formatFieldValue, semantic actions action:<id>, MCP write refreshes agent views proof
- Task 3: merge-round fix L1 implementer DONE_WITH_CONCERNS commit 7bb8a8e (verify 472; e2e 20; 5/5 detection); new contract field cardsState
- Task 3: L1 fix verdict — L1, A2, A3, A4 addressed, no new Critical/Important (commits 5e94c3c..7bb8a8e)
- Task 3: parked — CanvasHost reports cached cards `loaded` when refetch failed and screen shows error (CanvasHost.tsx:109) — Ruling: real but minor honesty gap, not identity leak; T3 at round cap (3 fix + merge + L1); carry to final-review fix wave — cost if wrong: snapshot may list cards while screen shows error until next success
- Task 3: parked — cardsSpaceId doc incomplete for agent-views loading/error; schema doesn't enforce cardsState↔cards link; cardsState required (not strictly append-only) — Ruling: doc/contract nits, client+server ship together; carry to final-review fix wave
- Final-review notes: Back into pre-switch history restores old `s` via SpaceSync (follows "until shell moves" rule); toAppContext sends raw shell ids right after switch (server owner checks apply); canvas stays on error after switch until shell moves (pre-existing)
- Task 3: complete (commits 3097586..7bb8a8e incl. merge e58796b, 2 parked)
- Task 3: merged into integracja 02a27d3; controller verify exit 0 vitest 472/472; controller e2e all non-model specs 100 passed exit 0
- WAVE 1 COMPLETE on integracja 02a27d3 (T1,T5,T2,T4,T3)
- Task 6: dispatched 2026-09-17T19:39:48+02:00 (opus) BASE 02a27d3; rulings: candidates = routed module views + run-conversation agent-view cards + parametrized view only when displayed (params from bound tab snapshot); no_renderer for unrendered field; explicit reported adjustments (clear excluding filter fields, page switch); matchesBackend via ack rawValue vs server pre-read; highlighted only when cell found
- Task 7: implementer DONE_WITH_CONCERNS commits da7b868..5f3be99 (verify 431; e2e 17 non-model specs 95 passed incl interactions 5; module-swap ok; 16 detection trials); review dispatched (opus)
- Task 6: implementer DONE_WITH_CONCERNS commits 02a27d3..1efaa94 (verify 502; show-value 6/6; 18 non-model specs 106 passed; 8 detection trials; 3 failed runs documented)
- Task 6: Ruling: keep `forbidden` only for reads the backend refuses; a record absent from an owner-scoped list is honestly `record_not_found` (no new contract field, no existence oracle across owners) — L6.16 distinctions are satisfied by the refusal set; document the rule in the report and module-author contract — cost if wrong: agent cannot tell "exists but not yours" for owner-scoped lists, which is the privacy-preserving answer anyway
- Task 7: review — spec ✅, quality Approved, no Critical/Important; minors M1..M8
- Task 7: Ruling: merge round also fixes M1 (registry.callTool keeps its own validate+handler copy; tests claim "viaMcp" but exercise it — delegate to executeTool), M3 (success status keeps claiming reload after refetch finished), M4 (409 operation_id_reused wording implies nothing happened; re-issue operationId on changed values or reword) — G9 + truthfulness to user — cost if wrong: small
- Task 7: minor (deferred): M2 startup type check asymmetric ($record→tool input types unchecked; jsonTypesOf computed twice); M5 parseFieldInput doc/test symmetry vs printed unit; M6 aria-invalid on all fields + focus not restored when row leaves page; M7 pre-existing (canvas invalidation on data_changed, RUN_FINISHED refresh marker, non-atomic idempotency); M8 money_minor/quantity_milli form types have no production caller
- Task 7: merge round dispatched (resume implementer): merge integracja 02a27d3 (adds Task 3)
- Task 6: review — spec ✅ (3 disclosed deviations; forbidden/record_not_found ruling judged to satisfy L6.16), quality Approved; Important I1 presentation change survives refusal without banner/adjustments; I2 unreadable candidate reads reported as record_not_found
- Task 6: Ruling: fix round 1 includes I1, I2 + Minors M3 (unbounded rAF in hidden tab → ack never posted after address already changed), M8 (displayedView falls back to appContext.conversationId — snapshot of another conversation), deviation 3 (unknown_target refusal undocumented in SHOW_VALUE_REFUSALS/tool/prompt), M10 (ambiguous lacks fieldLabel) — honesty of failure paths is the core of L6.16 — cost if wrong: one round
- Task 6: minor (deferred): M4 occlusion not checked; M5 client cannot honour #statementId disambiguation; M6 route recomputed client-side instead of server's decision; M7 no_renderer lacks shownIn detail; M9 small duplication (RevealNotice, settled check)
- Task 6: fix round 1 dispatched (resume implementer), FIX_BASE 1efaa94
- Task 7: merge round implementer DONE_WITH_CONCERNS: merge 5e55b10 (one conflict: scripted-server imports), fixes 42ae3da (M1 executeTool single path, M3 status text, M4 new operationId on changed values); verify 487; 18 non-model specs 106 passed; module-swap ok; re-review dispatched (sonnet)
- Task 6: fix round 1 implementer DONE_WITH_CONCERNS commit 1d041e5 (show-value 37; e2e 24; verify 509; 4 detection trials incl. R1 hang reproduced as timeout)
- Task 6: Ruling: accept "do not restore the address after a refusal" — the record is reachable in the adjusted view and the change is reported in the result and the banner; silently reverting would be a second unreported screen change — cost if wrong: user must clear the narrowing themselves (one button)
- Task 7: merge round verdict — MR1, MR2, MR3, M1, M3, M4 all OK, no new breakage
- Task 7: complete (commits da7b868..42ae3da incl. merge 5e55b10, review clean)
- Task 7: merged into integracja 1be9998; controller verify exit 0 vitest 487/487
- Task 6: fix round 1/5 (6 addressed, 0 open — I1,I2,R1,R2,R3,R4; commits 1efaa94..1d041e5)
- Task 6: minor (deferred): SHOW_VALUE_REFUSALS.unknownTarget and UI_COMMAND_FAILURES.unknownTarget share the string; revealNotice not cleared by a later command that fails before any screen change (pre-existing); FRAME_WAIT_MS doubled on card_focused path
- Task 6: merge round dispatched (resume implementer): merge integracja 1be9998 (adds Task 7)
- Task 6: merge round implementer DONE_WITH_CONCERNS: merge cd1e8c3 (3 conflicts kept both sides), fixes 134e0dd, a348d2a; verify 526; 19 non-model specs 114 passed; module-swap ok; finding: page change during open action form loses typed text (pinned by test); performReveal now waits for table refreshing else not_applied; re-review dispatched (sonnet)
- Task 6: merge round verdict — MR1, R1..R4 all OK, no new breakage
- Task 6: Ruling: park for final fix wave — (a) `not_applied` now means both "no view applied it" (T2/T3 defect signal) and "table still refreshing, retry" (T6 benign); add a distinct reason (e.g. `refreshing`) in the final wave; (b) typed text in an open record-action form is lost when its row leaves the page (T7 architecture: form values are per-row state) — lift to table-level controller keyed by recordId — cost if wrong: monitoring false positives; user retypes a value
- Task 6: complete (commits 02a27d3..a348d2a incl. merge cd1e8c3, review clean)
- Task 6: merged into integracja 00a88a7; controller verify exit 0 vitest 526/526; controller e2e all non-model specs 114 passed exit 0
- WAVE 2 COMPLETE on integracja 00a88a7 (T7, T6)
- Task 8: dispatched 2026-09-17T21:24:55+02:00 (opus) BASE 00a88a7; budget ≤12 model turns incl. retries, max 2 attempts per scenario, honest partial result required; evidence in docs/evidence/bl01-bl02-2026-09-17/
- Task 8: implementer DONE_WITH_CONCERNS (11/12 turns): T25 PASS (run_37fe2969), T26 PASS (3 runs), T27 step 1 proven (run_0de7b080), steps 3-5 unproven (budget); two product findings: (F1) agent composes `caseId: "PC-2026-01"` (business code as id) because the agent-views prompt never says to resolve identifiers with a module tool (platform refused correctly, no invented values); (F2) agent announced a chart that does not draw — server accepted a money series whose unit is not uniform in the data, the component refuses honestly, but the prompt requires ui_state only after ui_navigate/ui_filter/ui_sort, not after agent_view_*; T27 test committed RED on purpose
- Controller check: ui_catalog DOES return declared filter values (ui.ts:41-45) — Task 8's "names only" observation is model behaviour, not a regression; prompt nudge instead
- Ruling: Task 9 (fix round from model findings) dispatched from 00a88a7 in new worktree t9-poprawki-modelowe — prompt/tool honesty fixes only, no data-dependent validation at composition time (data changes; the component's refusal stays the durable guard) — cost if wrong: another model round
- Task 9: implementer DONE commits 00a88a7..a51e237 (verify 529; 28 e2e passed; 6 detection trials); F1 identifiers-from-read guidance, F2 rendered:false + readBack + ui_state rule for agent_view_* + descriptor-only warning unit_from_record, F3 declared values in prompt/tool text
- Task 9: review Approved (F1,F2,F3 closed; prompt statements verified true against code; no breakage)
- Task 9: minor (deferred): "stored, not rendered" rule duplicated in two prompt sections gated by different conditions (drift risk); unit_from_record warning fires also for single-currency data (accepted cost of data-independence)
- Task 9: complete, merged into integracja
- Task 9: merged into integracja 9c3d750; controller verify exit 0 vitest 529/529; Task 8 resumed for T27 steps 3-5 with budget ≤6 turns, starting with the variant that failed twice
- Task 8: T27 steps 1-5 PROVEN with real model (runs 335ba5ea, efa90d9f, 893c41ea, 9411a0c6); step 6 unproven — test selector fault (fixed 15c8994), not a product finding; F1/F2 fixes verified to change model behaviour (3e583d11 resolves id via procurement_search; 3213d8f0 reports the chart cannot draw after reading ui_state)
- Ruling: final grant of 4 model turns to (1) rewrite the step-2 expectation to the true honest behaviour (mixed-unit chart refuses on screen, agent reports it, ready after narrowing) and (2) prove step 6 — a red test encoding a wrong expectation is not an acceptance result — cost if wrong: 4 turns
- Task 8: minor (deferred → final wave): pnpm typecheck does not cover e2e/ (a dead reference in a spec can burn a model turn); needs tsconfig.e2e.json after tidying fixtures.ts, chat-drawer.spec.ts and three scripted scenarios
- Task 8: DONE — T25, T26, T27 all pass with the real model, no red tests, no test.fixme; T27 six steps proven in one conversation (cnv_7eeb2c33); 21 turns total (grants 12/6/4), one turn lost to implementer's own budget-guard mistake, phantom ledger entry removed and documented; suite cost 11 turns per full run; evidence in docs/evidence/bl01-bl02-2026-09-17/
- Task 8: review dispatched (opus) on 9c3d750..ccfd86c — evidence quality, no weakened assertions, ledger honesty
- Task 8: review Approved — assertions carry the criteria (DOM/address/acks/ui_state/run events/backend, never wording), step-2 rewrite is strictly stronger than what it replaced, zero production code in range, ledger/grants/failed runs honest, no secrets
- Task 8: Important I1 step-6 "bez przeladowania" computed into evidence but never asserted (spec:1268-1275); I2 mutation step branches on `hasActionHere` and silently walks to the case screen if the agent-view table lacks the record action (removed auxiliary test a69f8af did assert it)
- Task 8: Ruling: tighten both assertions WITHOUT spending further turns; the recorded evidence shows the asserted values held (stillWithoutReload true; mutacja.gdzie = "akcja rekordu w widoku agenta"), and the report must state plainly that the tightened assertions were not exercised in a run — spending 4 more turns to re-prove what the evidence already records is not worth it — cost if wrong: the next full run surfaces it
- Task 8: minor (deferred → same fix): MODEL_TURN_BUDGET 22 vs stated 21; ledger turn-18 stage/grant contradiction; evidence commit reconciliation note
- Task 8: minor (deferred → final wave): T25 real-model precondition covered only the narrowing (no view/space change; scripted covers it); single-card T27 run so "other cards preserved" is scripted-only; notShown now reads the LAST ui_show_value; publishedSnapshot returns null instead of asserting
- Task 8: final fixes commit 616cc15 (I1 step-6 witness asserted, I2 action button required, budget/ledger/README reconciled, not-exercised caveat stated beside the per-step table); verify 529, scripted specs 21 passed; no turns spent
- Ruling: skip a separate scoped re-review of 616cc15 (assertions + docs only, no production code) and let the final whole-branch review cover it — cost if wrong: the final review catches it
- Task 8: complete
## Final whole-branch review (two parts, opus)
- Part A (contracts/server/modules): Fit with Important fixed — A1 sortRecords ignores unitField so a money sort ranks PLN against EUR while the chart refuses the same series; A2 module-author contract absent from docs/NEW-APPLICATION.md (coordinator-owned); A3 not_applied overloaded (defect signal vs "still refreshing"); triage: item 76 (CanvasHost loaded-on-error) = fix before acceptance
- Part B (UI/tests/evidence): Fit with Important fixed — B1 next full `pnpm test:e2e` spends turn 22, throws at turn 23 and OVERWRITES t25/t26/t27 evidence with "niezaliczona"; B2 tightened assertions' remediation path blocked by B1; B3 stale section in task-8-report contradicts final state; B4 e2e/ outside pnpm typecheck and not clean (root cause: Step['input'] union collapses to unknown); browser: CanvasHost.tsx:106 publishes cardsState 'loaded' with cards while the screen shows an error; chat identity residue must be RECORDED against L10.11/T12, not closed
- Ruling: ONE final fix wave (Task 10) covering A1, A3, B1+B2 policy, B3, B4 and CanvasHost; docs (A2) and the L10.11/T12 recording stay with the coordinator — cost if wrong: one more review round
- Task 10 (final fix wave): implementer DONE_WITH_CONCERNS commits 22d9b4d..4328168 — item 1 money sort refused like a chart series (shared unitsInPlay/mixedUnits in contracts, composition throws, address/ui_sort set aside with new `mixed_units`), item 2 `refreshing` split from `not_applied`, item 3 model specs opt-in (`pnpm test:e2e:model`, gitignored tally, run-stamped evidence under runs/), item 4 stale report sections marked superseded, item 5 tsconfig.e2e.json in the gate + CallInput union fixes all 16 errors, item 6 canvas error-before-data; verify 540, module-swap ok, 19 non-model specs 114 passed; evidence byte-identical to 22d9b4d
- Ruling: add a pre-flight budget check to the model spec in the same round — with tally 21 and budget 22 an authorised run burns a paid turn in T25 and then fails in T26; a skip that names the shortfall spends nothing and claims nothing — cost if wrong: trivial
- Task 10: pre-flight added (41eea4b, ACCEPTANCE_TEST_TURNS + budgetPreflight, asked once, beforeEach skip); verify 542; 114 e2e; evidence still byte-identical; scoped re-review dispatched
- Task 10: re-review — all 7 items ADDRESSED, no new Critical/Important; verified one shared unit rule, single-project testIgnore, evidence immutability, tsc -p tsconfig.e2e.json exit 0, pre-flight boundary arithmetic
- Ruling: accept residual (1) no creation-time warning for a DataTable sorted by a unitField field (renders an honest error, never a false ranking) — record in the report and backlog instead of another code round — cost if wrong: an agent creates a card that shows an error it could have been warned about
- Ruling: accept residual (5) `pnpm test:e2e:model` costs 11 turns but only the acceptance spec is guarded (agent-ui, files-agent unguarded/uncounted) — state it explicitly in README/AGENTS (coordinator-owned docs) rather than extend the guard now — cost if wrong: up to 4 uncounted turns on an authorised run
- Ruling: accept residuals (2) not_applied still possible for a very slow first read, (3) ui_state carries no rejectedSort, (4) empty unitField value counts as its own unit (unreachable in the shipped module), (6) README edit was required by item 3, (7) runs/ untracked inside a committed evidence directory — record in the report/backlog
## Controller independent verification (clean worktree "weryfikacja" at 97a7945)
- pnpm install --frozen-lockfile exit 0; pnpm verify exit 0 (32 files / 542 tests, incl. new e2e typecheck)
- pnpm test:e2e (default) exit 0, 114 passed — model specs skipped, no turns spent, docs/evidence byte-identical
- pnpm check:module-swap exit 0
- production start on test port 8793 with its own data dir: /api/health {"ok":true,"instanceLabel":"agenticapp-test"}, /api/status refuses without a session (unauthenticated), index 200; process stopped, port free, data dir removed
- user instance untouched: same pid on 8791, dist sha 356bffc0… unchanged; main checkout clean at 7f569c0
## Documentation phase (controller)
- assessment.json updated: BL-01 (L2.16, L2.17, L6.15, L6.16, L6.17) and BL-02 (L3.14..L3.18) confirmed; adjacent criteria with new evidence confirmed (L3.3, L3.4, L3.12, L2.6, L10.5, L10.12, L6.1, L6.2); narrowed gaps kept open (L2.1, L2.13, L2.14, L2.15, L3.11, L6.3); scenarios T25/T26/T27 confirmed; BL-01 and BL-02 packages removed from the backlog; meta = code state 97a7945 + controller verification
- totals 77/107/9/7 (was 59/118/15/8), 0/12 layers closed, 10 backlog packages, consistency OK
- docs/NEW-APPLICATION.md §3.1/§3.2 (read result descriptor with fields+actions, module views, server-side OpenUI declarations), README/AGENTS caveat that only the acceptance spec is budget-guarded, FEEDBACK.md §T2, docs/RAPORT-ARCHITEKTA-BL01-BL02.md, DOCUMENTATION-MAP §6
- commit 197f628; pnpm verify exit 0 (542 tests) after the docs commit
