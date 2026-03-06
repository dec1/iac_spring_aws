@echo off
SETLOCAL

REM This script facilitates building a Docker image by creating a temporary
REM build context, copying all necessary files into it, performing the Docker
REM build, and then cleaning up the temporary directory.
REM
REM Problem Solved: Docker's 'COPY' command can only access files within
REM the build context. If the Dockerfile is in a subdirectory (e.g., 'local/'),
REM it cannot directly 'COPY ../src' if 'local/' is the build context.
REM This script ensures that the original 'local/' directory remains clean
REM by:
REM 1. Creating a temporary subdirectory (e.g., 'tmp_docker_build') within 'local/'.
REM 2. Copying the Dockerfile (from 'local/') and all required project files
REM    (from the parent directory: 'src', 'gradle', 'build.gradle.kts', etc.)
REM    into this temporary directory.
REM 3. Ensuring line endings are correct for executable scripts within the temp dir.
REM 4. Running the 'docker build' command with the temporary directory as the
REM    build context.
REM 5. Removing the temporary directory upon completion.

REM Define the application name for the Docker image tag
SET APP_NAME=spring-aws-app
REM Define the name for the temporary build directory
SET TMP_DIR=tmp_docker_build

echo Starting Docker image build process...

REM --- Step 1: Prepare the temporary build directory ---
echo Creating temporary build directory: .\%TMP_DIR%...
md ".\%TMP_DIR%"

echo Copying Dockerfile and project files into .\%TMP_DIR%...

REM Copy the Dockerfile itself into the temporary directory
copy ".\Dockerfile" ".\%TMP_DIR%\" > nul

REM Copy zscaler certificates and install script (assuming zscaler/ is in the current directory 'local/')
xcopy /E /I /Y ".\zscaler" ".\%TMP_DIR%\zscaler\" > nul

REM Convert line endings of the copied install-cert.sh to Unix format
echo Converting .\%TMP_DIR%\zscaler\install-cert.sh line endings to Unix format...
REM Using PowerShell for dos2unix-like functionality as it's often available on Windows
powershell -Command "(Get-Content '.\%TMP_DIR%\zscaler\install-cert.sh') -replace '\r\n', '\n' | Set-Content -NoNewline '.\%TMP_DIR%\zscaler\install-cert.sh'"
IF %ERRORLEVEL% NEQ 0 (
    echo Warning: PowerShell conversion failed for install-cert.sh. Ensure PowerShell is accessible and check file path.
)

REM Copy gradle wrapper and configuration from the parent directory
xcopy /E /I /Y "..\gradle" ".\%TMP_DIR%\gradle\" > nul
copy "..\build.gradle.kts" ".\%TMP_DIR%\" > nul
copy "..\settings.gradle.kts" ".\%TMP_DIR%\" > nul
copy "..\gradlew" ".\%TMP_DIR%\" > nul

REM Copy source code from the parent directory
xcopy /E /I /Y "..\src" ".\%TMP_DIR%\src\" > nul


REM --- Step 2: Build the Docker image using the temporary directory as context ---
echo.
echo Building Docker image using temporary directory as context...
REM Change into the temporary directory to ensure relative paths in Dockerfile work
cd ".\%TMP_DIR%"

REM Run the Docker build command
REM The Dockerfile within the temporary directory is now at '.'
docker build -t %APP_NAME% .

REM --- Step 3: Navigate back to the original directory and clean up ---
echo.
echo Navigating back to the parent directory and cleaning up...
cd ..

REM Remove the temporary build directory
rmdir /S /Q ".\%TMP_DIR%"

echo.
echo Docker build process completed. Temporary directory .\%TMP_DIR% removed.
ENDLOCAL