export {
  CanonicalRequestError,
  HMAC_HEADERS,
  HMAC_PROTOCOL_VERSION,
  canonicalString,
  createNonce,
  hashBody,
  headerValues,
  sign,
  signaturesMatch,
  splitUrl,
  timestampFresh,
  verify,
} from "./hmac.js";
export type { SignatureMaterial } from "./hmac.js";
