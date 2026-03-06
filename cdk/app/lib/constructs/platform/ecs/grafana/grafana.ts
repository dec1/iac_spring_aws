// lib/constructs/grafana/grafana.ts

import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

/**
 * Props for the Grafana Alloy sidecar.
 */
export interface GrafanaAlloySidecarConstructProps {
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly appContainer: ecs.ContainerDefinition;
  readonly stagingEnvironment: 'dev' | 'release';
  readonly serviceName: string;
  readonly grafanaCloudPrometheusRemoteWriteUrl: string;
  readonly grafanaCloudPrometheusUsername: string;
  readonly grafanaCloudPrometheusApiKey: string;
  /** Enable debug mode (uses DEBUG_IMAGE) + extended commands. */
  readonly wantDebug?: boolean;
}

/**
 * GrafanaAlloySidecarConstruct
 *
 * Attaches a Grafana Alloy sidecar to a Fargate task:
 *  - Reads and sanitizes agent.river at synth time
 *  - Base64‐encodes it into an emptyDir volume
 *  - Launches Alloy with that config
 *  - Optionally enables extensive debugging when wantDebug=true
 */
export class GrafanaAlloySidecarConstruct extends Construct {
  constructor(scope: Construct, id: string, props: GrafanaAlloySidecarConstructProps) {
    super(scope, id);

    // 1) Read & sanitize agent.river at synth time
    const agentHclPath = path.join(__dirname, 'agent.river');
    let agentHclContents: string;
    try {
      const raw = fs.readFileSync(agentHclPath, 'utf-8');
      const noBOM = raw.replace(/^\uFEFF/, '');
      const clean = noBOM.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
      agentHclContents = clean
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .filter(l => !/^\s*\d+\s+\/etc\/agent\/agent\.hcl\s*$/.test(l))
        .filter(l => !/^\s*#\s*lib\/grafana\/agent\.hcl\s*$/.test(l))
        .map(l => l.replace(/[ \t]+$/gm, ''))
        .filter(l => l.trim().length > 0 || l.startsWith(' '))
        .join('\n')
        .trim();
    } catch (err) {
      throw new Error(`Failed to read Alloy config at ${agentHclPath}: ${(err as Error).message}`);
    }

    // IMAGE CONFIG
    const DEBUG_IMAGE = 'dec1/my-alloy-debug:1.1.0';
    const PROD_IMAGE  = 'grafana/alloy:latest';
    const wantDebug   = props.wantDebug ?? true;
    const alloyImage  = wantDebug ? DEBUG_IMAGE : PROD_IMAGE;

    // 2) Create ephemeral volume for config
    const volumeName = 'alloy-config-volume';
    props.taskDefinition.addVolume({ name: volumeName });

    // 3) Base64‐encode the config
    const agentHclBase64 = Buffer.from(agentHclContents, 'utf-8').toString('base64');

    // 4) Build shell commands DRY
    // ----------------------------
    const commonShellCommands = [
      `echo "grafana (alloy): want_debug=${wantDebug}"`,
      `echo "Using image: ${alloyImage}"`,
      'echo "=== ALLOY SIDECAR STARTING ==="',
    ];

    // Extended diagnostics (only with DEBUG_IMAGE):
    const debugOnlyCommands: string[] = [
      // Context info
      'echo "Date: $(date)"',
      'echo "User: $(whoami)"',
      'echo "PWD: $(pwd)"',

      // Network & ports
      'echo "=== DEBUG: Network and Port Information ==="',
      'ip addr show   || echo "ip command not available"',
      'netstat -tulpn | grep LISTEN || ss -tulpn | grep LISTEN || echo "No netstat/ss available"',

      // Process checks
      'echo "=== DEBUG: Process check - is app container running? ==="',
      'ps aux | grep java   || echo "No Java processes found"',
      'ps aux | grep spring || echo "No Spring processes found"',

      // Port bindings
      'echo "=== DEBUG: Detailed port binding check ==="',
      'netstat -tulpn | grep :8080 || ss -tulpn | grep :8080 || echo "Port 8080 not bound"',
      'netstat -tulpn | grep :80   || ss -tulpn | grep :80   || echo "Port 80 not bound"',

      // Startup timing & connectivity
      'echo "=== DEBUG: Extended wait for application startup ==="',
      'for i in $(seq 1 60); do',
      '  echo "Attempt $i: Testing app readiness...";',
      '  if curl -s --connect-timeout 2 --max-time 3 http://localhost:8080/actuator/health > /dev/null 2>&1; then',
      '    echo "✅ App ready after ${i} attempts ($(date))";',
      '    break;',
      '  elif [ $i -eq 60 ]; then',
      '    echo "❌ App never became ready after 60 attempts";',
      '    ps aux;',
      '    netstat -tulpn || ss -tulpn;',
      '    exit 1;',
      '  else',
      '    echo "Waiting 2s..."; sleep 2;',
      '  fi;',
      'done',

      // Actuator endpoint tests
      'echo "=== DEBUG: Testing actuator endpoints ==="',
      'curl -s --connect-timeout 3 --max-time 5 http://localhost:8080/actuator/prometheus | head -3 || echo "Prometheus endpoint failed"',
      'curl -s --connect-timeout 3 --max-time 5 http://localhost:8080/actuator/health     | head -3 || echo "Health endpoint failed"',

      // ECS task definition sanity
      'echo "=== DEBUG: ECS Task Definition Check ==="',
      'echo "Checking container dependencies..."',
      'echo "Should wait for app container health before scraping"',

      // Alloy binary & version
      'echo "=== Checking Alloy Binary ==="',
      'which alloy                  || echo "alloy not in PATH"',
      '/usr/bin/alloy --version     || echo "Failed to get alloy version"',

      // Env var presence (keys only)
      'echo "=== Environment Variables (names only) ==="',
      'env | grep GRAFANA | cut -d= -f1 || echo "No GRAFANA vars found"',

      // Config write & syntax
      'echo "=== Writing and validating config ==="',
      `echo '${agentHclBase64}' | base64 -d > /etc/agent/agent.river || { echo "Config decode/write FAILED"; exit 1; }`,
      '/usr/bin/alloy fmt /etc/agent/agent.river > /dev/null && echo "Syntax OK" || { cat -A /etc/agent/agent.river; exit 1; }',

      // Final connectivity check & start
      'echo "=== Final connectivity test ==="',
      'wget --quiet --timeout=2 -O - http://localhost:8080/actuator/prometheus | wc -l || echo "Final test failed"',
      'echo "=== Starting Alloy ==="',
      '/usr/bin/alloy run /etc/agent/agent.river',
    ];

    // Minimal startup (PROD_IMAGE only):
    const baseOnlyCommands = [
      'mkdir -p /etc/agent',
      `echo '${agentHclBase64}' | base64 -d > /etc/agent/agent.river || { echo "Config decode/write FAILED"; exit 1; }`,
      '/usr/bin/alloy run /etc/agent/agent.river',
    ];

    const shellCommandToRunAlloy = [
      ...commonShellCommands,
      ...(wantDebug ? debugOnlyCommands : baseOnlyCommands),
    ].join('\n');

    // 5) Add the container
    const alloyContainer = props.taskDefinition.addContainer('AlloySidecar', {
      image: ecs.ContainerImage.fromRegistry(alloyImage),
      cpu: 128,
      memoryLimitMiB: 256,
      essential: false,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: `${props.serviceName}-${props.stagingEnvironment}-alloy`,
        logRetention: cdk.aws_logs.RetentionDays.ONE_WEEK,
      }),
      environment: {
        GRAFANA_REMOTE_WRITE_URL: props.grafanaCloudPrometheusRemoteWriteUrl,
        GRAFANA_USERNAME:         props.grafanaCloudPrometheusUsername,
        GRAFANA_API_KEY:          props.grafanaCloudPrometheusApiKey,
      },
      entryPoint: ['/bin/bash'],
      command: ['-c', shellCommandToRunAlloy],
      // healthCheck: {
      //   // 6) Add a health check so ECS knows if Alloy is healthy:
      //   //    Alloy listens on port 12345 and exposes health endpoints.
      //   //    Using wget instead of curl as it's more commonly available
      //   command: ['CMD-SHELL', 'wget --quiet --tries=1 --spider http://localhost:12345/-/healthy || exit 1'],
      //   interval: cdk.Duration.seconds(30),
      //   timeout: cdk.Duration.seconds(10),
      //   retries: 3,
      //   startPeriod: cdk.Duration.seconds(90),
      // },
    });

    // 6) Mount the emptyDir volume at /etc/agent in the sidecar
    alloyContainer.addMountPoints({
      sourceVolume: volumeName,
      containerPath: '/etc/agent',
      readOnly: false, // so our shell heredoc can write into it
    });

    // 7) Container Dependencies:
    //    Add dependency so Alloy waits for app to start before beginning scraping
    //    Use START condition if app doesnt have health checks (or you dont know), HEALTHY if it does 
    try {
      alloyContainer.addContainerDependencies({
        container: props.appContainer,
        condition: ecs.ContainerDependencyCondition.HEALTHY,
      });
      console.log(`Added container dependency: Alloy will wait for app (${props.serviceName}-${props.stagingEnvironment}) to become healthy`);
    } catch {
      console.warn('Could not add container dependency; containers will start in parallel');
    }

    // 8) Expose the Alloy HTTP port (optional, for debugging)
    alloyContainer.addPortMappings({
      containerPort: 12345,
      protocol:      ecs.Protocol.TCP,
      name:          'alloy-http',
    });

    // Log synthesis-time confirmation
    console.log(`[CDK] Grafana Alloy sidecar enabled for ${props.stagingEnvironment} service.`);
  }
}
