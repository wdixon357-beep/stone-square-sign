import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { calculateTreasury, currency, money, TREASURY_OFFICES } from './treasury.js';
const navy = rgb(.043,.145,.247), gold = rgb(.79,.635,.23), gray = rgb(.38,.42,.47), ink = rgb(.12,.16,.21);
const clean = v => String(v ?? '').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/[–—]/g,',').replace(/[^\x20-\x7e\xa0-\xff\n]/g,'');
const date = value => value ? new Intl.DateTimeFormat('en-US', { weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'UTC' }).format(new Date(value)) : 'Needs review';
export async function buildTreasuryPdf({ draft, status = 'draft', preparedBy = '', preparerRole = '', preparerSignature }) {
  const calc = calculateTreasury(draft), pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const seal = await pdf.embedPng(await readFile(new URL('./assets/lodge-seal.png', import.meta.url)));
  let page, y;
  const wrap = (value, width, size=10, font=regular) => {
    const lines = []; let line = '';
    for (const word of clean(value).split(/\s+/)) {
      if (font.widthOfTextAtSize(`${line} ${word}`.trim(),size)>width && line) { lines.push(line); line=''; }
      // Split long pasted identifiers rather than letting them run beyond the margin.
      for (const c of (line ? ' ' : '') + word) { if (font.widthOfTextAtSize(line+c,size)>width) { lines.push(line);line=''; } line+=c; }
    }
    if (line) lines.push(line); return lines.length ? lines : [''];
  };
  function newPage() {
    page=pdf.addPage([612,792]); y=672;
    page.drawRectangle({x:42,y:699,width:456,height:51,color:navy});
    page.drawText('STONE SQUARE LODGE NO. 22',{x:56,y:729,size:14,font:bold,color:rgb(1,1,1)});
    page.drawText("TREASURER'S REPORT",{x:56,y:709,size:10,font:bold,color:gold});
    page.drawImage(seal,{x:511,y:697,width:59,height:59});
    const footer=['ready_for_distribution','distributed'].includes(status) ? 'SIGNED TREASURER REPORT' : 'DRAFT FOR PREPARER REVIEW';
    page.drawText(footer,{x:42,y:34,size:8,font:bold,color:gray});
    page.drawText(`Confidential Lodge Financial Record | Page ${pdf.getPageCount()}`,{x:42,y:22,size:8,font:regular,color:gray});
  }
  const room = height => { if (y-height<57) newPage(); };
  function paragraph(value, bullet=false, color=ink) { for (const line of wrap(value,bullet?510:528)) { room(15);page.drawText(line,{x:bullet?55:42,y,size:10,font:regular,color});if(bullet){page.drawCircle({x:46,y:y+3,size:1.7,color:gold});bullet=false;}y-=15;} y-=5; }
  function heading(value) { room(55); y-=8;page.drawText(clean(value),{x:42,y,size:12,font:bold,color:navy});y-=8;page.drawLine({start:{x:42,y},end:{x:570,y},thickness:1,color:gold});y-=19; }
  function row(label, value, strong=false) { const lines=wrap(label,380,10,strong?bold:regular);room(lines.length*14+7);for(const [i,l] of lines.entries())page.drawText(l,{x:48,y:y-i*14,size:10,font:strong?bold:regular,color:ink});const number=clean(value);page.drawText(number,{x:562-(strong?bold:regular).widthOfTextAtSize(number,10),y,size:10,font:strong?bold:regular,color:ink});y-=lines.length*14+7; }
  newPage();paragraph(`Period: ${date(draft.periodStart)} through ${date(draft.periodEnd)}`); if(draft.presentedOn)paragraph(`Date presented: ${date(draft.presentedOn)}`);if(draft.bankName)paragraph(draft.bankName);
  heading('Financial Position');
  row('Cash in bank',currency(calc.cash),true);row('Book cash after reconciling items',currency(calc.bookCash));row('Bank membership shares and holds',currency(calc.hold));row('Fenced and restricted funds',currency(calc.fenced));row('Unrestricted book cash after holds',currency(calc.unrestricted),true);row('Unpaid obligations',currency(calc.obligations));row('Amount remaining after listed obligations',currency(calc.afterObligations),true);
  for(let i=0;i<calc.accounts.length;i+=2){
    const pair=calc.accounts.slice(i,i+2);room(335);const top=y-10;let bottom=top;
    pair.forEach((a,column)=>{
      const x=42+column*274,width=254;let yy=top;
      page.drawRectangle({x,y:yy-21,width,height:27,color:navy});
      page.drawText(clean(a.name).slice(0,36),{x:x+8,y:yy-12,size:10,font:bold,color:rgb(1,1,1)});yy-=42;
      for(const [label,key]of [['Beginning bank balance','opening'],['Receipts','receipts'],['Payments','disbursements'],['Transfers in','transfersIn'],['Transfers out','transfersOut'],['Calculated ending balance','calculated'],['Statement ending balance','statement'],['Deposits in transit','transit'],['Outstanding checks','outstanding'],['Adjusted bank balance','adjusted'],["Treasurer's book balance",'book'],['Reconciliation difference','difference']]){
        const lines=wrap(label,163,9.2);for(const [j,l]of lines.entries())page.drawText(l,{x:x+5,y:yy-j*12,size:9.2,font:regular,color:ink});
        const value=currency(a[key]);page.drawText(value,{x:x+width-5-regular.widthOfTextAtSize(value,9.2),y:yy,size:9.2,font:regular,color:ink});yy-=Math.max(19,lines.length*12+5);
      }
      bottom=Math.min(bottom,yy);
    });y=bottom-10;
  }
  if(draft.transactions.length && y<210)newPage();
  heading('Receipts, Payments and Transfers');
  if(!draft.transactions.length)paragraph('No itemized activity entered. Refer to the account totals and supporting records.');
  for(const t of draft.transactions){const account=draft.accounts.find(a=>a.id===t.account)?.name||'Account needs review';paragraph(`${t.date?date(t.date)+'. ':''}${account}. ${t.kind.replaceAll('_',' ')}: ${currency(money(t.amount))}. ${t.description}${t.reference&&!t.description.includes(t.reference)?' Check/reference '+t.reference+'.':''}${t.category&&!t.description.toLowerCase().includes(t.category.toLowerCase())?' '+t.category+'.':''}`,true);}
  heading('Fenced and Restricted Funds');
  if(!draft.funds.length)paragraph(draft.fundsReviewed?'No fenced or restricted funds reported.':'Fund allocations need confirmation.');
  for(const f of draft.funds){row(`${f.name} (${draft.accounts.find(a=>a.id===f.account)?.name||'Account needs review'})`,currency(money(f.amount)));if(f.restriction)paragraph(f.restriction,true);}
  heading('Outstanding Obligations and Upcoming Bills');
  if(!draft.obligations.length)paragraph(draft.obligationsReviewed?'No unpaid obligations reported.':'Unpaid obligations need confirmation.');
  for(const o of draft.obligations)paragraph(`${o.name}: ${currency(money(o.amount))}.${o.dueDate?' Due '+date(o.dueDate)+'.':''}${o.note?' '+o.note:''}`,true);
  if(draft.remarks){heading("Treasurer's Remarks");for(const line of draft.remarks.split('\n').filter(Boolean))paragraph(line,true);}
  if(calc.issues.length){heading('Items Requiring Review');for(const issue of calc.issues)paragraph(issue,true);}
  room(170);heading('Preparing Officer Attestation');
  for(const [x,label,name,role,signature] of [[42,'PREPARING OFFICER',preparedBy,TREASURY_OFFICES[preparerRole]||'',preparerSignature]]){
    page.drawText(label,{x,y,size:9,font:bold,color:navy});
    if(signature){const img=await pdf.embedPng(signature);const scale=Math.min(218/img.width,44/img.height);page.drawImage(img,{x:x+8,y:y-57,width:img.width*scale,height:img.height*scale});}
    page.drawLine({start:{x,y:y-63},end:{x:x+245,y:y-63},thickness:.7,color:gray});
    for(const [i,l]of wrap(name||'Attestation pending',245,10).entries())page.drawText(l,{x,y:y-80-i*13,size:10,font:bold,color:ink});
    if(name&&role)page.drawText(role,{x,y:y-111,size:9,font:regular,color:gray});
  }
  return Buffer.from(await pdf.save());
}
