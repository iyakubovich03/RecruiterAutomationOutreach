const tried = (history, email) => history.some(h => h.to === email && ['sent', 'pending', 'uncertain', 'bounced'].includes(h.status));

// The best address not yet attempted for this person, or null when every candidate has been tried.
export function nextCandidate(contact, history) {
  return contact.candidates.find(c => !tried(history, c.email)) || null;
}

export function automaticRecipients(contacts, ids, history) {
  const seen = new Set();
  return contacts.filter(contact => ids.includes(contact.id)).map(contact => {
    const candidate = nextCandidate(contact, history);
    const email = candidate?.email || '';
    let skipped = '';
    if (history.some(h => h.contactId === contact.id && ['sent', 'pending', 'uncertain'].includes(h.status))) skipped = 'Already contacted or pending';
    else if (!contact.candidates.length) skipped = 'No email candidate found';
    else if (!email) skipped = 'Every address bounced';
    else if (seen.has(email)) skipped = 'Duplicate email address';
    if (!skipped) seen.add(email);
    return { contact, email, skipped };
  });
}
