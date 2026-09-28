# Dowód #2 — pełna ścieżka agentowa przez AG-UI

Wszystkie przebiegi wykonane przez `POST /api/agui/run` na buildzie produkcyjnym,
z prawdziwym modelem na subskrypcji. Żaden nie używa mocka.

## A. Porównanie ofert + zmiana kompozycji canvasu

Polecenie: *„Porownaj oferty dla tej sprawy i dodaj na canvasie karte z tabela porownawcza."*

```
[RUN_STARTED]  threadId=cnv_95e1a56e8db24564b50c runId=run_f3d9d987f4bc49e18370
[CUSTOM] platform.session_bound sessionId=0bb7e15e-4859-470c-a180-8c4fb87d481a
[TOOL] mcp__app__procurement_compare_offers {"caseId":"pcs_27685a0138ec4538ad8a"}
[RESULT] {"caseCurrency":"PLN","casePriceBasis":"net","criteria":[...],"rows":[...]}
[TOOL] mcp__app__canvas_add_card {"spaceId":"spc_4f6abe59ad6649fba507",
        "title":"Porównanie ofert - PC-2026-01",
        "spec":{"kind":"component","component":"procurement.comparisonTable",...}}
[CUSTOM] platform.canvas_changed {"spaceId":"spc_4f6abe59ad6649fba507"}
[RESULT] {"cardId":"crd_9d11f5b5e6a04cb6bb4e","specVersion":1}
[RUN_FINISHED] 43605 ms
```

Odpowiedź modelu (fragment):

> Wygrała oferta **MediaPro Systemy** (MP-2026-0442) z kosztem **49 270 PLN** i najkrótszym
> terminem dostawy **14 dni**. Uzyskała najwyższy wynik (85 pkt)... Dwie oferty zostały wykluczone:
> Konferencje24 (niekompletna — brak systemu wideokonferencyjnego) oraz NordAV OY (waluta EUR).

Liczby zgodne co do grosza z niezależnym wyliczeniem w `tests/domain-comparison.test.ts`.
Karta trwale zapisana — `GET /api/canvas/spaces/{id}` zwraca ją po restarcie.

## B. Przetworzenie CSV w sandboxie i publikacja artefaktu

Polecenie: *„Przetworz zalaczony plik CSV..., zapisz wynik jako raport.md w output,
opublikuj jako artefakt, porownaj z najlepsza oferta."*

```
[TOOL] Read  .../run_02cda03196254e158768/input/oferta-nowa-technika-NT-2026-51.csv
[TOOL] mcp__app__procurement_compare_offers {"caseId":"pcs_2768..."}
[TOOL] Write .../run_02cda03196254e158768/output/raport.md
[TOOL] mcp__app__artifact_publish_file {"path":"output/raport.md", ...}
[CUSTOM] platform.artifact_created {"artifactId":"art_22318df363c246518ea4"}
[RESULT] {"artifactId":"art_22318df363c246518ea4","fileId":"fil_95a6a152a5fb46e3b261",
          "filename":"raport.md","byteSize":2515,
          "downloadUrl":"/api/files/fil_95a6a152a5fb46e3b261/content"}
[RUN_FINISHED] 89823 ms
# events: TEXT_MESSAGE_CONTENT=131, TOOL_CALL_START=7, TOOL_CALL_RESULT=7
```

Wyliczona suma nowej oferty: **49 410,00 PLN**.
Sprawdzenie ręczne: 2×12 750 + 3 050 + 18 100 + 16×172,50 = 25 500 + 3 050 + 18 100 + 2 760 = **49 410,00**.

Workspace uruchomienia został skasowany po zakończeniu; artefakt i plik nadal są do pobrania.

## C. Wznowienie rozmowy po restarcie backendu

Backend zatrzymany (`SIGTERM`), przebudowany i uruchomiony ponownie. Następnie:

Polecenie: *„Jaka dokladnie sume policzyles dla nowej oferty w poprzedniej wiadomosci?
Podaj sama liczbe i nie publikuj niczego ponownie."*

```
# run=run_3252bae1ea92490abcb3 conversation=cnv_e63305e013144ba7b8e1
49 410,00 PLN
[RUN_FINISHED] 7697 ms
# events: {"RUN_STARTED":1,"TEXT_MESSAGE_START":1,"TEXT_MESSAGE_CONTENT":2,
#          "TEXT_MESSAGE_END":1,"RUN_FINISHED":1}
```

**Zero wywołań narzędzi** — model odtworzył liczbę z pamięci wznowionej sesji Claude
(`resumeStream({ sessionId: '99e85532-e97b-4bd9-825f-eb102c4bf823' })`).

Stan po wznowieniu: **4 wiadomości** (2 pary), **1 artefakt**, wersja 1.
Żadna wcześniejsza mutacja nie została powtórzona.

## D. Izolacja sandboxa — odmowa sieci

Po udzieleniu zgody na `curl -s https://example.com/probe`:

```
[RESULT] Exit code 56

<sandbox_violations>
deny network-outbound example.com:443 (host is not on the allow list)
</sandbox_violations>
```

Zgoda użytkownika dotyczy uruchomienia narzędzia; sandbox nadal egzekwuje własne reguły.
