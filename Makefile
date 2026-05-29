.PHONY: start-ssh-pass start-ssh-key stop-ssh-pass stop-ssh-key \
        connect-ssh-pass connect-ssh-key \
        logs-ssh-pass logs-ssh-key \
        shell-ssh-pass shell-ssh-key \
        ssh-keygen ssh-status ssh-clean ssh-clean-keys \
        scp-build start-scp-pass start-scp-key stop-scp-pass stop-scp-key \
        connect-scp-pass connect-scp-key \
        logs-scp-pass logs-scp-key \
        shell-scp-pass shell-scp-key scp-clean-image \
        e2e e2e-build e2e-shell e2e-logs e2e-clean

# Test SSH servers (linuxserver/openssh-server) for local development.
# Two independent containers — password-auth and key-auth — can run in parallel.
SSH_IMAGE          := lscr.io/linuxserver/openssh-server:latest
SSH_USER           := testuser
SSH_PASSWORD       := testpass

# Password-auth container
SSH_PASS_CONTAINER := anyscp-test-sshd-pass
SSH_PASS_PORT      := 2222

# Key-auth container
SSH_KEY_CONTAINER  := anyscp-test-sshd-key
SSH_KEY_PORT       := 2223

# Test SSH keypair — generated on demand, kept out of git.
SSH_KEY_DIR        := .test-ssh
SSH_KEY            := $(SSH_KEY_DIR)/id_ed25519
SSH_PUB_KEY        := $(SSH_KEY).pub

# SCP-only test server (extends linuxserver/openssh-server with SFTP stripped).
SCP_IMAGE          := anyscp-test-scp-only:latest
SCP_IMAGE_STAMP    := tests/scp-server/.image-stamp
SCP_IMAGE_SRC      := tests/scp-server/Dockerfile tests/scp-server/disable-sftp.sh

# SCP-only password container
SSH_SCP_PASS_CONTAINER := anyscp-test-scp-pass
SSH_SCP_PASS_PORT      := 2224

# SCP-only key container
SSH_SCP_KEY_CONTAINER  := anyscp-test-scp-key
SSH_SCP_KEY_PORT       := 2225

# ─── Keypair ──────────────────────────────────────────────────────────────────

$(SSH_KEY):
	@mkdir -p $(SSH_KEY_DIR)
	@ssh-keygen -t ed25519 -f $(SSH_KEY) -N "" -C "anyscp-test-key" >/dev/null
	@echo "Generated test SSH key at $(SSH_KEY)"

ssh-keygen: $(SSH_KEY)
	@echo "Private key: $(SSH_KEY)"
	@echo "Public key:  $(SSH_PUB_KEY)"

# ─── Password container ───────────────────────────────────────────────────────

start-ssh-pass:
	@if [ "$$(docker ps -aq -f name=^/$(SSH_PASS_CONTAINER)$$)" ]; then \
		echo "Starting existing container $(SSH_PASS_CONTAINER)..."; \
		docker start $(SSH_PASS_CONTAINER) >/dev/null; \
	else \
		echo "Creating container $(SSH_PASS_CONTAINER) on port $(SSH_PASS_PORT)..."; \
		docker run -d \
			--name $(SSH_PASS_CONTAINER) \
			-p $(SSH_PASS_PORT):2222 \
			-e PUID=1000 \
			-e PGID=1000 \
			-e TZ=Etc/UTC \
			-e USER_NAME=$(SSH_USER) \
			-e USER_PASSWORD=$(SSH_PASSWORD) \
			-e PASSWORD_ACCESS=true \
			-e SUDO_ACCESS=true \
			$(SSH_IMAGE) >/dev/null; \
	fi
	@echo ""
	@echo "  Password SSH server running at:"
	@echo "    Host:     localhost"
	@echo "    Port:     $(SSH_PASS_PORT)"
	@echo "    User:     $(SSH_USER)"
	@echo "    Password: $(SSH_PASSWORD)"
	@echo ""
	@echo "  Connect: ssh -p $(SSH_PASS_PORT) $(SSH_USER)@localhost"

