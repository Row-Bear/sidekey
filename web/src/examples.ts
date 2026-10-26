/** A one-click call for the call builder: a function and its arguments, as typed in the form. */
export interface Example {
  label: string;
  fn: string;
  args: string[];
}

export interface ExampleContext {
  simulator: string;
  nativeToken: string;
  /** The active smart account. */
  account: string;
  /** The master's address. */
  master: string;
}

const ONE_XLM = "10000000";

/** Examples that make sense for the selected contract; contracts without any get none. */
export function examplesFor(contract: string, context: ExampleContext): Example[] {
  const id = contract.trim();
  const { account, master } = context;
  if (id === "" || account === "") return [];
  if (id === context.simulator) {
    return [
      { label: "claim(this account)", fn: "claim", args: [account] },
      { label: "withdraw(this account, 1 XLM)", fn: "withdraw", args: [account, ONE_XLM] },
    ];
  }
  if (id === context.nativeToken) {
    const examples: Example[] = [{ label: "balance(this account)", fn: "balance", args: [account] }];
    // Sends XLM from the smart account back to the master, e.g. to run the demo again from a wallet.
    if (master !== "") examples.push({ label: "send 1 XLM to the master", fn: "transfer", args: [account, master, ONE_XLM] });
    return examples;
  }
  return [];
}
