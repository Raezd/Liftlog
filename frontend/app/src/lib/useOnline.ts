import { useSyncExternalStore } from "react";

const subscribe = (fn: () => void) => {
  window.addEventListener("online", fn);
  window.addEventListener("offline", fn);
  return () => {
    window.removeEventListener("online", fn);
    window.removeEventListener("offline", fn);
  };
};

/** False when the device says it has no network (airplane mode). Edits that
 *  need the server are disabled then; a server that can't be reached
 *  otherwise still shows its plain error when the save fails. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
}
