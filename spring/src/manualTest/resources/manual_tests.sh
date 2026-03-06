#!/bin/bash

# =============================================================================
# Manual API Tests - s3-rest-demo
# =============================================================================
# Exercises the Products API via curl against a live instance.
#
# Key contract assumptions for the binary endpoint (/products/image...):
# - The request body is treated as raw bytes ("application/octet-stream") regardless
#   of the incoming request Content-Type.
# - The server ACCEPTS any incoming Content-Type (it is not used for validation).
# - The server stores/returns bytes; "image" is just a route name, not a guarantee
#   that the payload is a decodable image.
# - Optional: clients may send X-Filename on POST so GET can suggest the same name
#   via Content-Disposition (save-as prompt).
#
# Usage:
#   1) Remote (deployed):
#       export API_BASE="https://dev.api.your-domain.com/api"
#       export AUTH_URL="https://your-auth.auth.eu-west-1.amazoncognito.com/oauth2/token"
#       export INT_CLIENT_ID="..."  INT_CLIENT_SECRET="..."
#       export EXT_CLIENT_ID="..."  EXT_CLIENT_SECRET="..."
#       ./manual_tests.sh
#
#   2) Local (no auth, using -nosec endpoints):
#       ./manual_tests.sh --local
# =============================================================================

# --- Parse arguments ---
LOCAL_MODE=false
if [[ "$1" == "--local" ]]; then
    LOCAL_MODE=true
fi

# --- Configuration ---
if [ "$LOCAL_MODE" = true ]; then
    API_BASE="${API_BASE:-http://localhost:8080/api}"
    NOSEC_SUFFIX="-nosec"
    echo "Running in LOCAL mode (no auth, -nosec endpoints)"
else
    API_BASE="${API_BASE:?Error: Set API_BASE or use --local}"
    NOSEC_SUFFIX=""
    : "${AUTH_URL:?Error: Environment variable AUTH_URL is not set.}"
    : "${INT_CLIENT_ID:?Error: Environment variable INT_CLIENT_ID is not set.}"
    : "${INT_CLIENT_SECRET:?Error: Environment variable INT_CLIENT_SECRET is not set.}"
    : "${EXT_CLIENT_ID:?Error: Environment variable EXT_CLIENT_ID is not set.}"
    : "${EXT_CLIENT_SECRET:?Error: Environment variable EXT_CLIENT_SECRET is not set.}"
fi

echo "API_BASE: ${API_BASE}"

# --- Output Directory ---
# If running in WSL, write to Windows Temp so files are easy to inspect.
if grep -qi microsoft /proc/version 2>/dev/null; then
    WIN_HOME_WSL="$(wslpath "$(cmd.exe /c echo %USERPROFILE% 2>/dev/null | tr -d '\r')")"
    OUTPUT_DIR="${WIN_HOME_WSL}/AppData/Local/Temp/s3-rest-demo/out"
else
    OUTPUT_DIR="/tmp/s3-rest-demo/out"
fi

mkdir -p "$OUTPUT_DIR"
echo "OUTPUT_DIR: $OUTPUT_DIR"

# --- Test Data ---
# We avoid "bad image" naming: bytes are bytes. Some tests use bytes that happen
# to resemble a JPEG header, others use arbitrary text bytes.
SAMPLE_PRODUCTS="${OUTPUT_DIR}/sample_products.json"
SAMPLE_BYTES_JPEGISH="${OUTPUT_DIR}/sample_bytes_jpegish.bin"
TEMP_EMPTY="${OUTPUT_DIR}/temp_empty_file.bin"
TEMP_BAD_JSON="${OUTPUT_DIR}/temp_bad_structure.json"
TEMP_ARBITRARY_BYTES="${OUTPUT_DIR}/temp_arbitrary_bytes.bin"

cat > "$SAMPLE_PRODUCTS" << 'EOF'
{
  "products": [
    {"id": "mt-1", "name": "Manual Test Widget", "price": 9.99},
    {"id": "mt-2", "name": "Manual Test Gadget", "price": 19.99}
  ]
}
EOF

