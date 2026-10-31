#!/bin/bash
# Build locally; signing and submission are separate, explicit operations.
set -euo pipefail
cd "$(dirname "$0")/.."
app="$PWD/dist/Team Work.app"
zip="$PWD/dist/Team-Work-macOS.zip"
identity="${SIGN_IDENTITY:-Developer ID Application: Yanun Yang (Y366CJ66L6)}"

case "${1:-build}" in
build)
    npm --prefix frontend ci
    npm --prefix frontend run build -- --mode desktop
    mkdir -p dist
    stage=$(mktemp -d "$PWD/dist/macos-build.XXXXXX")
    trap 'rm -rf "$stage"' EXIT
    bundle="$stage/Team Work.app"
    mkdir -p "$bundle/Contents/"{MacOS,Helpers,Resources/web}
    cp macos/Info.plist "$bundle/Contents/Info.plist"
    iconutil -c icns macos/AppIcon.iconset -o "$bundle/Contents/Resources/AppIcon.icns"
    cp -R frontend/dist/. "$bundle/Contents/Resources/web/"
    for arch in arm64 x86_64; do
        goarch="$arch"
        [ "$arch" != x86_64 ] || goarch=amd64
        (cd backend && CGO_ENABLED=0 GOOS=darwin GOARCH="$goarch" go build -trimpath -ldflags='-s -w' -o "$stage/server-$arch" ./cmd/server)
        xcrun swiftc -swift-version 5 -O -target "$arch-apple-macos12.0" -framework AppKit -framework WebKit macos/main.swift -o "$stage/app-$arch"
    done
    xcrun lipo -create "$stage/server-arm64" "$stage/server-x86_64" -output "$bundle/Contents/Helpers/company-server"
    xcrun lipo -create "$stage/app-arm64" "$stage/app-x86_64" -output "$bundle/Contents/MacOS/Team Work"
    plutil -lint "$bundle/Contents/Info.plist"
    # Replace only the generated bundle, never a source or user data directory.
    rm -rf "$app"
    mv "$bundle" "$app"
    echo "Built: $app"
    ;;
sign)
    codesign --force --options runtime --timestamp --sign "$identity" --entitlements macos/server.entitlements.plist "$app/Contents/Helpers/company-server"
    codesign --force --options runtime --timestamp --sign "$identity" "$app"
    codesign --verify --deep --strict --verbose=2 "$app"
    ;;
notarize)
    codesign --verify --deep --strict "$app"
    ditto -c -k --keepParent "$app" "$zip"
    # Use only this Keychain profile. Never read or print its credentials.
    xcrun notarytool submit "$zip" --keychain-profile macos-notary --wait --output-format json > dist/notarization.json
    cat dist/notarization.json
    python3 -c 'import json; d=json.load(open("dist/notarization.json")); assert d.get("status") == "Accepted", "Notarization was not accepted; do not distribute"'
    xcrun stapler staple "$app"
    xcrun stapler validate "$app"
    spctl --assess --type execute --verbose=2 "$app"
    ditto -c -k --keepParent "$app" "$zip"
    shasum -a 256 "$zip"
    ;;
*) echo "Usage: $0 {build|sign|notarize}" >&2; exit 2 ;;
esac
