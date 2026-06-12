import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as random from "@pulumi/random";
import * as awsx from "@pulumi/awsx";
import * as vault from "@pulumi/vault";
import * as pulumiservice from "@pulumi/pulumiservice";
import { VaultInit } from "./vaultSetup";

const config = new pulumi.Config();

const vaultVersion = config.get("vaultVersion") ?? "1.15.6";
const current = aws.getCallerIdentityOutput();

const nameSuffix = new random.RandomId("name_suffix", {
  byteLength: 4,
});

// VPC & Security Groups

const vpc = new awsx.ec2.Vpc("vpc", {
  cidrBlock: "10.0.0.0/16",
  numberOfAvailabilityZones: 2,
  subnetSpecs: [
    {
      type: awsx.ec2.SubnetType.Public,
      name: "public-ecs-subnet",
    },
  ],
  tags: {
    name: "pk-ecs-vault",
  },
  subnetStrategy: awsx.ec2.SubnetAllocationStrategy.Auto,
  natGateways: {
    strategy: "None",
  },
});

const lbSg = new aws.ec2.SecurityGroup("vault-lb-sg", {
  vpcId: vpc.vpcId,
});

const ipList: string[] = [];

// TODO update the `cidrBlocks` with the IP addresses you want to be able to access Vault from
new aws.ec2.SecurityGroupRule("vault_api_tcp", {
  type: "ingress",
  description: "Vault API/UI",
  securityGroupId: lbSg.id,
  fromPort: 8200,
  toPort: 8200,
  protocol: "tcp",
  cidrBlocks: [],
});

new aws.ec2.SecurityGroupRule("egress_web", {
  type: "egress",
  description: "Internet access",
  securityGroupId: lbSg.id,
  fromPort: 0,
  toPort: 0,
  protocol: "all",
  cidrBlocks: ["0.0.0.0/0"],
});

const taskSg = new aws.ec2.SecurityGroup("vault-task-sg", {
  vpcId: vpc.vpcId,
});

new aws.ec2.SecurityGroupRule("task-lb-ingress-rule", {
  type: "ingress",
  securityGroupId: taskSg.id,
  fromPort: 8200,
  toPort: 8200,
  sourceSecurityGroupId: lbSg.id,
  protocol: "all",
});

new aws.ec2.SecurityGroupRule("task-egress_web", {
  type: "egress",
  description: "Internet access",
  securityGroupId: taskSg.id,
  fromPort: 0,
  toPort: 0,
  protocol: "all",
  cidrBlocks: ["0.0.0.0/0"],
});

const lb = new aws.lb.LoadBalancer("lb", {
  securityGroups: [lbSg.id],
  subnets: vpc.publicSubnetIds,
});

const hostedZone = aws.route53.getZone({
  name: "pulumi-ce.team",
});

const vaultRecord = new aws.route53.Record("vault-dns", {
  ttl: 60,
  name: "vault.pulumi-ce.team",
  type: "CNAME",
  records: [lb.dnsName],
  zoneId: hostedZone.then((x) => x.zoneId),
});

const cert = new aws.acm.Certificate("vault-tls", {
  domainName: "vault.pulumi-ce.team",
  validationMethod: "DNS",
});

const validationRecords = cert.domainValidationOptions.apply((options) => {
  const records: aws.route53.Record[] = [];
  options.map((option) => {
    records.push(
      new aws.route53.Record(`record-${option.domainName}`, {
        ttl: 60,
        name: option.resourceRecordName,
        records: [option.resourceRecordValue],
        type: aws.route53.RecordType.CNAME,
        zoneId: hostedZone.then((x) => x.zoneId),
      }),
    );
  });
  return records;
});

const certValidation = new aws.acm.CertificateValidation("vault-cert", {
  certificateArn: cert.arn,
  validationRecordFqdns: validationRecords.apply((records) =>
    records.map((record) => record.fqdn),
  ),
});

