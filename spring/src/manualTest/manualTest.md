## Manual Tests

End-to-end tests that exercise the deployed API (or a locally running instance) including authentication, CORS headers, and browser-facing behavior. _Note_, that in contrast to corresponding automated (kotlin) system tests, which retrieve the internal and external client tokens dynamically, the manual test test that the specific long term credentials you have distributed to the client (client id and secret) work as expected.

### Setup

Set `API_BASE` in the script depending on whether you want to test the app running **locally** or **remotely** (deployed):

- If testing locally, make sure the app is running first (e.g. `./gradlew bootRun`)
- Even when testing a locally running app, the real (dev) S3 bucket is used for pulling/pushing data

You can run the manual tests in _local_ mode (`--local`) if the application is running with the  [test_harness](../testing.md) profile active. In this case the `nosec` endpoints are used and no authentication is necessary. Otherwise you must make the necessary client credentials available as env vars:

```bash
export INT_CLIENT_ID=<val>
export INT_CLIENT_SECRET=<val>
export EXT_CLIENT_ID=<val>
export EXT_CLIENT_SECRET=<val>
```

See [idp](../../../cdk/app/idp/idp.md) for how to retrieve these credentials from the deployed Cognito stack.

### Execute

```bash
./manual_tests.sh [--local]
```

~~~
Running in LOCAL mode (no auth, -nosec endpoints)
API_BASE: http://localhost:8080/api
OUTPUT_DIR: /mnt/c/Users/declan.moran/AppData/Local/Temp/s3-rest-demo/out
Cleaning output directory: /mnt/c/Users/declan.moran/AppData/Local/Temp/s3-rest-demo/out

>>> Step A: Upload Valid Data (Seeding)...
PASS (Got 200) for Post Products when TESTING: Int:
PASS (Got 200) for Post Bytes when TESTING: Int:

>>> Step D: Verify Read Access...
PASS (Got 200) for Get Products when TESTING: Int:
PASS (Got 200) for Get Bytes when TESTING: Int:
PASS (Got 200) for Get Versions when TESTING: Int:

>>> Step E: Verify Input Validation (Expect 400)...
PASS (Got 400) for Post Empty Bytes when TESTING: Sanity: -> Server said: "Image payload must not be empty."
PASS (Got 400) for Post Bad JSON when TESTING: Sanity: -> Server said: "Missing required top-level field: 'products'."
PASS (Got 200) for Post Non-Octet CT when TESTING: Sanity:
PASS (Got 200) for Post Arbitrary Bytes when TESTING: Sanity:

>>> Step G: Verify Metadata Consistency...

Checking Products Consistency:
 PASS Version match (1772663199)
 PASS Timestamp match (2026-03-04T22:26:39)

Checking Binary Consistency:
 PASS Version match (1772663200)
 PASS Timestamp match (2026-03-04T22:26:40)

All tests passed.
~~~

The script fetches real JWTs from Cognito using the client credentials above, then exercises the secured API endpoints, verifying HTTP status codes, response headers (CORS), and content types.