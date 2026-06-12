# HashiCorp Vault on AWS ECS Fargate

Deploys a HashiCorp Vault instance on AWS ECS Fargate using Pulumi (TypeScript). Vault is configured with S3 as its storage backend, KMS for auto-unseal, and served over HTTPS via an ALB.

After deploying the infrastructure, the Pulumi program automatically initialises Vault and configures:

- JWT auth backend (bound to Pulumi Cloud OIDC)
- AWS secrets engine with an assumed-role credential backend
- PKI secrets engine with a root CA and intermediate CA
- Pulumi ESC environments for Vault login, AWS credentials, and certificates

## Prerequisites

- [Pulumi CLI](https://www.pulumi.com/docs/install/) >= v3
- Node.js >= 18
- Docker (for building the Vault image)
- Configured access to an AWS account
- A Route53 hosted zone for your target domain in the target AWS account

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Update the LB security group ingress CIDR allowlist in `index.ts` (lines 48–56) to include your IP address(es).

3. Select the `dev` stack:

   ```bash
   pulumi stack select dev
   ```

## Deploy

```bash
pulumi up
```

This will:

1. Build and push the Vault Docker image to ECR
2. Provision VPC, ALB, ACM certificate, ECS cluster, KMS keys, and S3 bucket
3. Create a DNS record for the Vault endpoint
4. Start the Vault ECS Fargate task
5. Initialise Vault and configure auth, secrets engines, and PKI
6. Create Pulumi ESC environments for Vault login, AWS credentials, and certificates

## Configuration

| Key            | Default     |
| -------------- | ----------- |
| `aws:region`   | `eu-west-1` |
| `vaultVersion` | `1.15.6`    |

The Dockerfile uses `VAULT_VERSION=2.0.1`, which takes precedence for the built image.

To change config values:

```bash
pulumi config set <key> <value>
```

## Stack Outputs

| Output                   | Description                               |
| ------------------------ | ----------------------------------------- |
| `setuptoken`             | Vault root token (sensitive)              |
| `policyName`             | Name of the Vault policy created          |
| `piers_test_cert_serial` | Serial number of the test PKI certificate |

## Tear Down

```bash
pulumi destroy
```

## Project Layout

| Path                 | Description                                            |
| -------------------- | ------------------------------------------------------ |
| `index.ts`           | Full infrastructure definition                         |
| `vaultSetup.ts`      | `VaultInit` component — initialises Vault via HTTP API |
| `ecs-fargate/`       | Docker build context (Dockerfile, `vault-server.hcl`)  |
| `Pulumi.yaml`        | Pulumi project metadata                                |
| `Pulumi.dev.yaml`    | Stack config for the `dev` stack                       |
| `setup-commands.txt` | Manual Vault CLI reference commands                    |
