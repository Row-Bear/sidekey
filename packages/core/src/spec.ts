import { contract, Networks, StrKey, xdr } from "@stellar/stellar-sdk";

// Reading a contract's interface from the chain and turning typed form input into ScVals.
// Everything except `loadSpec` is pure, so it can be tested against saved specs.

type SpecType = xdr.ScSpecTypeDef;

export type ArgKind = "address" | "integer" | "bool" | "symbol" | "string" | "bytes" | "json";

export interface ArgInfo {
  name: string;
  /** Readable type, e.g. `Address`, `i128`, `Option<u32>`. */
  type: string;
  kind: ArgKind;
  /** True for `Option<T>`: leaving the input empty means "none". */
  optional: boolean;
}

export interface FunctionInfo {
  name: string;
  doc: string;
  args: ArgInfo[];
}

const SPEC_CACHE_MS = 5 * 60 * 1000;
const specCache = new Map<string, { spec: contract.Spec; at: number }>();

/** Fetches the spec from the contract's WASM (or the built-in Stellar Asset Contract interface). */
export async function loadSpec(rpcUrl: string, contractId: string): Promise<contract.Spec> {
  if (!StrKey.isValidContract(contractId)) throw new Error(`"${contractId}" is not a valid contract id (C…)`);
  const cached = specCache.get(contractId);
  if (cached && Date.now() - cached.at < SPEC_CACHE_MS) return cached.spec;

  const client = await contract.Client.from({ contractId, rpcUrl, networkPassphrase: Networks.TESTNET });
  specCache.set(contractId, { spec: client.spec, at: Date.now() });
  return client.spec;
}

export function typeLabel(ty: SpecType): string {
  switch (ty.type) {
    case "scSpecTypeOption":
      return `Option<${typeLabel(ty.option.valueType)}>`;
    case "scSpecTypeVec":
      return `Vec<${typeLabel(ty.vec.elementType)}>`;
    case "scSpecTypeMap":
      return `Map<${typeLabel(ty.map.keyType)}, ${typeLabel(ty.map.valueType)}>`;
    case "scSpecTypeTuple":
      return `(${ty.tuple.valueTypes.map(typeLabel).join(", ")})`;
    case "scSpecTypeBytesN":
      return `BytesN<${ty.bytesN.n}>`;
    case "scSpecTypeUdt":
      return ty.udt.name.toString();
    default: {
      const name = ty.type.replace("scSpecType", "");
      return /^[UI]\d+$/.test(name) ? name.toLowerCase() : name;
    }
  }
}

export function argKind(ty: SpecType): ArgKind {
  switch (ty.type) {
    case "scSpecTypeAddress":
    case "scSpecTypeMuxedAddress":
      return "address";
    case "scSpecTypeU32":
    case "scSpecTypeI32":
    case "scSpecTypeU64":
    case "scSpecTypeI64":
    case "scSpecTypeU128":
    case "scSpecTypeI128":
    case "scSpecTypeU256":
    case "scSpecTypeI256":
    case "scSpecTypeTimepoint":
    case "scSpecTypeDuration":
      return "integer";
    case "scSpecTypeBool":
      return "bool";
    case "scSpecTypeSymbol":
      return "symbol";
    case "scSpecTypeString":
      return "string";
    case "scSpecTypeBytes":
    case "scSpecTypeBytesN":
      return "bytes";
    case "scSpecTypeOption":
      return argKind(ty.option.valueType);
    default:
      return "json";
  }
}

/** The callable functions of a contract, without the `__constructor` and `__check_auth` hooks. */
export function describeFunctions(spec: contract.Spec): FunctionInfo[] {
  return spec
    .funcs()
    .map((fn) => ({
      name: fn.name.toString(),
      doc: fn.doc.toString(),
      args: fn.inputs.map((input) => ({
        name: input.name.toString(),
        type: typeLabel(input.type),
        kind: argKind(input.type),
        optional: input.type.type === "scSpecTypeOption",
      })),
    }))
    .filter((fn) => !fn.name.startsWith("__"))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const INTEGER = /^-?\d+$/;
const HEX = /^(0x)?([0-9a-fA-F]{2})*$/;

/** Parses one form field into the JS value the SDK expects for `ty`. Throws with a readable message. */
export function toNative(text: string, ty: SpecType): unknown {
  if (ty.type === "scSpecTypeOption") {
    return text.trim() === "" ? null : toNative(text, ty.option.valueType);
  }
  const trimmed = text.trim();
  switch (argKind(ty)) {
    case "address":
    case "symbol":
      if (trimmed === "") throw new Error("a value is required");
      return trimmed;
    case "string":
      return text;
    case "integer": {
      if (!INTEGER.test(trimmed)) throw new Error("expected a whole number");
      const value = BigInt(trimmed);
      if (ty.type.startsWith("scSpecTypeU") && value < 0n) throw new Error("must not be negative");
      return ty.type === "scSpecTypeU32" || ty.type === "scSpecTypeI32" ? Number(value) : value;
    }
    case "bool":
      if (trimmed !== "true" && trimmed !== "false") throw new Error('expected "true" or "false"');
      return trimmed === "true";
    case "bytes": {
      if (!HEX.test(trimmed)) throw new Error("expected hex bytes");
      return Buffer.from(trimmed.replace(/^0x/, ""), "hex");
    }
    case "json":
      try {
        return JSON.parse(trimmed);
      } catch {
        throw new Error("expected JSON");
      }
  }
}

/** Encodes the typed form inputs for `functionName`, one text input per argument. */
export function encodeArgs(spec: contract.Spec, functionName: string, inputs: string[]): xdr.ScVal[] {
  const fn = spec.getFunc(functionName);
  if (inputs.length !== fn.inputs.length) {
    throw new Error(`${functionName} takes ${fn.inputs.length} argument(s), got ${inputs.length}`);
  }
  return fn.inputs.map((input, i) => encodeArg(spec, input.name.toString(), input.type, inputs[i]));
}

export function encodeArg(spec: contract.Spec, name: string, ty: SpecType, text: string): xdr.ScVal {
  try {
    return spec.nativeToScVal(toNative(text, ty), ty);
  } catch (err) {
    throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
