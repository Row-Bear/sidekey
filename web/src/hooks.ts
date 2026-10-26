import { useEffect, useRef, useState } from "react";
import type { FunctionInfo } from "@poc/core";
import { fetchFunctions, fetchSigners, looksLikeContractId, type SignersResponse } from "./api";

/** The account's signers and the demo's addresses; reloads when `version` changes. */
export function useSigners(version: number, demo = true) {
  const [data, setData] = useState<SignersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSigners(demo)
      .then((result) => !cancelled && (setData(result), setError(null)))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [version, demo]);

  return { data, error };
}

/** Loads a contract's callable functions once the id looks valid (debounced while typing). */
export function useContractFunctions(contractId: string) {
  const [functions, setFunctions] = useState<FunctionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = contractId.trim();
    if (!looksLikeContractId(id)) {
      setFunctions([]);
      setError(id === "" ? null : "Enter a contract id (C…, 56 characters)");
      return;
    }
    let cancelled = false;
    setLoading(true);
    // The previous contract's functions must not linger while the new ones load: a form would build its fields from them.
    setFunctions([]);
    const timer = setTimeout(() => {
      fetchFunctions(id)
        .then((result) => !cancelled && (setFunctions(result), setError(null)))
        .catch((err) => !cancelled && (setFunctions([]), setError(err instanceof Error ? err.message : String(err))))
        .finally(() => !cancelled && setLoading(false));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [contractId]);

  return { functions, loading, error };
}

/** Returns `value` after it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      setDebounced(value);
      return;
    }
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
