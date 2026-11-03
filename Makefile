.DEFAULT_GOAL := help

.PHONY: $(wildcard *)

## help: show help
help:
	@echo ""
	@echo "Usage:"
	@echo ""
	@sed -n 's/^## //p' Makefile | column -t -s ':' | sed -e 's/^/\t/'
	@echo ""

## dev: start the backend and the frontend together, Ctrl+C stops both (localhost port 5173)
dev: frontend/node_modules
	@./scripts/dev.sh

## dev-mock: start the frontend on mock data, with no backend (localhost port 5173)
dev-mock: frontend/node_modules
	npm --prefix frontend run dev:mock

## server: start only the backend (localhost port 8787)
server:
	cd backend && go run ./cmd/server

## build: build the universal macOS app in dist (unsigned)
build:
	@./scripts/macos.sh build

## sign: sign the macOS app with Developer ID
sign:
	@./scripts/macos.sh sign

## notarize: upload the signed app to Apple, staple its ticket and package the ZIP
notarize:
	@./scripts/macos.sh notarize

## appcast: write dist/release/appcast.xml for the notarized ZIP, signed with the Sparkle key (uploads nothing)
appcast:
	@./scripts/macos.sh appcast

## test-backend: run the backend tests
test-backend:
	cd backend && go test -race ./...
