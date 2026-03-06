// lib/constructs/domain.ts

import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

/**
 * @module domain-constructs
 * This module provides constructs for creating and managing SSL/TLS certificates
 * with AWS Certificate Manager (ACM) and setting up DNS records with Amazon Route 53.
 */

/**
 * Properties required for creating an ACM SSL/TLS certificate.
 */
export interface CertificateConstructProps {
  /**
   * The fully qualified domain name (FQDN) for which the certificate will be issued
   * (e.g., 'dev.api.example.com' or 'api.example.com').
   */
  fqdn: string;
  /**
   * The Route 53 hosted zone that corresponds to the apex domain. This is used by ACM
   * for DNS validation of the certificate request.
   */
  hostedZone: route53.IHostedZone;
}

/**
 * Properties required for creating Route 53 DNS records.
 */
export interface DnsRecordsConstructProps {
  /** The Route 53 hosted zone in which the DNS records will be created. */
  hostedZone: route53.IHostedZone;
  /**
   * The hostname prefix - the part of the FQDN before the apex domain
   * (e.g., 'dev.api' or 'api'). This will be used as the record name within the hosted zone.
   */
  hostnamePrefix: string;

  /** The Application Load Balancer to point the alias record to (for ECS). */
  loadBalancer?: elbv2.IApplicationLoadBalancer;
  
  /** The DNS name of the ALB managed by the EKS Ingress Controller (for Kubernetes). */
  eksAlbDnsName?: string;
}

/**
 * A CDK Construct that provisions an SSL/TLS certificate using AWS Certificate Manager (ACM).
 * The certificate is validated using DNS (Route 53 records).
 */
export class CertificateConstruct extends Construct {
  public readonly certificate: acm.ICertificate;

  /**
   * Creates an ACM certificate validated via Route 53.
   * @param scope The parent CDK Stack or Construct.
   * @param id The logical ID of this construct.
   * @param props Configuration properties for the certificate.
   */
  constructor(scope: Construct, id: string, props: CertificateConstructProps) {
    super(scope, id);

    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: props.fqdn,
      validation: acm.CertificateValidation.fromDns(props.hostedZone),
    });
  }
}

/**
 * A CDK Construct that sets up DNS records in Route 53.
 * It intelligently creates an A record alias for an ALB (ECS)
 * or a CNAME record for an EKS Ingress-managed ALB.
 */
export class DnsRecordsConstruct extends Construct {
  /**
   * Creates DNS records for the service.
   * @param scope The parent CDK Stack or Construct.
   * @param id The logical ID of this construct.
   * @param props Configuration properties for the DNS records.
   */
  constructor(scope: Construct, id: string, props: DnsRecordsConstructProps) {
    super(scope, id);

    if (props.loadBalancer) {
        new route53.ARecord(this, 'AliasRecord', {
            zone: props.hostedZone,
            recordName: props.hostnamePrefix, // This will be the 'name' part of the record, e.g., 'dev.api'
            target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(props.loadBalancer)),
            comment: `Alias record pointing ${props.hostnamePrefix}.${props.hostedZone.zoneName} to the Application Load Balancer.`,
        });
      console.log(`[DNS] Created A-Record for ECS: ${props.hostnamePrefix}.${props.hostedZone.zoneName} -> ${props.loadBalancer.loadBalancerDnsName}`);
    
    } else if (props.eksAlbDnsName) {
        new route53.CnameRecord(this, 'K8sCnameRecord', {
            zone: props.hostedZone,
            recordName: props.hostnamePrefix,
            domainName: props.eksAlbDnsName,
      });
      console.log(`[DNS] Created CNAME Record for EKS: ${props.hostnamePrefix}.${props.hostedZone.zoneName} -> ${props.eksAlbDnsName}`);
    
    } else {
      console.warn(`[DNS] Neither loadBalancer nor eksAlbDnsName provided for DNS records for hostname prefix: ${props.hostnamePrefix}. No DNS record created.`);
      throw new Error("Invalid DnsRecordsConstructProps: Must provide either 'loadBalancer' (for ECS) or 'eksAlbDnsName' (for K8s).");
    }
  }
}