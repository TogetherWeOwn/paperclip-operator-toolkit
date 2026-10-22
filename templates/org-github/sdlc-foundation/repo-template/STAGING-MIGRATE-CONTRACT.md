# Staging-migrate contract (TOG-24386, staged for the public repo-template repo)

Every repo created from the template honors this contract from day 1:

1. Staging first: deploys land on staging and prove green before production.
2. Never regress prod to prove staging; a red staging blocks promotion.
3. Migrations run against staging data only; production migrates after the
   staging apply is recorded and reviewed.
4. No new paid SaaS or Actions-minute spend without a recorded decision.
