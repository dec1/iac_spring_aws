import java.nio.file.Paths
import org.yaml.snakeyaml.Yaml
import org.yaml.snakeyaml.DumperOptions

buildscript {
    repositories {
        mavenCentral()
    }
    dependencies {
        // This makes SnakeYAML available to the Gradle script compiler
        classpath("org.yaml:snakeyaml:2.5")
    }
}

plugins {
    val ver_kotlin = "2.1.0"
    kotlin("jvm") version "$ver_kotlin"
    kotlin("plugin.spring") version "$ver_kotlin"
    id("org.springframework.boot") version "3.4.0"
    id("io.spring.dependency-management") version "1.1.6"
    id("com.github.ben-manes.versions") version "0.51.0"
    //adds gradle task: "dependencyUpdates" (in "Tasks" -> "help" in Gradle tool window)
    // - checks which dependencies are outdated
    // only show available stable (ie release) updates:
    // ./gradlew dependencyUpdates [-Drevision=release]
    // build container images
    // https://github.com/peter-evans/kotlin-jib
    // https://github.com/GoogleContainerTools/jib/tree/master/jib-gradle-plugin#quickstart
    id("com.google.cloud.tools.jib") version "3.4.4"
}

group = "dec"

// =============================================================================
// Config Loading
// Read and parse config_common.yaml; resolve imageSource, imageName, appVersion.
// =============================================================================

data class ConfigCommon(
    val raw: Map<String, Any?>,
    val imageSource: String,
    val imageName: String,
    val appVersion: String,
)

fun loadConfigCommon(rootProjectDir: java.io.File): ConfigCommon {
    val configCommonPath = Paths.get(rootProjectDir.absolutePath, "..", "config_common.yaml").normalize()
    val configCommonFile = configCommonPath.toFile()
    require(configCommonFile.exists()) { "Missing config file: $configCommonPath" }

    val yaml = Yaml()
    @Suppress("UNCHECKED_CAST")
    val raw = configCommonFile.inputStream().use { input ->
        yaml.load(input) as? Map<String, Any?> ?: emptyMap()
    }

    fun yamlString(key: String): String =
        (raw[key] as? String)?.trim().orEmpty().also {
            require(it.isNotEmpty()) { "Missing or empty '$key' in $configCommonPath" }
        }

    return ConfigCommon(
        raw        = raw,
        imageSource = yamlString("imageSource"),
        imageName   = yamlString("imageRepositoryName"),
        appVersion  = yamlString("appVersion"),
    )
}

val configCommon = loadConfigCommon(rootProject.projectDir)
val configCommonFile = Paths.get(rootProject.projectDir.absolutePath, "..", "config_common.yaml").normalize().toFile()

version = configCommon.appVersion
require(version.toString() != "unspecified") {
    "Gradle (project) version is still 'unspecified' after loading config_common.yaml; and some plugins/tasks (eg jib below) rely on it being set."
}

val ver_jdk = 21

// =============================================================================
// Image Registry
// Maps imageSource string -> enum; drives where Jib pushes the image.
// (CDK config controls where ECS *pulls* from at deploy time.)
// =============================================================================

enum class ImageRegistry {
    DOCKERHUB,
    AWS_ECR
}

fun resolveImageRegistry(imageSource: String): ImageRegistry =
    when (imageSource.lowercase()) {
        "ecr", "aws_ecr"                      -> ImageRegistry.AWS_ECR
        "dockerhub", "docker_hub", "docker"   -> ImageRegistry.DOCKERHUB
        else -> error("Unknown imageSource '$imageSource' in config_common.yaml (expected ecr or dockerhub)")
    }

val imageRegistry: ImageRegistry = resolveImageRegistry(configCommon.imageSource)

// Detect whether this Gradle invocation actually requests a Jib task.
// This avoids executing AWS/Docker registry discovery during plain builds/tests.
val isJibTaskRequested: Boolean = gradle.startParameter.taskNames.any { it.startsWith("jib") }