# Minimal JPEG-like bytes (FF D8 FF + padding).
# This is just a convenient binary sample; the server is not expected to decode it.
printf '\xff\xd8\xff' > "$SAMPLE_BYTES_JPEGISH"
dd if=/dev/zero bs=1 count=125 >> "$SAMPLE_BYTES_JPEGISH" 2>/dev/null

touch "$TEMP_EMPTY"
echo '{"wrong_key": "some value"}' > "$TEMP_BAD_JSON"

# Arbitrary non-empty bytes (text is still bytes).
echo "This is arbitrary bytes (text), still valid for an opaque binary endpoint." > "$TEMP_ARBITRARY_BYTES"

# --- Colors ---
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
GRAY='\033[0;90m'

# --- Clean Output ---
echo "Cleaning output directory: $(realpath "$OUTPUT_DIR")"
rm -f "${OUTPUT_DIR}"/Int_*.json "${OUTPUT_DIR}"/Ext_*.json "${OUTPUT_DIR}"/Invalid_*.json "${OUTPUT_DIR}"/Sanity_*.json

FAILED_COUNT=0

# --- Helper: Get OAuth Token ---
get_token() {
    local client_id=$1
    local client_secret=$2
    local token_scope=$3

    local response
    response=$(curl -s -X POST "$AUTH_URL" \
        -u "$client_id:$client_secret" \
        -d "grant_type=client_credentials&scope=$token_scope")

    if [ $? -ne 0 ] || [[ "$response" == *"error"* ]]; then
        echo "DEBUG: Token Error Response: $response" >&2
        return 1
    fi
    echo "$response" | grep -o '"access_token":"[^"]*' | cut -d'"' -f4
}

# --- Fetch Tokens (skip in local mode) ---
TOKEN_INT=""
TOKEN_EXT=""
TOKEN_INT_MOD=""

if [ "$LOCAL_MODE" = false ]; then
    SCOPE_READ_WRITE="api%3A%2F%2Fs3-rest-demo%2Fread+api%3A%2F%2Fs3-rest-demo%2Fwrite"
    SCOPE_READ_ONLY="api%3A%2F%2Fs3-rest-demo%2Fread"

    echo "Fetching tokens..."
    TOKEN_INT=$(get_token "$INT_CLIENT_ID" "$INT_CLIENT_SECRET" "$SCOPE_READ_WRITE")
    TOKEN_EXT=$(get_token "$EXT_CLIENT_ID" "$EXT_CLIENT_SECRET" "$SCOPE_READ_ONLY")

    if [ -z "$TOKEN_INT" ] || [ -z "$TOKEN_EXT" ]; then
        echo "Error: Failed to retrieve tokens."
        exit 1
    fi

    # Make a deliberately invalid token by mutating the tail.
    TOKEN_INT_MOD="${TOKEN_INT::-5}XXXXX"
    echo "Tokens retrieved successfully."
fi

