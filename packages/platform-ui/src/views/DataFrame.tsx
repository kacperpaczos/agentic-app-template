import type { ReactNode } from 'react';
import { AppError, type DataInstanceState } from '@platform/contracts';
import { QueryErrorState } from '../components/ErrorState.tsx';

/**
 * The frame every data component renders in, whatever state it is in.
 *
 * The root carries the instance identity (`data-ui-instance`,
 * `data-component`), the read it shows (`data-operation`) and its state
 * (`data-state`): `loading`, `ready`, `empty`, `error` or `forbidden`. Four of
 * those are not data, and each says so in words — an empty table, a table that
 * failed and a table the owner may not see must never look alike, and none of
 * them may look like a table with no rows in it by accident.
 */
export type DataState = DataInstanceState;

export function DataFrame(props: {
  instanceId: string;
  component: string;
  operation: string;
  state: DataState;
  title?: string;
  as?: 'section' | 'figure';
  children: ReactNode;
}) {
  const Root = props.as ?? 'section';
  return (
    <Root
      className="pf-data"
      data-ui-instance={props.instanceId}
      data-component={props.component}
      data-operation={props.operation}
      data-state={props.state}
      aria-busy={props.state === 'loading' || undefined}
    >
      {props.title && Root === 'section' && <h2 className="pf-data__title">{props.title}</h2>}
      {props.children}
    </Root>
  );
}

export function LoadingBody() {
  return (
    <div className="pf-state" role="status">
      Wczytywanie danych…
    </div>
  );
}

export function EmptyBody({ total, matched }: { total: number; matched: number }) {
  return (
    <div className="pf-state pf-state--empty" role="status" data-testid="data-empty">
      {total === 0
        ? 'Brak rekordow.'
        : `Zaden rekord nie spelnia zawezenia — pokazane ${matched} z ${total}.`}
    </div>
  );
}

/** Whether a failure means "not yours to see" rather than "something broke". */
export const isAccessFailure = (error: unknown): boolean =>
  error instanceof AppError &&
  (error.code === 'forbidden' || error.code === 'not_found' || error.code === 'unauthenticated');

export function FailureBody({ error }: { error: unknown }) {
  return <QueryErrorState error={error} what="danych" />;
}