stop-ssh-pass:
	@docker stop $(SSH_PASS_CONTAINER) >/dev/null 2>&1 && echo "Stopped $(SSH_PASS_CONTAINER)" || echo "$(SSH_PASS_CONTAINER) not running"

connect-ssh-pass:
	@ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p $(SSH_PASS_PORT) $(SSH_USER)@localhost

logs-ssh-pass:
	@docker logs -f $(SSH_PASS_CONTAINER)

shell-ssh-pass:
	@docker exec -it $(SSH_PASS_CONTAINER) /bin/sh

# ─── Key container ────────────────────────────────────────────────────────────

start-ssh-key: $(SSH_KEY)
	@if [ "$$(docker ps -aq -f name=^/$(SSH_KEY_CONTAINER)$$)" ]; then \
		echo "Starting existing container $(SSH_KEY_CONTAINER)..."; \
		docker start $(SSH_KEY_CONTAINER) >/dev/null; \
	else \
		echo "Creating container $(SSH_KEY_CONTAINER) on port $(SSH_KEY_PORT)..."; \
		docker run -d \
			--name $(SSH_KEY_CONTAINER) \
			-p $(SSH_KEY_PORT):2222 \
			-e PUID=1000 \
			-e PGID=1000 \
			-e TZ=Etc/UTC \
			-e USER_NAME=$(SSH_USER) \
			-e PASSWORD_ACCESS=false \
			-e SUDO_ACCESS=true \
			-e PUBLIC_KEY="$$(cat $(SSH_PUB_KEY))" \
			$(SSH_IMAGE) >/dev/null; \
	fi
	@echo ""
	@echo "  Key-auth SSH server running at:"
	@echo "    Host: localhost"
	@echo "    Port: $(SSH_KEY_PORT)"
	@echo "    User: $(SSH_USER)"
	@echo "    Key:  $(SSH_KEY)"
	@echo ""
	@echo "  Connect: ssh -i $(SSH_KEY) -p $(SSH_KEY_PORT) $(SSH_USER)@localhost"

stop-ssh-key:
	@docker stop $(SSH_KEY_CONTAINER) >/dev/null 2>&1 && echo "Stopped $(SSH_KEY_CONTAINER)" || echo "$(SSH_KEY_CONTAINER) not running"

connect-ssh-key: $(SSH_KEY)
	@ssh -i $(SSH_KEY) -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p $(SSH_KEY_PORT) $(SSH_USER)@localhost

logs-ssh-key:
	@docker logs -f $(SSH_KEY_CONTAINER)

shell-ssh-key:
	@docker exec -it $(SSH_KEY_CONTAINER) /bin/sh

# ─── SCP-only image ───────────────────────────────────────────────────────────
# Built from tests/scp-server/. Rebuilt automatically whenever the Dockerfile
# or the init script change.

$(SCP_IMAGE_STAMP): $(SCP_IMAGE_SRC)
	@echo "  building $(SCP_IMAGE) (sources changed)"
	@cd tests/scp-server && docker build -t $(SCP_IMAGE) .
	@touch $@

scp-build: $(SCP_IMAGE_STAMP)

# ─── SCP-only password container ──────────────────────────────────────────────

start-scp-pass: $(SCP_IMAGE_STAMP)
	@if [ "$$(docker ps -aq -f name=^/$(SSH_SCP_PASS_CONTAINER)$$)" ]; then \
		echo "Starting existing container $(SSH_SCP_PASS_CONTAINER)..."; \
		docker start $(SSH_SCP_PASS_CONTAINER) >/dev/null; \
	else \
		echo "Creating container $(SSH_SCP_PASS_CONTAINER) on port $(SSH_SCP_PASS_PORT)..."; \
		docker run -d \
			--name $(SSH_SCP_PASS_CONTAINER) \
			-p $(SSH_SCP_PASS_PORT):2222 \
			-e PUID=1000 \
			-e PGID=1000 \
			-e TZ=Etc/UTC \
			-e USER_NAME=$(SSH_USER) \
			-e USER_PASSWORD=$(SSH_PASSWORD) \
			-e PASSWORD_ACCESS=true \
			-e SUDO_ACCESS=true \
			$(SCP_IMAGE) >/dev/null; \
	fi
	@echo ""
	@echo "  SCP-only (password) server running at:"
	@echo "    Host:     localhost"
	@echo "    Port:     $(SSH_SCP_PASS_PORT)"
	@echo "    User:     $(SSH_USER)"
	@echo "    Password: $(SSH_PASSWORD)"
	@echo "    SFTP:     disabled (Subsystem stripped)"
	@echo ""
	@echo "  SCP (legacy proto): scp -O -P $(SSH_SCP_PASS_PORT) FILE $(SSH_USER)@localhost:"
	@echo "  SFTP (should fail): sftp -P $(SSH_SCP_PASS_PORT) $(SSH_USER)@localhost"

