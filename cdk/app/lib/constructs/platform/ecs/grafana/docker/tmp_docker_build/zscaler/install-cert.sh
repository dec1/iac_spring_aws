#!/bin/sh
# Simple Alpine-compatible certificate installer

echo "Installing Zscaler certificate..."

# Install certificate to Java keystore
keytool -importcert -alias zscaler -file /tmp/zscaler.pem -cacerts -storepass changeit -noprompt
echo "Certificate installed to Java cacerts"

# Create directories if they don't exist
mkdir -p /usr/local/share/ca-certificates/
mkdir -p /etc/ssl/certs/

# Copy certificate to Alpine's certificate directories
cp /tmp/zscaler.pem /usr/local/share/ca-certificates/zscaler.crt
cp /tmp/zscaler.pem /etc/ssl/certs/zscaler.pem

# Add certificate to system-wide OpenSSL configuration
cat /tmp/zscaler.pem >> /etc/ssl/certs/ca-certificates.crt

echo "Certificate added to system certificate stores"

# Enable SSL verification bypass for APK temporarily to install ca-certificates
cat > /etc/apk/repositories << EOF
http://dl-cdn.alpinelinux.org/alpine/v3.21/main
http://dl-cdn.alpinelinux.org/alpine/v3.21/community
http://apk.corretto.aws
EOF

# Install ca-certificates package using HTTP instead of HTTPS
echo "Installing ca-certificates package..."
apk add --no-cache --allow-untrusted ca-certificates
echo "ca-certificates package installed"

# Now run update-ca-certificates if available
if [ -x "$(command -v update-ca-certificates)" ]; then
    update-ca-certificates --fresh
    echo "CA certificates updated"
else
    echo "update-ca-certificates command not found, but certificates are installed"
fi

echo "Certificate setup completed"
exit 0