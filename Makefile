.DEFAULT_GOAL := help

.PHONY: $(wildcard *)

## help: show help
help:
	@echo ""
	@echo "Usage:"
	@echo ""
	@sed -n 's/^## //p' Makefile | column -t -s ':' | sed -e 's/^/\t/'
	@echo ""

## dev: start the frontend on the real backend (run make server too; localhost port 5173)
dev: frontend/node_modules
	npm --prefix frontend run dev

## dev-mock: start the frontend on mock data, with no backend (localhost port 5173)
dev-mock: frontend/node_modules
	npm --prefix frontend run dev:mock

## server: start the backend (localhost port 8787)
server:
	cd backend && go run ./cmd/server

## test-backend: run the backend tests
test-backend:
	cd backend && go test -race ./...
