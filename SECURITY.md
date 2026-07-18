# Security

CML is pilot software. Treat its security posture as explicit and reviewable,
not complete. Do not use the current repo for production customer data,
regulated production workflows, or autonomous downstream writes without a
separate production hardening and security review.

## Reporting

Report suspected vulnerabilities, accidental disclosures, or unsafe write
behaviour privately to the repository maintainer, preferably through GitHub's
private vulnerability reporting for this repository. Within a pilot, use the
agreed pilot coordination channel instead. Do not include real secrets in
issues, logs, screenshots, or chat excerpts.

## Secret handling

- Commit `.env.example`, never `.env`.
- Keep API keys, MCP tokens, database files, vault roots, and deployment URLs
  in local configuration or a secret manager.
- Rotate any credential that may have been committed, pasted, logged, or
  shared outside the intended pilot boundary.
- Run a secret scan before publication (see below).

## MCP exposure

The public MCP gateway should expose the smallest useful tool set.
Write-capable vault tools require an integer intent mandate and should be
paired with scoped path rules, a required actor, and a short-lived bearer
token.

For externally reachable pilots, prefer OAuth/OIDC mode over static public
bearer tokens. Do not run OAuth-enabled gateways with insecure mode enabled.

The built-in pilot OAuth issuer is for private pilots where CML owns the MCP
authorisation surface. Generate its RSA private key and browser access key
with `npm run oauth:bootstrap`; keep `.env.oauth.local` and `var/oauth/` out
of git and rotate them before moving between environments.

## Local data

The default SQLite database and vault directory are local state. They are
ignored by git and should not be copied into release artefacts.

Set retention and deletion rules before a pilot starts. Delete or export local
databases, WAL/SHM files, vault material, OAuth stores, logs, and screenshots
according to the agreed close-out plan.

## Before publishing

Do not publish: `.env` files other than `.env.example`; local SQLite
databases and WAL/SHM files; generated `dist/`, coverage, logs, and temp
files; agent worktrees; internal runbooks; diagrams carrying internal
deployment detail; or contract drafts that belong to a private operating
environment.

Review every untracked file before export:

```sh
git status --short
git ls-files --others --exclude-standard
```

Run a lightweight secret scan:

```sh
rg -n -I --pcre2 '(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (RSA |DSA |EC |OPENSSH |)PRIVATE KEY-----)' -g '!.git/**' -g '!node_modules/**' -g '!dist/**'
```

If available, also run `gitleaks detect --source .` or
`trufflehog filesystem .`.
