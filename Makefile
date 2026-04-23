.PHONY: ssh-up ssh-down ssh-restart ssh-logs ssh-shell ssh-connect ssh-status ssh-clean

# Test SSH server (linuxserver/openssh-server) for local development.
# Exposes port 2222 with password and key auth enabled.
SSH_CONTAINER := anyscp-test-sshd
SSH_IMAGE     := lscr.io/linuxserver/openssh-server:latest
SSH_PORT      := 2222
SSH_USER      := testuser
SSH_PASSWORD  := testpass

ssh-up:
	@if [ "$$(docker ps -aq -f name=^/$(SSH_CONTAINER)$$)" ]; then \
		echo "Starting existing container $(SSH_CONTAINER)..."; \
		docker start $(SSH_CONTAINER) >/dev/null; \
	else \
		echo "Creating container $(SSH_CONTAINER) on port $(SSH_PORT)..."; \
		docker run -d \
			--name $(SSH_CONTAINER) \
			-p $(SSH_PORT):2222 \
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
	@echo "  Test SSH server running at:"
	@echo "    Host:     localhost"
	@echo "    Port:     $(SSH_PORT)"
	@echo "    User:     $(SSH_USER)"
	@echo "    Password: $(SSH_PASSWORD)"
	@echo ""
	@echo "  Connect:  ssh -p $(SSH_PORT) $(SSH_USER)@localhost"

ssh-down:
	@docker stop $(SSH_CONTAINER) >/dev/null 2>&1 && echo "Stopped $(SSH_CONTAINER)" || echo "$(SSH_CONTAINER) not running"

ssh-restart: ssh-down ssh-up

ssh-logs:
	@docker logs -f $(SSH_CONTAINER)

ssh-shell:
	@docker exec -it $(SSH_CONTAINER) /bin/sh

ssh-connect:
	@ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p $(SSH_PORT) $(SSH_USER)@localhost

ssh-status:
	@docker ps -a -f name=^/$(SSH_CONTAINER)$$

ssh-clean:
	@docker rm -f $(SSH_CONTAINER) >/dev/null 2>&1 && echo "Removed $(SSH_CONTAINER)" || echo "Nothing to remove"
