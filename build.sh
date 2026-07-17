#!/bin/bash

set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

# Packages the plugin into a .streamDeckPlugin file.

PLUGIN_NAME="com.teamvrotek.claudepeak"
RELEASE_DIR="Release"
PLUGIN_DIR="$PLUGIN_NAME.sdPlugin"

echo "Building $PLUGIN_NAME..."

# Install Node dependencies
echo "Installing dependencies..."
cd "$PLUGIN_DIR"
npm install --production --silent
cd ..

# Package
mkdir -p "$RELEASE_DIR"
rm -f "$RELEASE_DIR/$PLUGIN_NAME.streamDeckPlugin"

zip -r "$RELEASE_DIR/$PLUGIN_NAME.streamDeckPlugin" "$PLUGIN_DIR" \
    -x "*.DS_Store" \
    -x "*__MACOSX*"

echo "Done: $RELEASE_DIR/$PLUGIN_NAME.streamDeckPlugin"