stop-scp-pass:
	@docker stop $(SSH_SCP_PASS_CONTAINER) >/dev/null 2>&1 && echo "Stopped $(SSH_SCP_PASS_CONTAINER)" || echo "$(SSH_SCP_PASS_CONTAINER) not running"

connect-scp-pass:
	@ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p $(SSH_SCP_PASS_PORT) $(SSH_USER)@localhost

logs-scp-pass:
	@docker logs -f $(SSH_SCP_PASS_CONTAINER)

shell-scp-pass:
	@docker exec -it $(SSH_SCP_PASS_CONTAINER) /bin/sh

# ─── SCP-only key container ───────────────────────────────────────────────────

start-scp-key: $(SCP_IMAGE_STAMP) $(SSH_KEY)
	@if [ "$$(docker ps -aq -f name=^/$(SSH_SCP_KEY_CONTAINER)$$)" ]; then \
		echo "Starting existing container $(SSH_SCP_KEY_CONTAINER)..."; \
		docker start $(SSH_SCP_KEY_CONTAINER) >/dev/null; \
	else \
		echo "Creating container $(SSH_SCP_KEY_CONTAINER) on port $(SSH_SCP_KEY_PORT)..."; \
		docker run -d \
			--name $(SSH_SCP_KEY_CONTAINER) \
			-p $(SSH_SCP_KEY_PORT):2222 \
			-e PUID=1000 \
			-e PGID=1000 \
			-e TZ=Etc/UTC \
			-e USER_NAME=$(SSH_USER) \
			-e PASSWORD_ACCESS=false \
			-e SUDO_ACCESS=true \
			-e PUBLIC_KEY="$$(cat $(SSH_PUB_KEY))" \
			$(SCP_IMAGE) >/dev/null; \
	fi
	@echo ""
	@echo "  SCP-only (key) server running at:"
	@echo "    Host: localhost"
	@echo "    Port: $(SSH_SCP_KEY_PORT)"
	@echo "    User: $(SSH_USER)"
	@echo "    Key:  $(SSH_KEY)"
	@echo "    SFTP: disabled (Subsystem stripped)"
	@echo ""
	@echo "  SCP (legacy proto): scp -O -i $(SSH_KEY) -P $(SSH_SCP_KEY_PORT) FILE $(SSH_USER)@localhost:"

stop-scp-key:
	@docker stop $(SSH_SCP_KEY_CONTAINER) >/dev/null 2>&1 && echo "Stopped $(SSH_SCP_KEY_CONTAINER)" || echo "$(SSH_SCP_KEY_CONTAINER) not running"

connect-scp-key: $(SSH_KEY)
	@ssh -i $(SSH_KEY) -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p $(SSH_SCP_KEY_PORT) $(SSH_USER)@localhost

logs-scp-key:
	@docker logs -f $(SSH_SCP_KEY_CONTAINER)

shell-scp-key:
	@docker exec -it $(SSH_SCP_KEY_CONTAINER) /bin/sh

# ─── Combined status / cleanup ────────────────────────────────────────────────

ssh-status:
	@docker ps -a \
		-f name=^/$(SSH_PASS_CONTAINER)$$ \
		-f name=^/$(SSH_KEY_CONTAINER)$$ \
		-f name=^/$(SSH_SCP_PASS_CONTAINER)$$ \
		-f name=^/$(SSH_SCP_KEY_CONTAINER)$$

