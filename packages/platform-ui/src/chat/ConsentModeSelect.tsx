import { createPortal } from 'react-dom';
import type { ConsentMode } from '@platform/contracts';
import { useAppState } from '../state/appState.ts';
import { useComposerHost } from './composerHost.ts';

/**
 * Choosing the consent mode of the next command, inside the ready-made composer.
 *
 * Three modes, the backend's own contract values (`ConsentMode`): `manual` asks
 * before every agent action, `supervised` is the behaviour the platform always
 * had — the application's tools run, everything else asks at the gate — and
 * `auto` lets the gate approve single actions itself, forbidden tools still
 * forbidden. The choice belongs to the *next* execution: a run already going
 * keeps the mode its record was started with, and there is no switch for it —
 * which is why the control reads and writes only the client-side field.
 *
 * **Where it lives.** The same portal trick as the paperclip
 * (`ComposerAttachments`, shared `useComposerHost`): a host prepended into the
 * composer's own action bar, the control portalled into it. Rendered in place,
 * it would become a panel beside the thread; inside the library's markup it
 * becomes what it is — one more control in the row the composer already
 * reserves for them, next to the attachments slot, with send staying right.
 *
 * Deliberately no persistence: the mode of a *finished* command lives in its
 * run record, in the database; this selection is transient state about a
 * command that does not exist yet.
 */

/** The three choices, in the order shown, with the behaviour under the cursor. */
const MODES: Array<{ value: ConsentMode; label: string; hint: string }> = [
  {
    value: 'manual',
    label: 'Ręczny',
    hint: 'Ręczny — agent pyta o zgodę przed każdą akcją.',
  },
  {
    value: 'supervised',
    label: 'Nadzorowany',
    hint: 'Nadzorowany — narzędzia aplikacji działają od razu, pozostałe akcje wymagają zgody.',
  },
  {
    value: 'auto',
    label: 'Pełna automatyzacja',
    hint: 'Pełna automatyzacja — agent nie pyta o pojedyncze akcje; narzędzia zabronione pozostają zablokowane.',
  },
];

export function ConsentModeSelect() {
  const consentMode = useAppState((s) => s.consentMode);
  const setConsentMode = useAppState((s) => s.setConsentMode);
  const host = useComposerHost('.openui-agent-thread-composer__action-bar', 'pf-consent-host');

  /* The description the cursor shows is the chosen mode's, not a static one. */
  const current = MODES.find((m) => m.value === consentMode) ?? MODES[1]!;

  const control = (
    <div className="pf-consent">
      <select
        className="pf-consent__select"
        data-testid="consent-mode-select"
        aria-label="Tryb zgody następnego polecenia"
        title={current.hint}
        value={consentMode}
        onChange={(e) => setConsentMode(e.target.value as ConsentMode)}
      >
        {MODES.map((m) => (
          <option key={m.value} value={m.value} title={m.hint}>
            {m.label}
          </option>
        ))}
      </select>
    </div>
  );

  return host ? createPortal(control, host) : null;
}
