.DEFAULT_GOAL := help

.PHONY: $(wildcard *)

## help: show help
help:
	@echo ""
	@echo "Usage:"
	@echo ""
	@sed -n 's/^## //p' Makefile | column -t -s ':' | sed -e 's/^/\t/'
	@echo ""

## dev: start the backend and the frontend together, Ctrl+C stops both (localhost port 5173, data in ~/.team-work-dev)
dev: frontend/node_modules
	@./scripts/dev.sh

## dev-mock: start the frontend on mock data, with no backend (localhost port 5173)
dev-mock: frontend/node_modules
	npm --prefix frontend run dev:mock

## help-shots: retake the help page's screenshots in frontend/src/help on mock data (TOPICS="map files" for only those)
help-shots: frontend/node_modules
	@./scripts/help-shots.sh $(TOPICS)

## server: start only the backend (localhost port 8787)
server:
	cd backend && go run ./cmd/server

## official-source: refresh the copy of the official source the tests and the simulator read (REF=<branch or tag> for another version)
official-source:
	@./scripts/official-source.sh

## build: build the universal macOS app in dist (unsigned)
build:
	@./scripts/macos.sh build

## semantic-helper: build only semantic search's helper into dist (arm64, macOS 27); run the backend with TEAM_WORK_SEMANTIC_HELPER=$(PWD)/dist/semantic-helper
semantic-helper:
	@./scripts/macos.sh semantic-helper

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
	cd backend && go test -timeout 30m ./...

## test-race: run the backend tests with the race detector (slower; before committing)
test-race:
	cd backend && go test -race -timeout 30m ./...
