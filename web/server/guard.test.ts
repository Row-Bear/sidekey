import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkApiRequest } from "./guard.ts";

const local = { host: "localhost:5173", origin: "http://localhost:5173", "content-type": "application/json" };

describe("checkApiRequest", () => {
  it("allows a same-origin browser POST", () => {
    assert.equal(checkApiRequest("POST", { ...local, "sec-fetch-site": "same-origin" }).allowed, true);
  });

  it("allows a same-origin browser GET and 127.0.0.1", () => {
    assert.equal(checkApiRequest("GET", { host: "localhost:5173", origin: "http://localhost:5173" }).allowed, true);
    assert.equal(
      checkApiRequest("POST", { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173", "content-type": "application/json" })
        .allowed,
      true,
    );
  });

  it("allows scripts that send no Origin header", () => {
    assert.equal(checkApiRequest("POST", { host: "localhost:5173", "content-type": "application/json" }).allowed, true);
  });

  it("refuses a cross-origin page, even with a JSON content type", () => {
    const result = checkApiRequest("POST", { ...local, origin: "https://evil.example" });
    assert.equal(result.allowed, false);
    assert.equal(result.status, 403);
  });

  it("refuses a cross-origin simple request that uses text/plain", () => {
    const result = checkApiRequest("POST", { host: "localhost:5173", origin: "https://evil.example", "content-type": "text/plain" });
    assert.equal(result.allowed, false);
  });

  it("refuses a different port as a different origin", () => {
    assert.equal(checkApiRequest("POST", { ...local, origin: "http://localhost:9999" }).allowed, false);
  });

  it("refuses cross-site fetch metadata", () => {
    assert.equal(checkApiRequest("GET", { host: "localhost:5173", "sec-fetch-site": "cross-site" }).allowed, false);
    assert.equal(checkApiRequest("GET", { host: "localhost:5173", "sec-fetch-site": "same-site" }).allowed, false);
  });

  it("refuses a non-JSON POST with 415", () => {
    const result = checkApiRequest("POST", { host: "localhost:5173", "content-type": "text/plain" });
    assert.equal(result.allowed, false);
    assert.equal(result.status, 415);
    assert.equal(checkApiRequest("POST", { host: "localhost:5173" }).status, 415);
  });

  it("accepts a JSON content type with a charset", () => {
    assert.equal(checkApiRequest("POST", { host: "localhost:5173", "content-type": "application/json; charset=utf-8" }).allowed, true);
  });

  it("refuses a rebinding hostname and a missing Host", () => {
    assert.equal(checkApiRequest("GET", { host: "attacker.example:5173" }).allowed, false);
    assert.equal(checkApiRequest("GET", { host: "localhost.attacker.example" }).allowed, false);
    assert.equal(checkApiRequest("GET", {}).allowed, false);
  });
});
