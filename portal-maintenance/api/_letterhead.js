// The Worshipful Master's letterhead, ported from ~/.claude/tools/lodge_letter.py.
// Rule enforced here: EVERY page carries the full header, the complete roll of
// officers and the footer. Pagination happens in the browser before the PDF is
// taken, so nothing depends on Chrome repeating anything.
import { EMBLEM } from "./_emblem.js";
import { FONT_CSS } from "./_fonts.js";
import { SIGNATURE_FONT_CSS } from "./_report-signature-font.js";

export const OFFICERS = [
  ["Worshipful Master", "W. Aaron Dixon-Saunders"], ["Senior Warden", "Xavier White"],
  ["Junior Warden", "Jamal Sadler"], ["Secretary", "William McDuffie"],
  ["Assistant Secretary", "Adrian Reese"], ["Treasurer", "John Brown, PM"],
  ["Assistant Treasurer", "David Marable"], ["Senior Deacon", "Cliff Skinner"],
  ["Junior Deacon", "Corey Grubbs"], ["Chaplain", "Kenny Davis, PM"],
  ["Senior Steward", "Karim Fletcher"], ["Junior Steward", "David Jackson"],
  ["Tyler", "Bobby Collins, HPM"],
];

const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function letterheadHtml({ header, subheader, date, to, salutation, bodyHtml, signer }) {
  const rail = OFFICERS.map(([t, n]) =>
    `<div class="ob"><div class="ot">${esc(t)}</div><div class="on">${esc(n)}</div><div class="oa">208 East Lake Street<br>Middletown, DE 19709</div></div>`).join("");
  const savedImage = signer?.office === "Worshipful Master" && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(signer.signatureImage || "")
    ? signer.signatureImage : "";
  if (signer?.office === "Worshipful Master" && signer.signatureName && !savedImage) {
    throw new Error("The Worshipful Master's approved saved signature is required.");
  }
  const signatureLine = savedImage
    ? `<div class="sigline saved"><img alt="Saved signature" src="${savedImage}"></div>`
    : `<div class="sigline${signer?.signatureName ? " signed" : ""}">${esc(signer?.signatureName || "")}</div>`;
  const sig = signer
    ? `<div class="sigblk"><p class="cl">Respectfully submitted,</p>${signatureLine}<div class="nm">${esc(signer.name)}</div><div class="ti">${signer.office ? esc(signer.office) + ", " : ""}Stone Square Lodge No. 22, PHA</div>${signer.phone ? `<div class="ti">${esc(signer.phone)}</div>` : ""}</div>`
    : "";
  // Function replacements: a "$" in an officer's text must never be read as a replacement pattern.
  const put = (h, k, v) => h.replace(k, () => v);
  let h = TEMPLATE.replace(/{{EMB}}/g, () => EMBLEM);
  for (const [k, v] of [["{{RAIL}}", rail], ["{{HEADER}}", esc(header)], ["{{SUBHEADER}}", esc(subheader)], ["{{PHONE}}", signer?.phone ? `Telephone ${esc(signer.phone)}<br>` : ""], ["{{DATE}}", esc(date)], ["{{TO}}", esc(to)], ["{{SAL}}", esc(salutation)], ["{{BODY}}", bodyHtml], ["{{SIG}}", sig]]) h = put(h, k, v);
  return h;
}

