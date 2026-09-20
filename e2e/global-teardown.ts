import { readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkCredentialFingerprint } from './credential-guard.ts';
import { directoryInUse } from './support/port-probe.ts';

/**
 * Ostatnie słowo przebiegu e2e: czy logowanie użytkownika wyszło nietknięte,
 * a potem — i tylko wtedy — porządki po katalogach instancji testowych.
 *
 * Kontrakt odcisku jest ten sam co w `tests/setup-credential-guard.ts`
 * (regresja vitest), tylko rozbity na dwa procesy: `globalSetup` zapisuje
 * odcisk (rozmiar:czas modyfikacji) pliku poświadczenia, ten hook porównuje go
 * po wszystkich testach. Różnica = naruszenie G21 przez ten przebieg, z głośnym
 * wskazaniem, że sprawcą był **przebieg e2e**.
 *
 * Przeniesienie odcisku plikiem (a nie środowiskiem) jest rozstrzygnięciem
 * opisanym w `e2e/credential-guard.ts` i zamrożonym testem w
 * `tests/credential-guard.test.ts`.
 *
 * **Porządki (ETAP 2, dziura 5).** Katalogi `.e2e*` nagromadziły się w
 * repozytorium, bo nic ich nie usuwało — a to śmieć, którego warunek odbioru
 * wprost zabrania („`pnpm verify` = 0 **i** repozytorium bez śmieci"). Usuwanie
 * dzieje się dopiero PO pomyślnym porównaniu odcisku: przy niezgodności
 * katalogi zostają nietknięte jako dowód naruszenia. Katalog zostaje też wtedy,
 * gdy trzyma go żywy proces (nigdy nie kasujemy spod procesu — ta sama reguła
 * co w `port-probe.ts`), albo gdy pytania nie da się zadać: porządki są
 * porządkiem, nie okazją do kasowania na ślepo. Pliki i dowiązania nie są
 * tu w ogóle brane pod uwagę — tylko katalogi o nazwie `.e2e*` w korzeniu
 * repozytorium.
 */
export interface TeardownOptions {
  /** Katalog z zapisanym odciskiem (domyślnie `test-results/`). */
  transferDir?: string;
  /** Korzeń repozytorium, z którego zbierane są katalogi `.e2e*`. */
  repoRoot?: string;
}

/** Usuwa `.e2e*` katalogi bez żywych procesów; resztę zostawia z powodem. */
export function usunKatalogiInstancjiTestowych(repoRoot: string): {
  usuniete: string[];
  zostawione: { katalog: string; powod: string }[];
} {
  const usuniete: string[] = [];
  const zostawione: { katalog: string; powod: string }[] = [];
  let wpisy;
  try {
    wpisy = readdirSync(repoRoot, { withFileTypes: true });
  } catch {
    return { usuniete, zostawione };
  }
  for (const wpis of wpisy) {
    if (wpis.isSymbolicLink() || !wpis.isDirectory()) continue;
    if (!wpis.name.startsWith('.e2e')) continue;
    const katalog = resolve(repoRoot, wpis.name);
    const odpowiedz = directoryInUse(katalog);
    if (odpowiedz === false) {
      rmSync(katalog, { recursive: true, force: true });
      usuniete.push(katalog);
    } else {
      zostawione.push({
        katalog,
        powod:
          odpowiedz === true
            ? 'katalog jest otwarty przez dzialajacy proces — nie kasujemy spod procesu'
            : 'nie da sie ustalic, czy katalog jest otwarty (brak /proc) — odmowa zamiast strzalu',
      });
    }
  }
  return { usuniete, zostawione };
}

export default async function globalTeardown(opcje: TeardownOptions = {}): Promise<void> {
  checkCredentialFingerprint(opcje.transferDir);
  console.log('[e2e] poswiadczenie uzytkownika nietkniete (odcisk zgodny z globalSetup)');

  const repoRoot = resolve(opcje.repoRoot ?? resolve(import.meta.dirname, '..'));
  const { usuniete, zostawione } = usunKatalogiInstancjiTestowych(repoRoot);
  for (const katalog of usuniete) {
    console.log(`[e2e] porzadki: usunieto katalog instancji testowej ${katalog}`);
  }
  for (const { katalog, powod } of zostawione) {
    console.log(`[e2e] porzadki: zostawiam ${katalog} (${powod})`);
  }
}
