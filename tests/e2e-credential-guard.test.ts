import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkCredentialFingerprint,
  credentialFile,
  fingerprintCredential,
  saveCredentialFingerprint,
} from '../e2e/credential-guard.ts';

/**
 * Czysta część bezpiecznika odcisku dla **przebiegów e2e**
 * (`e2e/credential-guard.ts` + `globalSetup`/`globalTeardown`).
 *
 * Kontekst: vitestowy bezpiecznik (`tests/setup-credential-guard.ts`) przez
 * miesiąc był jedynym — Playwright nie miał odpowiednika, więc reguła G21 dla
 * e2e była zależna od pamięci wykonawcy. Runda 7 dokłada ten sam mechanizm;
 * ponieważ `globalSetup`, workery i `globalTeardown` to trzy procesy, odcisk
 * (rozmiar:czas modyfikacji) przenoszony jest **plikiem** w gitignorowanym
 * `test-results/` — rozstrzygnięcie zamrożone poniżej (round-trip, honorowanie
 * `CLAUDE_CONFIG_DIR`, wykrycie zmiany rozmiaru **albo** mtime, głośny błąd przy
 * braku zapisanego odcisku).
 *
 * Zawsze na atrapach w katalogach tymczasowych — prawdziwe logowanie nie bierze
 * udziału (G21). Część procesowa (żeby `globalTeardown` naprawdę oblał zapis w
 * trakcie przebiegu) jest próbą zdolności wykrycia opisaną w dzienniku dowodów.
 */

describe('bezpiecznik odcisku poswiadczenia dla e2e', () => {
  it('odcisk honoruje CLAUDE_CONFIG_DIR i rozróżnia brak pliku', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atrapa-config-'));
    const realDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      expect(credentialFile()).toBe(join(dir, '.credentials.json'));
      expect(fingerprintCredential()).toBe('brak');
      writeFileSync(join(dir, '.credentials.json'), 'ATRAPA');
      expect(fingerprintCredential()).toMatch(/^\d+:\d+(\.\d+)?$/);
    } finally {
      if (realDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = realDir;
    }
  });

  it('round-trip przez plik przenosi odcisk; zmiana (nawet samego mtime) jest wykrywana', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atrapa-zapis-'));
    const transferDir = mkdtempSync(join(tmpdir(), 'odcisk-e2e-'));
    const realDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      writeFileSync(join(dir, '.credentials.json'), 'ATRAPA-v1');
      saveCredentialFingerprint(transferDir);

      const zapisany = JSON.parse(
        readFileSync(join(transferDir, 'credential-fingerprint.json'), 'utf8'),
      ) as { plik: string; odcisk: string };
      expect(zapisany.plik).toBe(join(dir, '.credentials.json'));
      expect(zapisany.odcisk).toBe(fingerprintCredential());

      /* Ta sama treść, nowy mtime — odcisk MUSI się zmienić: zapis identycznej
         treści to nadal zapis (lekcja rundy 3; G21 bez wyjątku). */
      const st = statSync(join(dir, '.credentials.json'));
      utimesSync(join(dir, '.credentials.json'), st.atime, new Date(st.mtimeMs + 5000));
      expect(fingerprintCredential()).not.toBe(zapisany.odcisk);

      /* I teardown to wychwyci: porównanie zapisanego odcisku z bieżącym. */
      expect(() => checkCredentialFingerprint(transferDir)).toThrow(/ZMIENIL SIE w trakcie/);
    } finally {
      if (realDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = realDir;
      rmSync(dir, { recursive: true, force: true });
      rmSync(transferDir, { recursive: true, force: true });
    }
  });

  it('brak zapisanego odcisku jest głośnym błędem, nie cichym przejściem', () => {
    const transferDir = mkdtempSync(join(tmpdir(), 'odcisk-e2e-'));
    expect(() => checkCredentialFingerprint(transferDir)).toThrow(/brak zapisanego odcisku/);
    rmSync(transferDir, { recursive: true, force: true });
  });
});
