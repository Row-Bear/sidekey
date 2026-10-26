/** True in the static build (VITE_STATIC=1): no dev server, so a relayer pays fees and accounts come from the factory. */
export const STATIC = import.meta.env?.VITE_STATIC === "1";