# --- Test Runner ---
# Writes the response body to a file and captures HTTP status code from curl.
# Optional 8th arg: filename to send as X-Filename header (used to influence save-as name on GET).
run_test() {
    local test_name=$1
    local token=$2
    local method=$3
    local endpoint=$4
    local expected_code=$5
    local content_type=$6
    local input_file=$7
    local filename_header=$8

    local ctx="${test_name%%:*}"
    local subj="${test_name#*: }"

    local ext="json"
    local safe_name=$(echo "$test_name" | tr -s ' :/' '_')
    local resp_file="${OUTPUT_DIR}/${safe_name}.${ext}"

    # Warn if POST input file is missing
    if [ "$method" == "POST" ]; then
        if [ -z "$input_file" ] || [ ! -f "$input_file" ]; then
             echo -e "${RED}SKIP${NC} (Input file not found: $input_file) for $subj when TESTING: $ctx"
             return
        fi
    fi

    # Build curl command
    local auth_header=""
    if [ -n "$token" ]; then
        auth_header="-H \"Authorization: Bearer $token\""
    fi

    local fname_header=""
    if [ -n "$filename_header" ]; then
        fname_header="-H \"X-Filename: $filename_header\""
    fi

    local cmd="curl -s -o \"$resp_file\" -w \"%{http_code}\" -X $method \"${API_BASE}/${endpoint}\" $auth_header $fname_header -H \"Origin: https://example.com\""

    if [ "$method" == "POST" ]; then
        cmd="$cmd -H \"Content-Type: $content_type\" --data-binary @\"$input_file\""
    fi

    local actual_code=$(eval $cmd)

    # Result
    local status_color="${RED}"
    local status_label="FAIL"
    if [ "$actual_code" == "$expected_code" ]; then
        status_color="${GREEN}"
        status_label="PASS"
    else
        FAILED_COUNT=$((FAILED_COUNT + 1))
    fi

    # Only attempt to parse "message" on 4xx/5xx.
    local server_msg=""
    if [[ "$actual_code" =~ ^[45] ]]; then
        server_msg=$(grep -o '"message"[[:space:]]*:[[:space:]]*"[^"]*"' "$resp_file" 2>/dev/null | sed 's/^.*:[[:space:]]*"//;s/"$//')
    fi

    local output="${status_color}${status_label} (Got $actual_code)${NC} for $subj when TESTING: ${ctx}:"
    if [ -n "$server_msg" ]; then
        output="$output -> ${GRAY}Server said: \"$server_msg\"${NC}"
    fi

    echo -e "$output"

    if [ "$status_label" == "FAIL" ]; then
        echo -e "      ${GRAY}Response saved to: $resp_file${NC}"
    fi
}

# =============================================================================
# Test Steps
# =============================================================================

# In local mode, use -nosec endpoints; in remote mode, use secure endpoints
P_PRODUCTS="products${NOSEC_SUFFIX}"
P_IMAGE="products/image${NOSEC_SUFFIX}"
P_VERSIONS="products/versions${NOSEC_SUFFIX}"

# --- STEP A: Valid Writes (Seeding Data) ---
echo -e "\n>>> Step A: Upload Valid Data (Seeding)..."
run_test "Int: Post Products" "$TOKEN_INT" "POST" "$P_PRODUCTS" "200" "application/json"          "$SAMPLE_PRODUCTS"        ""
# Documented contract: application/octet-stream. We send that, plus X-Filename for nicer GET save-as.
run_test "Int: Post Bytes"    "$TOKEN_INT" "POST" "$P_IMAGE"    "200" "application/octet-stream" "$SAMPLE_BYTES_JPEGISH"    "sample.bin"

# --- STEP B: Write Protection (remote only) ---
if [ "$LOCAL_MODE" = false ]; then
    echo -e "\n>>> Step B: Verify Write Protection (Expect 403)..."
    run_test "Ext: Post Products" "$TOKEN_EXT" "POST" "$P_PRODUCTS" "403" "application/json"          "$SAMPLE_PRODUCTS"     ""
    run_test "Ext: Post Bytes"    "$TOKEN_EXT" "POST" "$P_IMAGE"    "403" "application/octet-stream" "$SAMPLE_BYTES_JPEGISH" "sample.bin"
fi

# --- STEP C: Auth Token Validation (remote only) ---
if [ "$LOCAL_MODE" = false ]; then
    echo -e "\n>>> Step C: Verify Auth Token Validation (Expect 401)..."
    run_test "Invalid: Get Products" "$TOKEN_INT_MOD" "GET"  "$P_PRODUCTS" "401" "" ""
    run_test "Invalid: Post Products" "$TOKEN_INT_MOD" "POST" "$P_PRODUCTS" "401" "application/json"          "$SAMPLE_PRODUCTS"     ""
    run_test "Invalid: Get Bytes"    "$TOKEN_INT_MOD" "GET"  "$P_IMAGE"    "401" "" ""
    run_test "Invalid: Post Bytes"   "$TOKEN_INT_MOD" "POST" "$P_IMAGE"    "401" "application/octet-stream"  "$SAMPLE_BYTES_JPEGISH" "sample.bin"
fi