const tg = new aws.lb.TargetGroup(
  "tg",
  {
    port: 8200,
    protocol: "HTTP",
    targetType: "ip",
    vpcId: vpc.vpcId,
    healthCheck: {
      enabled: true,
      interval: 5,
      healthyThreshold: 2,
      path: "/v1/sys/health?uninitcode=200&sealedcode=200",
      protocol: "HTTP",
      port: "8200",
      timeout: 4,
    },
    deregistrationDelay: 5,
  },
  { dependsOn: [lb] },
);

const listener = new aws.lb.Listener(
  "listener",
  {
    loadBalancerArn: lb.arn,
    port: 8200,
    certificateArn: cert.arn,
    protocol: "HTTPS",
    defaultActions: [
      {
        type: "forward",
        targetGroupArn: tg.arn,
      },
    ],
  },
  { dependsOn: certValidation },
);

const listenerHttp = new aws.lb.Listener(
  "listenerhttp",
  {
    loadBalancerArn: lb.arn,
    port: 80,
    protocol: "HTTP",
    defaultActions: [
      {
        type: "redirect",
        redirect: {
          port: "8200",
          protocol: "HTTPS",
          statusCode: "HTTP_301",
        },
      },
    ],
  },
  { dependsOn: certValidation },
);

const listenerHttps = new aws.lb.Listener(
  "listenerhttps",
  {
    loadBalancerArn: lb.arn,
    port: 443,
    certificateArn: cert.arn,
    protocol: "HTTPS",
    defaultActions: [
      {
        type: "redirect",
        redirect: {
          port: "8200",
          protocol: "HTTPS",
          statusCode: "HTTP_301",
        },
      },
    ],
  },
  { dependsOn: certValidation },
);

// ECR

const ecrRepo = new awsx.ecr.Repository("vaultRepo", {
  forceDelete: true,
});

const image = new awsx.ecr.Image("vaultImage", {
  repositoryUrl: ecrRepo.url,
  context: "./ecs-fargate",
  platform: "linux/amd64",
});

// KMS

const s3Key = new aws.kms.Key("s3_key", {
  description: "S3 SSE key",
  keyUsage: "ENCRYPT_DECRYPT",
  deletionWindowInDays: 7,
  enableKeyRotation: false,
  multiRegion: false,
});

new aws.kms.Alias("s3_key_alias", {
  name: "alias/s3-sse-key",
  targetKeyId: s3Key.keyId,
});

const vaultKey = new aws.kms.Key("vault_key", {
  description: "Vault Auto Unseal key",
  keyUsage: "ENCRYPT_DECRYPT",
  deletionWindowInDays: 7,
  enableKeyRotation: false,
  multiRegion: false,
});

new aws.kms.Alias("vault_key_alias", {
  name: "alias/vault-auto-unseal-key",
  targetKeyId: vaultKey.keyId,
});

// S3

const vaultS3Backend = new aws.s3.Bucket("vault-s3-backend", {
  forceDestroy: true,
});

new aws.s3.BucketServerSideEncryptionConfiguration("s3_sse", {
  bucket: vaultS3Backend.bucket,
  rules: [
    {
      applyServerSideEncryptionByDefault: {
        kmsMasterKeyId: s3Key.arn,
        sseAlgorithm: "aws:kms",
      },
    },
  ],
});

new aws.s3.BucketPublicAccessBlock("s3_block_public", {
  bucket: vaultS3Backend.id,
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
});

// IAM

const taskRole = new aws.iam.Role("taskRole", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal(
    aws.iam.Principals.EcsTasksPrincipal,
  ),
});

const executionRole = new aws.iam.Role("executionRole", {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal(
    aws.iam.Principals.EcsTasksPrincipal,
  ),
});

