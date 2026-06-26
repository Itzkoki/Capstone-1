# Graph Report - ProMan  (2026-06-16)

## Corpus Check
- 136 files · ~656,561 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1368 nodes · 2621 edges · 89 communities (75 shown, 14 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 4 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 74|Community 74]]
- [[_COMMUNITY_Community 75|Community 75]]
- [[_COMMUNITY_Community 76|Community 76]]
- [[_COMMUNITY_Community 77|Community 77]]
- [[_COMMUNITY_Community 78|Community 78]]
- [[_COMMUNITY_Community 79|Community 79]]
- [[_COMMUNITY_Community 80|Community 80]]
- [[_COMMUNITY_Community 81|Community 81]]
- [[_COMMUNITY_Community 82|Community 82]]
- [[_COMMUNITY_Community 83|Community 83]]
- [[_COMMUNITY_Community 84|Community 84]]
- [[_COMMUNITY_Community 86|Community 86]]
- [[_COMMUNITY_Community 87|Community 87]]

## God Nodes (most connected - your core abstractions)
1. `api()` - 59 edges
2. `toast()` - 58 edges
3. `api()` - 46 edges
4. `toast()` - 45 edges
5. `showLoading()` - 39 edges
6. `hideLoading()` - 39 edges
7. `showLoading()` - 30 edges
8. `hideLoading()` - 30 edges
9. `authenticate()` - 25 edges
10. `esc()` - 16 edges

## Surprising Connections (you probably didn't know these)
- `extractArticle()` --calls--> `$()`  [INFERRED]
  backend/services/articleScraper.js → landing-content.js
- `sanitizeHtml()` --calls--> `$()`  [INFERRED]
  backend/services/articleScraper.js → landing-content.js
- `mount()` --calls--> `render()`  [INFERRED]
  bps-calendar.js → navbar.js
- `getIntakeForms()` --calls--> `sweepUnpaidIntakes()`  [EXTRACTED]
  backend/controllers/intakeController.js → backend/services/intakeCleanup.js
- `verifyPayment()` --calls--> `promoteIntakeForAppointment()`  [INFERRED]
  backend/controllers/paymentController.js → backend/services/intakePromote.js

## Import Cycles
- None detected.

