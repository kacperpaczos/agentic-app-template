# Inwentaryzacja pod tryb GLM (subagent, read-only, HEAD 2d59906)
# Zapisane przez orkiestratora z raportu subagenta. Pelna tresc: 9 sekcji, tabela plik:linia.

## Lista dotknięć
1. platform-contracts/src/agent.ts (authMethodSchema +='glm'; apiKeyPolicy literal→enum; authIsUsable/Confirmed gałąź GLM)
2. platform-server/src/agent/auth.ts (subscriptionOnlyEnv provider-aware; probeAuth: glm nie czyta .credentials.json)
3. platform-server/src/agent/runtime.ts (env z configiem providera)
4. platform-server/src/config.ts (APP_MODEL_PROVIDER: subscription|glm, fail-closed; w glm wymagane ANTHROPIC_BASE_URL+AUTH_TOKEN+APP_MODEL+izolowany CLAUDE_CONFIG_DIR)
5. platform-server/src/http/app.ts (/api/status)
6. platform-ui/src/shell/AppShell.tsx (etykieta GLM)
7. platform-ui/src/shell/SettingsPage.tsx (metoda/policy per provider)
8. apps/server/src/main.ts (log startowy provider-aware)
9. apps/server/src/cli/diag-agent.ts (diag: provider, model, endpoint-origin, bez „odrzucany")
10. scripts/probe-sdk-session.ts / probe-refresh-refused.ts (wariant/skip GLM)
11. tests: auth.test 172-222, runtime.test 65-111/546-549, diagnostics.test 377-398/519-527, contracts.test 105-113, durability 198-212 — warunkowanie trybem
12. e2e: app.spec 64-77, auth-limits (+scenariusz glm w scripted-server.ts:721-749), measurements.spec:186 (kanarek w AUTH_TOKEN tylko subscription-mode)
13. e2e/support/model-turns.ts:233,402 + bl03-model.ts (zrodlo provider-aware, pole model wypełnione, rejestr „tur GLM")
14. AGENTS.md/README (decyzja właściciela), FEEDBACK

## Ryzyka (z inwentaryzacji)
- Częściowy revert PROVIDER_OVERRIDES = osłabienie kanarków → API_KEY/Bedrock/Vertex skrubowane BEZWARUNKOWO; GLM = jawna flaga, nie „brak scrubu".
- Fałszywe dowody: stałe zrodlo „subskrypcja Claude" muszą być sparametryzowane.
- Kłamstwo UI/diag „odrzucany" + authIsUsable=false mimo działającego GLM.
- measurements.spec:186 kanarek w AUTH_TOKEN stałby się żywym sekretem do zewnętrznego endpointu → ten scenariusz tylko subscription-mode.
- Izolowany CLAUDE_CONFIG_DIR musi być w env SERWERA (nie tylko dziecka), inaczej protectedDirsFor strzeże złej ścieżki.