const vaultPolicy = new aws.iam.Policy("vault-user-policy", {
  name: "vault-ecs-policy",
  description: "ECS Vault user IAM policy",
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: [
          "s3:ListBucket",
          "s3:GetBucketLocation",
          "s3:GetObject",
          "s3:GetObjectAcl",
          "s3:PutObject",
          "s3:PutObjectAcl",
          "s3:DeleteObject",
          "s3:DeleteObjects",
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:GenerateDataKey",
          "kms:ListKeys",
          "kms:DescribeKey",
        ],
        Effect: "Allow",
        Resource: "*",
      },
    ],
  }),
});

const vaultRole = new aws.iam.Role("vaultAssumeRole", {
  assumeRolePolicy: aws.iam.getPolicyDocumentOutput({
    version: "2012-10-17",
    statements: [
      {
        effect: "Allow",
        principals: [
          {
            identifiers: [taskRole.arn],
            type: "AWS",
          },
        ],
        actions: ["sts:AssumeRole"],
      },
    ],
  }).json,
});

const vaultAssumePolicy = new aws.iam.Policy("vault-assume-policy", {
  name: "vault-assume-policy",
  description: "ECS Vault user IAM policy",
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Action: ["s3:ListAllMyBuckets"],
        Effect: "Allow",
        Resource: "*",
      },
    ],
  }),
});

new aws.iam.RolePolicyAttachment("rpa-vault-assume", {
  role: vaultRole.name,
  policyArn: vaultAssumePolicy.arn,
});

new aws.iam.RolePolicyAttachment("rpa-task", {
  role: taskRole.name,
  policyArn: vaultPolicy.arn,
});

new aws.iam.RolePolicyAttachment("rpa-execution", {
  role: executionRole.name,
  policyArn: aws.iam.ManagedPolicy.AmazonECSTaskExecutionRolePolicy,
});

// ECS

const ecsCluster = new aws.ecs.Cluster("ecs_cluster");

new aws.ecs.ClusterCapacityProviders("ecs_cluster_capacity", {
  clusterName: ecsCluster.name,
  capacityProviders: ["FARGATE"],
  defaultCapacityProviderStrategies: [
    {
      base: 1,
      weight: 100,
      capacityProvider: "FARGATE",
    },
  ],
});

const logGroup = new aws.cloudwatch.LogGroup("vault-loggroup");

const containerDefinitions = pulumi.jsonStringify([
  {
    name: "vault-docker",
    image: image.imageUri,
    entryPoint: ["/vault", "server", "-config", "/etc/vault/vault-server.hcl"],
    portMappings: [
      {
        hostPort: 8200,
        protocol: "tcp",
        containerPort: 8200,
      },
    ],
    environment: [
      { name: "AWS_REGION", value: "eu-west-1" },
      { name: "AWS_S3_BUCKET", value: vaultS3Backend.bucket },
      { name: "VAULT_AWSKMS_SEAL_KEY_ID", value: vaultKey.keyId },
    ],
    logConfiguration: {
      logDriver: "awslogs",
      options: {
        "awslogs-create-group": "true",
        "awslogs-group": logGroup.name,
        "awslogs-region": "eu-west-1",
        "awslogs-stream-prefix": "vault",
      },
    },
    essential: true,
    privileged: false,
  },
]);

const ecsTaskDef = new aws.ecs.TaskDefinition("ecs-task-def", {
  family: "vault-ecs-task-def",
  executionRoleArn: executionRole.arn,
  taskRoleArn: taskRole.arn,
  requiresCompatibilities: ["FARGATE"],
  networkMode: "awsvpc",
  cpu: "512",
  memory: "1024",
  containerDefinitions: containerDefinitions,
});

const vaultService = new aws.ecs.Service("vault-svc", {
  cluster: ecsCluster.name,
  taskDefinition: ecsTaskDef.arn,
  desiredCount: 1,
  launchType: "FARGATE",
  networkConfiguration: {
    subnets: vpc.publicSubnetIds,
    securityGroups: [taskSg.id],
    assignPublicIp: true,
  },
  loadBalancers: [
    {
      containerName: "vault-docker",
      containerPort: 8200,
      targetGroupArn: tg.arn,
    },
  ],
});