// =============================================================================
// Kotlin / Java Toolchain
// =============================================================================

kotlin {
    jvmToolchain(ver_jdk)
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(ver_jdk))
    }
}

repositories {
    mavenCentral()
}

// =============================================================================
// Dependencies
// =============================================================================

val ver_openapi = "2.8.0"
val ver_aws = "2.29.34"

//---------------------------------------------------------------------------------
// Mockito Java agent (future-proof JDK: avoid "Mockito is currently self-attaching...")
val mockitoAgent by configurations.creating

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin")
    implementation("org.jetbrains.kotlin:kotlin-reflect")

    //---
    // aws
    implementation("software.amazon.awssdk:sts:$ver_aws")
    implementation("software.amazon.awssdk:s3:$ver_aws")
    implementation("software.amazon.awssdk:sso:$ver_aws")
    implementation("software.amazon.awssdk:ssooidc:$ver_aws")

    // Spring Security + OAuth2 resource server (validate bearer JWTs or introspect tokens)
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-oauth2-resource-server")


    // Springdoc (Swagger/OpenAPI UI)
    implementation("org.springdoc:springdoc-openapi-starter-webmvc-ui:$ver_openapi") // http://localhost:8080/swagger-ui/index.html

    // --------------------------------------------------------------------
    // Instrumentation
    // ---------------
    // Spring Actuator
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    // Further configure Micrometer, which actuator uses behind scenes
    // Micrometer Registry for Prometheus (ensures Prometheus format output)
    implementation("io.micrometer:micrometer-registry-prometheus")
    // Optional: For more richer metrics and tracing
    implementation("io.micrometer:micrometer-observation")
    implementation("io.prometheus:prometheus-metrics-exposition-formats:1.3.3")
    // The following are ONLY for Tracing.
    // implementation("io.micrometer:micrometer-tracing")
    // implementation("io.micrometer:micrometer-tracing-bridge-otel")

    // --------------------------------------------------------------------
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit5")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")

    //automatic restarts and live reloads during development.
    developmentOnly("org.springframework.boot:spring-boot-devtools")

    // For testing programmatic query AWS credentials
    testImplementation("software.amazon.awssdk:cloudformation:${ver_aws}")
    testImplementation("software.amazon.awssdk:cognitoidentityprovider:${ver_aws}")

    // Mockito agent jar only (non-transitive) for -javaagent:
    mockitoAgent("org.mockito:mockito-core") { isTransitive = false }
}

kotlin {
    compilerOptions {
        freeCompilerArgs.addAll("-Xjsr305=strict")
    }
}

// =============================================================================
// Core Task Configuration
// =============================================================================

tasks.withType<Test> {
    useJUnitPlatform()
}

// given jar a fixed predictable name - so can copy into docker image
tasks.bootJar {
    archiveFileName.set("my-app.jar")
}

// =============================================================================
// Resource Filtering
// Injects config_common.yaml contents + appVersion into application.yaml at build time.
// =============================================================================

fun configureResourceFiltering(
    task: org.gradle.language.jvm.tasks.ProcessResources,
    configCommonFile: java.io.File,
    configCommon: ConfigCommon,
    projectVersion: Any,
) {
    // when gradle detects change of "inputs" it re-runs this task:
    // 1) config_common.yaml  (gradle maintains intelligent snapshot)
    task.inputs.file(configCommonFile)
    // 2) the value of the (project) version (set above)
    task.inputs.property("version", projectVersion.toString())

    // Configure SnakeYAML to output standard block format for correct indentation
    val dumperOptions = DumperOptions().apply {
        defaultFlowStyle = DumperOptions.FlowStyle.BLOCK
        isPrettyFlow = true
    }

    // Wrap the loaded map in a root "config_common" key and serialize it
    val yamlDumper = Yaml(dumperOptions)
    // Serialize the already-parsed configCommon map (parsed earlier) back to YAML for injection into application.yaml
    val configCommonYamlBlock = yamlDumper.dump(mapOf("configCommon" to configCommon.raw))

    task.filteringCharset = "UTF-8"

    task.filesMatching("**/application.yaml") {
        filter { line ->
            // Injects version and serializes the config_common content over the placeholder comment
            line.replace("# configCommon_placeholder", configCommonYamlBlock.trimEnd())
        }
    }
}

