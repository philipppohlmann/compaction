# Security policy

## Scope

The supported surface is the local-first CLI and its documented open-core
behavior. The repository is not a hosted service, and no public deployment or
remote trace-ingestion endpoint is implied by this policy.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's private
security advisory flow or another private maintainer channel made available by
the repository owner. Do not open a public issue for an unpatched vulnerability.

Include the affected version or commit, a minimal reproduction, and the impact
you observed. Remove API keys, tokens, prompts, customer data, and other
sensitive content before sending the report.

We will acknowledge reports when practicable, investigate them, and coordinate
any disclosure after a fix or mitigation is available. No response time or
severity outcome is guaranteed.

## Safe handling rules

- Never commit secrets or real customer traces.
- Use synthetic fixtures for tests and examples.
- Keep local credentials and generated `.compaction/` artifacts out of commits.
- Do not deploy or expose the repository or local API without explicit
  authorization.
