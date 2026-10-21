import { createHash } from "node:crypto";

const SIGNATURE_URL = "https://stone-square-sign.onrender.com/api/reports/signature";
const PNG_HEADER = Buffer.from("89504e470d0a1a0a", "hex");
export const OWNER_SIGNATURE_ERROR = "Your saved blue signature could not be loaded. Your report entries are safe. No email was sent. Open Signature Profile in the Dashboard, then try again.";

function unavailable(status = 409) {
  return Object.assign(new Error(OWNER_SIGNATURE_ERROR), { statusCode: status, code: "REPORT_OWNER_SIGNATURE_UNAVAILABLE" });
}

// Only the verified Dashboard owner can request the approved image. Never read
// a form-supplied image, a local file or a general officer's signature profile.
export async function ownerReportSignature({ principal, assertion, fetchImpl = globalThis.fetch }) {
  if (principal?.role !== "owner") return null;
  if (typeof assertion !== "string" || !assertion) throw unavailable(401);
  let response;
  try {
    response = await fetchImpl(SIGNATURE_URL, {
      method: "POST", headers: { Authorization: "Bearer " + assertion },
      redirect: "error", signal: AbortSignal.timeout(10000), cache: "no-store",
    });
  } catch { throw unavailable(); }
  if (!response?.ok) throw unavailable([401, 403].includes(response?.status) ? response.status : 409);
  try {
    if (!/^image\/png(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) throw unavailable();
    const expectedHash = response.headers.get("x-signature-sha256") || "";
    if (!/^[a-f0-9]{64}$/i.test(expectedHash)) throw unavailable();
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > 2500000) throw unavailable();
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 8 || bytes.length > 2500000 || !bytes.subarray(0, 8).equals(PNG_HEADER)
      || createHash("sha256").update(bytes).digest("hex") !== expectedHash.toLowerCase()) throw unavailable();
    return "data:image/png;base64," + bytes.toString("base64");
  } catch { throw unavailable(); }
}
