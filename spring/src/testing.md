# Testing Strategy & Architecture

For test commands, tiers, and FakeAws usage, see [spring](../spring.md#test-tiers). This document covers the design rationale behind the test structure.

---

## Design Principle: Environment Isolation

We distinguish between testing *business logic* (which requires determinism) and *cloud security* (which requires live infrastructure). Each test tier isolates a different combination of code path and infrastructure.

### Execution Contexts

- **Unit Tests:** Run in a simple JVM class loader. No Spring dependency injection.
- **Integration Tests:** Run inside a mocked Spring container. Beans are wired, but no TCP port is opened.
- **System Tests & Manual Script:** Spin up the embedded Tomcat server on a real port. They test the application exactly as it runs in Docker/Production.

### Testing Layers

**A. Unit & Component Layer (the "Brain"):** Verify complex logic in a vacuum. Direct method calls into parsing, validation, and export logic. No AWS, no auth. Key files: `ParserTest.kt`, `DataManTest.kt`.

**B. Integration Layer (the "Wiring"):** Verify that controllers, services, and JSON/Excel parsing work together without network flakiness. Uses MockMvc through the `-nosec` controllers with `FakeAws` providing a deterministic in-memory S3 simulation. Key files: `ConfigLogicDataIT.kt`, `ConfigLogicTranslationsIT.kt`.

**C. Functional System Layer (the "Machinery"):** Verify the running binary handles binary streams (Excel) over HTTP without corruption. Real HTTP requests through `-nosec` controllers against real S3. Key files: `ConfigLogicDataST.kt`.

**D. Security System Layer (the "Gatekeeper"):** Prove that IAM roles and `@PreAuthorize` annotations actually reject unauthorized users. Real HTTP through the security filter chain and secured controllers against real Cognito. Fetches real JWTs for internal (read/write) and external (read-only) clients and asserts that read-only clients receive `403 Forbidden` on POST requests. Key files: `ConfigLogicSecurityST.kt`, `manual_tests.sh`.

---

## The "FakeAws" Concept

We avoid mocking the AWS SDK static classes. Instead, we use a polymorphic service pattern:

1. **Interface:** `Aws` service class with S3 operations
2. **Real implementation:** Wraps the AWS SDK. Used in system tests and production.
3. **Fake implementation:** `FakeAws` (inherits from `Aws`). Used in unit and integration tests. Every `put` ticks a manual clock forward exactly 1 second, so version-ordering tests are 100% reproducible.

_Benefit:_ Tests run in milliseconds with no network dependency. _Benefit:_ "Time travel" debugging -- you can set the clock to any instant and verify time-dependent behavior.

---

## Tradeoffs

**Shared State Contamination vs. Fidelity:** System tests (`ConfigLogicDataST`) write to the dev S3 bucket. This creates noise and risks state conflicts if multiple developers/pipelines run simultaneously. Using LocalStack for S3 would prevent contamination but introduces lower fidelity -- it does not perfectly emulate AWS IAM enforcement, S3 Object Lock, or specific S3 error codes. Current decision: prioritize high fidelity. We test against real AWS S3 and accept dirty dev data as a cost of higher confidence.

**Cognito Fidelity (Hard Constraint):** We explicitly avoid LocalStack for security tests. Emulating Cognito's JWT signing and OAuth2 flows is notoriously low-fidelity. Live testing is the only way to prove IAM policies actually work.

**Security Isolation:** By splitting secured and nosec controllers, we can debug data issues without fighting login screens, while the security system tests provide a dedicated audit of permissions.

**Binary Integrity:** System tests specifically test the round-trip of Excel files, ensuring the Spring HTTP converter doesn't corrupt binary data -- a common bug in Spring Web.