ssh-clean:
	@docker rm -f $(SSH_PASS_CONTAINER)     >/dev/null 2>&1 && echo "Removed $(SSH_PASS_CONTAINER)"     || echo "$(SSH_PASS_CONTAINER) not present"
	@docker rm -f $(SSH_KEY_CONTAINER)      >/dev/null 2>&1 && echo "Removed $(SSH_KEY_CONTAINER)"      || echo "$(SSH_KEY_CONTAINER) not present"
	@docker rm -f $(SSH_SCP_PASS_CONTAINER) >/dev/null 2>&1 && echo "Removed $(SSH_SCP_PASS_CONTAINER)" || echo "$(SSH_SCP_PASS_CONTAINER) not present"
	@docker rm -f $(SSH_SCP_KEY_CONTAINER)  >/dev/null 2>&1 && echo "Removed $(SSH_SCP_KEY_CONTAINER)"  || echo "$(SSH_SCP_KEY_CONTAINER) not present"

scp-clean-image:
	@docker rmi $(SCP_IMAGE) 2>/dev/null && echo "Removed $(SCP_IMAGE)" || echo "$(SCP_IMAGE) not present"
	@rm -f $(SCP_IMAGE_STAMP)

ssh-clean-keys:
	@rm -rf $(SSH_KEY_DIR) && echo "Removed $(SSH_KEY_DIR)"

# ─── E2E tests (containerised) ────────────────────────────────────────────────
# Full UI E2E suite under WebKitWebDriver + xvfb inside Docker. The runner
# image bakes in tauri-driver, the webkit2gtk driver, and a build toolchain
# so the same setup works on dev machines (incl. Arch) and CI.

E2E_COMPOSE := docker compose -f tests/e2e/docker-compose.yml -p anyscp-e2e
# Stamp file — make rebuilds the image whenever any of its source inputs
# change (Dockerfile, entrypoint, or harness package.json).
E2E_IMAGE_STAMP := tests/e2e/.image-stamp
E2E_IMAGE_SRC   := tests/e2e/Dockerfile tests/e2e/entrypoint.sh tests/e2e/package.json

# (Re)build the runner image whenever any source input is newer than the stamp.
$(E2E_IMAGE_STAMP): $(E2E_IMAGE_SRC)
	@echo "  building anyscp-e2e-runner:latest (sources changed)"
	@cd tests/e2e && docker build -t anyscp-e2e-runner:latest .
	@touch $@

# Explicit rebuild target (alias).
e2e-build: $(E2E_IMAGE_STAMP)

# Run the full suite. Brings up the SSH targets + runner, runs WDIO, then
# tears containers down — but KEEPS volumes (rust-target, cargo-cache,
# node-modules) so the next run does an incremental compile (~5s instead
# of ~80s). Use `make e2e-clean` to wipe volumes when you want a fresh start.
e2e: $(E2E_IMAGE_STAMP)
	@$(E2E_COMPOSE) up --abort-on-container-exit --exit-code-from e2e e2e; \
		ec=$$?; \
		$(E2E_COMPOSE) down --remove-orphans >/dev/null 2>&1; \
		exit $$ec

# Drop into an interactive shell in the runner with the SSH targets up
# (useful when debugging a failing spec).
e2e-shell:
	@$(E2E_COMPOSE) up -d sshd-pass sshd-key keygen
	@$(E2E_COMPOSE) run --rm --entrypoint /bin/bash e2e

# Tail logs from the runner.
e2e-logs:
	@$(E2E_COMPOSE) logs -f e2e

# Tear down everything and remove cached volumes (forces a clean next run).
e2e-clean:
	@$(E2E_COMPOSE) down -v --remove-orphans
	@docker rmi anyscp-e2e-runner:latest 2>/dev/null || true
	@rm -f $(E2E_IMAGE_STAMP)

e2e-clean-artifacts:
	@rm -rf ./tests/e2e/{screenshots,videos,junit,report.md,.test-records.ndjson,.image-stamp}