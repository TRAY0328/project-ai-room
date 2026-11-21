# tests/security

`security_cases.test.mjs` — the 50 cases from `security_cases.json`, each with the
control that implements it and an executable assertion where the control lives
in this repo.

Status vocabulary used by the suite (and by the final report):

- **PASS** — exercised here, against the real D1 schema and the real worker, and
  the refusal was observed.
- **DELEGATED_TO_OTHER_TRACK** — the control is rendering/UI (link protocol,
  code-block rendering, phishing warning) or client/CI packaging (APK signing
  key custody). This track's half of the control (the server stores and returns
  opaque data and never renders or executes it) is covered by S31/S43.
- **BLOCKED_EXTERNAL_DEPENDENCY** — proving it needs a real GitHub Actions
  runner on a real private repository (S27 supply chain).

Current result (see the report for the run log):

```
security_cases: 50, passed: 45, delegated: 4, blocked_external: 1
```

Run:

```
node --test tests/security/*.test.mjs
```

The suite fails if any PASS case fails, if a case is missing, or if the status
counts do not add up to 50. It never marks a case PASS because a control is
assumed to exist.
