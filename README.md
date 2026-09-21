# RecruiterAutomationOutreach

Type a company name and the app finds its recruiters from LinkedIn search results, then works out their likely work email addresses from the company's email format. Review a personalized outreach email for each one, attach your resume, and send through your own Gmail. It runs locally and tracks who you've contacted so nobody gets emailed twice.

Everything runs on your computer: your API keys, Gmail tokens, contacts, resume, and send history stay in ignored local files and never go into this repository. It ships tuned for a **new-grad software engineering** search, but the wording, ranking, and default email all live in one config file, so anyone can point it at their own kind of job search without touching the code.

## Setup (about 15 minutes)

You need three things: **Node.js**, a **free search API key**, and a **Google sign-in for your Gmail**. Do the steps in order.

### Step 1. Install and run

1. Install Node.js 22 or newer from https://nodejs.org (pick the LTS download).
2. Open a terminal and run:

   ```sh
   git clone https://github.com/iyakubovich03/RecruiterAutomationOutreach.git
   cd RecruiterAutomationOutreach
   npm install
   cp .env.example .env.local
   npm run dev
   ```

3. Open http://localhost:3000 in your browser. The app loads, but searching and sending won't work until Steps 2 and 3 are done.

`.env.local` is your private settings file. It is never uploaded anywhere. You will paste two things into it below.

### Step 2. Get a free search key (2 minutes)

The app finds recruiters by running a Google search. That needs a key.

1. Go to https://serper.dev and sign up (free, no credit card).
2. Click **API Keys** in the left menu and copy your key.
3. Open `.env.local` in any text editor and paste it on this line:

   ```
   SERPER_API_KEY=paste-your-key-here
   ```

That's it for search. Each company you look up uses about 3 to 4 of your free credits.

*Alternative:* https://serpapi.com also works (100 free searches a month). Paste that key on the `SERPAPI_KEY=` line instead.

### Step 3. Let the app send from your Gmail (10 minutes)

The app sends emails from your own Gmail address. Google requires you to create a "sign-in" for it once. You only ever grant permission to **send**; the app cannot read your inbox.

1. Go to https://console.cloud.google.com and sign in with the Gmail account you want to send from.
2. At the top, click the project dropdown → **New project**. Name it anything (for example `recruiter-outreach`) and click **Create**. Make sure it is selected.
3. In the search bar at the top, type **Gmail API**, open it, and click **Enable**.
4. In the left menu, go to **APIs & Services → OAuth consent screen**.
   - Choose **External**, click Create.
   - App name: anything. User support email and developer email: your Gmail.
   - Click through Save and Continue until you reach **Test users**. Click **Add users** and add your own Gmail address. Save.
5. In the left menu, go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Application type: **Web application**.
   - Under **Authorized redirect URIs**, click Add URI and paste exactly:

     ```
     http://localhost:3000/api/auth/callback
     ```

   - Click Create. A box shows your **Client ID** and **Client secret**.
6. Paste both into `.env.local`:

   ```
   GOOGLE_CLIENT_ID=paste-client-id-here
   GOOGLE_CLIENT_SECRET=paste-client-secret-here
   ```

7. Restart the app (press Ctrl+C in the terminal, then `npm run dev` again).
8. In the app, click **Connect Gmail** at the top right, choose your account, and approve. Google may show "This app isn't verified" because it's your own private app: click **Continue**.

You're ready. Type a company, click **Find recruiters**, and review the results.

### Step 4. Set up your own email and resume (in the app)

Open the **Default email** tab in the app:

- Write the email you want recruiters to receive. Use `{first_name}` and `{company}` and the app fills them in per recruiter.
- Upload your resume. It is attached to every outreach email automatically.

Both are saved only on your computer.

### Step 5. Change what kind of job you're searching for (optional)

Out of the box the app looks for **new-grad software engineering** recruiters. To change that, open the file `search.config.json` in the project folder with a text editor. It looks like this:

