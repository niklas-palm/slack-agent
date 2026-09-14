.PHONY: help install typecheck lint format check up down restart logs invoke ping shell \
        deploy synth diff destroy ecr.create build.push bootstrap region observability.enable

PORT  ?= 8080
COMPOSE = PORT=$(PORT) docker compose -p slack-agent
URL     = http://localhost:$(PORT)

# Same precedence as the CDK app and the container: config.local.json over config.json.
REGION := $(shell node -p "const f='./config.local.json',fs=require('fs');({...require('./config.json'),...(fs.existsSync(f)?require(f):{})}).region")
REPO_NAME := slack-agent

ACCOUNT = $(shell aws sts get-caller-identity --query Account --output text)
REGISTRY = $(ACCOUNT).dkr.ecr.$(REGION).amazonaws.com

# Absolute so it works from any subshell - the `deploy` recipe `cd`s
# into cdk/ which would otherwise break a relative path.
CDK := $(CURDIR)/cdk/node_modules/.bin/cdk
HASH_INPUTS := src skills config.json config.local.json Dockerfile package.json package-lock.json

help:
	@echo "Local dev:"
	@echo "  make install                       Install root + cdk deps"
	@echo "  make typecheck                     tsc --noEmit (all packages)"
	@echo "  make lint                          eslint + prettier --check"
	@echo "  make format                        eslint --fix + prettier --write"
	@echo "  make check                         typecheck + lint (CI gate)"
	@echo "  make up                            Build & start container on :$(PORT)"
	@echo "  make logs                          Tail container logs"
	@echo "  make invoke PROMPT='hi' CHANNEL=C123 THREAD=1700.0 \\"
	@echo "              SLACK_USER=U456                       Send a fake Slack invocation"
	@echo "  make ping                          GET /ping"
	@echo "  make shell                         bash inside the container"
	@echo "  make down                          Stop & remove"
	@echo ""
	@echo "Deploy (region from config.json):"
	@echo "  make bootstrap                     One-time per account+region: cdk bootstrap"
	@echo "  make ecr.create                    Create ECR repo if missing"
	@echo "  make build.push                    Build + push container with content-hash tag"
	@echo "  make deploy                        Build, push, cdk deploy --all"
	@echo "  make destroy                       cdk destroy --all"
	@echo "  make observability.enable          One-time per account+region: CloudWatch Transaction Search at 100%"

install:
	npm install
	cd cdk && npm install
	cd lambda && npm install


typecheck:
	npx tsc --noEmit
	cd cdk && npx tsc --noEmit


lint:
	npx eslint 'src/**/*.ts' 'lambda/**/*.ts' 'cdk/**/*.ts'
	npx prettier --check 'src/**/*.ts' 'lambda/**/*.ts' 'cdk/**/*.ts'

format:
	npx eslint 'src/**/*.ts' 'lambda/**/*.ts' 'cdk/**/*.ts' --fix
	npx prettier --write 'src/**/*.ts' 'lambda/**/*.ts' 'cdk/**/*.ts'

check: typecheck lint

up:
	$(COMPOSE) up -d --build
	@echo "agent up at $(URL)"

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) restart agent

logs:
	$(COMPOSE) logs -f agent

ping:
	curl -s $(URL)/ping ; echo

# fake Slack invocation - uses arbitrary sessionId so a fresh microVM is created
SESSION_ID ?= $(shell uuidgen | tr A-Z a-z)
PROMPT  ?= hello
CHANNEL ?= C0000000000
THREAD  ?= 1700000000.000000
SLACK_USER ?= U0000000000
invoke:
	curl -s -X POST $(URL)/invocations \
	  -H "Content-Type: application/json" \
	  -H "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: $(SESSION_ID)" \
	  -d '{"prompt":"$(PROMPT)","slack":{"channel_id":"$(CHANNEL)","thread_ts":"$(THREAD)","slack_user_id":"$(SLACK_USER)","trigger_message_ts":"$(THREAD)"}}'
	@echo

shell:
	$(COMPOSE) exec agent bash

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------

ecr.create:
	@aws ecr describe-repositories --region $(REGION) --repository-names $(REPO_NAME) >/dev/null 2>&1 \
	  || aws ecr create-repository --region $(REGION) --repository-name $(REPO_NAME) >/dev/null
	@echo "ECR repo $(REPO_NAME) ready"

IMAGE_TAG = $(shell find $(HASH_INPUTS) -type f -print0 2>/dev/null | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-12)

build.push: ecr.create
	@TAG=$(IMAGE_TAG); \
	IMAGE=$(REGISTRY)/$(REPO_NAME):$$TAG; \
	echo "tag: $$TAG"; \
	if aws ecr describe-images --region $(REGION) --repository-name $(REPO_NAME) --image-ids imageTag=$$TAG >/dev/null 2>&1; then \
	  echo "image already in ECR - skipping build"; \
	else \
	  aws ecr get-login-password --region $(REGION) | docker login --username AWS --password-stdin $(REGISTRY); \
	  docker buildx build --platform linux/arm64 -t $$IMAGE --push .; \
	fi

deploy: build.push
	cd cdk && $(CDK) deploy --all --require-approval never -c imageTag=$(IMAGE_TAG)

synth:
	cd cdk && $(CDK) synth -c imageTag=$(IMAGE_TAG)

diff:
	cd cdk && $(CDK) diff -c imageTag=$(IMAGE_TAG)

destroy:
	cd cdk && $(CDK) destroy --all -c imageTag=$(IMAGE_TAG)

bootstrap:
	cd cdk && $(CDK) bootstrap aws://$(ACCOUNT)/$(REGION)

# Print the region config.json resolves to, for the copy-paste commands in the docs.
region:
	@echo $(REGION)

# ---------------------------------------------------------------------------
# Observability (one-time, per account and region)
# ---------------------------------------------------------------------------
# Spans exported by the runtime land in X-Ray. CloudWatch Transaction Search
# turns them into structured logs the CloudWatch GenAI Observability console
# reads, grouped by session (and by the Slack user/thread trace attributes).
# Three account-level settings: let X-Ray write to CloudWatch Logs, point
# X-Ray at CloudWatch Logs, and index 100% of spans so every session shows up.
# Shared by every agent in the region, so it's not part of any stack.
observability.enable:
	@aws logs put-resource-policy --region $(REGION) --policy-name TransactionSearchXRayAccess --policy-document \
	  '{"Version":"2012-10-17","Statement":[{"Sid":"TransactionSearchXRayAccess","Effect":"Allow","Principal":{"Service":"xray.amazonaws.com"},"Action":"logs:PutLogEvents","Resource":["arn:aws:logs:$(REGION):$(ACCOUNT):log-group:aws/spans:*","arn:aws:logs:$(REGION):$(ACCOUNT):log-group:/aws/application-signals/data:*","arn:aws:logs:$(REGION):$(ACCOUNT):log-group:/aws/bedrock-agentcore/runtimes/*:*"],"Condition":{"ArnLike":{"aws:SourceArn":"arn:aws:xray:$(REGION):$(ACCOUNT):*"},"StringEquals":{"aws:SourceAccount":"$(ACCOUNT)"}}}]}' >/dev/null
	@aws xray update-trace-segment-destination --region $(REGION) --destination CloudWatchLogs 2>/dev/null || echo "trace destination already CloudWatchLogs"
	aws xray update-indexing-rule --region $(REGION) --name Default --rule '{"Probabilistic":{"DesiredSamplingPercentage":100}}'
	@echo "Transaction Search on in $(REGION), indexing 100% of spans. Traces: CloudWatch > GenAI Observability."

