### Docker

If you need custom certs (eg zscaler installed) eg to run the container on a (local) machine that zscaler intercepts, you need to use _docker_, e.g.  `docker build` with a custom `Dockerfile`
(as there no jib equivalent. In particular, no equivalent of a Docker file `RUN` command, which is needed to install the cert)

The [Dockerfile](Dockerfile) here can be used for this purpose (or if for some other reason you don't want to use jib for local image builds)



eg in WSL

- `local> build_docker_image.sh`

- `docker images`

      REPOSITORY                       TAG                 IMAGE ID       CREATED              SIZE
      spring-aws-app                   latest              6f43bd8c7eb2   3 seconds ago        363MB


- **run**
  when running locally (need locally configured aws credentials and profile)
  - `docker run --rm -p 8080:8080 --name spring-aws-app -v /mnt/c/Users/<user-name>/.aws:/root/.aws -e AWS_PROFILE=mpb spring-aws-app`
    - cf: when running in aws (credentials come from (fargate) roles)
      - `docker run --rm -p 8080:8080 --name spring-aws-app`

- **tag** suitable for pushing (including prefix)
  - `docker tag spring-aws-app dec1/spring-aws-app:1.21.0`

- **push**
  - Note: The pushed image will have (trust of)  zscaler certs installed, 
  which is probably not what you want if the image is going to be pulled to run somewhere zscaler is not installed (eg aws)

    - `docker login`
    - `docker push dec1/spring-aws-app:1.21.0`
    - 
    - cdk: update `config_common.yaml` and (re) deploy