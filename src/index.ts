declare module "@hyperttp/types" {
  interface HyperClientOptions {
    /** Prefer HTTP/2 transport selection for REST and gRPC without modifying global fetch. */
    http2?: boolean;
  }
}

export { UndiciTransport } from "./undici.js";
