// A `fetch` for the static build: `/api/...` requests are answered by the in-browser backend.
import { handle } from "./backend.ts";

export async function localFetch(url: string, init?: RequestInit): Promise<Response> {
  const body = typeof init?.body === "string" && init.body ? (JSON.parse(init.body) as unknown) : {};
  const { status, body: answer } = await handle((init?.method ?? "GET").toUpperCase(), url, body);
  return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
}
