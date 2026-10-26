// The Stellar SDK and the core use Node's Buffer, which browsers do not have.
import { Buffer } from "buffer";

const scope = globalThis as { Buffer?: typeof Buffer };
scope.Buffer ??= Buffer;
