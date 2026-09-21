import { mimeMessage } from './core.mjs';
export function personalize(text, contact, email) {
 const values={first_name:contact.name.split(/\s+/)[0],full_name:contact.name,company:contact.company,email};
 return String(text||'').replace(/\{(first_name|full_name|company|email)\}/g,(_,key)=>values[key]);
}
// A bounced address is never retried, but the same person may be tried at their next address.
export function outreachBlocked(history, id, to, multipleCandidates = false) {
 return history.some(h => (h.to === to && ['sent','pending','uncertain','bounced'].includes(h.status)) || (h.contactId === id && (['pending','uncertain'].includes(h.status) || (!multipleCandidates && h.status === 'sent'))));
}
export function buildBatch(recipients,contacts,history,from,subject,message,multipleCandidates=false) {
 if(!Array.isArray(recipients)||recipients.length<1||recipients.length>8)throw new Error('Choose between 1 and 8 recipients.');
 const seen=new Set(),ids=new Set();
 return recipients.map(({id,to})=>{
   const c=contacts.find(c=>c.id===id);if(!c||!c.candidates.some(e=>e.email===to))throw new Error('Choose an available email candidate for each recruiter.');
   if(seen.has(to)||(!multipleCandidates&&ids.has(id)))throw new Error('Each recruiter and email address may appear only once in a batch.');seen.add(to);ids.add(id);
   if(outreachBlocked(history,id,to,multipleCandidates))throw new Error(`Outreach already exists for ${c.name}. Check Gmail Sent before sending again.`);
   const row={id,to,name:c.name,subject:personalize(subject,c,to),message:personalize(message,c,to),status:'not_started'};
   mimeMessage({...row,from});return row;
 });
}