const vaultInit = new VaultInit(
  "vault-init",
  {
    vaultUrl: pulumi.interpolate`https://${vaultRecord.fqdn}:8200`,
  },
  { dependsOn: [vaultService, listener] },
);

export const setuptoken = vaultInit.rootToken;

const vaultProvider = new vault.Provider("provider", {
  token: vaultInit.rootToken,
  address: pulumi.interpolate`https://${vaultRecord.fqdn}:8200`,
});

const jwtAuth = new vault.jwt.AuthBackend(
  "pulumi-cloud",
  {
    path: "jwt",
    oidcDiscoveryUrl: "https://api.pulumi.com/oidc",
    boundIssuer: "https://api.pulumi.com/oidc",
  },
  { provider: vaultProvider },
);

const policy = new vault.Policy(
  "vault-policy",
  {
    name: "vault",
    policy: `path "/aws/*" {
    capabilities = ["read", "list"]
}
path "/pk-i/*" {
  capabilities = ["read", "list"]
}
path "/pk_int/*" {
  capabilities = ["read", "list"]
} 
`,
  },
  { provider: vaultProvider },
);

export const policyName = policy.name;

const jwtRole = new vault.jwt.AuthBackendRole(
  "pulumi-cloud-adyen",
  {
    userClaim: "sub",
    boundAudiences: ["vault:pierskarsenbarg"],
    roleType: "jwt",
    tokenPolicies: [policy.name],
    boundClaimsType: "glob",
    allowedRedirectUris: [
      pulumi.interpolate`https://vault.pulumi-ce.team:8200/jwt/callback`,
    ],
    roleName: "pulumi-cloud",
    boundClaims: {
      sub: "pulumi:environments:org:pierskarsenbarg:env:*",
    },
  },
  { provider: vaultProvider, dependsOn: [jwtAuth] },
);

const awsMount = new vault.Mount(
  "aws-mount",
  {
    type: "aws",
    path: "aws",
  },
  { deleteBeforeReplace: true, provider: vaultProvider },
);

const role = new vault.aws.SecretBackendRole(
  "role",
  {
    backend: "aws",
    credentialType: "assumed_role",
    defaultStsTtl: 3600,
    maxStsTtl: 14400,
    name: "deploy-role",
    roleArns: [vaultRole.arn],
  },
  { dependsOn: [awsMount], provider: vaultProvider },
);

const pkiMount = new vault.Mount(
  "pki",
  {
    type: "pki",
    path: "pk-i",
    maxLeaseTtlSeconds: 87600,
  },
  { deleteBeforeReplace: true, provider: vaultProvider },
);

const rootCert = new vault.pkisecret.SecretBackendRootCert(
  "rootCert",
  {
    backend: pkiMount.path,
    type: "internal",
    commonName: "Root CA",
    ttl: "8760",
  },
  { provider: vaultProvider, deleteBeforeReplace: true },
);

const pkiRole = new vault.pkisecret.SecretBackendRole(
  "pkiRole",
  {
    backend: pkiMount.path,
    allowAnyName: true,
    allowedDomains: ["pulumi-ce.team"],
    allowSubdomains: true,
  },
  { provider: vaultProvider, dependsOn: [pkiMount] },
);

const pkiUrls = new vault.pkisecret.SecretBackendConfigUrls(
  "urls",
  {
    issuingCertificates: [
      pulumi.interpolate`${vaultRecord.fqdn}:8200/v1/pki/ca`,
    ],
    crlDistributionPoints: [
      pulumi.interpolate`${vaultRecord.fqdn}:8200/v1/pki/crl`,
    ],
    backend: pkiMount.path,
  },
  { provider: vaultProvider },
);

const pkiIntermediateMount = new vault.Mount(
  "intermediate",
  {
    path: "pki_int",
    type: "pki",
    defaultLeaseTtlSeconds: 2592000,
    maxLeaseTtlSeconds: 15552000,
  },
  { provider: vaultProvider },
);

