# Cross-Join Pipeline Design

## Intent

Reduce memory and latency in hybrid SQL + NoSQL joins by sending filters to each native source and support grouped counts, sums, and averages over joined records.

## Goals

- Accept `filtrosSql` and `filtrosNoSql` as arrays of `{ campo, operador, valor }` criteria combined with AND.
- Push SQL Server criteria into parameterized SQL and Firestore criteria into native `.where()` clauses.
- Support post-join `groupBy` and `aggregations` (`COUNT`, `SUM`, `AVG`) while retaining only aggregate state when requested.
- Preserve workspace checks, masking, pagination, timeouts, and existing row/byte caps.
- Add focused tests, including a stress case with more than 10,000 records and timing/heap observations.

## Non-goals

- Arbitrary SQL, OR expressions, computed expressions, or aggregations in source databases.
- Adding extraction adapters for database engines that currently have no native extractor.

## Constraints

- Criteria use an allowlist of operators shared by SQL Server and Firestore; field names are validated and SQL values are always bound parameters.
- Group keys refer to the unified joined row keys, including `sql.` / `nosql.` prefixes when names collide.
- Existing extraction and join caps remain enforced.

## Approaches

- Filter after extraction: simple but loads rows that should be discarded; rejected because it misses the main performance goal.
- Build provider-specific raw query fragments: flexible but unsafe and inconsistent; rejected.
- Use a shared typed filter contract translated by each native adapter: selected because it provides pushdown with safe, predictable behavior.
- Materialize all joined rows before aggregation: fits the current service but increases peak memory; incremental aggregation during the join is selected to retain only grouped state.

## Chosen behavior

`CrossJoinDto` exposes optional `filtrosSql`, `filtrosNoSql`, `groupBy`, and `aggregations`. Criteria are ANDed and validated against a shared operator enum. Aggregation metrics use `{ operation, field?, as }`; `COUNT` may omit `field` to count rows, while `SUM` and `AVG` require a numeric field. For LECTOR users, source rows are masked before aggregation; metrics derived from masked values remain masked even under custom aliases. Pagination and output masking apply to the post-aggregation result as they do to ordinary joined rows.

## Builder decisions

Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, and `not-in`; list operators require a nonempty list of at most 10 scalar values. Null is supported for equality and inequality. Non-numeric non-null values in `SUM` / `AVG` cause a bad-request error; null values are ignored.
