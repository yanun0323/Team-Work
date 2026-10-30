.DEFAULT_GOAL := help

.PHONY: $(wildcard *)

## help: show help
help:
	@echo ""
	@echo "Usage:"
	@echo ""
	@sed -n 's/^## //p' Makefile | column -t -s ':' | sed -e 's/^/\t/'
	@echo ""

## dev: start the frontend (localhost port 5173)
dev: frontend/node_modules
	npm --prefix frontend run dev
