import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, send } from "./api";
import { cached, refresh } from "./offline";
import type { Body, Me, Muscle } from "./types";

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: cached(() => get<Me>("/api/me"), (c) => c.me) });

export const useMuscles = () =>
  useQuery({ queryKey: ["muscles"], queryFn: () => get<Muscle[]>("/api/muscles"), staleTime: Infinity });

/** id -> label, for showing muscle lists. */
export function useMuscleLabels(): (id: string) => string {
  const { data } = useMuscles();
  const map = new Map(data?.map((m) => [m.id, m.label]));
  return (id) => map.get(id) ?? id;
}

/** Sites and check-ins: the server when it answers, else the phone's copy. */
export const useBody = () => useQuery({ queryKey: ["body"], queryFn: cached(() => get<Body>("/api/body"), (c) => c.body) });

/** Every body change answers with the whole body doc. Keeps the pages and the phone's copy current. */
export function useBodyChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ method, path, body }: { method: string; path: string; body?: unknown }) => send<Body>(method, `/api/body${path}`, body),
    onSuccess: (b) => {
      qc.setQueryData(["body"], b);
      void refresh(true);
    },
  });
}
