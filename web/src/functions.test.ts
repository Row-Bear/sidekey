import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ArgInfo, FunctionInfo } from "@poc/core";
import { defaultFunction, describeSignature, groupFunctions, looksAdministrative, looksReadOnly, matchesQuery } from "./functions.ts";

const arg = (name: string, type = "Address", optional = false): ArgInfo => ({ name, type, kind: "address", optional });
const fn = (name: string, args: ArgInfo[] = [], doc = ""): FunctionInfo => ({ name, doc, args });

describe("looksReadOnly", () => {
  it("recognises the usual getters", () => {
    for (const name of ["get_config", "is_active", "has_role", "list_signers", "total_deposits", "balance", "allowance", "decimals", "name", "symbol", "authorized", "admin", "version", "master", "accrued_yield", "pool_data", "reward_zone", "backstop_token", "bad_debt"]) {
      assert.equal(looksReadOnly(name), true, name);
    }
    for (const name of ["user_balance", "payout_asset_balance", "blnt_price", "extra_list"]) assert.equal(looksReadOnly(name), true, name);
  });

  it("treats everything that changes something, and the admin handover, as an action", () => {
    for (const name of ["claim", "deposit", "withdraw", "transfer", "approve", "mint", "burn", "set_admin", "propose_admin", "accept_admin", "submit", "gulp", "update_pool", "force_withdrawal", "clawback", "set_reserve"]) {
      assert.equal(looksReadOnly(name), false, name);
    }
  });

  it("matches whole names or real prefixes and suffixes, not stray substrings", () => {
    assert.equal(looksReadOnly("rebalance"), false);
    assert.equal(looksReadOnly("balance_of_everything"), false);
    assert.equal(looksReadOnly("budget"), false);
    assert.equal(looksReadOnly("namespace"), false);
    assert.equal(looksReadOnly("target_list_update"), false);
  });
});

describe("groupFunctions", () => {
  const list = [fn("accrued_yield"), fn("claim"), fn("balance"), fn("deposit"), fn("withdraw")];

  it("splits into actions and reads, keeping the original order", () => {
    const { actions, reads } = groupFunctions(list);
    assert.deepEqual(actions.map((f) => f.name), ["claim", "deposit", "withdraw"]);
    assert.deepEqual(reads.map((f) => f.name), ["accrued_yield", "balance"]);
  });

  it("puts allowed functions first inside each group", () => {
    const { actions, reads } = groupFunctions(list, new Set(["withdraw", "balance"]));
    assert.deepEqual(actions.map((f) => f.name), ["withdraw", "claim", "deposit"]);
    assert.deepEqual(reads.map((f) => f.name), ["balance", "accrued_yield"]);
  });

  it("copes with an empty list and does not change its input", () => {
    assert.deepEqual(groupFunctions([]), { actions: [], reads: [] });
    const input = [fn("balance"), fn("claim")];
    groupFunctions(input, new Set(["claim"]));
    assert.deepEqual(input.map((f) => f.name), ["balance", "claim"]);
  });
});

describe("defaultFunction", () => {
  it("starts on the first action", () => {
    assert.equal(defaultFunction([fn("accrued_yield"), fn("balance"), fn("claim"), fn("deposit")]), "claim");
  });

  it("skips administrative functions when anything else is available", () => {
    // The Blent pool's real list starts with accept_admin.
    assert.equal(defaultFunction([fn("accept_admin"), fn("bad_debt"), fn("cancel_set_reserve"), fn("claim"), fn("submit")]), "claim");
    assert.equal(defaultFunction([fn("get_admin"), fn("set_status"), fn("update_pool"), fn("mint"), fn("deposit")]), "deposit");
  });

  it("uses an administrative function only when there is nothing else, and the first read when there are no actions", () => {
    assert.equal(defaultFunction([fn("get_x"), fn("set_status"), fn("update_pool")]), "set_status");
    assert.equal(defaultFunction([fn("accept_admin")]), "accept_admin");
  });

  it("falls back to the first function when there are only reads, and to nothing for an empty list", () => {
    assert.equal(defaultFunction([fn("get_a"), fn("get_b")]), "get_a");
    assert.equal(defaultFunction([]), "");
  });
});

describe("describeSignature", () => {
  it("lists argument names and types, marking optional ones", () => {
    assert.equal(describeSignature(fn("deposit", [arg("user"), arg("amount", "i128")])), "deposit(user: Address, amount: i128)");
    assert.equal(describeSignature(fn("ping")), "ping()");
    assert.equal(describeSignature(fn("set", [arg("limit", "u32", true)])), "set(limit: u32?)");
  });
});

describe("matchesQuery", () => {
  const transfer = fn("transfer", [arg("from"), arg("to"), arg("amount", "i128")], "Move tokens between accounts");

  it("matches everything for an empty search", () => {
    assert.equal(matchesQuery(transfer, ""), true);
    assert.equal(matchesQuery(transfer, "   "), true);
  });

  it("matches on the name, an argument name or type, or the description, ignoring case", () => {
    assert.equal(matchesQuery(transfer, "TRANS"), true);
    assert.equal(matchesQuery(transfer, "amount"), true);
    assert.equal(matchesQuery(transfer, "i128"), true);
    assert.equal(matchesQuery(transfer, "between accounts"), true);
    assert.equal(matchesQuery(transfer, " from "), true);
    // The text itself has capitals too (the type is `Address`, the description starts with one).
    assert.equal(matchesQuery(transfer, "address"), true);
    assert.equal(matchesQuery(transfer, "move"), true);
  });

  it("does not match unrelated text", () => {
    assert.equal(matchesQuery(transfer, "claim"), false);
    assert.equal(matchesQuery(fn("claim", [], ""), "move"), false);
  });
});

describe("looksAdministrative", () => {
  it("flags settings, ownership and minting", () => {
    for (const name of ["set_admin", "set_status", "update_pool", "propose_admin", "accept_admin", "force_withdrawal", "queue_set_reserve", "cancel_set_reserve", "clawback", "mint", "upgrade"]) {
      assert.equal(looksAdministrative(name), true, name);
    }
  });

  it("leaves everyday actions and reads alone", () => {
    for (const name of ["claim", "deposit", "withdraw", "transfer", "submit", "gulp", "burn", "approve", "get_admin", "settle", "mints", "reset_x"]) {
      assert.equal(looksAdministrative(name), false, name);
    }
  });
});
