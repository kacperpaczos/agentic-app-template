# Dowód #1 — rzeczywiste wywołanie Claude Agent SDK przez subskrypcję

Data: 2026-09-14. Cel: sprawdzić prawdziwą ścieżkę agentową zanim powstanie reszta aplikacji.

## Warunki

- Node v24.19.0, `@anthropic-ai/claude-agent-sdk` 0.3.270.
- Uwierzytelnienie: OAuth subskrypcji z `~/.claude/.credentials.json`, plan `max`.
- Brak `ANTHROPIC_API_KEY` w środowisku (sprawdzone `env | grep ANTHROPIC` — pusto).
- Katalog tymczasowy poza repozytorium.

## Skrypt (istota)

```js
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const srv = createSdkMcpServer({
  name: 'probe', version: '1.0.0',
  tools: [tool('magic_number', 'Returns the magic number for a case', { caseId: z.string() },
    async ({ caseId }) => ({ content: [{ type: 'text', text: JSON.stringify({ caseId, magic: 4711 }) }] }))],
});

const q = query({
  prompt: 'Call the magic_number tool with caseId "PC-1" and then reply with exactly: MAGIC=<value>',
  options: {
    model: 'claude-sonnet-4-5',
    mcpServers: { probe: srv },
    allowedTools: ['mcp__probe__magic_number'],
    permissionMode: 'bypassPermissions',
    maxTurns: 5,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
  },
});
```

## Wynik (dosłowny)

```
[init] session e3f4bc6a-df7f-41bd-9b4d-f639ffb21a39 model claude-sonnet-4-5
       tools mcp__context7__query-docs,mcp__context7__resolve-library-id,mcp__probe__magic_number
[text] I'll load the magic_number tool schema and call it with caseId "PC-1".
[tool_use] ToolSearch {"query":"select:mcp__probe__magic_number","max_results":1}
[tool_result] [{"type":"tool_reference","tool_name":"mcp__probe__magic_number"}]
[tool_use] mcp__probe__magic_number {"caseId":"PC-1"}
[tool_result] [{"type":"text","text":"{\"caseId\":\"PC-1\",\"magic\":4711}"}]
[text] MAGIC=4711
[result] success ms=10317 session=e3f4bc6a-df7f-41bd-9b4d-f639ffb21a39 cost=0.0786627
```

## Wnioski

1. **Uwierzytelnienie subskrypcyjne działa** — bez klucza API, bez gatewaya.
2. **Narzędzia MCP w procesie działają** — model wywołał narzędzie, dostał wynik i użył go
   w odpowiedzi (`MAGIC=4711`).
3. **`session_id` jest dostępny** w komunikacie `system/init` — podstawa do wznawiania rozmowy.
4. **Wykryto wyciek konfiguracji:** na liście narzędzi pojawiły się `mcp__context7__*` — serwery
   MCP z prywatnego `~/.claude/settings.json` dewelopera. W aplikacji ustawiono `settingSources: []`.
5. `total_cost_usd` jest raportowany także przy rozliczeniu subskrypcyjnym; to wycena zużycia,
   nie obciążenie API.

Uwaga: nie zapisano żadnej wartości tokena. Pole `cost` i identyfikator sesji nie są sekretami.