```json
{
  "workspace": { "label": "Your job search", "focus": "New-grad software engineering" },
  "search": {
    "roleKeyword": "recruiter",
    "audience": "University, early-career, and technical recruiters.",
    "exampleCompanies": ["Stripe", "Microsoft", "Datadog"]
  },
  "recruiterTerms": ["recruit\\w*", "talent acquisition", "early careers", "campus hiring", "university relations"],
  "focusTiers": [
    { "label": "Early careers", "any": ["university", "campus", "early.?career", "new.?grad", "graduate recruit"] },
    { "label": "Technical recruiting", "any": ["technical", "engineering", "software"], "also": ["recruit", "talent"] }
  ],
  "fallbackFocus": "Review recruiting focus",
  "template": { "subject": "...", "message": "..." }
}
```

What each part does:

- **`workspace.focus`**: the label shown in the sidebar. Just text.
- **`search.roleKeyword`**: the word added to the Google search. `recruiter` works for almost everyone. Use `"design recruiter"` or `"sales recruiter"` to narrow it.
- **`search.audience`** and **`exampleCompanies`**: the description and the "Try …" buttons on the search page. Just text.
- **`focusTiers`**: how results are ranked. The first tier is shown first. A result lands in a tier when its title contains any word from `any` (and, if `also` is present, at least one word from `also` too). Add your own tier at the top, for example `{ "label": "Design recruiting", "any": ["design", "ux", "product"], "also": ["recruit", "talent"] }`.
- **`recruiterTerms`**: a result must contain one of these to count as a recruiter. Usually leave alone.
- **`template`**: the starting email for a brand-new install. Once you've saved your own email in the app, this is no longer used.

Words in `any`, `also`, and `recruiterTerms` are matched case-insensitively and can use regex. Write `\\` for a backslash inside the JSON. If you make a typo, the app tells you which field on startup.

Restart `npm run dev` after editing.

### Step 6. Chrome extension (optional): send outreach right after you apply

The `extension/` folder is a private Chrome extension that notices when you submit a job application and offers to email that company's recruiters, using the same search, default email, and resume as the app. Nothing is published to the Chrome Web Store; it runs only in your browser and talks only to `localhost:3000`.

1. In the app, open **Connections → Chrome extension** and copy the folder path and the extension token.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the `extension` folder.
3. Click the green **R** icon in Chrome's toolbar, paste the token, and click **Save token**. The popup shows whether the app, Gmail, resume, default email, and search key are all ready.
4. So the app is always there for the extension, run `npm run agent:install` once; it registers a login item that keeps `npm run dev` running and restarts it if it stops. `npm run agent:remove` undoes it.

After you submit an application on Greenhouse, Lever, Ashby, Workday, LinkedIn, SmartRecruiters, iCIMS, or most career sites that show a "thanks for applying" page, a small **R** badge appears in the corner. Click it, confirm the company name, and the panel runs the search, lists the recruiters and their addresses, shows each personalized email with your resume attached, and sends only after you tick the authorization box. If a site is not recognized, click the toolbar icon and use **Find recruiters** with the company name. Test sends, duplicate protection, and history are shared with the app.

### What stays on your computer

These are listed in `.gitignore` and are never committed or shared:

- `.env.local`: your search key and Google client ID and secret.
- `.local-data/`: your Gmail connection, saved email, resume, contacts, and send history.

## Troubleshooting

- **"NO SEARCH API KEY" pill on the search page**: `.env.local` is missing the Serper or SerpApi key, or the app wasn't restarted after adding it.
- **Google says "Access blocked" or "app has not completed verification"**: you skipped adding yourself as a **test user** in Step 3.4.
- **Google says "redirect_uri_mismatch"**: the redirect URI in Step 3.5 must be exactly `http://localhost:3000/api/auth/callback`, and the app must be on port 3000.
- **Search finds nobody**: open the **Requests** tab. It shows every request and why results were excluded.

---

The rest of this file describes how the app works in detail. You don't need it to get started.

## Search to batch outreach

Type a company name and choose **Find recruiters**. While the search runs, the page shows a four-step progress strip (LinkedIn results → company domain → RocketReach formats → email candidates); the full request-by-request log lives in the **Requests** tab. Name and company-association extraction from LinkedIn search results runs first; automatic discovery does not request LinkedIn profile pages. If no matching profiles are found, later research is skipped with a diagnostic explanation. Official website and email-domain discovery, mail-server checks, and RocketReach format scraping follow.

