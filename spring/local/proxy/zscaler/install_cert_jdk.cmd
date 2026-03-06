
:: ---------------------------------------------------------------------
::  Purpose:
::     Imports the corporate or Zscaler root certificate into the selected
::     Amazon Corretto JDK truststore so Java applications can connect
::     through the company proxy (Zscaler) without TLS errors.
::
::  Prerequisite:
::     The Zscaler and related corporate certificates must first be
::     exported (see from the Windows certificate store using `certmgr.msc`
::       → Trusted Root Certification Authorities → Certificates
::       → Export as Base-64 encoded X.509 (.CER) file (PEM format)
::     Example output:  C:\Users\<user-name>\Documents\zone\mid\certs\zscaler.pem
::
::  Why:
::     The Windows OS and browsers trust Zscaler via the system store,
::     but the JDK maintains its own truststore (cacerts). Each JDK
::     installation or upgrade resets this store, so the certificate
::     must be re-imported for every new JDK version.
::
::  Usage:
::     1. Confirm CERT_PATH points to the exported Zscaler PEM file.
::     2. Update JDK_NAME to the target JDK folder.
::     3. Run this script as your normal user.
::
::  Result:
::     Adds the Zscaler certificate to cacerts, enabling Java tools
::     (Spring Boot, AWS SDK, Gradle, etc.) to trust HTTPS endpoints
::     intercepted by Zscaler.
:: ---------------------------------------------------------------------

@echo off

set "JDK_NAME=corretto-21.0.8"

:: modify as appropriate
set User_Name=john.doe

set "JDKS_DIR=C:\Users\%User_Name%\.jdks"  
set "JDK_DIR=%JDKS_DIR%\%JDK_NAME%"
set "KEYSTORE=%JDK_DIR%\lib\security\cacerts"


set "CERT_PATH=zscaler.pem"
set "ALIAS=zscaler"
set "STOREPASS=changeit"

echo Using Keystore: 

"%JDK_DIR%\bin\keytool" -import -file "%CERT_PATH%" -keystore "%KEYSTORE%" -alias "%ALIAS%" -storepass "%STOREPASS%"

echo Imported "%CERT_PATH%"  into "%KEYSTORE%"