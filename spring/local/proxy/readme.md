### Running behind proxy like zscaler, that modify certificates

If you want to run the app behind a proxy (e.g  zscaler) that modify certificates, you will need to add the proxy's cert to the JDK custom store. (This includes running locally via gradle, starting from an IDE like Intellij or in a [docker container](../docker/readme.md). 

Example scripts are provided for

- [windows](zscaler/install_cert_jdk.cmd)
-  [linux](zscaler/install-cert.sh)


