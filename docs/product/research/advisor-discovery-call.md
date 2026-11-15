# Advisor discovery calls vs. our intake

**Date:** 2026-11-14 · **Author:** travel PM · **Status:** desk research, not yet validated with advisors

**Summary.** A human advisor's discovery call is 10-30 minutes. It covers five things: the logistics of the trip (where, when, how long, who, budget), why the client is going and what would make it a success, how they like to travel (pace, style, deal-breakers), what past trips they loved or hated, and practical needs (mobility, diet, documents). Advisors also qualify the client: fees, who decides, and fit. Our intake asks for three of these: destination, purpose and, when the purpose is vague, interests. It then confirms a one-line recap, which matches the advisor practice of sending a recap after the call. The two biggest gaps are **when** and **who is travelling**. Every source treats both as baseline, and today they sit in a free-form planner question, never confirmed or stored. My recommendation: add both to the brief, but ask only when the guest hasn't already said them (destination and purpose answers often contain them), so the intake grows by at most two short turns. Leave budget, pace, deal-breakers and needs to the planner, which should ask them in context the way advisors do (budget last, framed as comfort tiers, never "what's your budget?"). Make a returning-guest profile the long-term home for the durable facts, such as past trips, diet, mobility and home airport. Skip all booking and admin data. The biggest unknown is whether consumers in a self-serve chat will put up with any extra questions. Advisor clients have already chosen to hire someone; our guests haven't. That needs testing before we lengthen anything.

**Decision this informs:** what, if anything, to add to or change in our intake, and what should instead be asked later by the planner, kept in a returning-guest profile, or never asked, given that the intake should stay short.

Claim labels used throughout: **[E]** evidence (sourced), **[IK]** industry knowledge (my experience, unsourced), **[H]** hypothesis (needs validation). All sources were accessed 2026-11-14.

---

## 1. What our intake collects today

Read from the code on 2026-11-14:

| Step | Who asks | What is stored | Source |
|---|---|---|---|
| Name (given + surname) | Web app, scripted | `GuestIdentity`, typed by the guest | `packages/shared/src/intake.ts`, `apps/web/src/components/Chat.tsx` |
| Title (Mr/Ms/Mrs/Mx/Dr/none) | Web app, scripted | `prefix` | same |
| Destination ("a city, a region or a landscape", suggestions offered if undecided) | Scripted question, answered to the intake agent | `TripBrief.destination` | `travel-agent.ts` intake prompt |
| Purpose ("what brings you on the trip") | Intake agent | `TripBrief.purpose` | same |
| Interests (10 base options + up to 3 destination-specific extras), **only if the purpose is general** | Intake agent, `InterestPicker` | `TripBrief.interests` | same |
| Confirm the brief ("So that's <purpose> in <destination>, with a focus on <interests>") | `TripBrief` recap with "Looks perfect" / "Change something", editable per field | `briefConfirmed` | `IntakeComponents.tsx` |

After the intake, the planner is told: *"Ask a short clarifying question when something important is missing (dates, budget, who is travelling)."* Anything the planner learns is never written back to the brief. The intake is stored in an in-memory `Map` per conversation (`apps/api/src/intake/intake.service.ts`), so nothing carries over between conversations or trips. The Parlant backend (`apps/parlant/travel_agent/prompts.py`) mirrors the same steps.

So, today: **2 identity questions + 2-3 trip questions + 1 confirmation.** Dates, travellers and budget are left to the planner's judgement.

---

## 2. What a real discovery call covers

### 2.1 Format and sequence

