# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Does

Deploys HashiCorp Vault on AWS ECS Fargate using Pulumi (TypeScript). The infrastructure includes:
- A custom Docker image built from `ecs-fargate/` and pushed to ECR
- Vault configured with S3 as its storage backend and KMS for auto-unseal
- An ALB with TLS termination via ACM, pointed at `vault.pulumi-ce.team` (Route53 zone: `pulumi-ce.team`)
- Single ECS Fargate task (1 desired count) running on a public subnet

## Commands

All commands run from the repo root.

```bash
npm install          # install dependencies
pulumi preview       # preview changes
pulumi up            # deploy
pulumi destroy       # tear down
```

The stack name is `dev`; stack config is in `Pulumi.dev.yaml`. The stack uses a Pulumi ESC environment (`cloud-access/aws`) to supply AWS credentials.

## Architecture Notes

- **`index.ts`** — the entire infrastructure definition. Networking, ECR, KMS, S3, IAM, ECS, and ALB all live here.
- **`vaultSetup.ts`** — a `ComponentResource` (`VaultInit`) that initialises Vault via its HTTP API (`/v1/sys/init`, `/v1/sys/unseal`). Active in `index.ts`; Vault provider resources (JWT auth, PKI, AWS secrets engine) are also wired up and run after `VaultInit` completes.
- **`ecs-fargate/`** — Docker build context. Multi-stage scratch image; `vault-server.hcl` configures Vault to use `awskms` seal and `s3` storage (credentials via ECS task role). `init.json` is a Vault init payload template.
- **`setup-commands.txt`** — manual `vault` CLI commands needed after first deploy (operator init/unseal, JWT auth config, policy/role creation). These are the steps `VaultInit` is meant to automate.

## Key Config Values

| Key | Value |
|---|---|
| `aws:region` | `eu-west-1` |
| `vaultVersion` | `1.15.6` (Pulumi config default) |
| Vault version in Dockerfile | `2.0.1` (takes precedence for the built image) |
| Vault DNS | `vault.pulumi-ce.team` |
| Vault port | `8200` (HTTPS via ALB; container uses plain HTTP) |

## Known Issues / In-Progress

- `VaultInit` and all Vault provider resources (`vault.jwt.*`, `vault.Mount`, etc.) are active in `index.ts`. They require a running, initialised Vault endpoint — if the endpoint is unavailable, `pulumi up` will fail at the Vault initialisation step.
- The Vault version in the Dockerfile (`VAULT_VERSION=2.0.1`) differs from the Pulumi config default (`1.15.6`); the Dockerfile value takes precedence for the actual image built.
- LB security group ingress is restricted to a hardcoded CIDR allowlist in `index.ts:48-56`.
- The Dockerfile `ENTRYPOINT` references `/etc/vault/config.hcl` but copies `vault-server.hcl` to `/etc/vault/vault-server.hcl` — these paths don't match.
