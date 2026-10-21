import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ownerReportSignature, OWNER_SIGNATURE_ERROR } from "../portal-maintenance/api/_report-owner-signature.js";

// A one-pixel synthetic fixture. No saved Lodge signature or live endpoint is used.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYuQAAAAASUVORK5CYII=", "base64");
const hash = createHash("sha256").update(png).digest("hex");
const principal = { role: "owner" };
const input = { principal, assertion: "synthetic-assertion" };
const reply = ({ bytes = png, expectedHash = hash, contentType = "image/png", contentLength = String(png.length), status = 200 } = {}) => ({
  ok: status === 200, status,
  headers: new Headers({ "content-type": contentType, "content-length": contentLength, "x-signature-sha256": expectedHash }),
  arrayBuffer: async () => bytes,
});

test("only the owner fetches the approved PNG using the fixed Dashboard route", async () => {
  const calls = [];
  const signature = await ownerReportSignature({ ...input, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return reply();
  } });
  assert.equal(signature, "data:image/png;base64," + png.toString("base64"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://stone-square-sign.onrender.com/api/reports/signature");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer synthetic-assertion");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.cache, "no-store");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.body, undefined);
  for (const value of [null, { role: "secretary" }, { role: "warden" }, { role: "member" }]) {
    assert.equal(await ownerReportSignature({ principal: value, fetchImpl: () => { throw Error("Must not fetch"); } }), null);
  }
});

test("invalid or unavailable signatures never fall back to a typed owner signature", async () => {
  for (const response of [
    reply({ expectedHash: "0".repeat(64) }), reply({ expectedHash: "" }), reply({ contentType: "text/html" }),
    reply({ bytes: Buffer.from("not a PNG") }), reply({ contentLength: "2500001" }),
    reply({ bytes: Buffer.alloc(2500001) }), reply({ status: 409 }), reply({ status: 503 }),
  ]) await assert.rejects(ownerReportSignature({ ...input, fetchImpl: async () => response }), error =>
    error.statusCode === 409 && error.code === "REPORT_OWNER_SIGNATURE_UNAVAILABLE" && error.message === OWNER_SIGNATURE_ERROR);
  await assert.rejects(ownerReportSignature({ ...input, fetchImpl: async () => { throw Error("private credential or URL"); } }), error =>
    error.message === OWNER_SIGNATURE_ERROR && !error.message.includes("credential"));
  for (const status of [401, 403]) await assert.rejects(ownerReportSignature({ ...input, fetchImpl: async () => reply({ status }) }), error => error.statusCode === status);
  await assert.rejects(ownerReportSignature({ principal, assertion: "", fetchImpl: () => { throw Error("Must not fetch"); } }), error => error.statusCode === 401);
});