## Communities (89 total, 14 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.04
Nodes (60): allArchive, ALLOWED_ROLES, allReports, allTemplates, allTrash, backToPdfPreview(), _cal, _calOutside() (+52 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (50): allArchive, ALLOWED_ROLES, allReports, allTemplates, allTrash, backToPdfPreview(), _cal, _calOutside() (+42 more)

### Community 2 - "Community 2"
Cohesion: 0.11
Nodes (47): ACCEPTED_MIMES, ActivityLog, assignRequest(), audit(), CONCERN_KIND, CONCERN_STATUSES, concernRequiresVersion(), concernStatus() (+39 more)

### Community 3 - "Community 3"
Cohesion: 0.06
Nodes (37): ActivityLog, approveArticle(), Article, articleScraper, createArticle(), deleteArticle(), getAllArticles(), getArticle() (+29 more)

### Community 4 - "Community 4"
Cohesion: 0.16
Nodes (42): api(), bulkArchiveReports(), bulkDeleteReports(), bulkPermanentDeleteTrash(), bulkRestoreTrash(), canDeleteReport(), closeModal(), deleteReport() (+34 more)

### Community 5 - "Community 5"
Cohesion: 0.19
Nodes (40): api(), bulkArchiveReports(), bulkDeleteReports(), bulkRestoreArchive(), closeModal(), createReportFromForm(), deleteReport(), delTpl() (+32 more)

### Community 6 - "Community 6"
Cohesion: 0.06
Nodes (34): { activityLogger }, app, appointmentRoutes, articleRoutes, assessmentIntakeRoutes, authRoutes, caseRoutes, communityRoutes (+26 more)

### Community 7 - "Community 7"
Cohesion: 0.05
Nodes (9): db, DocuSealService, NotificationService, PdfGenerator, PsychologicalReport, ReportAudit, ReportTemplate, RuleEngine (+1 more)

### Community 8 - "Community 8"
Cohesion: 0.09
Nodes (31): ActivityLog, arr(), createTeamMember(), deleteTeamMember(), getAdminLanding(), getClientIP(), getPublicLanding(), KNOWN_SECTIONS (+23 more)

### Community 9 - "Community 9"
Cohesion: 0.10
Nodes (34): admitParticipant(), assignClient(), buildSessionView(), consentRecording(), createSession(), db, endSession(), getAllSessions() (+26 more)

### Community 10 - "Community 10"
Cohesion: 0.17
Nodes (28): $all(), applyOrderAndVisibility(), fallbackCarousel(), hydrate(), hydrateAbout(), hydrateCta(), hydrateHeader(), hydrateHero() (+20 more)

### Community 11 - "Community 11"
Cohesion: 0.13
Nodes (26): Appointment, approveSchedule(), cancelAppointment(), checkConflicts(), clientConfirm(), clientDecline(), clientRequestChange(), editAppointment() (+18 more)

### Community 12 - "Community 12"
Cohesion: 0.11
Nodes (25): ACCEPTED_PROOF_MIMES, ActivityLog, Appointment, Case, createPayment(), getClientIP(), getPayment(), getPaymentCounts() (+17 more)

### Community 13 - "Community 13"
Cohesion: 0.10
Nodes (25): addKeyword(), Article, ContentFlag, ForumReply, ForumThread, getKeywords(), getPendingFlags(), getStats() (+17 more)

### Community 14 - "Community 14"
Cohesion: 0.12
Nodes (23): addNote(), approveReport(), Case, CaseAuditLog, CaseNote, ClinicalAssessment, closeCase(), completeAssessment() (+15 more)

### Community 15 - "Community 15"
Cohesion: 0.12
Nodes (24): approveThread(), createReply(), createThread(), crisisDetection, deleteReply(), deleteThread(), ForumReply, ForumThread (+16 more)

### Community 16 - "Community 16"
Cohesion: 0.12
Nodes (21): bcrypt, crypto, forgotPassword(), generateOTP(), generateResetToken(), jwt, login(), LoginAttempt (+13 more)

### Community 17 - "Community 17"
Cohesion: 0.11
Nodes (21): abandonCheckout(), Appointment, Case, checkoutIntake(), db, getIntakeForm(), getIntakeForms(), Notification (+13 more)

### Community 18 - "Community 18"
Cohesion: 0.12
Nodes (20): bcrypt, crypto, fullName(), generateOTP(), getClientIp(), issueSession(), jwt, login() (+12 more)

### Community 19 - "Community 19"
Cohesion: 0.09
Nodes (21): dependencies, bcryptjs, cheerio, cors, dotenv, express, express-rate-limit, express-validator (+13 more)

### Community 20 - "Community 20"
Cohesion: 0.15
Nodes (20): ActivityLog, bcrypt, createStaff(), getActivityLogs(), getAllStaff(), getClientIP(), getStaffActivity(), getStaffById() (+12 more)

### Community 21 - "Community 21"
Cohesion: 0.12
Nodes (18): authorize(), authorizeMinRole(), ROLE_LEVELS, { authenticate }, { authorize, authorizeMinRole }, caseCtrl, express, router (+10 more)

### Community 22 - "Community 22"
Cohesion: 0.12
Nodes (19): AuditLog, bcrypt, changePassword(), crypto, db, deleteProfile(), generateOTP(), generateResetToken() (+11 more)

### Community 23 - "Community 23"
Cohesion: 0.12
Nodes (15): db, getCommunityStats(), db, search(), authenticate(), jwt, Staff, { authenticate } (+7 more)

### Community 24 - "Community 24"
Cohesion: 0.11
Nodes (11): db, db, { Pool }, CaseAuditLog, db, db, FAQ, db (+3 more)

### Community 25 - "Community 25"
Cohesion: 0.18
Nodes (19): editTpl(), esc(), generateNarratives(), openModal(), openRcReview(), openRcVersions(), openRrPayment(), openRrReview() (+11 more)

### Community 26 - "Community 26"
Cohesion: 0.19
Nodes (15): mount(), buildItem(), dashItemsForRole(), ensureBadgeEl(), esc(), fileOf(), getToken(), icSvg() (+7 more)

### Community 27 - "Community 27"
Cohesion: 0.14
Nodes (15): Appointment, Case, db, getAssessmentIntakeForm(), getAssessmentIntakeForms(), notificationService, rowToFormData(), submitAssessmentIntake() (+7 more)

### Community 28 - "Community 28"
Cohesion: 0.15
Nodes (14): createMeeting(), endMeeting(), getMeeting(), getMeetings(), Meeting, notificationService, updateConsent(), crypto (+6 more)

### Community 29 - "Community 29"
Cohesion: 0.17
Nodes (14): { body, validationResult }, COMMON_PASSWORDS, forgotPasswordRules, handleValidation(), loginRules, registerRules, resendOtpRules, resetPasswordRules (+6 more)

### Community 30 - "Community 30"
Cohesion: 0.12
Nodes (11): ContentFlag, db, db, ForumReply, db, ForumThread, ContentFlag, db (+3 more)

### Community 31 - "Community 31"
Cohesion: 0.13
Nodes (14): 1. Install Dependencies, 2. Configure Environment, 3. Create the Database & Schema, 4. Start the Server, API Endpoints, Features, `GET /api/health`, `POST /api/auth/login` (+6 more)

### Community 32 - "Community 32"
Cohesion: 0.20
Nodes (15): editTpl(), esc(), generateNarratives(), openModal(), openRrPayment(), openRrReview(), renderFindingsTable(), rrBadge() (+7 more)

### Community 33 - "Community 33"
Cohesion: 0.16
Nodes (12): db, getSystemHealth(), getSystemSettings(), SystemSettings, updateSystemSettings(), db, SystemSettings, { authenticate } (+4 more)

### Community 34 - "Community 34"
Cohesion: 0.17
Nodes (12): batchGetVotes(), castVote(), getVote(), removeVote(), VALID_TYPES, Vote, db, Vote (+4 more)

### Community 35 - "Community 35"
Cohesion: 0.14
Nodes (14): `appointments`, `assessments`, `audit_log`  *(New)*, `case_notes`  *(New)*, `cases`, Database Schema, `intake_forms`, `notifications` (+6 more)

### Community 36 - "Community 36"
Cohesion: 0.21
Nodes (12): createFaq(), deleteFaq(), FAQ, getAllFaqs(), getCategories(), getFaq(), updateFaq(), { authenticate } (+4 more)

### Community 37 - "Community 37"
Cohesion: 0.15
Nodes (12): getProfile(), verifyPassword(), { body }, CIVIL_STATUS_VALUES, GENDER_VALUES, updateProfileRules, { authenticate }, express (+4 more)

### Community 38 - "Community 38"
Cohesion: 0.14
Nodes (6): ReportAudit, ReportTemplate, db, ReportTemplate, db, ReportAuditService

### Community 39 - "Community 39"
Cohesion: 0.14
Nodes (13): 0. Architecture recap, Decisions / notes, Phase 1 — Provision the VPS (~20 min), Phase 2 — Install the stack (~15 min), Phase 3 — Database setup (~10 min), Phase 4 — Deploy the app code (~10 min), Phase 5 — Run the app under PM2 (~5 min), Phase 6 — Nginx reverse proxy + TLS 1.3 (~15 min) (+5 more)

### Community 40 - "Community 40"
Cohesion: 0.14
Nodes (13): 0. Architecture recap, Decisions / notes, Phase 1 — Provision the VPS (~20 min), Phase 2 — Install the stack (~15 min), Phase 3 — Database setup (~10 min), Phase 4 — Deploy the app code (~10 min), Phase 5 — Run the app under PM2 (~5 min), Phase 6 — Nginx reverse proxy + TLS 1.3 (~15 min) (+5 more)

### Community 41 - "Community 41"
Cohesion: 0.24
Nodes (11): deleteNotification(), getNotifications(), getUnreadCount(), markAllAsRead(), markAsRead(), markAsUnread(), Notification, { authenticate } (+3 more)

### Community 42 - "Community 42"
Cohesion: 0.19
Nodes (13): clearAssessmentInputs(), collectPreempTests(), createReportFromForm(), currentTemplateType(), loadIntakeClients(), loadTemplatesForCreate(), loadTemplatesView(), nextCreateStep() (+5 more)

### Community 43 - "Community 43"
Cohesion: 0.17
Nodes (11): rateLimit, staffLoginLimiter, staffLoginRules, { body }, express, { login, verifyOtp, resendOtp }, resendRules, router (+3 more)

### Community 44 - "Community 44"
Cohesion: 0.15
Nodes (10): db, Notification, ASSIGNABLE_ROLES, db, Staff, Notification, notificationService, sgMail (+2 more)

### Community 45 - "Community 45"
Cohesion: 0.17
Nodes (11): Case Status Lifecycle, Clinic Management System — Case-Centered Architecture, Data Integrity and Audit Requirements, Design Philosophy, Notification Catalog, Permission Matrix, Role-Based Access Control (RBAC), Roles (+3 more)

### Community 46 - "Community 46"
Cohesion: 0.17
Nodes (11): 0. Current State (what already exists), Cross-cutting: Secrets & Config, Data Protection & Backup Module — Implementation Plan, Out of Scope / Decisions Needed, Phase 1 — Transport Security & Hardening (Quick wins, ~1 day), Phase 2 — Encryption at Rest (AES-256, ~2–3 days), Phase 3 — Audit Trail Enhancement (~1–2 days), Phase 4 — Backup & Encrypted Storage (~2 days) (+3 more)

### Community 47 - "Community 47"
Cohesion: 0.21
Nodes (9): db, ModerationKeyword, BUILTIN_PATTERNS, determineAction(), filterContent(), keywordCache, ModerationKeyword, preprocess() (+1 more)

### Community 48 - "Community 48"
Cohesion: 0.20
Nodes (11): clearAssessmentInputs(), currentTemplateType(), loadIntakeClients(), loadSectionsEditor(), loadTemplatesForCreate(), loadTemplatesView(), nextCreateStep(), renderAssessmentStep() (+3 more)

### Community 49 - "Community 49"
Cohesion: 0.20
Nodes (10): Completing the Assessment, Phase 11 — Report Release, Phase 12 — Case Closure, Phase 1 — Intake Submission, Phase 4 — Appointment Scheduling, Phase 5 — Assessment Conduct, Phase 6 — Report Drafting, Phase 8 — Report Request Submission (+2 more)

### Community 50 - "Community 50"
Cohesion: 0.20
Nodes (9): Appointment Scheduling & Payment — Two-Phase Flow, Config, Files, Modified, New, Phase 1 — Intake & Schedule Proposal, Phase 2 — Payment (only after the schedule is confirmed), Security / compliance (unchanged) (+1 more)

### Community 51 - "Community 51"
Cohesion: 0.27
Nodes (10): bulkPermanentDeleteTrash(), bulkRestoreTrash(), filterTrash(), getSelectedTrashIds(), getTrashChecks(), loadTrash(), renderTrashStats(), renderTrashTable() (+2 more)

### Community 52 - "Community 52"
Cohesion: 0.42
Nodes (9): clearSession(), getHomePage(), getToken(), getUser(), guardProtectedPage(), isLoggedIn(), loginPageForUser(), logout() (+1 more)

### Community 53 - "Community 53"
Cohesion: 0.33
Nodes (8): db, ensureFeatureColumns(), ensureNotificationCategoryEnum(), ensureRequestTables(), fs, path, runMigrations(), seedLandingDefaults()

### Community 54 - "Community 54"
Cohesion: 0.28
Nodes (9): applySignature(), closeEsignModal(), headers(), launchEsignBuilder(), mountDocusealBuilder(), mountDocusealForm(), openEsignModal(), proceedToSigning() (+1 more)

### Community 55 - "Community 55"
Cohesion: 0.28
Nodes (9): bulkRestoreArchive(), filterArchive(), getArchiveChecks(), getSelectedArchiveIds(), loadArchive(), renderArchiveStats(), renderArchiveTable(), syncArchiveBulkBar() (+1 more)

### Community 56 - "Community 56"
Cohesion: 0.28
Nodes (9): applySignature(), closeEsignModal(), headers(), launchEsignBuilder(), mountDocusealBuilder(), mountDocusealForm(), openEsignModal(), proceedToSigning() (+1 more)

### Community 57 - "Community 57"
Cohesion: 0.22
Nodes (9): loadReportConcerns(), pdfEditorClose(), pdfEditorSave(), rcBuildIdentDataUrl(), rcBuildIdentPdfBytes(), rcCloseEdit(), rcSaveVersionFromSections(), refreshReportConcernBadge() (+1 more)

### Community 58 - "Community 58"
Cohesion: 0.36
Nodes (8): countOpenUnseenRequests(), getSeenRequests(), markReportRequestSeen(), refreshReportRequestBadge(), rrSeenKey(), rrSend(), saveSeenRequests(), setNavBadge()

### Community 59 - "Community 59"
Cohesion: 0.38
Nodes (7): filterReports(), getReportChecks(), getSelectedReportIds(), renderReportTable(), syncBulkBar(), toggleSelectAll(), updateBulkBar()

### Community 60 - "Community 60"
Cohesion: 0.43
Nodes (6): baseUsername(), db, run(), splitName(), STAFF_ROLES, uniqueUsername()

### Community 61 - "Community 61"
Cohesion: 0.33
Nodes (4): crypto, db, SECURITY_EMOJI_SET, TeleconferenceSession

### Community 62 - "Community 62"
Cohesion: 0.33
Nodes (5): COLORS, fs, LOGO_PATH, path, PdfGenerator

### Community 63 - "Community 63"
Cohesion: 0.60
Nodes (5): dismissToast(), ensureContainer(), escHtml(), pruneToasts(), show()

### Community 64 - "Community 64"
Cohesion: 0.40
Nodes (4): getAssignableStaff(), express, { getAssignableStaff }, router

### Community 66 - "Community 66"
Cohesion: 0.50
Nodes (3): contentFilter(), notificationService, profanityFilter

### Community 68 - "Community 68"
Cohesion: 0.67
Nodes (3): 1. User Identifier — Permanent Account Identity, 2. Case Identifier — Episode-Based Clinical Identifier, Core Identifiers

### Community 69 - "Community 69"
Cohesion: 0.67
Nodes (3): Option A — Approve Intake, Option B — Reject Intake, Phase 2 — Intake Review

### Community 70 - "Community 70"
Cohesion: 0.67
Nodes (3): Option A — Approve Payment, Option B — Reject Payment, Phase 3 — Initial Payment Verification

### Community 71 - "Community 71"
Cohesion: 0.67
Nodes (3): Option A — Approve Report, Option B — Return for Revision, Phase 7 — Director Approval

### Community 72 - "Community 72"
Cohesion: 0.67
Nodes (3): Option A — Approve Request, Option B — Reject Request, Phase 9 — Report Request Review

### Community 73 - "Community 73"
Cohesion: 0.67
Nodes (3): Option A — Payment Approved, Option B — Payment Rejected, Phase 10 — Report Request Payment Verification

### Community 74 - "Community 74"
Cohesion: 0.67
Nodes (3): generateNarratives(), restoreVersion(), updateSection()

## Knowledge Gaps
- **566 isolated node(s):** `db`, `{ Pool }`, `Appointment`, `Notification`, `notificationService` (+561 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **14 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `authenticate()` connect `Community 23` to `Community 2`, `Community 3`, `Community 8`, `Community 9`, `Community 11`, `Community 12`, `Community 13`, `Community 15`, `Community 17`, `Community 20`, `Community 21`, `Community 27`, `Community 28`, `Community 29`, `Community 33`, `Community 34`, `Community 36`, `Community 37`, `Community 41`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **What connects `db`, `{ Pool }`, `Appointment` to the rest of the system?**
  _566 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.035789473684210524 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.04858757062146893 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.10857142857142857 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.05919661733615222 - nodes in this community are weakly interconnected._
- **Should `Community 6` be split into smaller, more focused modules?**
  _Cohesion score 0.05555555555555555 - nodes in this community are weakly interconnected._