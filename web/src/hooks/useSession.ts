import { useSyncExternalStore } from 'react';
import type { ChainSession, SessionState } from '../client/session';

const noSubscribe = () => () => {};
const noState = () => null;

/** Subscribes a component to the chain session, if there is one. */
export function useSession(session: ChainSession | null): SessionState | null {
  return useSyncExternalStore<SessionState | null>(session ? session.subscribe : noSubscribe, session ? session.getState : noState);
}

/** What Testnet-mode components need: the session, its state, and nothing when in Demo mode. */
export interface ChainUi {
  session: ChainSession;
  state: SessionState;
}
