export function automaticRecipients(contacts, ids, history) {
  const seen = new Set();
  return contacts.filter(contact => ids.includes(contact.id)).map(contact => {
    const email = contact.candidates[0]?.email || '';
    let skipped = '';
    if (!email) skipped = 'No email candidate found';
    else if (history.some(h => (h.contactId === contact.id || h.to === email) && ['sent', 'pending', 'uncertain'].includes(h.status))) skipped = 'Already contacted or pending';
    else if (seen.has(email)) skipped = 'Duplicate email address';
    if (!skipped) seen.add(email);
    return { contact, email, skipped };
  });
}
