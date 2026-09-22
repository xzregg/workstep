# GitHub repository settings

After the first push:

- Enable Issues and Discussions; set the website to `https://xzregg.github.io/workstep/`.
- Allow squash merging and automatic branch deletion.
- Add a default-branch ruleset requiring pull requests, resolved conversations, and the stable CI check; block force pushes and deletion.
- Enable dependency graph, Dependabot alerts/security updates, private vulnerability reporting, secret scanning, and push protection where available.
- Set Pages source to **GitHub Actions**.
- Add repository topics: `llm`, `workflow`, `local-first`, `agent`, `fastapi`, and `react`.

To enable website traffic counts, set repository variable `CLOUDFLARE_WEB_ANALYTICS_TOKEN`. If absent, no analytics script is shipped.

GitHub Traffic shows recent clones, views, referrers, stars, and forks; Releases show asset download counts. Neither is an exact active-user count. WorkStep intentionally adds no desktop telemetry, so download totals are an adoption signal, not unique users.
