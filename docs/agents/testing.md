# Testing

Use focused tests while iterating, then run the checks that cover the changed surface area.

## Placement

- Unit tests live next to source files as `*.spec.ts`.
- Web tests use Vitest with setup in `apps/web/src/test-setup.ts`.
- API tests use Vitest with setup in `apps/api/src/test-setup.ts`.
- Use `vi.fn()` or local fixtures for mocks.
- Prefer interaction-focused specs for complex board behavior.

## Focused Commands

- Web typecheck: `pnpm exec nx typecheck web`
- API typecheck: `pnpm exec nx typecheck api`
- Web tests: `pnpm exec nx test web -- --run`
- Focused web spec: `pnpm exec nx test web -- --run src/path/to/file.spec.ts`
- Focused API spec: `pnpm exec nx test api -- --run src/path/to/file.spec.ts`
- Web lint: `pnpm exec nx lint web`
- API lint: `pnpm exec nx lint api`
- Shared board lint: `pnpm exec nx lint board-commons`

API specs that call `startDB()` (`src/tests/*`, `mcp.spec.ts`, `schema.spec.ts`, `layout-service.spec.ts`) seed users and delete boards, so they refuse any database whose name does not end in `_test`. Create one once (`createdb tapiz_test`) and point the tests at it, either per run with `POSTGRES_DB=tapiz_test pnpm exec nx test api -- --run` or with an untracked root `.env.test.local` containing `POSTGRES_DB=tapiz_test`, which Nx loads for the test target only.

When passing a test file to Nx/Vitest, use the path relative to that Nx project root. For example, from the workspace root use `src/app/validation.spec.ts` for `api`, not `apps/api/src/app/validation.spec.ts`.

## Coverage Expectations

- Changes to shared validators should have API or validator tests.
- Board geometry should have pure utility tests where possible.
- UI-only changes should at least pass typecheck and lint; add component or interaction tests when behavior can regress without TypeScript catching it.
- Database schema changes should include the relevant migration and migration-oriented tests.