# --- STEP D: Valid Reads ---
echo -e "\n>>> Step D: Verify Read Access..."
run_test "Int: Get Products" "$TOKEN_INT" "GET" "$P_PRODUCTS" "200" "" ""
run_test "Int: Get Bytes"    "$TOKEN_INT" "GET" "$P_IMAGE"    "200" "" ""
run_test "Int: Get Versions" "$TOKEN_INT" "GET" "$P_VERSIONS" "200" "" ""

if [ "$LOCAL_MODE" = false ]; then
    run_test "Ext: Get Products" "$TOKEN_EXT" "GET" "$P_PRODUCTS" "200" "" ""
    run_test "Ext: Get Bytes"    "$TOKEN_EXT" "GET" "$P_IMAGE"    "200" "" ""
    run_test "Ext: Get Versions" "$TOKEN_EXT" "GET" "$P_VERSIONS" "200" "" ""
fi

# --- STEP E: Input Validation (Bad Requests) ---
echo -e "\n>>> Step E: Verify Input Validation (Expect 400)..."
# Empty should still be rejected (non-empty requirement).
run_test "Sanity: Post Empty Bytes"     "$TOKEN_INT" "POST" "$P_IMAGE"    "400" "application/octet-stream"  "$TEMP_EMPTY"           "empty.bin"

# Products payload structure validation remains (JSON validator).
run_test "Sanity: Post Bad JSON"        "$TOKEN_INT" "POST" "$P_PRODUCTS" "400" "application/json"          "$TEMP_BAD_JSON"        ""

# Content-Type is accepted even if "wrong" because endpoint treats body as bytes.
run_test "Sanity: Post Non-Octet CT"    "$TOKEN_INT" "POST" "$P_IMAGE"    "200" "application/pdf"           "$SAMPLE_BYTES_JPEGISH"  "sample.bin"

# Arbitrary bytes (text bytes) are still valid for an opaque binary endpoint.
run_test "Sanity: Post Arbitrary Bytes" "$TOKEN_INT" "POST" "$P_IMAGE"    "200" "application/octet-stream"  "$TEMP_ARBITRARY_BYTES"  "arbitrary.txt"

# --- STEP F: CORS (remote only) ---
if [ "$LOCAL_MODE" = false ]; then
    echo -e "\n>>> Step F: Verify CORS Headers..."
    CORS_FILE="${OUTPUT_DIR}/cors_headers.txt"

    # Authenticated pre-flight
    curl -s -I -X OPTIONS "${API_BASE}/${P_PRODUCTS}" \
        -H "Authorization: Bearer ${TOKEN_INT}" \
        -H "Origin: https://example.com" \
        -H "Access-Control-Request-Method: POST" \
        > "$CORS_FILE"

    ACTUAL_STATUS=$(head -n 1 "$CORS_FILE" | tr -d '\r')
    if grep -qi "Access-Control-Allow-Origin" "$CORS_FILE"; then
         echo -e "${GREEN}PASS ($ACTUAL_STATUS)${NC} for CORS Pre-flight when TESTING: Authenticated"
    else
         echo -e "${RED}FAIL ($ACTUAL_STATUS)${NC} for CORS Pre-flight when TESTING: Authenticated (Headers missing)"
         FAILED_COUNT=$((FAILED_COUNT + 1))
    fi

    # Anonymous pre-flight
    curl -s -I -X OPTIONS "${API_BASE}/${P_PRODUCTS}" \
        -H "Origin: https://example.com" \
        -H "Access-Control-Request-Method: POST" \
        > "$CORS_FILE"

    ACTUAL_STATUS=$(head -n 1 "$CORS_FILE" | tr -d '\r')
    if grep -Eq "^HTTP/.* 200" "$CORS_FILE" && grep -qi "Access-Control-Allow-Origin" "$CORS_FILE"; then
         HEADER_VAL=$(grep -i "Access-Control-Allow-Origin" "$CORS_FILE" | tr -d '\r')
         echo -e "${GREEN}PASS ($ACTUAL_STATUS)${NC} for CORS Pre-flight when TESTING: Anonymous -> ${GRAY}${HEADER_VAL}${NC}"
    else
         echo -e "${RED}FAIL ($ACTUAL_STATUS)${NC} for CORS Pre-flight when TESTING: Anonymous"
         FAILED_COUNT=$((FAILED_COUNT + 1))
    fi
