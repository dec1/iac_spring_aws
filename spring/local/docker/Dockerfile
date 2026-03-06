# Stage 1: Build the application
FROM gradle:8.12-jdk21-alpine AS build

WORKDIR /app

# ------
# Zscaler - certificate setup
# COPY commands are now relative to the build context (the temporary directory)
COPY ../proxy/zscaler/zscaler.pem /tmp/zscaler.pem
COPY ../proxy/zscaler/install-cert.sh /tmp/install-cert.sh
RUN chmod +x /tmp/install-cert.sh
RUN /tmp/install-cert.sh
# -------

# Copy Gradle files first for better layer caching
# COPY commands are now relative to the build context (the temporary directory)
COPY gradle ./gradle/
COPY ../../build.gradle.kts settings.gradle.kts gradlew ./

RUN chmod +x ./gradlew

# Copy source code
# COPY commands are now relative to the build context (the temporary directory)
COPY src ./src

# Build the application (gradle pre-installed)
RUN gradle build -x test --no-daemon

# -----------------------------------------------------------------------------
# Stage 2: Create the runtime image
# amazoncorretto:21 ~250 MB (compressed) includes curl
#     'amazoncorretto:21-alpine' is smaller -approx 200 MB (compressed), but doesnt come with curl (or bash), which is needed for health checks
FROM amazoncorretto:21-alpine


WORKDIR /app

# ------
# Zscaler - certificate setup
# COPY commands are now relative to the build context (the temporary directory)
COPY ../proxy/zscaler/zscaler.pem /tmp/zscaler.pem
COPY ../proxy/zscaler/install-cert.sh /tmp/install-cert.sh
RUN chmod +x /tmp/install-cert.sh
RUN /tmp/install-cert.sh
# -------

# Install curl for health checks
# RUN apk add --no-cache curl

# Replace with your actual jar filename
COPY --from=build /app/build/libs/my-app.jar app.jar

EXPOSE 8080

ENTRYPOINT ["java", "-jar", "app.jar"]
