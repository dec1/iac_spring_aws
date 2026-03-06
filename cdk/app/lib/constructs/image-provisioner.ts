import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

/**
 * Properties for the ContainerImageProvisioner
 */
export interface ContainerImageProvisionerProps {
  /** Source of the container image: either 'ecr' or 'dockerhub' */
  imageSource: 'ecr' | 'dockerhub';
  /** Name of the repository (for ECR or Docker Hub) */
  imageRepositoryName: string;
  /** Tag of the container image */
  tag: string;
}

/**
 * A CDK construct that provisions a container image for use in ECS.
 * Supports images from Amazon ECR or Docker Hub.
 */
export class ContainerImageProvisioner extends Construct {
  public readonly containerImage: ecs.ContainerImage;
  public readonly ecrRepository?: ecr.IRepository;

  /**
   * Creates a container image configuration based on the provided source.
   * For ECR, it can create a new repository or import an existing one.
   * For Docker Hub, it references the image directly.
   * @param scope The CDK Stack or Construct that this construct belongs to
   * @param id The logical ID of this construct
   * @param props Properties defining the image source, repository, and tag
   */
  constructor(scope: Construct, id: string, props: ContainerImageProvisionerProps) {
    super(scope, id);

    if (props.imageSource === 'ecr') {

      const repository: ecr.IRepository =  ecr.Repository.fromRepositoryName(this, 'ImportedEcrRepo', props.imageRepositoryName);

      this.ecrRepository = repository;

      /**
       * ECS will pull this image at task start time.
       * - For ECR, ensure the ECS *execution role* has pull permissions (see iam.ts changes).
       */
      this.containerImage = ecs.ContainerImage.fromEcrRepository(repository, props.tag);
      return;
    }

    if (props.imageSource === 'dockerhub') {
      /**
       * Configures a container image from Docker Hub using the repository name and tag.
       * Format: imageRepositoryName:tag (e.g., nginx:latest)
       */
      this.containerImage = ecs.ContainerImage.fromRegistry(`${props.imageRepositoryName}:${props.tag}`);
      return;
    }

    throw new Error(`Invalid imageSource: ${props.imageSource}. Must be 'ecr' or 'dockerhub'.`);
  }
}