const csrRequest = new vault.pkisecret.SecretBackendIntermediateCertRequest(
  "csrRequest",
  {
    backend: pkiIntermediateMount.path,
    type: "internal",
    commonName: "pulumi-ce.team Intermediate Authority",
  },
  { provider: vaultProvider },
);

const rootSignIntermediate =
  new vault.pkisecret.SecretBackendRootSignIntermediate(
    "intermediate",
    {
      backend: pkiMount.path,
      commonName: "new_intermediate",
      csr: csrRequest.csr,
      format: "pem_bundle",
      ttl: "15480000",
      issuerRef: rootCert.issuerId,
    },
    { provider: vaultProvider },
  );

const intermediateSetSigned =
  new vault.pkisecret.SecretBackendIntermediateSetSigned(
    "intermediate",
    {
      backend: pkiIntermediateMount.path,
      certificate: rootSignIntermediate.certificate,
    },
    { provider: vaultProvider },
  );

const intermediateRole = new vault.pkisecret.SecretBackendRole(
  "intermediate",
  {
    backend: pkiIntermediateMount.path,
    issuerRef: "default",
    allowIpSans: true,
    keyType: "rsa",
    allowedDomains: ["pulumi-ce.team"],
    allowSubdomains: true,
  },
  { provider: vaultProvider },
);

const piers_test_cert = new vault.pkisecret.SecretBackendCert(
  "piers_test_cert",
  {
    issuerRef: rootSignIntermediate.issuerRef,
    backend: intermediateRole.backend,
    commonName: "piers-test-cert.pulumi-ce.team",
    ttl: "3600",
    revoke: true,
    name: intermediateRole.name,
  },
  { provider: vaultProvider },
);

export const piers_test_cert_serial = piers_test_cert.serialNumber;

const envVaultLoginYml = pulumi.interpolate`
values:
  vault:
    login:
      fn::open::vault-login:
        address: https://${vaultRecord.fqdn}:8200
        jwt:
          role: pulumi-cloud
`;

const vaultEnv = new pulumiservice.Environment("vault-login", {
  name: "login",
  organization: "pierskarsenbarg",
  project: "vault",
  yaml: envVaultLoginYml,
});

const envVaultAwsCreds = pulumi.interpolate`
imports:
  - vault/login
values:
  vault:
    secrets:
      fn::open::vault-secrets:
        login: \${vault.login}
        read:
          aws:
            path: aws/creds/deploy-role
  environmentVariables:
    AWS_ACCESS_KEY_ID: \${vault.secrets.aws.access_key}
    AWS_SECRET_ACCESS_KEY: \${vault.secrets.aws.secret_key}
    AWS_SESSION_TOKEN: \${vault.secrets.aws.session_token}
`;

const vaultAwsCressEnv = new pulumiservice.Environment("vault-aws", {
  name: "aws-creds",
  organization: "pierskarsenbarg",
  project: "vault",
  yaml: envVaultAwsCreds,
});

const envVaultCertificates = pulumi.interpolate`
imports:
  - vault/login
values:
  stackRefs:
    fn::open::pulumi-stacks:
      stacks: 
        vaultSetup:
          stack: "${pulumi.getProject()}/${pulumi.getStack()}"
  vault:
    secrets:
      fn::open::vault-secrets:
        login: \${vault.login}
        read:
          piers_test_cert:
            path: "${pkiIntermediateMount.path}/cert/\${stackRefs.vaultSetup.piers_test_cert_serial}"
  files:
    PIERS_TEST_CERT: \${vault.secrets.piers_test_cert.certificate}
`;

const vaultCertificatesEnv = new pulumiservice.Environment("vault-certs", {
  name: "certs",
  organization: pulumi.getOrganization(),
  project: "vault",
  yaml: envVaultCertificates,
});