fi

# --- STEP G: Metadata Consistency ---
echo -e "\n>>> Step G: Verify Metadata Consistency..."

get_val() {
    local key=$1
    local content=$2
    echo "$content" | grep -o "\"$key\":[[:space:]]*[^,}]*" | cut -d: -f2- | tr -d '"' | tr -d ' '
}

extract_nested_val() {
    local file=$1
    local block_key=$2
    local target_key=$3
    local full_content=$(cat "$file" | tr -d '\n')
    local block_content=$(echo "$full_content" | sed -n "s/.*\"$block_key\":[[:space:]]*{\([^}]*\)}.*/\1/p")
    get_val "$target_key" "$block_content"
}

clean_ts() {
    echo "$1" | cut -d'.' -f1 | tr -d 'Z'
}

compare_meta() {
    local label=$1
    local exp_raw=$2
    local act_raw=$3

    local exp="$exp_raw"
    local act="$act_raw"

    if [[ "$label" == "Timestamp" ]]; then
        exp=$(clean_ts "$exp_raw")
        act=$(clean_ts "$act_raw")
    fi

    if [ -z "$exp" ] || [ -z "$act" ]; then
         echo -e "      ${RED}FAIL${NC} $label extraction failed (Empty value detected)"
         FAILED_COUNT=$((FAILED_COUNT + 1))
         return
    fi

    if [ "$exp" == "$act" ]; then
        echo -e " ${GREEN}PASS${NC} $label match ($exp)"
    else
        echo -e "      ${RED}FAIL${NC} $label mismatch: Expected=$exp  Received=$act"
        FAILED_COUNT=$((FAILED_COUNT + 1))
    fi
}

# Extract from POST responses (seeded in Step A)
POST_PRODUCTS_RES="${OUTPUT_DIR}/Int_Post_Products.json"
POST_PRODUCTS_CONTENT=$(cat "$POST_PRODUCTS_RES" | tr -d '\n')
EXP_PROD_V=$(get_val "version" "$POST_PRODUCTS_CONTENT")
EXP_PROD_TS=$(get_val "lastModified" "$POST_PRODUCTS_CONTENT")

POST_BYTES_RES="${OUTPUT_DIR}/Int_Post_Bytes.json"
POST_BYTES_CONTENT=$(cat "$POST_BYTES_RES" | tr -d '\n')
EXP_BIN_V=$(get_val "version" "$POST_BYTES_CONTENT")
EXP_BIN_TS=$(get_val "lastModified" "$POST_BYTES_CONTENT")

# Compare with versions endpoint
VERSIONS_FILE="${OUTPUT_DIR}/Int_Get_Versions.json"

ACT_PROD_V=$(extract_nested_val "$VERSIONS_FILE" "products" "version")
ACT_PROD_TS=$(extract_nested_val "$VERSIONS_FILE" "products" "lastModified")
ACT_BIN_V=$(extract_nested_val "$VERSIONS_FILE" "image" "version")
ACT_BIN_TS=$(extract_nested_val "$VERSIONS_FILE" "image" "lastModified")

echo -e "\nChecking Products Consistency:"
compare_meta "Version" "$EXP_PROD_V" "$ACT_PROD_V"
compare_meta "Timestamp" "$EXP_PROD_TS" "$ACT_PROD_TS"

echo -e "\nChecking Binary Consistency:"
compare_meta "Version" "$EXP_BIN_V" "$ACT_BIN_V"
compare_meta "Timestamp" "$EXP_BIN_TS" "$ACT_BIN_TS"

# --- Final Result ---
if [ $FAILED_COUNT -gt 0 ]; then
    echo -e "\n${RED}Job failed: $FAILED_COUNT test(s) failed in total.${NC}"
    exit 1
fi

echo -e "\n${GREEN}All tests passed.${NC}"
exit 0