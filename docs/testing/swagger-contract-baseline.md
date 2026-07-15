# Swagger/OpenAPI Contract Baseline

The baseline is generated from the active Nest application using `scripts/generate-openapi.ts` and stored at `docs/testing/openapi-baseline.json`.

## Contract rules

- REST prefix remains `/api/v1`; GraphQL remains `/api/v2/graphql`.
- Existing paths and HTTP methods are compatibility constraints.
- Request parameters, request bodies, responses, required/optional fields, enums, security metadata and schema references are compared.
- `scripts/compare-openapi.ts` reports missing routes, changed contracts, duplicate operation IDs and broken schema references.
- Unstable `servers` entries are normalized out; no business contract fields are discarded.

## Route-precedence scenarios

The itinerary controller must continue to resolve static routes such as `/details/:quoteId`, `/latest`, `/customer-info/:planId`, `/confirmed`, `/cancelled`, and `/hotel-rooms/categories` before the generic numeric `/:id` route.
