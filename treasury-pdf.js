import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { calculateTreasury, currency, money, TREASURY_OFFICES } from './treasury.js';

const navy = rgb(.043,.145,.247), gold = rgb(.79,.635,.23), gray = rgb(.38,.42,.47), ink = rgb(.12,.16,.21);
const clean = v => String(v ?? '').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/[–—]/g,',').replace(/[^\x20-\x7e\xa0-\xff\n]/g,'');
const date = value => value ? new Intl.DateTimeFormat('en-US', { weekday:'long',month:'long',day:'numeric',year:'numeric',timeZone:'UTC' }).format(new Date(`${value}T00:00:00Z`)) : 'Needs review';
const shortDate = value => value ? new Intl.DateTimeFormat('en-US', { month:'numeric',day:'numeric',year:'numeric',timeZone:'UTC' }).format(new Date(`${value}T00:00:00Z`)) : 'Needs review';
const titleDate = value => value ? new Intl.DateTimeFormat('en-US', { month:'long',day:'numeric',year:'numeric',timeZone:'UTC' }).format(new Date(`${value}T00:00:00Z`)) : 'Date Needs Review';

export async function buildTreasuryPdf({ draft, status = 'draft', preparedBy = '', preparerRole = '', preparerSignature }) {
  const calc = calculateTreasury(draft), pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const seal = await pdf.embedPng(await readFile(new URL('./assets/lodge-seal.png', import.meta.url)));
  let page, y;
  const wrap = (value, width, size=10, font=regular) => {
    const lines = []; let line = '';
    for (const word of clean(value).split(/\s+/)) {
      if (font.widthOfTextAtSize(`${line} ${word}`.trim(),size)>width && line) { lines.push(line); line=''; }
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
    if(/FICTIONAL DEMONSTRATION/i.test(draft.remarks||''))page.drawText('FICTIONAL DEMONSTRATION - NOT A LODGE RECORD',{x:42,y:46,size:8,font:bold,color:rgb(.72,.12,.09)});
    page.drawText(footer,{x:42,y:34,size:8,font:bold,color:gray});
    page.drawText(`Confidential Lodge Financial Record | Page ${pdf.getPageCount()}`,{x:42,y:22,size:8,font:regular,color:gray});
  }
  const room = height => { if (y-height<57) newPage(); };
  function paragraph(value, bullet=false, color=ink) { for (const line of wrap(value,bullet?510:528)) { room(15);page.drawText(line,{x:bullet?55:42,y,size:10,font:regular,color});if(bullet){page.drawCircle({x:46,y:y+3,size:1.7,color:gold});bullet=false;}y-=15;} y-=5; }
  function heading(value) { room(55); y-=8;page.drawText(clean(value),{x:42,y,size:12,font:bold,color:navy});y-=8;page.drawLine({start:{x:42,y},end:{x:570,y},thickness:1,color:gold});y-=19; }
  function subheading(value) { room(34);page.drawRectangle({x:42,y:y-17,width:528,height:24,color:navy});page.drawText(clean(value),{x:50,y:y-10,size:10,font:bold,color:rgb(1,1,1)});y-=34; }
  function row(label, value, strong=false) { const lines=wrap(label,380,10,strong?bold:regular);room(lines.length*14+7);for(const [i,l] of lines.entries())page.drawText(l,{x:48,y:y-i*14,size:10,font:strong?bold:regular,color:ink});const number=clean(value);page.drawText(number,{x:562-(strong?bold:regular).widthOfTextAtSize(number,10),y,size:10,font:strong?bold:regular,color:ink});y-=lines.length*14+7; }
  function activityTable(entries, opening) {
    const x=[42,104,354,426,498];
    const headers=['Date','Description','Check No.','Amount','Balance'];
    room(25);page.drawRectangle({x:42,y:y-15,width:528,height:23,color:rgb(.93,.94,.95)});
    headers.forEach((label,i)=>page.drawText(label,{x:x[i]+4,y:y-8,size:8.5,font:bold,color:ink}));y-=29;
    let balance=opening;
    for(const entry of entries) {
      const amount=money(entry.amount);
      if(balance!==null&&amount!==null)balance+=['receipt','transfer_in'].includes(entry.kind)?amount:-amount;
      const direction=entry.kind==='payment'?'Disbursement':entry.kind==='transfer_in'?'Transfer In':entry.kind==='transfer_out'?'Transfer Out':'Receipt';
      const description=`${entry.description||'Description needs review'}${direction.startsWith('Transfer')?` (${direction})`:''}`;
      const descLines=wrap(description,242,8.3), height=Math.max(20,descLines.length*11+5);room(height);
      page.drawText(shortDate(entry.date),{x:x[0]+4,y,size:8.3,font:regular,color:ink});
      descLines.forEach((line,i)=>page.drawText(line,{x:x[1]+4,y:y-i*11,size:8.3,font:regular,color:ink}));
      page.drawText(clean(entry.reference||''),{x:x[2]+4,y,size:8.3,font:regular,color:ink});
      const signedAmount=amount===null?null:['payment','transfer_out'].includes(entry.kind)?-amount:amount;
      const amountText=currency(signedAmount), balanceText=currency(balance);
      page.drawText(amountText,{x:x[4]-4-regular.widthOfTextAtSize(amountText,8.3),y,size:8.3,font:regular,color:ink});
      page.drawText(balanceText,{x:570-regular.widthOfTextAtSize(balanceText,8.3),y,size:8.3,font:regular,color:ink});
      y-=height;page.drawLine({start:{x:42,y:y+5},end:{x:570,y:y+5},thickness:.3,color:rgb(.82,.84,.86)});
    }
  }

  newPage();
  page.drawText(`Period Covered: ${date(draft.periodStart)} through ${date(draft.periodEnd)}`,{x:42,y,size:10,font:bold,color:ink});y-=19;
  if(draft.presentedOn){page.drawText(`Presented at the ${date(draft.presentedOn)} meeting`,{x:42,y,size:10,font:regular,color:ink});y-=19;}
  if(draft.bankName){page.drawText(clean(draft.bankName),{x:42,y,size:10,font:regular,color:ink});y-=20;}

  for(const account of calc.accounts) {
    const entries=draft.transactions.filter(t=>t.account===account.id&&t.postedDateConfirmed&&t.date&&(!draft.periodStart||t.date>=draft.periodStart)&&(!draft.periodEnd||t.date<=draft.periodEnd));
    const receipts=entries.filter(t=>t.kind==='receipt'), disbursements=entries.filter(t=>t.kind==='payment');
    const transfersIn=entries.filter(t=>t.kind==='transfer_in'), transfersOut=entries.filter(t=>t.kind==='transfer_out');
    room(245);subheading(account.name);
    heading('Receipts');
    if(receipts.length)for(const item of receipts)row(item.description||'Receipt',currency(money(item.amount)));
    else paragraph('No receipts recorded for this account.');
    row('Total Receipts',currency(account.receipts),true);
    heading('Disbursements');
    if(disbursements.length)for(const item of disbursements)row(`${item.description||'Disbursement'}${item.reference?` (Check ${item.reference})`:''}`,currency(money(item.amount)));
    else paragraph('No disbursements recorded for this account.');
    row('Total Disbursements',currency(account.disbursements),true);
    if(transfersIn.length||transfersOut.length){
      heading('Transfers');
      for(const item of transfersIn)row(`Transfer In: ${item.description||'Account transfer'}`,currency(money(item.amount)));
      for(const item of transfersOut)row(`Transfer Out: ${item.description||'Account transfer'}`,currency(money(item.amount)));
    }
    heading('Monthly Summary');
    row('Beginning Balance',currency(account.opening));row('Plus: Total Receipts',currency(account.receipts));row('Less: Total Disbursements',currency(account.disbursements));
    if(account.transfersIn!==null&&account.transfersIn!==0)row('Plus: Transfers In',currency(account.transfersIn));
    if(account.transfersOut!==null&&account.transfersOut!==0)row('Less: Transfers Out',currency(account.transfersOut));
    row('Ending Bank Balance',currency(account.calculated),true);
    heading('Account Reconciliation');
    row('Bank Statement Ending Balance',currency(account.statement));row('Plus: Deposits in Transit',currency(account.transit));row('Less: Outstanding Checks',currency(account.outstanding));row('Adjusted Bank Balance',currency(account.adjusted),true);row("Treasurer's Book Balance",currency(account.book));row('Difference, if any',currency(account.difference),true);
  }

  room(105+Math.min(draft.obligations.length,6)*24);heading('Outstanding Obligations');
  if(!draft.obligations.length)paragraph(draft.obligationsReviewed?'No outstanding obligations reported.':'Outstanding obligations need confirmation.');
  for(const item of draft.obligations)row(`${item.name}${item.dueDate?` (Due ${titleDate(item.dueDate)})`:''}${item.note?` - ${item.note}`:''}`,currency(money(item.amount)));
  if(draft.obligations.length)row('Total Outstanding Obligations',currency(calc.obligations),true);

  room(105+Math.min(draft.funds.length,6)*24);heading('Fenced Money');
  if(!draft.funds.length)paragraph(draft.fundsReviewed?'No fenced money reported.':'Fenced money needs confirmation.');
  for(const fund of draft.funds)row(`${fund.name}${fund.restriction?` - ${fund.restriction}`:''}`,currency(money(fund.amount)));
  if(draft.funds.length)row('Total Fenced Money',currency(calc.fenced),true);

  heading(`Position at ${titleDate(draft.periodEnd)}`);
  for(const account of calc.accounts)row(`${account.name} account ending balance`,currency(account.statement));
  row('Total cash in bank',currency(calc.cash),true);row('Less: Total Fenced Money',currency(calc.fenced));row('Unrestricted cash',currency(calc.unrestricted),true);

  newPage();heading(`Account Activity: ${titleDate(draft.periodEnd)}`);
  for(const account of calc.accounts) {
    subheading(`${account.name} Account Activity`);
    const entries=draft.transactions.filter(t=>t.account===account.id&&t.postedDateConfirmed&&t.date&&(!draft.periodStart||t.date>=draft.periodStart)&&(!draft.periodEnd||t.date<=draft.periodEnd)).sort((a,b)=>a.date.localeCompare(b.date));
    if(entries.length)activityTable(entries,account.opening);else paragraph('No account activity recorded for this account.');
  }
  if(draft.remarks){heading("Treasurer's Remarks");for(const line of draft.remarks.split('\n').filter(Boolean))paragraph(line,true);}
  if(calc.issues.length){heading('Items Requiring Review');for(const issue of calc.issues)paragraph(issue,true);}
  room(150);heading('Preparing Officer');
  page.drawText('PREPARING OFFICER',{x:42,y,size:9,font:bold,color:navy});
  if(preparerSignature){const img=await pdf.embedPng(preparerSignature);const scale=Math.min(218/img.width,34/img.height);page.drawImage(img,{x:50,y:y-42,width:img.width*scale,height:img.height*scale});}
  page.drawLine({start:{x:42,y:y-46},end:{x:287,y:y-46},thickness:.7,color:gray});
  for(const [i,line]of wrap(preparedBy||'Attestation pending',245,10).entries())page.drawText(line,{x:42,y:y-62-i*12,size:10,font:bold,color:ink});
  const role=TREASURY_OFFICES[preparerRole]||'';if(preparedBy&&role)page.drawText(role,{x:42,y:y-78,size:9,font:regular,color:gray});
  return Buffer.from(await pdf.save());
}