Results are shown as one card per recruiter: name, title, focus, the top-ranked address with its RocketReach usage percentage, an expandable list of every possible format, and the LinkedIn source. Two buttons follow: **Send my default email to all** uses the message saved under **Default email**; **Write a custom message** opens an editor first (with an option to save it as the new default). Either way a review dialog lists every recipient, shows the exact personalized email for each, and sends only after you tick the authorization box and click **Authorize & send**. Placeholders `{first_name}`, `{full_name}`, `{company}`, and `{email}` are filled in per recruiter. The top-ranked address is used for each person; previously contacted recruiters and duplicate addresses are skipped automatically. The server saves the exact reviewed messages for ten minutes, then Gmail sends a separate message to each recipient, up to eight per batch. Sending is not mailbox verification, and recipients do not see each other's addresses.

A resume (PDF, DOC, or DOCX up to 5 MB) can be uploaded once under **Default email**; it is stored as `.local-data/resume.bin` with restricted permissions and its name, size, and date in `workspace.json`. Recruiter batches always include it — the authorize dialog has no attach/detach option, and if no resume is saved the dialog stops and links to the upload instead of sending. Only **Send yourself a test** offers an attachment toggle. Every message is sent as `multipart/alternative` — the plain text plus a simple HTML twin (paragraphs and line breaks only, no tracking or styling beyond a standard font) — so it renders at normal width like a hand-written Gmail message. Attached messages wrap that in `multipart/mixed` through the same Gmail API call, and history rows show the attached filename.

