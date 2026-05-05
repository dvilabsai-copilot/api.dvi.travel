# GraphQL v2 Notes

- endpoint: /api/v2/graphql
- purpose: additive v2 read-optimized API layer
- REST remains under /api/v1
- first query: dashboardSummaryV2
- auth: existing JWT + RBAC guards support both REST and GraphQL
- migration strategy: gradually move read-heavy nested frontend screens only
