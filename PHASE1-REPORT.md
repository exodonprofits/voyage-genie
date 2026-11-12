# Phase 1 report

Status as of the Phase 1 cleanup commits on `claude/dazzling-goodall-7xat0a`.

## 1. Links to files that don't exist

Fixed in Phase 1: the customs guide rename, three homepage cards, and five trip-dashboard cards (three became coming-soon cards; eSIM and parking now point at `esim-guide.html` and `parking-tips.html`).

Still broken (Voyage Genie pages only):

| Missing target | Linked from | Suggested fix |
|---|---|---|
| `images/` (whole folder) | 43 pages (`nav-icon.png`), homepage heroes (`beachortropical.jpg`, `hotel.jpg`, `cruise1.jpg`, `adventure1.jpg`, random `bg*.jpg`) | Upload the folder from the server. Not in the repo. |
| `privacy.html`, `terms.html` | register, contact, smart-trip-finder | Write them. Needed before any affiliate ID goes live. |
| `affiliate-disclosure.html` | smart-trip-finder | Write it. Booking.com and Viator require a disclosure. |
| `forgot-password.html` | login | Build it (Supabase `resetPasswordForEmail`), or remove the link. |
| `explore-this-destination.html` | 4 trip itineraries, visa-check (button built as `explore-this-destination.html?destination=…`) | Same coming-soon treatment, or build the page. |
| `/cdn-cgi/l/email-protection` | contact | Page was saved from a browser behind Cloudflare. The email links only work while the domain is proxied by Cloudflare. Replace with a plain `mailto:`. |

Not real links (ignored): `href="URL"` in airport-lounge-finder, airport-transfer-planner, customs-entry-guide, layover-guide and travel-insurance is text inside AI prompt strings.

Links from pages that don't belong to Voyage Genie (`dashboard.html`, `add-telecom.html`) are left out; see section 3.

## 2. Ad-blocker class names (not fixed yet)

These class names match ad-blocker filter patterns, so the elements are likely hidden for anyone running uBlock or AdBlock:

| Class prefix | Pages |
|---|---|
| `affiliate-card`, `affiliate-link`, `affiliate-note`, `affiliate-sidebar`, `affiliate-title`, `affiliate-card-title` | adventure/airbnb/cruise planners, 4 itineraries, airport-departure-planner, airport-lounge-finder, airport-transfer-planner, customs-entry-guide, jet-lag-planner, layover-guide, travel-insurance, packing-checklist |
| `deal-banner`, `deal-btn`, `deal-card` | same set plus visa-check |
| `aff-link`, `aff-note`, `aff-card`, `aff-title`, `aff-arrow`, `aff-link-transport` | adventure/airbnb itineraries, packing-checklist, visa-check, cruise-trip-planner |
| `promo-btn` | tropical-trip-planner |
| `sponsor-grid`, `sponsor-col-1/2`, `sponsor-people-grid`, `sponsor-rules-grid`, `sponsor-applied-note` | trip-cost-tracker, trip-budget-settlement |

The `sponsor-*` ones matter most: they're on the cost-splitting UI that Phase 2 builds on. Proposed fix: rename to neutral prefixes (`book-*` for booking panels, `split-*` for the cost-splitting UI). This goes with item 5 because it touches the same files.

## 3. Duplicate and stray pages (nothing deleted)

| Page | What it does | Linked from | Recommendation |
|---|---|---|---|
| `packing-checklist.html` | Full checklist: share, import/export, print, AI suggest, reads planner context | 15 pages incl. homepage | **Keep** |
| `packing-assistant.html` | Rule-based list from destination/dates/activities; CSV export, print. Branded GenieSphere | nothing | Delete |
| `packing-assistant-ai.html` | AI list via n8n `packing-assistant-ai` webhook | nothing | Delete, after checking the AI prompt isn't better than checklist's "AI Suggest" |
| `trip-cost-tracker.html` | Group cost tracking, splits, settlement, reports; Supabase `trips` | homepage, trip-dashboard | **Keep** |
| `travel-budget-planner.html` | Simple category budget (flights, lodging, food…); `<title>` is "Confirmation" | nothing | Delete |
| `trip-dashboard.html` | Voyage "My Trips" dashboard; Supabase `trips`, `user_trips` | 37 pages | **Keep** |
| `dashboard.html` | **Rental Genie** dashboard (properties, leases, rent_log) | only `detail.html` | Delete (wrong product) |
| `add-telecom.html` | Phone/TV/internet tracker (another product) | nothing | Delete (wrong product) |
| `detail.html` | "Smart Travel Hub | GenieSphere", links to the Rental Genie dashboard | nothing | Delete |
| `departure-location.html` | Bare airport `<select>` fragment, no page shell | nothing | Delete |

Note: `dashboard.html` points at the same Supabase project as Voyage Genie (`pbojacnagutipfhcxltj`). Either Rental Genie shares the project, or the file was copied across. Worth knowing before any RLS work.

## 4. Affiliate readiness

About 200 outbound links across 18 files and 15+ domains (Skyscanner, Viator, SafetyWing, Booking.com, Airbnb, GetYourGuide, World Nomads, Kayak, Google Travel, Hotels.com, Vrbo, Expedia, Cruises.com, Airalo, Holafly, LoungeBuddy, Priority Pass, Amazon, Omio).

- Parameter-based (easy): Booking.com `aid`, Viator `pid`/`mcid`, GetYourGuide `partner_id`.
- Network deep links (different URL format, not a parameter): Skyscanner, Expedia Group, Kayak, Hotels.com, Vrbo.
- Airbnb ended its affiliate program in 2021. No ID to configure.
- `smart-trip-finder.html` already has a local `PARTNER` object; it moves into `js/partners.js`.

## 5. Other

- `supabase-js` is imported unpinned (`cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm`). A breaking major release would break every auth page at once. Pin a version.
- `airport-transfer-planner.html` is a full page (739 lines) but the homepage shows it as "coming soon". The trip dashboard links to it normally. Pick one.
