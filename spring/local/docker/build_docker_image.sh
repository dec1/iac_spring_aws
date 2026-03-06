#!/bin/bash

# This script facilitates building a Docker image by creating a temporary
# build context, copying all necessary files into it, performing the Docker
# build, and then cleaning up the temporary directory.
#
# Problem Solved: Docker's 'COPY' command can only access files within
# the build context. If the Dockerfile is in a subdirectory (e.g., 'local/'),
# it cannot directly 'COPY ../src' if 'local/' is the build context.
# This script ensures that the original 'local/' directory remains clean
# by:
# 1. Creating a temporary subdirectory (e.g., 'tmp_docker_build') within 'local/'.
# 2. Copying the Dockerfile (from 'local/') and all required project files
#    (from the parent directory: 'src', 'gradle', 'build.gradle.kts', etc.)
#    into this temporary directory.
# 3. Ensuring line endings are correct for executable scripts within the temp dir.
# 4. Running the 'docker build' command with the temporary directory as the
#    build context.
# 5. Removing the temporary directory upon completion.

# Exit immediately if a command exits with a non-zero status.
set -e

# Define the application name for the Docker image tag
APP_NAME="spring-aws-app"
# Define the name for the temporary build directory
TMP_DIR="tmp_docker_build"

echo "Starting Docker image build process..."

# --- Step 1: Prepare the temporary build directory ---
echo "Creating temporary build directory: ./${TMP_DIR}..."
mkdir -p "./${TMP_DIR}"

echo "Copying Dockerfile and project files into ./${TMP_DIR}..."

# Copy the Dockerfile itself into the temporary directory
cp "./Dockerfile" "./${TMP_DIR}/"

# Copy zscaler certificates and install script (assuming zscaler/ is in the current directory 'local/')
# If zscaler/ is in the parent directory, change to "../zscaler"
cp -R "./zscaler" "./${TMP_DIR}/zscaler"

# Convert line endings of the copied install-cert.sh to Unix format
echo "Converting ./${TMP_DIR}/zscaler/install-cert.sh line endings to Unix format..."
if command -v dos2unix &> /dev/null; then
    dos2unix "./${TMP_DIR}/zscaler/install-cert.sh"
else
    echo "Warning: dos2unix not found. Attempting conversion with sed. Please consider installing dos2unix for robustness."
    sed -i 's/\r$//' "./${TMP_DIR}/zscaler/install-cert.sh"
fi

# Copy gradle wrapper and configuration from the parent directory
cp -R "../gradle" "./${TMP_DIR}/gradle/"
cp "../build.gradle.kts" "./${TMP_DIR}/"
cp "../settings.gradle.kts" "./${TMP_DIR}/"
cp "../gradlew" "./${TMP_DIR}/"

# Copy source code from the parent directory
cp -R "../src" "./${TMP_DIR}/src"


# --- Step 2: Build the Docker image using the temporary directory as context ---
echo ""
echo "Building Docker image using temporary directory as context..."
# Change into the temporary directory to ensure relative paths in Dockerfile work
cd "./${TMP_DIR}"

# Run the Docker build command
# The Dockerfile within the temporary directory is now at '.'
docker build -t "${APP_NAME}" .

# --- Step 3: Navigate back to the original directory and clean up ---
echo ""
echo "Navigating back to the parent directory and cleaning up..."
cd ..

# Remove the temporary build directory
rm -rf "./${TMP_DIR}"

echo ""
echo "Docker build process completed. Temporary directory ./${TMP_DIR} removed."