tasks.processResources {
    configureResourceFiltering(this, configCommonFile, configCommon, version)
}

// =============================================================================
// Jib - Container Image Build & Push
// =============================================================================

fun resolveJibImagePath(
    imageRegistry: ImageRegistry,
    imageName: String,
    imageTag: String,
    providers: ProviderFactory,
): String {
    return when (imageRegistry) {
        ImageRegistry.DOCKERHUB -> {
            val dockerHubAccount = providers.environmentVariable("DOCKER_HUB_ACCOUNT")
                .orElse("")
                .get()
            require(dockerHubAccount.isNotBlank()) {
                "DOCKER_HUB_ACCOUNT must be set when pushing images to Docker Hub."
            }
            "$dockerHubAccount/$imageName:$imageTag"
        }
        ImageRegistry.AWS_ECR   -> {
            val awsAccountId = providers.environmentVariable("AWS_ACCOUNT_ID")
                .orElse(
                    providers.exec {
                        commandLine(
                            "aws",
                            "sts",
                            "get-caller-identity",
                            "--query",
                            "Account",
                            "--output",
                            "text",
                        )
                    }.standardOutput.asText.map { it.trim() },
                )
                .get()

            val awsRegion = providers.environmentVariable("AWS_REGION")
                .orElse(providers.environmentVariable("AWS_DEFAULT_REGION"))
                .orElse(
                    providers.exec { commandLine("aws", "configure", "get", "region") }
                        .standardOutput.asText.map { it.trim() },
                )
                .orElse("eu-west-1")
                .get()

            "$awsAccountId.dkr.ecr.$awsRegion.amazonaws.com/$imageName:$imageTag"
        }
    }
}

// can be used to create local docker image
tasks.named("jibDockerBuild") {
    // Ensure gradle daemon can find docker executable
    doFirst {
        val currentPath = System.getenv("PATH") ?: ""
        println("Updated PATH for jibDockerBuild: $currentPath")
    }
}

// "jib" can be used to create and push image to registry (without local docker)
jib {
    from {
        image = "amazoncorretto:21-alpine"
    }
    to {
        // Only resolve AWS/Docker registry details when a Jib task is actually requested.
        // This keeps plain builds/tests runnable on machines/runners without AWS CLI/credentials.
        image = if (isJibTaskRequested) {
            resolveJibImagePath(imageRegistry, configCommon.imageName, version.toString(), providers)
        } else {
            // Placeholder (unused) destination; prevents configuration-time AWS calls.
            "local/skip-jib:${version}"
        }

        // JIB_USERNAME, JIB_PASSWORD
        // env vars need to be set appropriately (destination registry specific)
        //
        // Dockerhub:
        //   - JIB_USERNAME = your Docker Hub username (e.g. "myuser")
        //   - JIB_PASSWORD = your Docker Hub password OR an access token
        //   Note: even with a token, username is still required.
        //
        // ECR:
        //   - JIB_USERNAME = "AWS"
        //   - JIB_PASSWORD = output of `aws ecr get-login-password ...`
        //
        //      PowerShell:
        //          $env:JIB_USERNAME="AWS"
        //          $env:JIB_PASSWORD=(aws ecr get-login-password --region eu-west-1)
        //
        //      Bash:
        //          export JIB_USERNAME="AWS"
        //          export JIB_PASSWORD="$(aws ecr get-login-password --region eu-west-1)"

        auth {
            username = System.getenv("JIB_USERNAME") ?: ""
            password = System.getenv("JIB_PASSWORD") ?: ""
        }
    }
    container {
        environment = mapOf("APP_VERSION_FROM_ENV" to version.toString())
        ports = listOf("8080")
    }
}

