#!/bin/bash
# Build locally; signing and submission are separate, explicit operations.
set -euo pipefail
cd "$(dirname "$0")/.."
app="$PWD/dist/Team Work.app"
zip="$PWD/dist/Team-Work-macOS.zip"
identity="${SIGN_IDENTITY:-Developer ID Application: Yanun Yang (Y366CJ66L6)}"
# Sparkle, pinned by version and checksum; downloaded once into .cache.
sparkle_version=2.10.1
sparkle_sha256=1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27
sparkle="$PWD/.cache/sparkle/$sparkle_version"
# Releases live on GitHub, tagged v<version>; the app reads the newest appcast from there (SUFeedURL in macos/Info.plist).
releases=https://github.com/yanun0323/Team-Work/releases

# Semantic search's helper runs Core AI, which exists only on macOS 27 on Apple silicon: it is built for arm64 and
# macOS 27 alone, apart from the universal app and backend, which keep running on macOS 13.3 and Intel.
build_semantic_helper() {
    local out="$1"
    mkdir -p "$(dirname "$out")"
    xcrun swiftc -swift-version 5 -O -target arm64-apple-macos27.0 -framework CoreAI -framework ImageIO -framework CoreGraphics \
        -framework AVFoundation -framework Accelerate -module-name SemanticHelper \
        macos/semantic-helper/Sources/EmbeddingGemma2CoreAI/*.swift macos/semantic-helper/Sources/semantic-helper/main.swift -o "$out"
}

fetch_sparkle() {
    [ -d "$sparkle/Sparkle.framework" ] && return
    local tmp
    tmp=$(mktemp -d)
    curl -fsSL -o "$tmp/sparkle.tar.xz" "https://github.com/sparkle-project/Sparkle/releases/download/$sparkle_version/Sparkle-$sparkle_version.tar.xz"
    echo "$sparkle_sha256  $tmp/sparkle.tar.xz" | shasum -a 256 -c -
    mkdir -p "$tmp/x"
    tar -xJf "$tmp/sparkle.tar.xz" -C "$tmp/x"
    mkdir -p "$(dirname "$sparkle")"
    rm -rf "$sparkle"
    mv "$tmp/x" "$sparkle"
    rm -rf "$tmp"
}

case "${1:-build}" in
semantic-helper)
    # For development: the backend finds it through TEAM_WORK_SEMANTIC_HELPER.
    build_semantic_helper "$PWD/dist/semantic-helper"
    echo "Built: $PWD/dist/semantic-helper"
    ;;
build)
    fetch_sparkle
    npm --prefix frontend ci
    npm --prefix frontend run build -- --mode desktop
    mkdir -p dist
    stage=$(mktemp -d "$PWD/dist/macos-build.XXXXXX")
    trap 'rm -rf "$stage"' EXIT
    bundle="$stage/Team Work.app"
    mkdir -p "$bundle/Contents/"{MacOS,Helpers,Frameworks,Resources/web}
    # The version comes from frontend/package.json; the build number counts the commits on HEAD, so main's history must not be rewritten.
    plist="$bundle/Contents/Info.plist"
    cp macos/Info.plist "$plist"
    plutil -replace CFBundleShortVersionString -string "$(node -p 'require("./frontend/package.json").version')" "$plist"
    plutil -replace CFBundleVersion -string "$(git rev-list --count HEAD)" "$plist"
    plutil -replace TWGitCommit -string "$(git rev-parse --short=6 HEAD)" "$plist"
    iconutil -c icns macos/AppIcon.iconset -o "$bundle/Contents/Resources/AppIcon.icns"
    cp -R frontend/dist/. "$bundle/Contents/Resources/web/"
    # The app is not sandboxed, so Sparkle's XPC services go unused.
    ditto "$sparkle/Sparkle.framework" "$bundle/Contents/Frameworks/Sparkle.framework"
    rm -rf "$bundle/Contents/Frameworks/Sparkle.framework/XPCServices" "$bundle/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices"
    for arch in arm64 x86_64; do
        goarch="$arch"
        [ "$arch" != x86_64 ] || goarch=amd64
        (cd backend && CGO_ENABLED=0 GOOS=darwin GOARCH="$goarch" go build -trimpath -ldflags='-s -w' -o "$stage/server-$arch" ./cmd/server)
        xcrun swiftc -swift-version 5 -O -target "$arch-apple-macos13.3" -framework AppKit -framework WebKit -framework UserNotifications \
            -F "$sparkle" -framework Sparkle -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
            macos/main.swift -o "$stage/app-$arch"
    done
    xcrun lipo -create "$stage/server-arm64" "$stage/server-x86_64" -output "$bundle/Contents/Helpers/company-server"
    xcrun lipo -create "$stage/app-arm64" "$stage/app-x86_64" -output "$bundle/Contents/MacOS/Team Work"
    build_semantic_helper "$bundle/Contents/Helpers/semantic-helper"
    # The helper includes EmbeddingGemma-2-CoreAI's Swift code, under Apache-2.0 with its NOTICE.
    mkdir -p "$bundle/Contents/Resources/semantic-helper"
    cp macos/semantic-helper/LICENSE macos/semantic-helper/NOTICE macos/semantic-helper/UPSTREAM "$bundle/Contents/Resources/semantic-helper/"
    plutil -lint "$plist"
    # Replace only the generated bundle, never a source or user data directory.
    rm -rf "$app"
    mv "$bundle" "$app"
    echo "Built: $app"
    ;;
sign)
    # Inside out, without --deep: Sparkle's helpers first, then the framework, the backend and the app.
    framework="$app/Contents/Frameworks/Sparkle.framework"
    codesign --force --options runtime --timestamp --sign "$identity" "$framework/Versions/B/Autoupdate"
    codesign --force --options runtime --timestamp --sign "$identity" "$framework/Versions/B/Updater.app"
    codesign --force --options runtime --timestamp --sign "$identity" "$framework"
    codesign --force --options runtime --timestamp --sign "$identity" --entitlements macos/server.entitlements.plist "$app/Contents/Helpers/company-server"
    codesign --force --options runtime --timestamp --sign "$identity" "$app/Contents/Helpers/semantic-helper"
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
appcast)
    # The appcast for the notarized ZIP, signed with the Sparkle key in the login Keychain. Nothing is uploaded.
    fetch_sparkle
    [ -f "$zip" ] || { echo "No $zip; run make notarize first" >&2; exit 1; }
    release="$PWD/dist/release"
    rm -rf "$release"
    mkdir -p "$release"
    cp "$zip" "$release/"
    # Each update points at its own tag, so the ZIP always matches the signature in the appcast.
    version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")
    "$sparkle/bin/generate_appcast" --download-url-prefix "$releases/download/v$version/" "$release"
    echo "Upload to the GitHub release: $release/$(basename "$zip") and $release/appcast.xml"
    ;;
*) echo "Usage: $0 {build|semantic-helper|sign|notarize|appcast}" >&2; exit 2 ;;
esac
