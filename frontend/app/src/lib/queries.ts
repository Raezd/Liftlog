import { useQuery } from "@tanstack/react-query";
import { get } from "./api";
import type { Me, Muscle } from "./types";

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: () => get<Me>("/api/me") });

export const useMuscles = () =>
  useQuery({ queryKey: ["muscles"], queryFn: () => get<Muscle[]>("/api/muscles"), staleTime: Infinity });

/** id -> label, for showing muscle lists. */
export function useMuscleLabels(): (id: string) => string {
  const { data } = useMuscles();
  const map = new Map(data?.map((m) => [m.id, m.label]));
  return (id) => map.get(id) ?? id;
}
