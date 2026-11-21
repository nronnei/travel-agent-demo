# Opportunities

**Date:** 2026-11-14 · **Status:** living list, ranked by user value against effort

**Summary.** These opportunities come from comparing our intake with how human advisors run discovery. The best ratio of value to effort is to capture **when** and **who** in the confirmed brief (asking only when the guest hasn't said them already) and to give the planner explicit, advisor-style guidance on what to ask next and when. Both are mostly prompt and schema changes. A returning-guest profile is probably the most valuable item overall, but it needs accounts, persistence and a privacy stance, so it ranks lower until the cheap items show what's worth remembering. Value scores are hypotheses until validated.

Labels: **[E]** evidence, **[IK]** industry knowledge, **[H]** hypothesis. Main source: [research/advisor-discovery-call.md](research/advisor-discovery-call.md).

| Rank | Opportunity | Persona | User value | Effort | Evidence | Status |
|---|---|---|---|---|---|---|
| 1 | **When and who in the brief.** Ask for timing (fuzzy is fine) and the travelling party only if not already given. Show both in the `TripBrief` recap. | All | High: every advisor source treats these as baseline. **[E]** | Low (schema, prompt and recap UI) | Strong for advisors; guest tolerance untested **[H]** | Recommended next brief |
| 2 | **Planner discovery guidance.** Replace "ask a short clarifying question" with ordered, in-context discovery: occasion, then pace, then budget tier after the first idea, then needs when relevant. Use advisor phrasing. | All | High: better first plans with fewer wasted turns. **[H]** | Low (prompt only) | Advisor practice is well documented. **[E]** | Bundle with 1 |
| 3 | **"Anything I should know?"** An optional line on the brief for occasion, needs and things to avoid. No extra turn if the guest ignores it. | Celebrator, Coordinator | Medium. Catches high-stakes needs early. **[H]** | Low-medium (UI and schema) | Advisors probe needs and deal-breakers. **[E]** | Validate with advisor interviews (Q8-9) |
| 4 | **A living brief.** Facts the planner learns (budget tier, pace, needs, home airport) are written back to the brief and shown to the guest. | All | Medium-high. Feeds 5. | Medium (agent write-back path; agents currently never author canonical values) | Advisors' notes and recaps. **[E]** | After 1-2 |
| 5 | **Returning-guest profile.** Remember past trips, diet, mobility, pace, home airport and tier across trips. | All, especially repeat guests | High. Advisors call profiles their real asset. **[IK]** Mindtrip stores preferences. **[E]** | High (accounts, persistent storage instead of the in-memory map, consent, retention, deletion) | Medium | Later. Needs a product decision on accounts. |
| 6 | **Shareable plan for co-deciders.** | Coordinator | Medium **[H]** | Medium | Advisors ask who else decides. **[E]** | Later |

**Explicitly not opportunities:** collecting booking or admin data (legal names, DOB, passport numbers, KTN, loyalty numbers, payment). We can't book, and holding it adds risk with no user value.
