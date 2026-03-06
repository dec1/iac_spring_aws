// config/service-config.ts

import * as cdk from 'aws-cdk-lib';

/**
 * Centralized configuration for ECS Fargate Service tuning.
 * Edit these values to control costs, performance, and deployment behavior.
 */
export const ServiceConfig = {
  // --- Resource Allocation (Per Task/VM) ---
  // 512 = 0.5 vCPU. 1024 = 1 GB RAM.
  taskCpu: 512,
  taskMemory: 1024,

  // --- Auto-Scaling Limits (Number of Tasks) ---
  scaling: {
    minCapacity: 1, // Minimum tasks to keep running (1 = ensure uptime)
    
    // Maximum concurrent tasks allowed per environment
    maxCapacityDev: 2,
    maxCapacityRelease: 10,

    // CPU utilization % that triggers scaling up
    targetCpuUtilizationPercent: 70,

    // Cooldowns (seconds) to prevent rapid flapping between scale-in/out
    scaleInCooldown: 60,
    scaleOutCooldown: 60,
  },

  // --- Deployment Health Limits (Blue/Green & Rolling) ---
  deployment: {
    // 100% = Keep all current tasks running until new ones are healthy.
    // Prevents capacity drops during updates.
    minHealthyPercent: 100, 
    
    // 200% = Allow creating up to double the tasks during deployment.
    // Required to spin up the Green fleet while Blue is still running.
    maxHealthyPercent: 200, 
  },

  // --- Health Checks & Timeouts ---
  // Seconds to ignore health check failures during startup (allows slow apps to boot)
  healthCheckGracePeriodSeconds: 300, 

  // --- Kubernetes (EKS) Node Group Sizing ---
  // These control the EC2 instances in the managed node group.
  // Pods are scheduled onto these nodes by the K8s scheduler.
  //
  // t3.medium = 2 vCPU, 4 GB RAM (~$30/month on-demand)
  // For your Spring Boot app at 0.5 vCPU / 1 GB, a single t3.medium
  // can comfortably run 2-3 pods (some memory reserved for kubelet + system).
  kubernetes: {
    nodeGroup: {
      dev: {
        instanceType: 't3.medium',
        minNodes: 1,    // Always keep 1 node running (K8s needs somewhere to schedule pods)
        maxNodes: 2,    // Allow scaling to 2 during deployments or load spikes
        desiredNodes: 1,
        diskSizeGb: 30, // Root volume for the node (container images + logs)
      },
      release: {
        instanceType: 't3.medium',
        minNodes: 2,    // 2 nodes across AZs for high availability
        maxNodes: 5,    // Room for scaling under load
        desiredNodes: 2,
        diskSizeGb: 30,
      },
    },
  },
};