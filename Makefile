.PHONY: install dev test test-all test-contracts check preflight smoke scenarios mcp docker-build docker-up

install:
	npm install
	npm --prefix hardhat install

dev:
	npm run dev

test:
	npm test

test-contracts:
	npm run test:contracts

test-all: test test-contracts

check:
	npm run check

preflight:
	npm run preflight

smoke:
	npm run smoke

scenarios:
	npm run scenarios

mcp:
	npm run mcp

docker-build:
	docker build -t agentbl:local .

docker-up:
	docker compose up -d --build
