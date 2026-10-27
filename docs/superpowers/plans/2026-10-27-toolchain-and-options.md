# Reproducible Toolchain and Typed Options Implementation Plan

**Goal:** Pin Node 24 and Bun with mise and replace TypeScript enums with JSII-compatible value classes while preserving autocomplete and Zod validation.

**Approved design:** Only Node and Bun are mise tools; do not add the CDK CLI. Keep CDK library versions in package.json, pin JSII and pacmak exactly, and preserve the Node >=24 consumer requirement. Authentication and endpoint options become classes with private constructors, static readonly instances, and a string value validated with Zod. The constructor's props schema accepts these instances, not arbitrary strings.

## Tasks (direct execution)

- [x] Add regression tests in `test/web-function.test.ts` asserting named instances, underlying values, and rejection of invalid values; run them and confirm failure with the existing enums.
- [x] Add `src/web-function-options.ts`, update `src/web-function.ts` to validate and unwrap instances, and export the classes through `src/index.ts`.
- [x] Add `.mise.toml` pinning Node 24.22.1 and Bun 1.4.4; pin JSII 6.0.19 and pacmak 1.142.0 in package.json and update bun.lock with Bun.
- [x] Document mise installation/execution and typed options in README.md.
- [x] Verify tool versions, frozen dependency installation, tests, JSII build, generated assembly/declarations, packaging, and git whitespace checks under mise. Preserve unrelated root index.ts and leave changes unpushed.
