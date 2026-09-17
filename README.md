# RecruiterAutomationOutreach

Type a company name and the app finds its recruiters from LinkedIn search results, then works out their likely work email addresses from the company's email format. Review a personalized outreach email for each one, attach your resume, and send through your own Gmail. It runs locally and tracks who you've contacted so nobody gets emailed twice.

Everything runs on your computer: your API keys, Gmail tokens, contacts, resume, and send history stay in ignored local files and never go into this repository. It ships tuned for a **new-grad software engineering** search, but the wording, ranking, and default email all live in one config file, so anyone can point it at their own kind of job search without touching the code.

## Quick start

Requires **Node.js 22.19+** and npm. You will need two things from outside the repo: a search API key (free tier is fine) and a Google OAuth client so the app can send from your Gmail. Both are one-time setup.

```sh
git clone <this repository>
cd recruiterIdentifier
npm install
cp .env.example .env.local     # then fill it in, see below
npm run dev                    # open http://localhost:3000
```

### 1. Search API key (required, about 2 minutes)

Recruiter discovery starts from a web search such as `site:linkedin.com/in/ "<company>" recruiter`. Public search pages block automated queries, so a key is required or every search returns nothing.

- **Serper** (recommended, https://serper.dev): sign in, open **API Keys**, and put the key in `.env.local` as `SERPER_API_KEY`. Free starter credits, no card. One company search costs roughly three to four credits.
- **SerpApi** (https://serpapi.com): 100 free searches a month. Put the key in `SERPAPI_KEY`.

Only one is needed. The **Find recruiters** page shows a `NO SEARCH API KEY` pill until one is set.

### 2. Google OAuth client for Gmail sending (required to send, about 10 minutes)

The app sends from your Gmail using the official API. It asks only for `gmail.send` plus your email address, and it never reads your inbox. Each person needs their own OAuth client; do not share one.

1. Go to https://console.cloud.google.com, create a project (any name), and enable the **Gmail API** under *APIs & Services → Library*.
2. Under *APIs & Services → OAuth consent screen*, choose **External**, fill in the app name and your email, and add **yourself as a test user**. (Internal only works for Google Workspace accounts.)
3. Under *Credentials → Create credentials → OAuth client ID*, choose **Web application** and add this exact Authorized redirect URI:

   `http://localhost:3000/api/auth/callback`

4. Copy the client ID and secret into `.env.local`:

   ```env
   GOOGLE_CLIENT_ID=your-oauth-client-id
   GOOGLE_CLIENT_SECRET=your-oauth-client-secret
   GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/callback
   ```

5. Start the app, open **Connections → Connect Gmail**, and approve the sending permission.

The port is fixed at 3000 because the redirect URI has to match exactly.

### 3. Make it yours (optional, edit `search.config.json`)

Everything specific to one kind of job search lives in `search.config.json` at the repo root. Edit it and restart `npm run dev`.

| Key | What it controls | Default |
| --- | --- | --- |
| `workspace.label`, `workspace.focus` | The label under your avatar in the sidebar. | "Your job search" / "New-grad software engineering" |
| `search.roleKeyword` | The word appended to the LinkedIn search: `site:linkedin.com/in/ "<company>" <roleKeyword>`. | `recruiter` |
| `search.audience` | The one-line description on the search page. | "University, early-career, and technical recruiters." |
| `search.exampleCompanies` | The "Try …" buttons next to the search box (up to 5). | Stripe, Microsoft, Datadog |
| `recruiterTerms` | Regex fragments; a search result must contain at least one to count as a recruiter at all. | recruit\\w*, talent acquisition, early careers, campus hiring, university relations |
| `focusTiers` | Ordered ranking tiers. A result matches a tier when any `any` term appears and, if `also` is given, at least one `also` term appears too. The first tier ranks highest. | Early careers, then Technical recruiting |
| `fallbackFocus` | Label for recruiters that match no tier. | "Review recruiting focus" |
| `template.subject`, `template.message` | The default email a new workspace starts with. Placeholders: `{first_name}`, `{full_name}`, `{company}`, `{email}`. | New-grad software engineering outreach |

Regex fields are JavaScript regular expressions inside JSON strings, case-insensitive, so a backslash must be doubled (`"new.?grad"`, `"recruit\\w*"`). Invalid entries stop the app at startup with a message naming the field.

Example: pointing the app at product-design internships.

```json
{
  "workspace": { "label": "Your job search", "focus": "Product design internships" },
  "search": { "roleKeyword": "design recruiter", "audience": "Design and early-career recruiters.", "exampleCompanies": ["Figma", "Airbnb", "Notion"] },
  "recruiterTerms": ["recruit\\w*", "talent acquisition", "talent partner", "early careers", "university relations"],
  "focusTiers": [
    { "label": "Design recruiting", "any": ["design", "ux", "product"], "also": ["recruit", "talent"] },
    { "label": "Early careers", "any": ["university", "campus", "early.?career", "intern"] }
  ],
  "fallbackFocus": "Review recruiting focus",
  "template": { "subject": "Product design internship at {company}", "message": "Hi {first_name},\n\n…" }
}
```

The default template only seeds a brand-new workspace. After that, edit it in the app under **Default email**, where you also upload the resume that is attached to every recruiter batch.

### What is private and stays out of Git

- `.env.local`: your API key and Google client credentials.
- `.local-data/`: Gmail tokens, contacts, send history, the saved email template, your resume, and cached research pages.
- Build output and tool caches (`dist/`, `.next/`, `.vinext/`, `.wrangler/`, `*.tsbuildinfo`).

All of these are listed in `.gitignore` and denied by the development file server. `search.config.json` and `.env.example` are intentionally committed.

## Search to batch outreach

Type a company name and choose **Find recruiters**. While the search runs, the page shows a four-step progress strip (LinkedIn results → company domain → RocketReach formats → email candidates); the full request-by-request log lives in the **Requests** tab. Name and company-association extraction from LinkedIn search results runs first; automatic discovery does not request LinkedIn profile pages. If no matching profiles are found, later research is skipped with a diagnostic explanation. Official website and email-domain discovery, mail-server checks, and RocketReach format scraping follow.

Results are shown as one card per recruiter: name, title, focus, the top-ranked address with its RocketReach usage percentage, an expandable list of every possible format, and the LinkedIn source. Two buttons follow: **Send my default email to all** uses the message saved under **Default email**; **Write a custom message** opens an editor first (with an option to save it as the new default). Either way a review dialog lists every recipient, shows the exact personalized email for each, and sends only after you tick the authorization box and click **Authorize & send**. Placeholders `{first_name}`, `{full_name}`, `{company}`, and `{email}` are filled in per recruiter. The top-ranked address is used for each person; previously contacted recruiters and duplicate addresses are skipped automatically. The server saves the exact reviewed messages for ten minutes, then Gmail sends a separate message to each recipient, up to eight per batch. Sending is not mailbox verification, and recipients do not see each other's addresses.

A resume (PDF, DOC, or DOCX up to 5 MB) can be uploaded once under **Default email**; it is stored as `.local-data/resume.bin` with restricted permissions and its name, size, and date in `workspace.json`. Recruiter batches always include it — the authorize dialog has no attach/detach option, and if no resume is saved the dialog stops and links to the upload instead of sending. Only **Send yourself a test** offers an attachment toggle. Every message is sent as `multipart/alternative` — the plain text plus a simple HTML twin (paragraphs and line breaks only, no tracking or styling beyond a standard font) — so it renders at normal width like a hand-written Gmail message. Attached messages wrap that in `multipart/mixed` through the same Gmail API call, and history rows show the attached filename.

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