const TEMPLATE = `<!doctype html><html><head><meta charset="utf-8"><style>
${FONT_CSS}
${SIGNATURE_FONT_CSS}
@page { size: letter; margin: 0; }
* { box-sizing: border-box; }
body { margin:0; font-family:"Tinos", "Times New Roman", Georgia, serif; color:#000; }
.sheet { width:8.5in; height:11in; padding:0.5in 0.55in 0.45in; position:relative; page-break-after:always; overflow:hidden; }
.sheet:last-child { page-break-after:auto; }
.hdr { text-align:center; position:relative; }
.hdr img.em { position:absolute; top:0; width:76px; }
.hdr img.l { left:4px; } .hdr img.r { right:4px; }
.hdr h1 { font-size:24pt; margin:0; color:#152a52; font-weight:bold; }
.hdr .aff { font-size:11pt; color:#152a52; margin-bottom:2px; }
.hdr .ad { font-size:8.4pt; line-height:1.28; color:#222; }
.rule { border-top:2px solid #152a52; border-bottom:1px solid #152a52; height:2px; margin:6px 0 5px; }
.office { font-size:11.5pt; color:#152a52; letter-spacing:4.5px; font-weight:bold; text-align:center; }
.office .wm { display:block; font-size:9pt; font-style:italic; letter-spacing:0; color:#333; font-weight:normal; }
.cols { display:flex; margin-top:10px; }
.rail { width:1.32in; flex:none; border-right:1.5px solid #b99a54; padding-right:9px; }
.rail h3 { font-size:9.5pt; letter-spacing:2.2px; color:#152a52; margin:0 0 1px; }
.rail .yr { font-size:7.4pt; color:#b99a54; letter-spacing:1px; margin-bottom:6px; }
.ob { margin-bottom:4.5px; }
.ot { font-size:7pt; color:#b99a54; font-weight:bold; line-height:1.15; }
.on { font-size:8.4pt; color:#152a52; font-weight:bold; line-height:1.2; }
.oa { font-size:6.6pt; color:#555; line-height:1.18; }
.bodybox { flex:1; padding-left:18px; font-size:10.5pt; line-height:1.42; }
.bodybox p { margin:0 0 9.5px; }
.bodybox h3 { font-size:10.5pt; color:#152a52; letter-spacing:.6px; text-transform:uppercase; margin:10px 0 4px; }
.bodybox ul { margin:0 0 9px 16px; padding:0; }
.bodybox li { margin:0 0 3px; }
.bodybox .title { font-size:12.5pt; font-weight:bold; color:#152a52; margin:0 0 10px; }
.date { margin-bottom:12px; }
.sigblk { margin-top:16px; }
.sigblk .cl { margin-bottom:2px; }
.sigline { height:38px; }
.sigline.signed { height:auto; min-height:38px; padding:4px 0 6px; font-family:"Allura", "Tinos", serif; font-size:26pt; line-height:1.15; overflow-wrap:anywhere; }
.sigline.saved { height:58px; padding:4px 0 6px; }
.sigline.saved img { display:block; max-width:190px; max-height:48px; width:auto; height:auto; object-fit:contain; object-position:left center; }
.nm { font-weight:bold; font-size:11pt; }
.ti { font-style:italic; font-size:9.5pt; }
.ftr { position:absolute; left:0.55in; right:0.55in; bottom:0.30in; text-align:center; font-size:8.5pt; font-style:italic; color:#555; }
.dia { width:6px; height:6px; border:1.3px solid #b99a54; transform:rotate(45deg); margin:0 auto 3px; }
</style></head><body>
<template id="tpl">
  <div class="sheet">
    <div class="hdr">
      <img class="em l" src="data:image/png;base64,{{EMB}}">
      <img class="em r" src="data:image/png;base64,{{EMB}}">
      <h1>Stone Square Lodge No. 22</h1>
      <div class="aff">Free and Accepted Masons, Prince Hall Affiliation</div>
      <div class="ad">208 East Lake Street<br>Middletown, DE 19709<br>Telephone (302) 304-6123<br>Stated Meetings: 1st &amp; 3rd Thursdays, 7:30 PM</div>
      <div class="rule"></div>
      <div class="office">{{HEADER}}<span class="wm">{{SUBHEADER}}</span></div>
      <div class="rule"></div>
    </div>
    <div class="cols">
      <div class="rail"><h3>OFFICERS</h3><div class="yr">2026 &nbsp;&nbsp; 2027</div>{{RAIL}}</div>
      <div class="bodybox"></div>
    </div>
    <div class="ftr"><div class="dia"></div>Returning to the Fundamentals, 2026 to 2027</div>
  </div>
</template>
<div id="src">
  <div class="date">{{DATE}}</div>
  <p>{{TO}}</p>
  <p>{{SAL}}</p>
  {{BODY}}
  {{SIG}}
</div>
<div id="out"></div>
<script>
document.fonts.ready.then(function paginate() {
  var tpl = document.getElementById('tpl'), src = document.getElementById('src'), out = document.getElementById('out');
  // Keep the closing and signature with the proposed motion when present.
  // A signature alone must not become an otherwise empty continuation page.
  var signature = src.querySelector('.sigblk');
  if (signature) {
    var closing = signature.previousElementSibling;
    if (closing && closing.tagName === 'P') {
      var first = closing;
      var motion = closing.previousElementSibling;
      var heading = motion && motion.previousElementSibling;
      if (motion && motion.tagName === 'P' && heading && heading.tagName === 'H3' && heading.textContent === 'Proposed motion') first = heading;
      var group = document.createElement('div'); src.insertBefore(group, first);
      while (group.nextElementSibling) group.appendChild(group.nextElementSibling);
    }
  }
  var nodes = Array.prototype.slice.call(src.children); src.remove();
  var box;
  function newSheet() { out.appendChild(tpl.content.cloneNode(true)); var s = out.querySelectorAll('.sheet'); box = s[s.length - 1].querySelector('.bodybox'); return box; }
  function room() { var sheet = box.closest('.sheet'); var ftr = sheet.querySelector('.ftr'); return ftr.getBoundingClientRect().top - box.getBoundingClientRect().top - 10; }
  function fits() { return box.scrollHeight <= room(); }
  // Fill the current sheet with as many pieces of n as fit, then send the rest on as a new node of the same kind.
  function splitInto(n, kids, make) {
    var head = make(); box.appendChild(head); var i = 0;
    for (; i < kids.length; i++) { head.appendChild(kids[i]); if (!fits()) { head.removeChild(kids[i]); break; } }
    if (!head.childNodes.length) { box.removeChild(head); box.appendChild(n); return; }
    var rest = make(); for (; i < kids.length; i++) rest.appendChild(kids[i]);
    if (rest.childNodes.length) { newSheet(); place(rest); }
  }
  function place(n) {
    box.appendChild(n);
    if (fits()) return;
    box.removeChild(n);
    // An empty sheet, or a sheet holding only the heading this node belongs under: split the node here.
    var onlyHeading = box.children.length === 1 && box.lastElementChild.tagName === 'H3';
    if (!box.children.length || onlyHeading) {
      if (n.tagName === 'UL' && n.children.length > 1) return splitInto(n, Array.prototype.slice.call(n.children), function () { return document.createElement('UL'); });
      if (n.tagName === 'P' && n.textContent.split(/\\s+/).length > 12) {
        var words = n.textContent.split(/\\s+/).map(function (w) { return document.createTextNode(w + ' '); });
        return splitInto(n, words, function () { var p = document.createElement('P'); p.className = n.className; return p; });
      }
      box.appendChild(n); return;
    }
    var last = box.lastElementChild;
    if (last && last.tagName === 'H3' && box.children.length > 1) { box.removeChild(last); newSheet(); box.appendChild(last); }
    else newSheet();
    place(n);
  }
  newSheet();
  nodes.forEach(place);
  document.title = 'paginated:' + out.querySelectorAll('.sheet').length;
});
</script>
</body></html>`;
