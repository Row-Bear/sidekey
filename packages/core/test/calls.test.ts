import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contractErrorSource } from "../src/calls.ts";

// Real simulator logs: a failed `withdraw` inside the yield simulator...
const simulatorFailure = `HostError: Error(Contract, #2)

Event log (newest first):
   0: [Diagnostic Event] contract:CDGOE4WK2MAL2U2VFIFPVGIAWNZU5A2KJ5FJTJ7GMXVNS2GGWK4N33DL, topics:[error, Error(Contract, #2)], data:"escalating error to VM trap from failed host function call: fail_with_error"
   1: [Diagnostic Event] contract:CDGOE4WK2MAL2U2VFIFPVGIAWNZU5A2KJ5FJTJ7GMXVNS2GGWK4N33DL, topics:[error, Error(Contract, #2)], data:["failing with contract error", 2]`;

// ...and a policy rejection, whose log mentions the simulator AND an Error(Contract, #3) that is the account's.
const accountRejection = `HostError: Error(Auth, InvalidAction)

Event log (newest first):
   0: [Diagnostic Event] contract:CDGOE4WK2MAL2U2VFIFPVGIAWNZU5A2KJ5FJTJ7GMXVNS2GGWK4N33DL, topics:[error, Error(Auth, InvalidAction)], data:"escalating error to VM trap from failed host function call: require_auth"
   1: [Diagnostic Event] contract:CDGOE4WK2MAL2U2VFIFPVGIAWNZU5A2KJ5FJTJ7GMXVNS2GGWK4N33DL, topics:[error, Error(Auth, InvalidAction)], data:["failed account authentication with error", CBG63ZR72B7FF7FLRDH6EGRNZ5YPNL7I4OX6CUOOCTSWHLETB5WQCRQX, Error(Contract, #3)]
   2: [Failed Diagnostic Event (not emitted)] contract:CBG63ZR72B7FF7FLRDH6EGRNZ5YPNL7I4OX6CUOOCTSWHLETB5WQCRQX, topics:[error, Error(Contract, #3)], data:"escalating Ok(ScErrorType::Contract) frame-exit to Err"`;

describe("contractErrorSource", () => {
  it("finds the contract that raised its own error", () => {
    assert.deepEqual(contractErrorSource(simulatorFailure), {
      contractId: "CDGOE4WK2MAL2U2VFIFPVGIAWNZU5A2KJ5FJTJ7GMXVNS2GGWK4N33DL",
      code: 2,
    });
  });

  it("attributes the smart account's rejection to the smart account, not the simulator", () => {
    // The simulator's id appears on the same line as the account's Error(Contract, #3); only the
    // account's own error event counts.
    assert.deepEqual(contractErrorSource(accountRejection), {
      contractId: "CBG63ZR72B7FF7FLRDH6EGRNZ5YPNL7I4OX6CUOOCTSWHLETB5WQCRQX",
      code: 3,
    });
  });

  it("returns null when there is no contract error", () => {
    assert.equal(contractErrorSource("HostError: Error(Auth, InvalidAction)"), null);
  });
});
