import { useEffect } from 'react';
import { useCollabStore } from '../../store/useCollabStore';
import { useModelStore } from '../../store/useModelStore';

/** Keeps one live-collaboration socket open for the model in view and accepts ?invite= links. */
export function useCollabConnection() {
  const authToken = useModelStore((s) => s.authToken);
  const roomId = useModelStore((s) => s.activeRemoteModel?.id ?? 'workspace');
  const connect = useCollabStore((s) => s.connect);
  const disconnect = useCollabStore((s) => s.disconnect);

  useEffect(() => {
    if (!authToken) {
      disconnect();
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const invite = params.get('invite');
    const start = () => connect(roomId);
    if (invite) {
      params.delete('invite');
      const q = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${q ? `?${q}` : ''}`);
      useCollabStore
        .getState()
        .acceptInvite(invite)
        .then((msg) => useModelStore.setState({ statusBanner: { type: 'success', message: msg } }))
        .catch((e: Error) => useModelStore.setState({ statusBanner: { type: 'error', message: e.message } }))
        .finally(() => {
          disconnect();
          start();
        });
    } else {
      start();
    }
  }, [authToken, roomId, connect, disconnect]);

  useEffect(() => () => useCollabStore.getState().disconnect(), []);
}
