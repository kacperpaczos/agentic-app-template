import { useEffect, useRef } from 'react';
import { useSessionLocation } from '../state/sessionLocation.ts';
import { registerAccessContextReset } from '../state/accessReset.ts';

/**
 * Renders nothing; makes an identity switch drop the session ids the address
 * bar carries.
 *
 * A component because the address bar is only reachable through the router's
 * hooks, and the rule itself lives in `state/accessReset.ts` where it can be
 * tested without a browser. The client store is cleared elsewhere, by the store
 * itself — see `state/accessReset.ts`. Mounted *after* `UiSnapshotPublisher` in
 * the shell; the note there says why the order of the listeners is not
 * arbitrary.
 */
export function AccessContextReset() {
  const { setConversation, setSpace } = useSessionLocation();
  /*
   * The subscription is made once, for the life of the shell, so it cannot be
   * torn down and re-made on every navigation (which would silently reorder it
   * after the description source's). The current navigators are read through a
   * ref instead of closed over.
   */
  const navigate = useRef({ setConversation, setSpace });
  navigate.current = { setConversation, setSpace };

  useEffect(
    () =>
      registerAccessContextReset({
        clearSessionLocation: () => {
          navigate.current.setConversation(null, { replace: true });
          navigate.current.setSpace(null);
        },
      }),
    [],
  );

  return null;
}