// =============================================================================
// Source Sets - Test Tiers
// Unit (test), Integration, System, Manual - all share src/test/resources fixtures.
// =============================================================================

fun org.gradle.api.NamedDomainObjectContainer<org.gradle.api.tasks.SourceSet>.addTestTier(
    name: String,
    srcDir: String,
    main: org.gradle.api.tasks.SourceSet,
    test: org.gradle.api.tasks.SourceSet,
) {
    create(name) {
        kotlin.srcDir(srcDir)
        // Reuse unit-test resources (json fixtures) without duplicating files.
        resources.srcDir("src/test/resources")
        // Allow tests to use main code + helpers from src/test/kotlin.
        compileClasspath += main.output + test.output
        runtimeClasspath += output + compileClasspath
    }
}

sourceSets {
    val main = main.get()
    val test = test.get()
    addTestTier("integrationTest", "src/integrationTest/kotlin", main, test)
    addTestTier("systemTest",      "src/systemTest/kotlin",      main, test)
    addTestTier("manualTest",      "src/manualTest/kotlin",      main, test)
}

// Extend dependencies from test to integrationTest, systemTest, and manualTest
configurations {
    val integrationTestImplementation by getting
    val integrationTestRuntimeOnly by getting
    integrationTestImplementation.extendsFrom(testImplementation.get())
    integrationTestRuntimeOnly.extendsFrom(testRuntimeOnly.get())

    val systemTestImplementation by getting
    val systemTestRuntimeOnly by getting
    systemTestImplementation.extendsFrom(testImplementation.get())
    systemTestRuntimeOnly.extendsFrom(testRuntimeOnly.get())

    val manualTestImplementation by getting
    val manualTestRuntimeOnly by getting
    manualTestImplementation.extendsFrom(testImplementation.get())
    manualTestRuntimeOnly.extendsFrom(testRuntimeOnly.get())
}

// =============================================================================
// Test Tasks
// =============================================================================

tasks.withType<Test>().configureEach {

    // Test-harness - enable (spring profile) for all tests
    val profile = System.getenv("SPRING_PROFILES_ACTIVE") ?: "test-harness"
    systemProperty("spring.profiles.active", profile)

    // --- Mockito agent (stops "self-attaching" warning - future-proof for newer JDKs) ---
    val agentJar = mockitoAgent.singleFile
    jvmArgs("-javaagent:${agentJar.absolutePath}")
}

fun registerTestTask(
    tasks: TaskContainer,
    name: String,
    description: String,
    sourceSets: SourceSetContainer,
    shouldRunAfter: String,
    extraConfig: Test.() -> Unit = {},
) {
    tasks.register<Test>(name) {
        this.description = description
        group = "verification"
        testClassesDirs = sourceSets[name].output.classesDirs
        classpath = sourceSets[name].runtimeClasspath
        useJUnitPlatform()
        shouldRunAfter(shouldRunAfter)
        extraConfig()
    }
}

registerTestTask(tasks, "integrationTest", "Runs integration tests",   sourceSets, "test")
registerTestTask(tasks, "systemTest",      "Runs system tests",        sourceSets, "integrationTest")
registerTestTask(tasks, "manualTest",      "Runs manual smoke tests",  sourceSets, "test") {
    testLogging { showStandardStreams = true }
}

// Make gradle task 'check' run integrationTest, systemTest (as well as test)
tasks.named("check") {
    dependsOn("integrationTest")
    dependsOn("systemTest")
}

// one shared test-resources folder used by both suites ---
sourceSets {
    val shared = "src/test-resources-shared"
    named("integrationTest") { resources.srcDir(shared) }
    named("systemTest") { resources.srcDir(shared) }
    named("manualTest") { resources.srcDir(shared) }
}