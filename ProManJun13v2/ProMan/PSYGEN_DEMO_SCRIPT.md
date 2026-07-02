# PSYGEN Report Module — Demo Script (~3–4 min)

Simple, on-camera narration. Focus is on **how the rule-based engine turns clinician input into a report**.

---

## SCENE 1 — Dashboard (~30s)

> "This is PSYGEN, our report module. From this dashboard, clinicians manage all their psychological reports in one place.
>
> At the top we see the counts — **Total, Drafts, Submitted, Approved, and Finalized**. Below, each report shows the **client, case number, template, and status**. Statuses move from **Draft**, to **Signature Required**, to **Released**. To make a report, we click **New Report**."

---

## SCENE 2 — Step 1: Template (~25s)

> "Reports are made in **5 steps**: Template, Client, Assessment, Generate, and Submit.
>
> First we pick a **template**. There are three — **Neurodevelopmental**, **Clinical Psychological**, and **Pre-Employment**. Each one has its own sections. We'll use the Clinical template."

---

## SCENE 3 — Steps 2 & 3: Client + Inputs (~25s)

> "Next we enter the **client's information**.
>
> Then we enter the **assessment data** — the clinician's own notes from the session: **Observational Notes, Behavioral Observations, and Interview Findings.** This is the only writing the clinician does. Everything else, the system builds."

---

## SCENE 4 — Step 4: Generate — HOW IT WORKS (~90s) ⭐ main part

> "This is the heart of PSYGEN. When the clinician clicks **Generate Narratives**, the system reads those notes and writes the clinical report.
>
> And here's the important part — **how it actually does it.** This is a **rule-based engine. It is not AI and it is not a chatbot.** It follows fixed clinical rules, step by step.
>
> **Step one — it reads the words.** The engine scans the clinician's notes and looks for known clinical keywords. We keep a **clinical dictionary** — for example, words like *worried, nervous, restless, or panic* all point to **anxiety**; words like *tired, insomnia, or can't sleep* point to a **sleep problem.** It even understands Taglish, like *kaba* or *puyat* — and it ignores negatives, so *'no anxiety'* is not counted as anxiety.
>
> **Step two — it decides how strong it is.** For each finding, the engine sets a level — **mild, moderate, or severe** — based on the words used and any scores entered.
>
> **Step three — it picks the matching sentence.** Every finding is linked to a rule, like an **IF–THEN**: *IF the notes show anxiety, THEN use the anxiety sentence.* Each rule pulls a ready, professionally-written clinical sentence from our **fragment library** and drops the client's name into it.
>
> **Step four — it assembles the report.** All the chosen sentences are placed into the correct sections — emotional functioning, risk, recommendations — and that becomes the finished narrative you see here.
>
> **Quick example:** the clinician writes *'client feels nervous and can't sleep.'* The engine detects **anxiety** and a **sleep problem**, fires those two rules, and writes: *'[Client] reported notable anxiety, accompanied by overthinking and restlessness…'* plus a sentence about disrupted sleep.
>
> Because every sentence comes from a fixed rule, the report is **consistent and traceable** — the same input always gives the same result, and every line can be traced back to the rule that wrote it. That's exactly what a clinical report needs."

---

## SCENE 5 — Step 5: Submit (~20s)

> "The narrative fills in the report. The clinician reviews it, then clicks **Submit** — and it enters the **signature and release** workflow we saw on the dashboard. From simple session notes to a finished, signed report."

---

**Timing:** ~3:10. To reach 4:00, slow the Scene 4 example. To cut to 3:00, drop the example paragraph.
