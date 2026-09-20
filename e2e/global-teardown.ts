import { checkCredentialFingerprint } from './credential-guard.ts';

/**
 * Ostatnie słowo przebiegu e2e: czy logowanie użytkownika wyszło nietknięte.
 *
 * Kontrakt jest ten sam co w `tests/setup-credential-guard.ts` (regresja
 * vitest), tylko rozbity na dwa procesy: `globalSetup` zapisuje odcisk
 * (rozmiar:czas modyfikacji) pliku poświadczenia, ten hook porównuje go po
 * wszystkich testach. Różnica = naruszenie G21 przez ten przebieg, z głośnym
 * wskazaniem, że sprawcą był **przebieg e2e**.
 *
 * Przeniesienie odcisku plikiem (a nie środowiskiem) jest rozstrzygnięciem
 * opisanym w `e2e/credential-guard.ts` i zamrożonym testem w
 * `tests/credential-guard.test.ts`.
 */
export default async function globalTeardown(): Promise<void> {
  checkCredentialFingerprint();
  console.log('[e2e] poswiadczenie uzytkownika nietkniete (odcisk zgodny z globalSetup)');
}