**Verified runs.** Authorizing a batch starts a server-owned *run* rather than a one-shot send. The first recruiter is emailed at the top-ranked format and the inbox is checked every ten seconds for up to a minute; the moment that address bounces (Gmail's failure notice usually lands within seconds), the same person is tried at the next format, and so on (up to three addresses per person). Only an address that never bounces is watched for the full minute. The first format that gets through is locked in and everyone else is emailed at it; anyone who bounces is retried at their next address automatically. **Stop sending** (in the run dialog, on the Find page card, and in the extension panel; two clicks, so a stray click never halts a run) stops it immediately: nothing more is sent, emails already handed to Gmail cannot be recalled, and **Resume** later picks up exactly where it left off. Because the run is driven by a server timer, closing the dialog, the browser tab, or the extension panel never strands it — the Find page shows the run in progress and re-opens it, the extension badge re-attaches to it, and a run interrupted by a restart can be resumed. Without the headers permission a run simply sends everyone once at their top address.

Finding the RocketReach page itself uses two queries: `site:rocketreach.co <company> email format` through the search API first (for well-known names a plain Google query returns only videos and forum threads *about* RocketReach), then the plain `rocketreach <company> email format` query, which the public search pages can also serve. If no RocketReach page turns up and the company's own pages cannot be read, the top result for the bare company name becomes the domain once its mail servers check out.

Runs also guard against a wrong *domain*. Discovery records fallback domains alongside the chosen one — the top organic result for the bare company name (usually the official site), RocketReach's stated domain, and the application page's domain — each checked for mail servers. If every address for the probe recruiter bounces at the chosen domain, the run probes the fallbacks; a domain where several addresses have already bounced with no delivery is probed last. When a fallback delivers, everyone in the run is switched to it and the company's domain *and the format that got through* are remembered as *verified by delivery*, so the next search uses them directly. RocketReach stays the only format source: when it files the company under the wrong domain (it lists `scale.ai` for Scale AI, but only `scale.com` delivers, and it has no `scale.com` page at all), its formats for the company are applied at the verified domain, with the delivered format ranked first. The Find page lists every format at the domain in the order a run tries it, with RocketReach's share and what your own outreach has shown (delivered / bounced / verified by delivery).

**Bounces.** Gmail is also asked for read-only access to message *headers* (`gmail.metadata`; bodies are never read). Every email carries its own `Message-ID`. After a batch is sent, the dialog stays open for about a minute and polls the inbox history for delivery-failure notices, matching them by `X-Failed-Recipients` or `In-Reply-To`. A bounced address is marked **Bounced** in history and is never used again; the recruiter's next-best RocketReach address is queued as a retry batch that still needs your **Authorize & send** click. **Check again** re-scans later for slow bounces. If Gmail was connected before this permission existed, Connections shows "Bounce detection is off" until you reconnect once.

**Send yourself a test** (Default email tab) sends the text currently in the editor to any address you type, with `{company}` and `{first_name}` filled in from the form and the resume optionally attached, through the same Gmail path. Test sends are recorded in history with a *Test* tag, never count as outreach, and never block later sends.

The latest search results are kept for the local session, so a page reload does not lose them. Batch results are saved in local outreach history. A failure stops later recipients, uncertain submissions block automatic retries, and the same batch cannot be sent twice. A server restart marks an active batch interrupted; inspect its saved history and Gmail Sent before preparing any new outreach. Tests use mocked Gmail responses and do not send real messages.

## Search API

Recruiter discovery, company-domain discovery, and RocketReach page discovery all start from a web search for queries such as `site:linkedin.com/in/ "<company>" recruiter`. The public DuckDuckGo HTML endpoint now answers automated requests with a bot challenge, and Bing's HTML/RSS endpoints silently drop the `site:` operator and omit LinkedIn profile pages, so without an API key a search returns no recruiters. Configure one of these in `.env.local`:

- **Serper** (recommended; https://serper.dev): whole-web Google results as JSON with free starter credits and no card. Sign in, open **API Keys**, and set `SERPER_API_KEY`. One company search costs about three to four credits.
- **SerpApi** (https://serpapi.com): also whole-web Google results; 100 free searches per month. Set `SERPAPI_KEY`.
- **Google Custom Search JSON API**: supported for projects that already had access (`GOOGLE_CSE_KEY` + `GOOGLE_CSE_ID`), but Google closed it to new customers — new projects receive `403 This project does not have the access to Custom Search JSON API` even after enabling it — and it shuts down on 2027-01-01.

Keyed providers are tried first, then the public DuckDuckGo, Bing, and Google pages. Company-domain discovery still works through Bing without a key because its query has no `site:` operator. Search diagnostics show which provider answered; API keys never appear in diagnostics or the status API. One company search uses roughly three to four queries (recruiters, company domain, and one or two RocketReach searches); saved format evidence avoids repeat queries for three months.

## Research and outreach

- **Find recruiters automatically** searches the configured search API, falling back to public DuckDuckGo and Bing pages. It extracts and deduplicates LinkedIn profile URLs, full names, recruiting titles, and snippets; filters for company and the `recruiterTerms` from `search.config.json`; and ranks results by that file's `focusTiers` (early-career, then technical recruiters, by default). Up to eight recruiters with full names and explicit company-association evidence are retained. Initial-only names and explicitly historical associations are excluded. Profile pages are not fetched. Search results are cached for ten minutes, and no CAPTCHA or sign-in wall is bypassed. Public search may be blocked or incomplete; the app reports this rather than inventing contacts.
- Search discovers the company domain, researches email formats, and generates candidates. Proceed includes all discovered profiles together. No individual profile needs to be opened. Current employment is not confirmed from a search match; differing employer information is flagged. Duplicate saved contacts are skipped.
- Add recruiter has separate **Read profile URL** and **Parse pasted text** actions. The URL importer parses structured Person/ProfilePage data, name headings, and metadata, and extracts published email addresses from profile content and mailto links. It shows the extraction source and fills in the name, title, employer when available, and a suggested domain only when published work addresses share one domain. Login walls, redirects, and blocked pages require pasted text. There is no login automation or access-control bypass.
- Review extracted name and title; supply the current company and its email domain yourself. Extraction is heuristic and should be corrected before saving; URL slugs are never treated as proof of a person’s name.
- Email candidates are built from RocketReach's reported formats for the company domain, ranked by reported usage, plus any address found in supplied text. Only when RocketReach reports nothing are six generic name-based formats offered. Imported addresses do not prove ownership; all candidates remain explicitly unverified.
- Mail-domain checks look up MX records. They do not test individual mailboxes. SMTP probing, catch-all detection, automatic bounce tracking are not implemented.
- Select one candidate, compose or paste a message, save a reusable template, and review the personalized email. The final checkbox and send button authorize exactly one real message.
- Gmail acceptance is recorded as **submitted**, never as delivered or verified. Check replies and bounces in Gmail itself. No emails are sent to test permutations.
- Duplicate outreach to the same saved recruiter is blocked after submission in the default mode. Explicit multiple-candidate batches may include another address for that person. Pending and uncertain requests also block retries so a timeout does not cause duplicate messages. Check Gmail Sent if an outcome is uncertain.

Local access is limited to `localhost:3000`; mutating requests require a same-origin request and a session CSRF token. OAuth uses a session-bound expiring state and PKCE. The app requests `openid`, `email`, and `https://www.googleapis.com/auth/gmail.send` only. No credentials or tokens are returned by the status API; Disconnect revokes Google authorization and deletes locally saved tokens. The app is a single-user local tool; do not expose it using a public tunnel.

## Checks

```sh
npm test
npm run typecheck
npm run test:build
```

Tests use synthetic profiles and mocked Google responses, never your credentials or real recipients. Actual Google sign-in requires you to register the redirect URI and authorize your account. Live sending is intentionally left for your explicit review in the app.

References: [Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail sending](https://developers.google.com/workspace/gmail/api/guides/sending).

## Company email pattern research

Select a saved recruiter, then choose **Find company email pattern** above their email candidates. RocketReach is the only format source: the app searches for the company's RocketReach email-format page, reads it, and records the formats it reports for the exact domain together with their reported usage percentages. Source pages are untrusted: requests pin validated public IPv4 DNS results, revalidate redirects, enforce size/time limits, and reject local/private destinations.

Pattern evidence is saved locally per domain and reused for three calendar months; new contacts inherit the ranking, and existing recipients are not changed. Failure to find new evidence does not erase a previously saved report. A research date is the retrieval date, not a claim about when RocketReach updated its data.

Reported formats and source links appear beside the ranked candidates. All generated mailboxes remain unverified; this feature does not send emails or run SMTP probes.

Company-domain discovery checks public official-site evidence and organization metadata. Published company contact addresses are preferred; an official website with MX records is labeled as an inferred email domain. When equally supported domains are regional editions of one site (for example `amazon.in` and `amazon.ae` whose mail servers sit under `amazon.com`), the domain the others route mail through is chosen and the decision is shown in diagnostics. Otherwise multiple equally supported domains or missing evidence remain unresolved, and Proceed stays disabled. No company.com address is invented from a company name.

## Visible research stages and RocketReach

Search diagnostics stay expanded and show the exact public search query, source URLs, name extraction, company-association evidence, excluded matches, domain evidence, MX lookup outcomes, RocketReach page failures, and candidate generation. Errors and empty/rejected results are highlighted. **Run fresh search** bypasses the ten-minute recruiter discovery cache. It still reuses unexpired company format evidence.

RocketReach research first searches for `rocketreach <company> email format`, then falls back to `site:rocketreach.co "<domain>" "email format"` if no format-page links are found. It uses the exact discovered URL, including the company-specific suffix, which only a search engine can supply. Search uses the configured search API, then DuckDuckGo, Bing RSS, and Google public HTML; blocked or JavaScript-only results are diagnosed. It reads up to three public email-format pages, and extracts explicit domain-matched format notation from HTML tables and text. It does not bypass sign-in, bot checks, or JavaScript-only pages. Missing links, fetch failures, unsupported notation, and no matching formats are reported. Live access depends on the public sources.

When RocketReach reports formats, candidates are built only from those formats, ranked by reported percentage. Formats use `first`, `last`, `f`/`l` (first or last initial), and `f2`/`l2` (first two letters), with up to two tokens separated by a dot, underscore, hyphen, or nothing (for example `flast`, `last.first`, `lastf`, `firstl2`). Six generic formats — `first.last`, `flast`, `firstlast`, `first`, `first_last`, and `firstl` — are offered only when RocketReach reports nothing for the domain. When several RocketReach pages share a domain, the top-ranked page's figures are used. Candidate addresses are deduplicated. RocketReach percentages are reported usage claims, not mailbox confidence; example addresses on format pages are not counted as real employee evidence.

Successful company format reports are stored in `.local-data/workspace.json` under `patterns`, keyed by normalized email domain, with company name, extracted formats, exact source URLs, collection date, and expiry date. Company aliases at the same domain share evidence; identical company names at different domains do not. The cache survives restarts. The next lookup after three calendar months refreshes the report; no background scheduler is required. Empty or failed research is retried after one hour instead of being treated as a three-month success. A failed refresh keeps older evidence and its original date. Concurrent requests for the same domain share a single research job.