- **It usually has two parts: a short form first, then a call.** Before the call, advisors send a logistics-focused "travel interest survey" or intake form (destination, rough dates, group size, budget range, whether the client has used an advisor before, how they found you). The call then covers motivation and preferences. **[E]** [HAR, How to qualify clients, 2024](https://hostagencyreviews.com/blog/how-to-qualify-clients-travel-agent); [PTN, Qualifying travel clients, 2026-04-21](https://ptntravel.com/stop-wasting-hours-on-the-wrong-leads-your-guide-to-qualifying-travel-clients/); [Travelweek, Discovery Calls 101, 2022-09-20](https://www.travelweek.ca/blog/fast-efficient-successful-discovery-calls-101/)
- **There is a counter-trend: a short call and no long form up front.** Travefy's sales workshop recommends a 10-15 minute call and warns that long intake forms early on add friction. The detailed questionnaire comes after the client hires the advisor. **[E]** [Travefy, Sales workflow, 2026-01-13](https://travefy.com/blog-post/travel-agent-sales-workflow). The HAR six-step system does the same: a 30-minute introduction call, then a detailed per-group questionnaire only after hiring. **[E]** [HAR, 6-step onboarding, 2026-05-18](https://hostagencyreviews.com/blog/from-first-call-to-lifelong-client-a-six-step-system-for-onboarding-new-clients)
  - *What this means for us:* even advisors split the work into **a short qualifier now and depth later**. That is the same shape as our intake-then-planner split. **[IK]** This matches my own practice: I never asked for passport details on a first call.
- **The typical sequence:** rapport and small talk, then how they found you, then the story and inspiration, then who is travelling and who else decides, then the vision (where, when, style), then must-haves and deal-breakers, then **budget last**, then an honest fit check, then a written recap and next steps. **[E]** [Travelweek, The power of the discovery call, 2025-06-17](https://www.travelweek.ca/blog/sphere-homebased/the-power-of-the-discovery-call/); [Travelweek 2022](https://www.travelweek.ca/blog/fast-efficient-successful-discovery-calls-101/) ("We always discuss budget at the end of the call, once we've established their priorities.")
- **The client does most of the talking.** Sources stress listening, open-ended questions and not pitching. One study guide puts it at roughly 80% listening and 20% asking. **[E]** [Travefy 2026](https://travefy.com/blog-post/travel-agent-sales-workflow); [HAR 2024](https://hostagencyreviews.com/blog/how-to-qualify-clients-travel-agent); [open-exam-prep TAP guide](https://open-exam-prep.com/study-guides/tap/sales-ethics-communication/consultative-selling)
- **Advisors send a recap after the call so the client can correct misunderstandings.** **[E]** [HAR 2024](https://hostagencyreviews.com/blog/how-to-qualify-clients-travel-agent); [Travelweek 2022](https://www.travelweek.ca/blog/fast-efficient-successful-discovery-calls-101/). Our `TripBrief` confirmation is the same practice, done in-line.

### 2.2 Themes, with essential vs. nice-to-have

"Essential" means the sources call it the minimum, or an advisor can't make a credible first proposal without it. That judgement is mine unless a source says so.

**A. Trip logistics (the "bare minimum")**
| Item | Essential? | Basis |
|---|---|---|
| Destination or trip type | Essential | Every source. **[E]** |
| When: dates or season, and how flexible | Essential | "Where, when and how much… is the bare minimum" (TravelPulse, via search snippet; the page returned 403 so I couldn't read it in full). Listed on every intake form reviewed. **[E]** [HAR 2024](https://hostagencyreviews.com/blog/how-to-qualify-clients-travel-agent), [PTN 2026](https://ptntravel.com/stop-wasting-hours-on-the-wrong-leads-your-guide-to-qualifying-travel-clients/) |
| Trip length | Essential | HAR logistics list, HAR questionnaire §3. **[E]** |
| Who is travelling: number, relationships, children's ages | Essential | Every source. "Tell me a bit about your family: how old are your kids…" [TMR, 25 qualifying questions, 2023-05-21](https://www.travelmarketreport.com/articles/25-Qualifying-Questions-to-Help-You-Nail-Your-Clients-Vacation-Plans). **[E]** |
| Budget / "investment range" | Essential to advisors, but *asked late and indirectly* | PTN calls a budget range "non-negotiable" on the intake form, while HAR 2026 and Travelweek say never open with it. See 2.3. **[E]** |
| Departure city / home airport | Essential once air is involved | HAR questionnaire §3. **[E]** |
| Cabin class, accommodation preferences | Nice-to-have at discovery, needed at proposal | HAR questionnaire §3. **[E]** |

**B. Motivation and vision**
| Item | Essential? | Basis |
|---|---|---|
| Purpose / what's driving the trip | Essential. Coaches say to start here. | "Their main goal should be finding out what is motivating them to travel in the first place" (search snippet, TravelPulse); [PTN 2026](https://ptntravel.com/stop-wasting-hours-on-the-wrong-leads-your-guide-to-qualifying-travel-clients/). **[E]** |
| Celebration or milestone | High value, cheap to ask | TMR Q9 "Are you celebrating any milestone?"; HAR questionnaire §4. **[E]** **[IK]** It changes suppliers' amenities and the whole tone of a proposal. |
| What success looks like ("what would make it a 10 out of 10", "what will you say on the flight home") | Advisors' favourite question, but not strictly necessary | [Travefy 2026](https://travefy.com/blog-post/travel-agent-sales-workflow); TMR Q4, Q8. **[E]** |
| How they want to feel, what memories they want to bring home | Nice-to-have | HAR questionnaire §4. **[E]** |
| Must-do experiences | Essential if there are any | HAR 2024 "must-do activities"; TMR Q2. **[E]** |

**C. Travel style**
| Item | Essential? | Basis |
|---|---|---|
| Pace / activity level ("active, easy pace") | Essential for itinerary building | TMR Q7; HAR questionnaire §4. **[E]** |
| **What they *don't* want / deal-breakers** ("no tours before 10am, modern bathroom") | High value. Advisors call it out specifically. | TMR Q5, Q6; Travelweek 2025 "must-haves and deal-breakers"; HAR §4 "things to avoid". **[E]** |
| Party vs. quiet atmosphere; how adventurous they are with food | Nice-to-have | TMR Q23-25. **[E]** |
| Hobbies and general interests | Nice-to-have | TMR Q20-22; HAR 2024. **[E]** |
| Options vs. a curated plan; how involved they want to be | Nice-to-have. Shapes the proposal format. | HAR questionnaire §5. **[E]** |

**D. Travel history and aspirations**
| Item | Essential? | Basis |
|---|---|---|
| Past trips: favourite, worst, and why | Advisors' main proxy for taste *and for budget* | TMR Q10-13; HAR 2024 "highlights and lowlights of your last vacation"; Travelweek 2025. **[E]** |
| Bucket list / dream destination | Nice-to-have. A source of future trips. | TMR Q14-16. **[E]** |
| How they normally book; whether they've used an advisor before | Qualification only | HAR, PTN, Travelweek. **[E]** |

**E. Practical needs and constraints**
| Item | Essential? | Basis |
|---|---|---|
| Mobility and accessibility | Essential when it applies; the cost of a miss is high | HAR questionnaire §1; Travelweek 2022 "health concerns". **[E]** |
| Dietary restrictions and allergies | Essential when it applies | HAR questionnaire §1. **[E]** |
| Pre-existing conditions, travel insurance | Proposal stage | HAR questionnaire §5. **[E]** |
| Passport / nationality, ID expiry | Booking stage. Nationality drives entry rules. | HAR questionnaire §1. **[E]** **[IK]** Nationality is the input that most often catches self-planners out (visas, ETIAS/ETA-style permits, six-month passport validity). |

**F. Booking and admin data (collected after hiring, not on discovery)**
Legal names as on ID, dates of birth, Known Traveler/Global Entry numbers, loyalty numbers, rooming, emergency contacts, payment authorisation. **[E]** [HAR 2026 questionnaire §1](https://hostagencyreviews.com/blog/from-first-call-to-lifelong-client-a-six-step-system-for-onboarding-new-clients). Loyalty memberships are sometimes raised on discovery because they shape recommendations. **[E]** [Travelweek 2025](https://www.travelweek.ca/blog/sphere-homebased/the-power-of-the-discovery-call/)

**G. Advisor-side qualification**
Who the decision-maker is, readiness, how they found you, other advisors they've contacted, prior research, openness to fees, and fit with the advisor's niche. PTN scores budget alignment, decision authority, timeline, openness to process and niche fit. **[E]** [PTN 2026](https://ptntravel.com/stop-wasting-hours-on-the-wrong-leads-your-guide-to-qualifying-travel-clients/); [Travefy 2026](https://travefy.com/blog-post/travel-agent-sales-workflow). Most of this protects the advisor's unpaid time, a problem we don't have.

### 2.3 How advisors handle budget

Budget is the one item where practice clearly diverges:
- **Direct:** ask for a range on the form ("Proposed budget"), and clarify whether it is per person or total and what it includes (air, transfers, meals). **[E]** [HAR, "Should travel agents say the B word?", updated 2023-12-29](https://hostagencyreviews.com/blog/should-travel-agents-say-the-b-word)
- **Investigative:** infer it from past trips, hotels they've stayed in and their occupation, and ask late if at all ("I don't ask!"). **[E]** same source
- **Indirect:** avoid the word. Ask instead about a comfortable "price range", a per-person figure, or a resort level ("moderate, superior, luxury"). **[E]** same source
- **Why:** "Never open with 'What's your budget?'", because clients lowball out of fear of being overcharged. **[E]** [HAR 2026](https://hostagencyreviews.com/blog/from-first-call-to-lifelong-client-a-six-step-system-for-onboarding-new-clients). Newer travellers often don't know what things cost. **[E]** [HAR B-word](https://hostagencyreviews.com/blog/should-travel-agents-say-the-b-word); [open-exam-prep](https://open-exam-prep.com/study-guides/tap/sales-ethics-communication/consultative-selling)
- Some advisors **deliberately show one option above the stated range** to show what's possible. **[E]** [HAR B-word](https://hostagencyreviews.com/blog/should-travel-agents-say-the-b-word)

**[H]** For an AI with no fee to protect, the best pattern is likely the indirect, tiered one, asked *after* the guest has seen a first idea, because a concrete idea makes cost tangible.

### 2.4 Phrasing patterns worth borrowing for the concierge voice

- Open-ended rather than yes/no: ask "how would you like to get from the airport?", not "do you want transfers?" **[E]** [HAR 2024](https://hostagencyreviews.com/blog/how-to-qualify-clients-travel-agent)
- Ask permission before personal questions: "Would it be OK if I asked about…", "Do you mind if I ask…" **[E]** [Travelweek 2025](https://www.travelweek.ca/blog/sphere-homebased/the-power-of-the-discovery-call/)
- Ask about the negative space: "What *don't* you want to do?", "What was your worst trip and why?" **[E]** [TMR 2023](https://www.travelmarketreport.com/articles/25-Qualifying-Questions-to-Help-You-Nail-Your-Clients-Vacation-Plans)
- Ask about the outcome, not features: "What would make this trip a 10 out of 10?" **[E]** [Travefy 2026](https://travefy.com/blog-post/travel-agent-sales-workflow)
- "Is there anyone else who should be included…?" catches hidden co-planners. **[E]** [Travelweek 2025](https://www.travelweek.ca/blog/sphere-homebased/the-power-of-the-discovery-call/)

### 2.5 Why clients use advisors (and what that implies)

- Expedia/Wakefield, 5,000 respondents in 10 countries (published 2025-02): expert advice and convenience 52%, exclusive deals and personalised service 45%, handling emergencies 38%, finding the ideal destination and accommodation 37%. International (50%) and multi-destination (41%) trips are seen as advisor territory. **[E]** [OpenJaw, 2025-02-19](https://openjaw.com/newsroom/retail/2025/02/19/expert-advice-among-top-reasons-travellers-use-advisors-survey). The US cut has expert advice at 53% and time savings at 52% (TAAP 2024 report, via search summary; I didn't read the PDF in full). This is an Expedia TAAP study, which has an interest in favouring advisors.
- *Implication:* **[H]** People come for expertise and saved time. An intake that feels like paperwork works against the second, while a planner that asks the *right* question at the right moment (the way an expert would) supports the first.

---

## 3. How competitors handle intake (brief)

| Product | Category | Intake approach | Note |
|---|---|---|---|
| **Mindtrip** | Consumer AI planner | Free chat; asks you to "tell us about yourself": "what you love doing, what you'd rather skip, your budget, who you're traveling with". Preferences are stored in an editable profile. The founder has described a travel quiz that sets a persona. **[E]** [Mindtrip traveler FAQ](https://resources.mindtrip.ai/travelers/help/traveler-faqs.md); [Product Hunt](https://www.producthunt.com/products/mindtrip) (secondary) | No forced intake, and the profile carries over. I couldn't confirm whether the quiz is still live. |
| **Layla** | Consumer AI planner (reportedly owned by Expedia; unverified) | Chat-first: "Tell me your style and budget, and I'll design a trip". The FAQ lists dates, destinations, budget and style. **[E]** from search snippets of [layla.ai](https://layla.ai/) and [layla.ai/faq](https://layla.ai/faq); the FAQ fetch returned 429 | Asks for budget early. One Trustpilot review complains the offers were too expensive for a low budget. **[E]** [Trustpilot](https://www.trustpilot.com/review/layla.ai?page=2) (snippet) |
| **Advisor tools (Tern, Fora-hosted forms, Travefy)** | Advisor CRM / forms | Web forms before the call: dates, destinations, travellers, origin, style, budget ("investment range"), priorities, contact preference. Advisors can see answers as they're typed (Tern). **[E]** search results for Tern/Fora forms; [Travefy 2026](https://travefy.com/blog-post/travel-agent-sales-workflow) | Longer forms suit advisors because the client is already committed. |

**[H]** Our gap against the consumer AI planners isn't the *number* of questions, since they ask almost none up front. It's that they keep and reuse preferences (Mindtrip's profile). Our advantage could be the *confirmed* brief: a concierge who restates what it heard, the way a good advisor does.

---

## 4. Gap analysis: discovery items vs. our intake

Status: **Covered / Partly / Missing**. Recommendation:
- **Intake**: add to the intake and the confirmed brief.
- **Planner**: the planner asks in context, when it matters.
- **Profile**: store in a future returning-guest profile.
- **Skip**: don't ask.

| # | Discovery item | Status today | Recommendation | Why |
|---|---|---|---|---|
| 1 | Destination | Covered | Keep | Matches practice, and offering suggestions when the guest is undecided is good. |
| 2 | Purpose / motivation | Covered | Keep | Advisors lead with this. |
| 3 | Interests / must-dos | Covered (conditional picker) | Keep | Skipping it for specific purposes is the right instinct. |
| 4 | **When: dates or season, plus length** | Missing (planner may ask) | **Intake, ask only if not already said.** One question that accepts anything from "next spring, about a week" to exact dates. Show it in the brief. | Every source treats it as baseline. Without it the planner can't use web search well (events, closures, seasonality), and that is the planner's main differentiator. **[H]** A fuzzy answer is enough. |
| 5 | **Who is travelling (count, relationship, children's ages)** | Partly: sometimes implied in the purpose ("with my partner"), not stored | **Intake, ask only if not implied by the purpose.** Show it in the brief. | Baseline for every source. It changes pace, lodging and activities. Often free to extract. |
| 6 | Budget / comfort level | Missing (planner may ask) | **Planner**, after a first idea, framed as tiers (e.g. "comfortable / superior / luxury") and per person vs. total. Store the answer in the brief once given. | Advisors themselves defer it and warn that early answers are unreliable. **[H]** Asking it in the intake would also clash with the concierge tone. This is the riskiest call: see interview Q5-7. |
| 7 | Celebration / milestone | Partly (only if the guest volunteers it in the purpose) | **Planner**: one natural question early in planning ("Is there an occasion we're marking?"), unless the purpose already says. **[H]** Candidate to fold into the intake purpose question's phrasing at no extra turn. | Cheap and high value. Changes recommendations. |
| 8 | Success criterion ("10 out of 10") | Missing | **Planner, optional.** Skip for short or simple trips. | Advisors love it, but in a chat it can feel like a survey question. **[H]** |
| 9 | Pace / activity level | Missing | **Planner**, before the first day-by-day itinerary. Later **Profile**. | Needed for itineraries, not for the brief. |
| 10 | Deal-breakers / what to avoid | Missing | **Planner** ("Anything you'd rather we avoid?") when proposing. Later **Profile**. | Advisors single this out. It's also a natural reaction to a first draft, so it's easier to answer then than in the abstract. |
| 11 | Accommodation style / tier | Missing | **Planner**, merged with budget (6). Later **Profile**. | Advisors use lodging tier as a proxy for budget. |
| 12 | Past trips loved / hated | Missing | **Profile** (ask once per guest, not per trip). Optionally the planner asks if stuck. | Best taste signal advisors have, but too slow for a short intake. |
| 13 | Mobility / accessibility | Missing | **Planner**: ask when proposing anything physical. **Profile** once known. **[H]** Consider a light "anything I should know?" at the brief (see opportunity 3). | Rare but high-stakes. Never block the intake on it. |
| 14 | Dietary / allergies | Missing | **Planner** when recommending food. **Profile**. | Same reasoning. |
| 15 | Departure city / home airport | Missing | **Planner** when transport comes up. **Profile**. | Needed for air and timing, not for the brief. |
| 16 | Nationality / passport (entry rules) | Missing | **Planner**, only when giving entry or visa guidance. Don't store passport numbers. | Valuable for "what you don't know" help. Sensitive, so ask only for nationality. |
| 17 | Options vs. curated; involvement level | Missing | **Skip for now** (the planner can infer it from behaviour). | Shapes advisor proposals. In chat, the guest steers anyway. |
| 18 | Loyalty programmes | Missing | **Profile, later.** | Only matters if we recommend specific hotels or airlines. |
| 19 | Legal names, DOB, KTN, emergency contacts, payment | Missing | **Skip.** | We can't book. Collecting it adds privacy risk with no use. |
| 20 | Decision-maker / co-planners | Missing | **Skip in the intake.** The planner may offer a shareable summary for group trips (future). | Advisors use it to protect their time. For us it's a group-coordination feature, not a question. |
| 21 | Referral source, prior advisor use, fees, readiness | N/A | **Skip.** | Advisor-business qualification. Our analogue is marketing analytics, not a question to the guest. |
| 22 | Name and title | Covered (we ask first) | Keep, but note it is **not** discovery practice: advisors open with the story, not the formalities. **[IK]** It fits a hotel-concierge persona. | Low risk. See interview Q10. |

**Net effect if adopted:** the intake grows by at most two short, skippable turns (when, who). In the common case where the guest volunteers one or both, it grows by none or one. Everything else moves into explicit planner guidance plus a future profile.

**Supporting change (no extra questions):** the brief should become a *living* record. Facts the planner learns (budget tier, pace, needs) get written back and shown to the guest, the way an advisor's notes accumulate. Today they're lost in the transcript and gone when the conversation ends.

---

## 5. Interview guide: validating with 3-5 advisors

**Goal:** test the riskiest conclusions: (a) when and who belong up front, and nothing else does; (b) budget should wait; (c) needs can be asked in context rather than up front; (d) what carries over between trips.
**Who:** 3-5 working advisors. Mix leisure generalists and luxury/FIT specialists, and if possible include one who uses an online intake form *and* one who doesn't. Aim for 30 minutes each, recorded with consent.

Warm-up
1. Walk me through the last new client you took on, from first contact to proposal. What did you ask before you'd do any research?
2. What do you send *before* the first call, if anything? What did you cut from that form over time, and why?

Minimum viable discovery
3. If you could only ask three questions before sketching a first idea, which would they be? *(Tests whether dates and travellers make everyone's list.)*
4. When a client gives you only a destination and a reason ("Japan, our anniversary"), what's the next thing you need, and what can you safely assume?

Budget (riskiest)
5. When in the conversation do you raise budget, and how do you phrase it?
6. Have you ever shown an idea *before* knowing the budget? What happened?
7. If a client says "I don't know, what does it usually cost?", what do you do?

Needs and deal-breakers
8. How do you find out about mobility, dietary or health needs? Has a client ever *not* mentioned one that mattered? How did you catch it, or miss it?
9. Do you ask "what don't you want?" up front, or wait until they react to a proposal? Which works better?

Tone and format
10. How do you open a first call? Would a client find it odd to be asked their name and how to address them before anything about the trip?
11. When you send a recap after the call, what goes in it? *(Show our brief recap, then ask: what's missing, what's unnecessary?)*

Repeat clients
12. For a returning client, what do you never ask again, and what do you *always* re-ask? *(Tests what belongs in a profile, e.g. budget changes with companions and occasions.)*
13. What's in your client profile that you'd hate to lose?

Close
14. If an AI did the first five minutes of discovery before handing over to you, what would you need it to have captured so you didn't have to repeat it?

**What would change my mind:** if most advisors put budget in their top three *and* report that early budget answers are usable, move a budget-tier question into the intake. If several put "who's travelling" below other items, keep it with the planner. If needs are commonly missed unless asked up front, add the optional "anything I should know" line to the brief.

**Separately (not advisors):** the advisor view can't settle how many questions a *consumer* will tolerate in a self-serve chat. That needs a guest-side test: compare completion rates for the current intake vs. intake + when/who.

---

## 6. Recommended next brief

**`docs/product/briefs/2026-11-xx-trip-timing-and-party.md`: "When and who in the trip brief, plus planner discovery guidance."**
Scope: (1) capture *when* (fuzzy is fine) and *who* in the intake, asking only when not already given, and show both in the `TripBrief` recap; (2) rewrite the planner's "ask a clarifying question" line into explicit, ordered discovery guidance (occasion, then pace, then budget tier after the first idea, then needs in context) using the advisor phrasings above. Non-goals: profiles and persistence, budget in the intake, any booking data. This is the smallest change that tests the riskiest assumption (that two more conditional questions are worth their friction), and it is mostly prompt and schema work.
